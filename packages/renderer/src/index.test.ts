import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ReelForgeError,
  RenderJobSnapshotSchema,
  createErrorPayload,
  type RenderJobSnapshot,
} from '@reelforge/core';
import { describe, expect, it } from 'vitest';

import * as renderer from './index.js';

describe('narration timeline', () => {
  it('places probed clips consecutively without adding silence', () => {
    const api = renderer as Record<string, unknown>;

    expect(typeof api.createNarrationTimeline).toBe('function');
    const timeline = (
      api.createNarrationTimeline as (clips: ReadonlyArray<{ cardId: string; durationSeconds: number }>) => {
        durationSeconds: number;
        segments: unknown[];
      }
    )([
      { cardId: 'first', durationSeconds: 1.25 },
      { cardId: 'second', durationSeconds: 0.75 },
      { cardId: 'third', durationSeconds: 2 },
    ]);

    expect(timeline).toEqual({
      durationSeconds: 4,
      segments: [
        {
          cardId: 'first',
          durationSeconds: 1.25,
          startSeconds: 0,
          endSeconds: 1.25,
          fadeInSeconds: 0,
          fadeOutSeconds: 0.2,
        },
        {
          cardId: 'second',
          durationSeconds: 0.75,
          startSeconds: 1.25,
          endSeconds: 2,
          fadeInSeconds: 0.2,
          fadeOutSeconds: 0.2,
        },
        {
          cardId: 'third',
          durationSeconds: 2,
          startSeconds: 2,
          endSeconds: 4,
          fadeInSeconds: 0.2,
          fadeOutSeconds: 0,
        },
      ],
    });
  });

  it('clamps each boundary fade to half of the shorter adjacent clip', () => {
    const api = renderer as Record<string, unknown>;

    expect(typeof api.clampCrossfadeSeconds).toBe('function');
    const clamp = api.clampCrossfadeSeconds as (
      leftDurationSeconds: number,
      rightDurationSeconds: number,
      targetSeconds?: number,
    ) => number;

    expect(clamp(0.1, 2)).toBeCloseTo(0.05, 10);
    expect(clamp(2, 0.24)).toBeCloseTo(0.12, 10);
    expect(clamp(2, 3)).toBe(0.2);
  });

  it('rejects non-positive or non-finite probed durations', () => {
    const create = renderer.createNarrationTimeline;

    expect(() => create([{ cardId: 'bad', durationSeconds: 0 }])).toThrow(
      'Narration duration must be a positive finite number',
    );
    expect(() => create([{ cardId: 'bad', durationSeconds: Number.NaN }])).toThrow(
      'Narration duration must be a positive finite number',
    );
  });

  it('overlaps clamped visual fades with complementary alpha at a short-segment boundary', () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.createVisualCardWindows).toBe('function');
    expect(typeof api.visualCardOpacityAt).toBe('function');
    const shortTimeline = renderer.createNarrationTimeline([
      { cardId: 'short', durationSeconds: 0.1 },
      { cardId: 'long', durationSeconds: 2 },
    ]);
    const windows = (
      api.createVisualCardWindows as (timeline: renderer.NarrationTimeline) => Array<{
        startSeconds: number;
        endSeconds: number;
        fadeInEndSeconds: number;
        fadeOutStartSeconds: number;
      }>
    )(shortTimeline);
    const opacityAt = api.visualCardOpacityAt as (
      window: (typeof windows)[number],
      timeSeconds: number,
    ) => number;

    expect(windows).toEqual([
      {
        startSeconds: 0,
        endSeconds: 0.125,
        fadeInEndSeconds: 0,
        fadeOutStartSeconds: 0.075,
      },
      {
        startSeconds: 0.075,
        endSeconds: 2.1,
        fadeInEndSeconds: 0.125,
        fadeOutStartSeconds: 2.1,
      },
    ]);
    expect(windows[0]!.endSeconds - windows[1]!.startSeconds).toBeCloseTo(0.05, 10);
    expect(opacityAt(windows[0]!, 0.1)).toBeCloseTo(0.5, 10);
    expect(opacityAt(windows[1]!, 0.1)).toBeCloseTo(0.5, 10);
    expect(opacityAt(windows[0]!, 0.1) + opacityAt(windows[1]!, 0.1)).toBeCloseTo(1, 10);
    expect(shortTimeline.segments.map(({ startSeconds, endSeconds }) => ({ startSeconds, endSeconds }))).toEqual([
      { startSeconds: 0, endSeconds: 0.1 },
      { startSeconds: 0.1, endSeconds: 2.1 },
    ]);
  });
});

describe('ffprobe JSON', () => {
  it('normalizes stream metadata, duration, and rational frame rate', () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.parseFfprobeJson).toBe('function');

    const probe = (api.parseFfprobeJson as (source: string) => unknown)(JSON.stringify({
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          width: 720,
          height: 1280,
          avg_frame_rate: '30000/1001',
          duration: '1.251',
        },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          sample_rate: '48000',
          channels: 2,
        },
      ],
      format: { duration: '1.267', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    }));

    expect(probe).toEqual({
      durationSeconds: 1.267,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      streams: [
        {
          index: 0,
          type: 'video',
          codec: 'h264',
          width: 720,
          height: 1280,
          fps: 30000 / 1001,
          durationSeconds: 1.251,
        },
        {
          index: 1,
          type: 'audio',
          codec: 'aac',
          sampleRate: 48000,
          channels: 2,
        },
      ],
    });
  });

  it('selects narration duration from the audio stream instead of artwork or stale container duration', () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.selectAudioDurationSeconds).toBe('function');
    const select = api.selectAudioDurationSeconds as (probe: Record<string, unknown>) => number;

    expect(select({
      durationSeconds: 99,
      streams: [
        { index: 0, type: 'video', codec: 'mjpeg', durationSeconds: 99, attachedPicture: true },
        { index: 1, type: 'audio', codec: 'aac', durationSeconds: 1.25 },
      ],
    })).toBe(1.25);
  });

  it('supports duration_ts times time_base and only safe audio-only format fallback', () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.selectAudioDurationSeconds).toBe('function');
    const select = api.selectAudioDurationSeconds as (probe: Record<string, unknown>) => number;

    expect(select({
      durationSeconds: 8,
      streams: [{
        index: 0,
        type: 'audio',
        codec: 'pcm_s16le',
        durationTimestamp: 48_000,
        timeBase: 1 / 48_000,
      }],
    })).toBe(1);
    expect(select({
      durationSeconds: 0.75,
      streams: [{ index: 0, type: 'audio', codec: 'mp3' }],
    })).toBe(0.75);
    expect(() => select({
      durationSeconds: 99,
      streams: [
        { index: 0, type: 'video', codec: 'h264', durationSeconds: 99 },
        { index: 1, type: 'audio', codec: 'aac' },
      ],
    })).toThrow('Narration audio duration is unavailable');
  });

  it('rejects malformed or streamless ffprobe output as a safe render failure', () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.parseFfprobeJson).toBe('function');
    const parse = api.parseFfprobeJson as (source: string) => unknown;

    for (const source of ['not-json', '{"streams":[]}']) {
      try {
        parse(source);
        throw new Error('expected parser to reject');
      } catch (error) {
        expect(error).toMatchObject({
          payload: {
            code: 'RENDER_FAILED',
            message: 'Media inspection failed',
          },
        });
        expect(String(error)).not.toContain(source);
      }
    }
  });
});

describe('FFmpeg command graph', () => {
  it('builds timed cards, paired memes, reusable transition audio, and ducked looping music', () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.buildFfmpegCommand).toBe('function');
    const build = api.buildFfmpegCommand as (request: Record<string, unknown>) => {
      args: string[];
      filterGraph: string;
    };
    const timeline = renderer.createEditTimeline({
      cards: [
        { cardId: 'one', contentSeconds: 2, hasNarration: true, memeSeconds: 1.5 },
        { cardId: 'two', contentSeconds: 2, hasNarration: true, memeSeconds: 0.4 },
      ],
      transitionSeconds: 0.5,
    });
    const command = build({
      backgroundPath: 'gameplay.mp4',
      cards: [
        {
          imagePath: 'one.png',
          audioPath: 'one.wav',
          segment: timeline.cards[0],
          meme: {
            imagePath: 'meme-one.png',
            soundPath: 'meme-one.mp3',
            range: timeline.cards[0]!.meme!,
          },
        },
        {
          imagePath: 'two.png',
          audioPath: 'two.wav',
          segment: timeline.cards[1],
          meme: {
            imagePath: 'meme-two.png',
            soundPath: 'meme-two.mp3',
            range: timeline.cards[1]!.meme!,
          },
        },
      ],
      transitionSoundPath: 'transition.mp3',
      backgroundMusicPath: 'music.mp3',
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
      outputPath: 'result.partial.mp4',
    });

    expect(command.args.slice(0, 4)).toEqual(['-hide_banner', '-nostdin', '-y', '-stream_loop']);
    expect(command.args).toContain('-1');
    expect(command.filterGraph).toContain(
      '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30',
    );
    expect(command.filterGraph).toContain(
      "overlay=x=216:y=806:eof_action=pass:shortest=0:enable='between(t,2,3.5)'",
    );
    expect(command.filterGraph).toContain('adelay=2000|2000[memeAudio0]');
    expect(command.filterGraph).toContain('adelay=3500|3500[transitionAudio1]');
    expect(command.filterGraph).toContain('adelay=4000|4000[narration1]');
    expect(command.filterGraph).toContain('sidechaincompress=');
    expect(command.filterGraph).toContain('volume=0.18');
    expect(command.filterGraph).toContain('alimiter=limit=0.95[aout]');
    expect(command.filterGraph).toContain(
      '[cardImage0][cardImage1]xfade=transition=fade:duration=0.2:offset=3.5[cards1]',
    );
    expect(command.filterGraph).not.toContain('legacy-sticker.png');
    expect(command.filterGraph).not.toContain('[0:a]');
    expect(command.args.filter((value) => value === 'transition.mp3')).toHaveLength(1);
    expect(command.args).toEqual(expect.arrayContaining(['-t', '6.4']));
    expect(command.args).toEqual(expect.arrayContaining([
      '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-movflags', '+faststart',
      '-progress', 'pipe:2', 'result.partial.mp4',
    ]));
  });

  it('renders each meme in its own layout and falls back to the request meme slot', () => {
    const timeline = renderer.createEditTimeline({
      cards: [
        { cardId: 'one', contentSeconds: 1, hasNarration: false, memeSeconds: 0.4 },
        { cardId: 'two', contentSeconds: 1, hasNarration: false, memeSeconds: 0.4 },
        { cardId: 'three', contentSeconds: 1, hasNarration: false, memeSeconds: 0.4 },
      ],
    });
    const command = renderer.buildFfmpegCommand({
      backgroundPath: 'gameplay.mp4',
      cards: [
        {
          imagePath: 'one.png',
          segment: timeline.cards[0]!,
          meme: {
            imagePath: 'meme-one.png',
            soundPath: 'meme-one.mp3',
            layout: { x: 0.05, y: 0.1, width: 0.4, height: 0.3 },
            range: timeline.cards[0]!.meme!,
          },
        },
        {
          imagePath: 'two.png',
          segment: timeline.cards[1]!,
          meme: {
            videoPath: 'meme-two.mp4',
            videoDurationSeconds: 0.4,
            hasAudio: false,
            layout: { x: 0.5, y: 0.55, width: 0.45, height: 0.4 },
            range: timeline.cards[1]!.meme!,
          },
        },
        {
          imagePath: 'three.png',
          segment: timeline.cards[2]!,
          meme: {
            imagePath: 'meme-three.png',
            soundPath: 'meme-three.mp3',
            range: timeline.cards[2]!.meme!,
          },
        },
      ],
      memeSlot: { x: 0.2, y: 0.8, width: 0.5, height: 0.1 },
      outputPath: 'result.partial.mp4',
      width: 720,
      height: 1280,
    });

    expect(command.filterGraph).toContain('scale=288:384:force_original_aspect_ratio=decrease');
    expect(command.filterGraph).toContain('overlay=x=36:y=128');
    expect(command.filterGraph).toContain('scale=324:512:force_original_aspect_ratio=decrease');
    expect(command.filterGraph).toContain('overlay=x=360:y=704');
    expect(command.filterGraph).toContain('scale=360:128:force_original_aspect_ratio=decrease');
    expect(command.filterGraph).toContain('overlay=x=144:y=1024');
  });

  it('builds intro-delayed audio, per-card full-canvas layouts, and held video memes', () => {
    const timeline = renderer.createEditTimeline({
      introSeconds: 0.75,
      transitionSeconds: 0.4,
      cards: [
        { cardId: 'one', contentSeconds: 1.25, hasNarration: true, memeSeconds: 1.5 },
        { cardId: 'two', contentSeconds: 1, hasNarration: false },
      ],
    });
    const command = renderer.buildFfmpegCommand({
      backgroundPath: 'gameplay.mp4',
      cards: [
        {
          imagePath: 'one.png',
          audioPath: 'one.wav',
          layout: { x: 0.2, y: 0.1, width: 0.5, height: 0.25 },
          segment: timeline.cards[0]!,
          meme: {
            videoPath: 'meme.mp4',
            soundPath: 'meme-extra.mp3',
            videoDurationSeconds: 0.75,
            hasAudio: true,
            range: timeline.cards[0]!.meme!,
          },
        },
        {
          imagePath: 'two.png',
          segment: timeline.cards[1]!,
        },
      ],
      introSoundPath: 'intro.mp3',
      transitionSoundPath: 'transition.mp3',
      backgroundMusicPath: 'music.mp3',
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
      outputPath: 'result.partial.mp4',
    } as unknown as renderer.FfmpegCommandRequest);

    expect(command.filterGraph).toContain('scale=360:320:force_original_aspect_ratio=decrease');
    expect(command.filterGraph).toContain('color=c=black@0.0:s=720x1280:r=30');
    expect(command.filterGraph).toContain('overlay=x=144:y=128');
    expect(command.filterGraph).toContain('adelay=0|0[introAudio]');
    expect(command.filterGraph).toContain('adelay=750|750[narration0]');
    expect(command.filterGraph).toContain('adelay=750|750,atrim=duration=4.9,volume=0.18[musicBase]');
    expect(command.filterGraph).toContain('tpad=stop_mode=clone:stop_duration=0.75');
    expect(command.filterGraph).toContain('adelay=2000|2000[videoAudio0]');
    expect(command.filterGraph).toContain('adelay=2000|2000[memeAudio0]');
    expect(command.args.filter((value) => value === 'meme.mp4')).toHaveLength(1);
    expect(command.args.filter((value) => value === 'meme-extra.mp3')).toHaveLength(1);
    expect(command.args).toEqual(expect.arrayContaining(['-t', '4.9']));
  });

  it('clamps a visual-only card crossfade for a short segment without changing audio or total duration', () => {
    const timeline = renderer.createEditTimeline({
      cards: [
        { cardId: 'short', contentSeconds: 0.1, hasNarration: true },
        { cardId: 'long', contentSeconds: 1, hasNarration: true },
      ],
    });
    const command = renderer.buildFfmpegCommand({
      backgroundPath: 'gameplay.mp4',
      cards: [
        { imagePath: 'short.png', audioPath: 'short.wav', segment: timeline.cards[0]! },
        { imagePath: 'long.png', audioPath: 'long.wav', segment: timeline.cards[1]! },
      ],
      outputPath: 'result.partial.mp4',
    });

    expect(command.filterGraph).toContain(
      '[cardImage0][cardImage1]xfade=transition=fade:duration=0.05:offset=0.1[cards1]',
    );
    expect(command.filterGraph).toContain('adelay=100|100[narration1]');
    expect(command.args).toEqual(expect.arrayContaining(['-t', '1.1']));
  });

  it('uses encoder-safe even dimensions for an odd-pixel meme slot', () => {
    const timeline = renderer.createEditTimeline({
      cards: [{ cardId: 'only', contentSeconds: 1, hasNarration: true, memeSeconds: 0.4 }],
    });
    const command = renderer.buildFfmpegCommand({
      backgroundPath: 'gameplay.mp4',
      cards: [{
        imagePath: 'card.png',
        audioPath: 'narration.wav',
        segment: timeline.cards[0]!,
        meme: {
          imagePath: 'meme.jpg',
          soundPath: 'meme.mp3',
          range: timeline.cards[0]!.meme!,
        },
      }],
      outputPath: 'result.partial.mp4',
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    });

    expect(command.filterGraph).toContain(
      'scale=288:396:force_original_aspect_ratio=decrease,pad=288:396:',
    );
  });

  it('keeps a valid near-edge card slot inside the 720x1280 canvas', () => {
    const timeline = renderer.createEditTimeline({
      cards: [{ cardId: 'only', contentSeconds: 1, hasNarration: true }],
    });
    const command = renderer.buildFfmpegCommand({
      backgroundPath: 'gameplay.mp4',
      cards: [{
        imagePath: 'card.png',
        audioPath: 'narration.wav',
        segment: timeline.cards[0]!,
      }],
      outputPath: 'result.partial.mp4',
      cardSlot: { x: 0.999, y: 0.999, width: 0.001, height: 0.001 },
    });

    const scale = command.filterGraph.match(
      /\[1:v\].*?scale=(\d+):(\d+):force_original_aspect_ratio=decrease/,
    );
    const overlay = command.filterGraph.match(
      /\[bg\]\[cardImage0\]overlay=x=(\d+):y=(\d+):/,
    );
    expect(scale).not.toBeNull();
    expect(overlay).not.toBeNull();

    const pixelWidth = Number(scale![1]);
    const pixelHeight = Number(scale![2]);
    const pixelX = Number(overlay![1]);
    const pixelY = Number(overlay![2]);
    expect(pixelWidth % 2).toBe(0);
    expect(pixelHeight % 2).toBe(0);
    expect(pixelX + pixelWidth).toBeLessThanOrEqual(720);
    expect(pixelY + pixelHeight).toBeLessThanOrEqual(1280);
  });

  it('keeps the foreground-only path when optional audio is absent and allows a final meme', () => {
    const timeline = renderer.createEditTimeline({
      cards: [{ cardId: 'only', contentSeconds: 1, hasNarration: true, memeSeconds: 0.4 }],
    });
    const command = renderer.buildFfmpegCommand({
      backgroundPath: 'gameplay.mp4',
      cards: [{
        imagePath: 'card.png',
        audioPath: 'narration.wav',
        segment: timeline.cards[0]!,
        meme: {
          imagePath: 'final-meme.png',
          soundPath: 'final-meme.mp3',
          range: timeline.cards[0]!.meme!,
        },
      }],
      outputPath: 'result.partial.mp4',
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    });

    expect(command.filterGraph).toContain("between(t,1,1.4)");
    expect(command.filterGraph).toContain('alimiter=limit=0.95[aout]');
    expect(command.filterGraph).not.toContain('sidechaincompress=');
    expect(command.filterGraph).not.toContain('transitionAudio');
    expect(command.filterGraph).not.toContain('music');
    expect(command.args).toEqual(expect.arrayContaining(['-t', '1.4']));
  });
});

describe('FFmpeg progress', () => {
  it('parses chunked progress records and clamps percent to the render duration', () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.createProgressParser).toBe('function');
    const values: number[] = [];
    const parser = (api.createProgressParser as (
      durationSeconds: number,
      listener: (percent: number) => void,
    ) => { push(chunk: string): void; finish(): void })(2, (percent) => values.push(percent));

    parser.push('frame=3\nout_time_us=500');
    parser.push('000\nprogress=continue\nout_time=00:00:03.000000\n');
    parser.finish();

    expect(values).toEqual([25, 100]);
  });

  it('never regresses and treats a chunked progress=end record as exactly 100', () => {
    const values: number[] = [];
    const parser = renderer.createProgressParser(2, (percent) => values.push(percent));

    parser.push('out_time_us=1000000\nprogress=cont');
    parser.push('inue\nout_time_us=500000\nprogress=end\n');
    parser.finish();

    expect(values).toEqual([50, 100]);
  });

  it('emits exactly 100 when an owned process exits successfully without progress output', async () => {
    const values: number[] = [];
    const operation = renderer.startOwnedFfmpegProcess({
      binaryPath: process.execPath,
      args: ['-e', ''],
      durationSeconds: 1,
      onProgress: (percent) => values.push(percent),
    });

    await operation.completion;
    expect(values).toEqual([100]);
  });

  it('turns a progress callback failure into a controlled completion rejection', async () => {
    const operation = renderer.startOwnedFfmpegProcess({
      binaryPath: process.execPath,
      args: ['-e', "process.stderr.write('out_time_us=500000\\n'); setInterval(() => {}, 1000)"],
      durationSeconds: 1,
      onProgress: () => {
        throw new ReelForgeError(createErrorPayload('CONFLICT', 'Worker lease ownership was lost'));
      },
      terminateProcessTree: async (child) => {
        child.kill('SIGKILL');
        return true;
      },
    });

    await expect(operation.completion).rejects.toMatchObject({
      payload: { code: 'CONFLICT', message: 'Worker lease ownership was lost' },
    });
    expect(isProcessAlive(operation.pid)).toBe(false);
  });
});

describe('bundled media tools', () => {
  it('resolves executable ffmpeg and ffprobe files without a system installation', async () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.resolveBundledBinaries).toBe('function');
    const binaries = (api.resolveBundledBinaries as () => {
      ffmpegPath: string;
      ffprobePath: string;
    })();

    await expect(access(binaries.ffmpegPath)).resolves.toBeUndefined();
    await expect(access(binaries.ffprobePath)).resolves.toBeUndefined();
    expect(binaries.ffmpegPath.toLowerCase()).toContain('ffmpeg-static');
    expect(binaries.ffprobePath.toLowerCase()).toContain('ffprobe-static');
  });

  it('probes real media through injected bundled ffprobe resolution', async () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.probeMedia).toBe('function');
    const root = await mkdtemp(join(tmpdir(), 'reelforge-probe-'));
    const audioPath = join(root, 'tone.wav');
    await writeFile(audioPath, createSilentWav(8000, 0.25));

    try {
      const probe = await (api.probeMedia as (
        path: string,
        options: { binaryResolver: typeof renderer.resolveBundledBinaries },
      ) => Promise<renderer.MediaProbe>)(audioPath, {
        binaryResolver: renderer.resolveBundledBinaries,
      });
      expect(probe.durationSeconds).toBeCloseTo(0.25, 3);
      expect(probe.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'audio', codec: 'pcm_s16le', sampleRate: 8000, channels: 1 }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fully decodes managed media and safely rejects corrupt content', async () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.inspectMediaFully).toBe('function');
    const root = await mkdtemp(join(tmpdir(), 'reelforge-decode-'));
    const badPath = join(root, 'managed.png');
    await writeFile(badPath, 'not actually an image');

    try {
      await expect((api.inspectMediaFully as (
        path: string,
        kind: string,
      ) => Promise<unknown>)(badPath, 'image')).rejects.toMatchObject({
        payload: { code: 'RENDER_FAILED', message: 'Managed media is invalid' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('owned FFmpeg process', () => {
  it('exposes ownership and cancellation that terminates the child process', async () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.startOwnedFfmpegProcess).toBe('function');
    const operation = (api.startOwnedFfmpegProcess as (request: Record<string, unknown>) => {
      pid: number;
      cancel(): Promise<void>;
      completion: Promise<void>;
    })({
      binaryPath: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      durationSeconds: 10,
    });

    expect(operation.pid).toBeGreaterThan(0);
    await operation.cancel();
    await expect(operation.completion).rejects.toMatchObject({
      payload: { code: 'CANCELLED', message: 'Render was cancelled' },
    });
    expect(isProcessAlive(operation.pid)).toBe(false);
  });

  it('awaits an injected Windows tree terminator and closes a child plus grandchild', async () => {
    const api = renderer as Record<string, unknown>;
    const root = await mkdtemp(join(tmpdir(), 'reelforge-process-tree-'));
    const grandchildPidPath = join(root, 'grandchild.pid');
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });`,
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('');
    let grandchildPid = -1;

    try {
      const operation = (api.startOwnedFfmpegProcess as (request: Record<string, unknown>) => {
        pid: number;
        cancel(): Promise<void>;
        completion: Promise<void>;
      })({
        binaryPath: process.execPath,
        args: ['-e', childScript],
        durationSeconds: 10,
        terminateProcessTree: async (child: ChildProcess) => {
          grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'));
          process.kill(grandchildPid, 'SIGKILL');
          child.kill('SIGKILL');
          await waitUntil(() => !isProcessAlive(grandchildPid));
          return true;
        },
      });

      await waitUntil(async () => {
        try {
          await access(grandchildPidPath);
          return true;
        } catch {
          return false;
        }
      });
      await operation.cancel();
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      expect(isProcessAlive(operation.pid)).toBe(false);
      expect(isProcessAlive(grandchildPid)).toBe(false);
    } finally {
      if (grandchildPid > 0 && isProcessAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares one delayed-close cancellation promise across concurrent callers', async () => {
    const closeGate = createDeferred<void>();
    let terminationCalls = 0;
    const operation = renderer.startOwnedFfmpegProcess({
      binaryPath: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      durationSeconds: 10,
      terminateProcessTree: async (child) => {
        terminationCalls += 1;
        await closeGate.promise;
        child.kill('SIGKILL');
        return true;
      },
    });
    let firstSettled = false;
    let secondSettled = false;

    try {
      const firstCancel = operation.cancel().finally(() => {
        firstSettled = true;
      });
      const secondCancel = operation.cancel().finally(() => {
        secondSettled = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(terminationCalls).toBe(1);

      closeGate.resolve(undefined);
      await Promise.all([firstCancel, secondCancel]);
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      expect(isProcessAlive(operation.pid)).toBe(false);
    } finally {
      closeGate.resolve(undefined);
      if (isProcessAlive(operation.pid)) process.kill(operation.pid, 'SIGKILL');
    }
  });

  it('shares registry cancellation until every registered process closes', async () => {
    const closeGate = createDeferred<void>();
    const registry = new renderer.RenderProcessRegistry();
    let terminationCalls = 0;
    const operation = renderer.startOwnedFfmpegProcess({
      binaryPath: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      durationSeconds: 10,
      processRegistry: registry,
      terminateProcessTree: async (child) => {
        terminationCalls += 1;
        await closeGate.promise;
        child.kill('SIGKILL');
        return true;
      },
    });
    let firstSettled = false;
    let secondSettled = false;

    try {
      const firstCancel = registry.cancel().finally(() => {
        firstSettled = true;
      });
      const secondCancel = registry.cancel().finally(() => {
        secondSettled = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(terminationCalls).toBe(1);

      closeGate.resolve(undefined);
      await Promise.all([firstCancel, secondCancel]);
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      expect(isProcessAlive(operation.pid)).toBe(false);
    } finally {
      closeGate.resolve(undefined);
      if (isProcessAlive(operation.pid)) process.kill(operation.pid, 'SIGKILL');
    }
  });
});

describe('render-scoped process ownership', () => {
  it.each(['ffprobe', 'decode'] as const)('aborts and awaits standalone preflight during %s', async (phase) => {
    // Production break caught: worker preflight owns no cancel operation, leaving ffprobe/full-decode alive after durable cancellation.
    const root = await createRenderRequestRoot(`reelforge-standalone-${phase}-`);
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    try {
      const pending = renderer.preflightRender({
        ...root.request,
        signal: controller.signal,
      }, {
        binaryResolver: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
        processSpawner: (_binaryPath, args, options) => {
          if (phase === 'decode' && args.includes('-show_streams')) {
            return nodeSpawn(process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify({
              streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', duration: '1' }],
              format: { duration: '1' },
            }))})`], options);
          }
          child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          markStarted?.();
          return child;
        },
        terminateProcessTree: async (ownedChild) => {
          ownedChild.kill('SIGKILL');
          return true;
        },
      });
      const outcome = pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );

      const first = await Promise.race([
        started.then(() => 'started' as const),
        outcome.then(() => 'settled' as const),
      ]);
      expect(first).toBe('started');
      controller.abort();

      expect((await outcome).error).toMatchObject({ payload: { code: 'CANCELLED' } });
      expect(child?.signalCode).not.toBeNull();
      expect(isProcessAlive(child?.pid ?? -1)).toBe(false);
    } finally {
      child?.kill('SIGKILL');
      await rm(root.root, { recursive: true, force: true });
    }
  });

  it('cancels and awaits an ffprobe subprocess active during preflight', async () => {
    const root = await createRenderRequestRoot('reelforge-cancel-probe-');
    let child: ChildProcess | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });

    try {
      const operation = renderer.startRender(root.request, {
        binaryResolver: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
        processSpawner: (_binaryPath, _args, options) => {
          child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          markStarted?.();
          return child;
        },
        terminateProcessTree: async (ownedChild) => {
          ownedChild.kill('SIGKILL');
          return true;
        },
      } as renderer.RenderVideoOptions);

      await started;
      await operation.cancel();
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      expect(child?.signalCode).not.toBeNull();
      expect(isProcessAlive(child?.pid ?? -1)).toBe(false);
    } finally {
      child?.kill('SIGKILL');
      await rm(root.root, { recursive: true, force: true });
    }
  });

  it('cancels and awaits a full-decode subprocess after ffprobe succeeds', async () => {
    const root = await createRenderRequestRoot('reelforge-cancel-decode-');
    let decodeChild: ChildProcess | undefined;
    let resolveDecodeStarted: (() => void) | undefined;
    const decodeStarted = new Promise<void>((resolveStarted) => {
      resolveDecodeStarted = resolveStarted;
    });

    try {
      const operation = renderer.startRender(root.request, {
        binaryResolver: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
        processSpawner: (_binaryPath, args, options) => {
          if (args.includes('-show_streams')) {
            return nodeSpawn(process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify({
              streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', duration: '1' }],
              format: { duration: '1' },
            }))})`], options);
          }
          decodeChild = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          resolveDecodeStarted?.();
          return decodeChild;
        },
        terminateProcessTree: async (ownedChild) => {
          ownedChild.kill('SIGKILL');
          return true;
        },
      } as renderer.RenderVideoOptions);

      await decodeStarted;
      await operation.cancel();
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      expect(decodeChild?.signalCode).not.toBeNull();
      expect(isProcessAlive(decodeChild?.pid ?? -1)).toBe(false);
    } finally {
      decodeChild?.kill('SIGKILL');
      await rm(root.root, { recursive: true, force: true });
    }
  });
});

describe('render cancellation error precedence', () => {
  it('surfaces an unremoved attempt partial on the owned render operation after failure', async () => {
    // Production break caught: worker cannot persist renderer cleanup debt when completion rejects without returning a RenderVideoResult.
    const root = await createRenderRequestRoot('reelforge-failed-cleanup-debt-');
    const operation = renderer.startRender(
      { ...root.request, providerReady: false },
      { fileOperations: { remove: async () => { throw errnoError('EACCES'); } } },
    ) as renderer.RenderOperation & { cleanupPendingPaths?: readonly string[] };
    try {
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
      expect(operation.cleanupPendingPaths).toEqual([
        expect.stringMatching(/\.partial\.mp4$/),
      ]);
    } finally {
      await rm(root.root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'output conflict', accessResult: 'conflict' as const },
    { name: 'unavailable output location', accessResult: 'unavailable' as const },
  ])('lets cancellation beat a delayed $name', async ({ accessResult }) => {
    const root = await createRenderRequestRoot(`reelforge-cancel-${accessResult}-`);
    const accessStarted = createDeferred<void>();
    const releaseAccess = createDeferred<void>();
    const outputPath = join(
      root.request.outputDirectory,
      'Project-Name-20260824-070000000-cancel-job.mp4',
    );
    const operation = renderer.startRender(root.request, {
      now: () => new Date('2026-08-24T07:00:00.000Z'),
      fileOperations: {
        access: async () => {
          accessStarted.resolve(undefined);
          await releaseAccess.promise;
          if (accessResult === 'unavailable') throw errnoError('EACCES');
        },
      },
    });
    let cancelSettled = false;
    let completionSettled = false;
    void operation.completion.then(
      () => { completionSettled = true; },
      () => { completionSettled = true; },
    );

    try {
      await accessStarted.promise;
      const cancellation = operation.cancel().then(() => {
        cancelSettled = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      expect(cancelSettled).toBe(false);
      expect(completionSettled).toBe(false);

      releaseAccess.resolve(undefined);
      await cancellation;
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseAccess.resolve(undefined);
      await operation.completion.catch(() => undefined);
      await rm(root.root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'conflict', access: async () => undefined, code: 'CONFLICT' },
    { name: 'unavailable output', access: async () => { throw errnoError('EACCES'); }, code: 'RENDER_FAILED' },
  ])('preserves an output $name when cancellation was not requested', async ({ access: checkOutput, code }) => {
    const root = await createRenderRequestRoot(`reelforge-original-${code.toLowerCase()}-`);
    try {
      const operation = renderer.startRender(root.request, {
        fileOperations: { access: checkOutput },
      });
      await expect(operation.completion).rejects.toMatchObject({ payload: { code } });
    } finally {
      await rm(root.root, { recursive: true, force: true });
    }
  });

  it('lets cancellation beat a delayed preflight failure', async () => {
    const root = await createRenderRequestRoot('reelforge-cancel-preflight-error-');
    const preflightBlocked = createDeferred<void>();
    const releasePreflight = createDeferred<void>();
    const outputPath = join(
      root.request.outputDirectory,
      'Project-Name-20260824-070001000-cancel-job.mp4',
    );
    const operation = renderer.startRender(
      { ...root.request, providerReady: false },
      {
        binaryResolver: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
        now: () => new Date('2026-08-24T07:00:01.000Z'),
        processSpawner: successfulMediaProcessSpawner,
        fileOperations: {
          makeDirectory: async (path) => {
            if (path === root.request.outputDirectory) {
              preflightBlocked.resolve(undefined);
              await releasePreflight.promise;
              throw errnoError('EACCES');
            }
            await mkdir(path, { recursive: true });
          },
        },
      },
    );
    let cancelSettled = false;
    let completionSettled = false;
    void operation.completion.then(
      () => { completionSettled = true; },
      () => { completionSettled = true; },
    );

    try {
      await preflightBlocked.promise;
      const cancellation = operation.cancel().then(() => {
        cancelSettled = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      expect(cancelSettled).toBe(false);
      expect(completionSettled).toBe(false);

      releasePreflight.resolve(undefined);
      await cancellation;
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releasePreflight.resolve(undefined);
      await operation.completion.catch(() => undefined);
      await rm(root.root, { recursive: true, force: true });
    }
  });

  it('preserves a preflight error when cancellation was not requested', async () => {
    const root = await createRenderRequestRoot('reelforge-original-preflight-error-');
    try {
      const operation = renderer.startRender(
        { ...root.request, providerReady: false },
        {
          binaryResolver: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
          processSpawner: successfulMediaProcessSpawner,
        },
      );
      await expect(operation.completion).rejects.toMatchObject({
        payload: { code: 'INVALID_INPUT', message: 'Render preflight failed' },
      });
    } finally {
      await rm(root.root, { recursive: true, force: true });
    }
  });
});

describe('render preflight', () => {
  it('reports all safe readiness failures before synthesis or render', async () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.preflightRender).toBe('function');
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-'));
    const dataDirectory = join(root, 'data');
    const outputDirectory = join(root, 'output');
    const tempDirectory = join(root, 'temp');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
    ]);
    const secret = 'do-not-leak-this-api-key';
    const snapshot = createSnapshot('Narrate this card');

    let caught: unknown;
    try {
      await (api.preflightRender as (
        request: Record<string, unknown>,
        dependencies: Record<string, unknown>,
      ) => Promise<unknown>)(
        {
          snapshot,
          dataDirectory,
          outputDirectory,
          tempDirectory,
          providerReady: false,
          minimumFreeBytes: 1024,
        },
        {
          inspectMedia: async (path: string) => {
            if (path.endsWith('card.png')) throw new Error(`invalid ${secret} ${path}`);
          },
          availableDiskBytes: async () => 10,
        },
      );
    } catch (error) {
      caught = error;
    }
    try {
      expect(caught).toMatchObject({
        payload: {
          code: 'INVALID_INPUT',
          message: 'Render preflight failed',
          details: {
            issues: expect.arrayContaining([
              { code: 'PROVIDER_NOT_READY', asset: 'provider' },
              { code: 'MEDIA_INVALID', asset: 'card' },
              { code: 'INSUFFICIENT_DISK_SPACE', asset: 'output' },
            ]),
          },
        },
      });
      expect(JSON.stringify(caught)).not.toContain(secret);
      expect(JSON.stringify(caught)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps blank-card hold bounds in the parsed render snapshot contract', () => {
    const snapshot = createSnapshot('');
    const parsed = RenderJobSnapshotSchema.parse({
      ...snapshot,
      project: {
        ...snapshot.project,
        cards: [{ ...snapshot.project.cards[0], script: '', holdSeconds: 3 }],
      },
    });

    expect(parsed.project.cards[0]?.holdSeconds).toBe(3);
    for (const holdSeconds of [0, 5.01]) {
      expect(() => RenderJobSnapshotSchema.parse({
        ...snapshot,
        project: {
          ...snapshot.project,
          cards: [{ ...snapshot.project.cards[0], script: '', holdSeconds }],
        },
      })).toThrow();
    }
  });

  it('allows an all-blank parsed project without provider readiness or narration media', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-blank-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
    ]);
    const snapshot = RenderJobSnapshotSchema.parse({
      ...createSnapshot(''),
      project: {
        ...createSnapshot('').project,
        cards: [{ ...createSnapshot('').project.cards[0], script: '', holdSeconds: 3 }],
      },
    });
    const inspected: Array<{ path: string; kind: string }> = [];

    try {
      await expect(renderer.preflightRender({
        snapshot,
        dataDirectory,
        outputDirectory: join(root, 'output'),
        tempDirectory: join(root, 'temp'),
        providerReady: false,
        narrationAudioPaths: [undefined],
        minimumFreeBytes: 1,
      }, {
        inspectMedia: async (path, kind) => {
          inspected.push({ path, kind });
        },
        availableDiskBytes: async () => 1024 * 1024,
      })).resolves.toEqual({ assetCount: 2, availableBytes: 1024 * 1024 });
      expect(inspected).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preflights intro transition-sound and optional video-meme sound resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-video-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    const narrationPath = join(root, 'narration.wav');
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
      writeFile(join(dataDirectory, 'assets', 'intro.mp3'), 'intro'),
      writeFile(join(dataDirectory, 'assets', 'meme.mp4'), 'meme'),
      writeFile(narrationPath, 'narration'),
    ]);
    const snapshot = createSnapshot('Narrate this card');
    snapshot.project.introSoundPath = 'assets/intro.mp3';
    snapshot.project.cards[0]!.postCardMeme = { videoPath: 'assets/meme.mp4' };
    const inspected: Array<{ path: string; kind: string }> = [];

    try {
      await expect(renderer.preflightRender({
        snapshot,
        dataDirectory,
        outputDirectory: join(root, 'output'),
        tempDirectory: join(root, 'temp'),
        providerReady: true,
        narrationAudioPaths: [narrationPath],
        minimumFreeBytes: 1,
      }, {
        inspectMedia: async (path, kind) => {
          inspected.push({ path, kind });
        },
        availableDiskBytes: async () => 1024 * 1024,
      })).resolves.toEqual({ assetCount: 5, availableBytes: 1024 * 1024 });
      expect(inspected).toEqual(expect.arrayContaining([
        { path: join(dataDirectory, 'assets', 'intro.mp3'), kind: 'audio' },
        { path: join(dataDirectory, 'assets', 'meme.mp4'), kind: 'video' },
        { path: narrationPath, kind: 'audio' },
      ]));
      expect(inspected.filter(({ path }) => path.endsWith('meme.mp3'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unmanaged intro and video-meme paths with resource-specific issues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-video-path-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
    ]);
    const snapshot = createSnapshot('');
    snapshot.project.introSoundPath = 'outside/intro.mp3';
    snapshot.project.transitionSoundPath = 'outside/transition.mp3';
    snapshot.project.cards[0]!.postCardMeme = { videoPath: 'outside/meme.mp4' };

    try {
      await expect(renderer.preflightRender({
        snapshot,
        dataDirectory,
        outputDirectory: join(root, 'output'),
        tempDirectory: join(root, 'temp'),
        providerReady: false,
        narrationAudioPaths: [undefined],
        minimumFreeBytes: 1,
      }, {
        inspectMedia: async () => undefined,
        availableDiskBytes: async () => 1024 * 1024,
      })).rejects.toMatchObject({
        payload: {
          code: 'INVALID_INPUT',
          details: {
            issues: expect.arrayContaining([
              { code: 'ASSET_PATH_INVALID', asset: 'resource', resourceKind: 'intro-sound' },
              { code: 'ASSET_PATH_INVALID', asset: 'resource', resourceKind: 'transition-sound' },
              { code: 'ASSET_PATH_INVALID', asset: 'resource', cardId: 'card-id', resourceKind: 'meme-video' },
            ]),
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preflights selected resources with their media kinds and redacted identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-resources-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
      writeFile(join(dataDirectory, 'assets', 'transition.mp3'), 'transition'),
      writeFile(join(dataDirectory, 'assets', 'music.mp3'), 'music'),
      writeFile(join(dataDirectory, 'assets', 'meme.png'), 'meme'),
      writeFile(join(dataDirectory, 'assets', 'meme.mp3'), 'meme sound'),
    ]);
    const snapshot = createSnapshot('Narrate this card');
    snapshot.project.transitionSoundPath = 'assets/transition.mp3';
    snapshot.project.backgroundMusicPath = 'assets/music.mp3';
    snapshot.project.cards[0]!.postCardMeme = {
      imagePath: 'assets/meme.png',
      soundPath: 'assets/meme.mp3',
    };
    const inspected: Array<{ path: string; kind: string }> = [];
    const secret = 'probe-detail-must-not-leak';

    try {
      let caught: unknown;
      try {
        await renderer.preflightRender({
          snapshot,
          dataDirectory,
          outputDirectory: join(root, 'output'),
          tempDirectory: join(root, 'temp'),
          providerReady: true,
          minimumFreeBytes: 1,
        }, {
          inspectMedia: async (path, kind) => {
            inspected.push({ path, kind });
            if (path.endsWith('meme.mp3')) throw new Error(secret);
          },
          availableDiskBytes: async () => 1024 * 1024,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        payload: {
          code: 'INVALID_INPUT',
          details: {
            issues: expect.arrayContaining([
              { code: 'MEDIA_INVALID', asset: 'resource', cardId: 'card-id', resourceKind: 'meme-sound' },
            ]),
          },
        },
      });
      expect(inspected).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: join(dataDirectory, 'assets', 'transition.mp3'), kind: 'audio' }),
        expect.objectContaining({ path: join(dataDirectory, 'assets', 'music.mp3'), kind: 'audio' }),
        expect.objectContaining({ path: join(dataDirectory, 'assets', 'meme.png'), kind: 'image' }),
        expect.objectContaining({ path: join(dataDirectory, 'assets', 'meme.mp3'), kind: 'audio' }),
      ]));
      expect(JSON.stringify(caught)).not.toContain(root);
      expect(JSON.stringify(caught)).not.toContain(secret);
      expect(JSON.stringify(caught)).not.toContain('assets/meme.mp3');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a selected resource outside managed assets without probing its raw path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-resource-path-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
    ]);
    const snapshot = createSnapshot('Narrate this card');
    snapshot.project.backgroundMusicPath = 'cache/not-managed.mp3';
    let probeCalls = 0;

    try {
      await expect(renderer.preflightRender({
        snapshot,
        dataDirectory,
        outputDirectory: join(root, 'output'),
        tempDirectory: join(root, 'temp'),
        providerReady: true,
        minimumFreeBytes: 1,
      }, {
        inspectMedia: async () => {
          probeCalls += 1;
        },
        availableDiskBytes: async () => 1024 * 1024,
      })).rejects.toMatchObject({
        payload: {
          code: 'INVALID_INPUT',
          details: {
            issues: expect.arrayContaining([
              { code: 'ASSET_PATH_INVALID', asset: 'resource', resourceKind: 'background-music' },
            ]),
          },
        },
      });
      expect(probeCalls).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a selected audio resource when probing reports zero duration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-resource-zero-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
      writeFile(join(dataDirectory, 'assets', 'transition.mp3'), 'transition'),
    ]);
    const snapshot = createSnapshot('Narrate this card');
    snapshot.project.transitionSoundPath = 'assets/transition.mp3';

    try {
      await expect(renderer.preflightRender({
        snapshot,
        dataDirectory,
        outputDirectory: join(root, 'output'),
        tempDirectory: join(root, 'temp'),
        providerReady: true,
        minimumFreeBytes: 1,
      }, {
        inspectMedia: async (_path, kind) => kind === 'audio'
          ? { durationSeconds: 0, streams: [{ type: 'audio' }] }
          : undefined,
        availableDiskBytes: async () => 1024 * 1024,
      })).rejects.toMatchObject({
        payload: {
          code: 'INVALID_INPUT',
          details: {
            issues: expect.arrayContaining([
              { code: 'MEDIA_INVALID', asset: 'resource', resourceKind: 'transition-sound' },
            ]),
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a zero-card project before any narration can be synthesized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-empty-'));
    const dataDirectory = join(root, 'data');
    const snapshot = createSnapshot('unused');
    snapshot.project.cards.length = 0;
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
    ]);

    try {
      await expect(renderer.preflightRender({
        snapshot,
        dataDirectory,
        outputDirectory: join(root, 'output'),
        tempDirectory: join(root, 'temp'),
        providerReady: true,
        minimumFreeBytes: 1,
      }, {
        inspectMedia: async () => undefined,
        availableDiskBytes: async () => 1024,
      })).rejects.toMatchObject({
        payload: {
          code: 'INVALID_INPUT',
          message: 'Render preflight failed',
          details: { issues: expect.arrayContaining([
            { code: 'NO_CARDS', asset: 'card' },
          ]) },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts complete assets, ready credentials, writable directories, and sufficient disk', async () => {
    const api = renderer as Record<string, unknown>;
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-ok-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
    ]);

    try {
      await expect((api.preflightRender as (
        request: Record<string, unknown>,
        dependencies: Record<string, unknown>,
      ) => Promise<unknown>)(
        {
          snapshot: createSnapshot('Narrate this card'),
          dataDirectory,
          outputDirectory: join(root, 'output'),
          tempDirectory: join(root, 'temp'),
          providerReady: true,
          minimumFreeBytes: 1024,
        },
        {
          inspectMedia: async () => undefined,
          availableDiskBytes: async () => 1024 * 1024,
        },
      )).resolves.toMatchObject({ assetCount: 2, availableBytes: 1024 * 1024 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a location when the write probe can be created but not deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-preflight-delete-'));
    const dataDirectory = join(root, 'data');
    await mkdir(join(dataDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
      writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
    ]);

    try {
      await expect(renderer.preflightRender({
        snapshot: createSnapshot('Narrate this card'),
        dataDirectory,
        outputDirectory: join(root, 'output'),
        tempDirectory: join(root, 'temp'),
        providerReady: true,
        minimumFreeBytes: 1,
      }, {
        inspectMedia: async () => undefined,
        availableDiskBytes: async () => 1024,
        fileOperations: {
          remove: async () => {
            throw new Error('delete denied');
          },
        },
      } as renderer.RenderPreflightDependencies)).rejects.toMatchObject({
        payload: {
          code: 'INVALID_INPUT',
          details: { issues: expect.arrayContaining([
            { code: 'LOCATION_NOT_WRITABLE', asset: 'output' },
            { code: 'LOCATION_NOT_WRITABLE', asset: 'temp' },
          ]) },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('fenced output publication', () => {
  it('passes a validated publication handle to the synchronous guard instead of linking itself', async () => {
    const root = await createRenderRequestRoot('reelforge-publication-guard-');
    const order: string[] = [];
    let prepared: { publish(): void } | undefined;

    try {
      const operation = renderer.startRender(root.request, {
        binaryResolver: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
        processSpawner: validMediaProcessSpawner,
        fileOperations: {
          linkSync: () => { order.push('link'); },
          unlinkSync: () => undefined,
          remove: async () => undefined,
        },
        publicationGuard: (publication: { publish(): void }) => {
          order.push('guard');
          prepared = publication;
          publication.publish();
        },
      } as unknown as renderer.RenderVideoOptions);

      const result = await operation.completion;
      expect(prepared).toBeDefined();
      expect((result as unknown as { publication?: unknown }).publication).toBe(prepared);
      expect(order).toEqual(['guard', 'link']);
    } finally {
      await rm(root.root, { recursive: true, force: true });
    }
  });

  it('does not link when the guarded publication callback rejects', async () => {
    const root = await createRenderRequestRoot('reelforge-publication-reject-');
    const order: string[] = [];

    try {
      const operation = renderer.startRender(root.request, {
        binaryResolver: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
        processSpawner: validMediaProcessSpawner,
        fileOperations: {
          linkSync: () => { order.push('link'); },
          unlinkSync: () => undefined,
          remove: async () => undefined,
        },
        publicationGuard: () => {
          order.push('guard');
          throw new ReelForgeError(createErrorPayload('CONFLICT', 'Worker lease ownership was lost'));
        },
      } as unknown as renderer.RenderVideoOptions);

      await expect(operation.completion).rejects.toMatchObject({
        payload: { code: 'CONFLICT', message: 'Worker lease ownership was lost' },
      });
      expect(order).toEqual(['guard']);
    } finally {
      await rm(root.root, { recursive: true, force: true });
    }
  });
});

describe('atomic publication cleanup', () => {
  it('reports cleanup debt without failing after the final output is linked', async () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.publishRenderedOutput).toBe('function');
    const files = new Set(['partial.mp4']);
    let removeAttempts = 0;

    const result = await (api.publishRenderedOutput as (
      partialPath: string,
      outputPath: string,
      operations: Record<string, unknown>,
    ) => Promise<unknown>)('partial.mp4', 'final.mp4', {
      link: async (partialPath: string, outputPath: string) => {
        if (!files.has(partialPath)) throw new Error('missing partial');
        files.add(outputPath);
      },
      remove: async () => {
        removeAttempts += 1;
        throw new Error('ACL denied partial deletion');
      },
    });

    expect(files.has('final.mp4')).toBe(true);
    expect(result).toEqual({ cleanupPendingPaths: ['partial.mp4'] });
    expect(removeAttempts).toBe(3);
  });
});

function createSnapshot(script: string): RenderJobSnapshot {
  return {
    project: {
      schemaVersion: 2,
      id: 'project-id',
      name: 'Project Name',
      templateId: 'template-id',
      tts: { provider: 'google', voiceId: 'voice-id', speakingRate: 1 },
      output: { width: 720, height: 1280, fps: 30, crf: 20 },
      cards: [{ id: 'card-id', imagePath: 'assets/card.png', script, order: 0 }],
    },
    template: {
      schemaVersion: 2,
      id: 'template-id',
      name: 'Template',
      backgroundPath: 'assets/background.mp4',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    },
  };
}

function createSilentWav(sampleRate: number, durationSeconds: number): Buffer {
  const samples = Math.round(sampleRate * durationSeconds);
  const dataLength = samples * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

async function createRenderRequestRoot(prefix: string): Promise<{
  root: string;
  request: renderer.RenderVideoRequest;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDirectory = join(root, 'data');
  const outputDirectory = join(root, 'output');
  const tempDirectory = join(root, 'temp');
  await mkdir(join(dataDirectory, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(join(dataDirectory, 'assets', 'background.mp4'), 'background'),
    writeFile(join(dataDirectory, 'assets', 'card.png'), 'card'),
    writeFile(join(root, 'narration.wav'), 'narration'),
  ]);
  return {
    root,
    request: {
      jobId: 'cancel-job',
      snapshot: createSnapshot('Narrate this card'),
      dataDirectory,
      outputDirectory,
      tempDirectory,
      providerReady: true,
      narrationAudioPaths: [join(root, 'narration.wav')],
      minimumFreeBytes: 1,
    },
  };
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for process state');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('injected filesystem failure'), { code });
}

function successfulMediaProcessSpawner(
  _binaryPath: string,
  args: readonly string[],
  options: Parameters<renderer.ProcessSpawner>[2],
): ChildProcess {
  const probe = JSON.stringify({
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 16,
        height: 16,
        duration: '1',
        r_frame_rate: '30/1',
      },
      { index: 1, codec_type: 'audio', codec_name: 'aac', duration: '1' },
    ],
    format: { duration: '1' },
  });
  const script = args.includes('-show_streams')
    ? `process.stdout.write(${JSON.stringify(probe)})`
    : '';
  return nodeSpawn(process.execPath, ['-e', script], options);
}

function validMediaProcessSpawner(
  _binaryPath: string,
  args: readonly string[],
  options: Parameters<renderer.ProcessSpawner>[2],
): ChildProcess {
  const probe = JSON.stringify({
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 720,
        height: 1280,
        avg_frame_rate: '30/1',
        duration: '1',
      },
      { index: 1, codec_type: 'audio', codec_name: 'aac', duration: '1' },
    ],
    format: { duration: '1' },
  });
  const script = args.includes('-show_streams')
    ? `process.stdout.write(${JSON.stringify(probe)})`
    : '';
  return nodeSpawn(process.execPath, ['-e', script], options);
}
