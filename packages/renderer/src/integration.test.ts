import { execFile } from 'node:child_process';
import {
  access,
  link as linkFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { RenderJobSnapshot } from '@reelforge/core';
import { describe, expect, it } from 'vitest';

import * as renderer from './index.js';

const execFileAsync = promisify(execFile);

describe('real bundled FFmpeg render', () => {
  it('prepares a speed-adjusted narration through the public renderer entry point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-speed-integration-'));
    const binaries = renderer.resolveBundledBinaries();
    const inputPath = join(root, 'input.wav');
    const outputPath = join(root, 'output.wav');

    try {
      await runFfmpeg(binaries.ffmpegPath, [
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
        '-c:a', 'pcm_s16le', inputPath,
      ]);

      const preparedPath = await renderer.prepareAudioAtSpeed(inputPath, outputPath, 2, {
        binaryResolver: () => binaries,
      });
      const probe = await renderer.probeMedia(preparedPath, { binaryResolver: () => binaries });

      expect(preparedPath).toBe(outputPath);
      expect(renderer.selectAudioDurationSeconds(probe)).toBeCloseTo(1, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('renders narration-only vertical MP4, never overwrites, and preserves older output on failure', async () => {
    const api = renderer as Record<string, unknown>;
    expect(typeof api.renderVideo).toBe('function');
    const root = await mkdtemp(join(tmpdir(), 'reelforge-render-'));
    const dataDirectory = join(root, 'data');
    const assetsDirectory = join(dataDirectory, 'assets');
    const outputDirectory = join(root, 'outputs');
    const tempDirectory = join(root, 'temp');
    await Promise.all([
      mkdir(assetsDirectory, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(tempDirectory, { recursive: true }),
    ]);
    const binaries = renderer.resolveBundledBinaries();
    const backgroundPath = join(assetsDirectory, 'background.mp4');
    const cardOnePath = join(assetsDirectory, 'card-one.png');
    const cardTwoPath = join(assetsDirectory, 'card-two.png');
    const narrationOnePath = join(tempDirectory, 'narration-one.wav');
    const narrationTwoPath = join(tempDirectory, 'narration-two.wav');

    try {
      await runFfmpeg(binaries.ffmpegPath, [
        '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=30:d=3',
        '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', backgroundPath,
      ]);
      await Promise.all([
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=red:s=640x200', '-frames:v', '1', cardOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=blue:s=400x500', '-frames:v', '1', cardTwoPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.1',
          '-c:a', 'pcm_s16le', narrationOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000:duration=0.5',
          '-c:a', 'pcm_s16le', narrationTwoPath,
        ]),
      ]);

      const fixedTime = new Date('2026-08-24T05:00:00.123Z');
      const request = {
        jobId: 'job-42',
        snapshot: fixtureSnapshot(),
        dataDirectory,
        outputDirectory,
        tempDirectory,
        providerReady: true,
        narrationAudioPaths: [narrationOnePath, narrationTwoPath],
        minimumFreeBytes: 1,
      };
      const result = await (api.renderVideo as (
        request: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<{ outputPath: string; probe: renderer.MediaProbe }>)(request, {
        binaryResolver: () => binaries,
        now: () => fixedTime,
      });

      expect(result.outputPath).toMatch(/Fixture-Project-20260824-050000123-job-42\.mp4$/);
      expect(result.probe.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'video', codec: 'h264', width: 720, height: 1280, fps: 30 }),
        expect.objectContaining({ type: 'audio', codec: 'aac' }),
      ]));
      expect(result.probe.durationSeconds).toBeCloseTo(0.6, 1);
      expect(Math.abs(result.probe.durationSeconds - 0.6)).toBeLessThanOrEqual(0.1);

      const firstCardPixelPath = join(tempDirectory, 'first-card.rgb');
      await runFfmpeg(binaries.ffmpegPath, [
        '-i', result.outputPath,
        '-vf', 'select=eq(n\\,1),format=rgb24,crop=1:1:360:646',
        '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', firstCardPixelPath,
      ]);
      const firstCardPixel = await readFile(firstCardPixelPath);
      const [red = 0, green = 0, blue = 0] = firstCardPixel;
      expect(red).toBeGreaterThan(80);
      expect(blue).toBeLessThan(80);
      expect(green).toBeLessThan(30);

      const secondCardPixelPath = join(tempDirectory, 'second-card.rgb');
      await runFfmpeg(binaries.ffmpegPath, [
        '-i', result.outputPath,
        '-vf', 'select=eq(n\\,5),format=rgb24,crop=1:1:360:646',
        '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', secondCardPixelPath,
      ]);
      const secondCardPixel = await readFile(secondCardPixelPath);
      const [secondRed = 0, secondGreen = 0, secondBlue = 0] = secondCardPixel;
      expect(secondBlue).toBeGreaterThan(80);
      expect(secondRed).toBeLessThan(80);
      expect(secondGreen).toBeLessThan(30);

      const firstNarration = await decodeAudioSegment(
        binaries.ffmpegPath,
        result.outputPath,
        join(tempDirectory, 'first-narration.s16le'),
        0.02,
        0.06,
      );
      const secondNarration = await decodeAudioSegment(
        binaries.ffmpegPath,
        result.outputPath,
        join(tempDirectory, 'second-narration.s16le'),
        0.18,
        0.25,
      );
      const firstExpected = toneMagnitude(firstNarration, 8000, 880);
      const firstOther = toneMagnitude(firstNarration, 8000, 1100);
      const firstTemplate = toneMagnitude(firstNarration, 8000, 220);
      const secondExpected = toneMagnitude(secondNarration, 8000, 1100);
      const secondOther = toneMagnitude(secondNarration, 8000, 880);
      const secondTemplate = toneMagnitude(secondNarration, 8000, 220);
      expect(firstExpected).toBeGreaterThan(firstOther * 4);
      expect(secondExpected).toBeGreaterThan(secondOther * 4);
      expect(firstTemplate).toBeLessThan(0.002);
      expect(secondTemplate).toBeLessThan(0.002);

      const originalBytes = await readFile(result.outputPath);
      await expect((api.renderVideo as (
        request: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<unknown>)(request, {
        binaryResolver: () => binaries,
        now: () => fixedTime,
      })).rejects.toMatchObject({ payload: { code: 'CONFLICT' } });
      expect(await readFile(result.outputPath)).toEqual(originalBytes);

      await writeFile(narrationTwoPath, 'corrupt narration');
      await expect((api.renderVideo as (
        request: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<unknown>)({ ...request, jobId: 'failed-job' }, {
        binaryResolver: () => binaries,
        now: () => new Date('2026-08-24T05:00:01.123Z'),
      })).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT', message: 'Render preflight failed' } });
      expect(await readFile(result.outputPath)).toEqual(originalBytes);
      const outputStats = await stat(result.outputPath);
      expect(outputStats.size).toBe(originalBytes.byteLength);
      expect((await readdir(outputDirectory)).filter((name) => name.includes('.partial.mp4'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('renders timed memes, a shared transition, looped ducked music, and muted gameplay audio', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-rich-render-'));
    const dataDirectory = join(root, 'data');
    const assetsDirectory = join(dataDirectory, 'assets');
    const outputDirectory = join(root, 'outputs');
    const tempDirectory = join(root, 'temp');
    await Promise.all([
      mkdir(assetsDirectory, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(tempDirectory, { recursive: true }),
    ]);
    const binaries = renderer.resolveBundledBinaries();
    const backgroundPath = join(assetsDirectory, 'background.mp4');
    const cardOnePath = join(assetsDirectory, 'card-one.png');
    const cardTwoPath = join(assetsDirectory, 'card-two.png');
    const memeOnePath = join(assetsDirectory, 'meme-one.jpg');
    const memeTwoPath = join(assetsDirectory, 'meme-two.png');
    const transitionPath = join(assetsDirectory, 'transition.mp3');
    const musicPath = join(assetsDirectory, 'music.mp3');
    const memeSoundOnePath = join(assetsDirectory, 'meme-one.mp3');
    const memeSoundTwoPath = join(assetsDirectory, 'meme-two.mp3');
    const narrationOnePath = join(tempDirectory, 'narration-one.wav');
    const narrationTwoPath = join(tempDirectory, 'narration-two.wav');

    try {
      await Promise.all([
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=30:d=5',
          '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=5',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', backgroundPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=red:s=640x200', '-frames:v', '1', cardOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=blue:s=400x500', '-frames:v', '1', cardTwoPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=yellow:s=750x1099',
          '-pix_fmt', 'yuvj444p', '-frames:v', '1', memeOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=purple:s=320x240', '-frames:v', '1', memeTwoPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
          '-c:a', 'pcm_s16le', narrationOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000:duration=1.2',
          '-c:a', 'pcm_s16le', narrationTwoPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=1760:sample_rate=48000:duration=0.65',
          '-c:a', 'libmp3lame', '-q:a', '4', memeSoundOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=2200:sample_rate=48000:duration=0.35',
          '-c:a', 'libmp3lame', '-q:a', '4', memeSoundTwoPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.45',
          '-c:a', 'libmp3lame', '-q:a', '4', transitionPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=0.6',
          '-c:a', 'libmp3lame', '-q:a', '4', musicPath,
        ]),
      ]);

      const request: renderer.RenderVideoRequest = {
        jobId: 'rich-job',
        snapshot: {
          project: {
            schemaVersion: 2,
            id: 'rich-project',
            name: 'Rich Project',
            templateId: 'rich-template',
            tts: { provider: 'google', voiceId: 'fixture-voice', speakingRate: 1 },
            output: { width: 720, height: 1280, fps: 30, crf: 20 },
            transitionSoundPath: 'assets/transition.mp3',
            backgroundMusicPath: 'assets/music.mp3',
            cards: [
              {
                id: 'one', imagePath: 'assets/card-one.png', script: 'One', order: 0,
                postCardMeme: {
                  imagePath: 'assets/meme-one.jpg',
                  soundPath: 'assets/meme-one.mp3',
                  layout: { x: 0.05, y: 0.55, width: 0.3, height: 0.2 },
                },
              },
              {
                id: 'two', imagePath: 'assets/card-two.png', script: 'Two', order: 1,
                postCardMeme: {
                  imagePath: 'assets/meme-two.png',
                  soundPath: 'assets/meme-two.mp3',
                  layout: { x: 0.55, y: 0.55, width: 0.35, height: 0.25 },
                },
              },
            ],
          },
          template: {
            schemaVersion: 2,
            id: 'rich-template',
            name: 'Rich Template',
            backgroundPath: 'assets/background.mp4',
            canvas: { width: 720, height: 1280, fps: 30 },
            cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
            memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
          },
        },
        dataDirectory,
        outputDirectory,
        tempDirectory,
        providerReady: true,
        narrationAudioPaths: [narrationOnePath, narrationTwoPath],
        minimumFreeBytes: 1,
      };

      const result = await renderer.renderVideo(request, {
        binaryResolver: () => binaries,
        now: () => new Date('2026-08-24T07:00:00.000Z'),
      });

      expect(result.probe.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'video', codec: 'h264', width: 720, height: 1280, fps: 30 }),
        expect.objectContaining({ type: 'audio', codec: 'aac' }),
      ]));
      expect(result.durationSeconds).toBeCloseTo(3.8, 1);
      expect(Math.abs(result.probe.durationSeconds - 3.8)).toBeLessThanOrEqual(0.1);

      const firstMemePixelPath = join(tempDirectory, 'first-meme.rgb');
      await runFfmpeg(binaries.ffmpegPath, [
        '-ss', '1.35', '-i', result.outputPath,
        '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:100:800',
        '-f', 'rawvideo', firstMemePixelPath,
      ]);
      const firstMemePixel = await readFile(firstMemePixelPath);
      const [firstMemeRed = 0, firstMemeGreen = 0, firstMemeBlue = 0] = firstMemePixel;
      expect(firstMemeRed).toBeGreaterThan(120);
      expect(firstMemeGreen).toBeGreaterThan(120);
      expect(firstMemeBlue).toBeLessThan(100);

      const finalMemePixelPath = join(tempDirectory, 'final-meme.rgb');
      await runFfmpeg(binaries.ffmpegPath, [
        '-ss', '3.6', '-i', result.outputPath,
        '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:450:800',
        '-f', 'rawvideo', finalMemePixelPath,
      ]);
      const finalMemePixel = await readFile(finalMemePixelPath);
      const [finalMemeRed = 0, finalMemeGreen = 0, finalMemeBlue = 0] = finalMemePixel;
      expect(finalMemeRed).toBeGreaterThan(80);
      expect(finalMemeBlue).toBeGreaterThan(80);
      expect(finalMemeGreen).toBeLessThan(100);

      const narrationAudio = await decodeAudioSegment(
        binaries.ffmpegPath,
        result.outputPath,
        join(tempDirectory, 'rich-narration.s16le'),
        0.2,
        0.4,
      );
      expect(toneMagnitude(narrationAudio, 8000, 880)).toBeGreaterThan(
        toneMagnitude(narrationAudio, 8000, 220) * 3,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('renders a video meme with original audio, delayed intro/music, per-card layout, and a held final frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-video-meme-render-'));
    const dataDirectory = join(root, 'data');
    const assetsDirectory = join(dataDirectory, 'assets');
    const outputDirectory = join(root, 'outputs');
    const tempDirectory = join(root, 'temp');
    await Promise.all([
      mkdir(assetsDirectory, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(tempDirectory, { recursive: true }),
    ]);
    const binaries = renderer.resolveBundledBinaries();
    const backgroundPath = join(assetsDirectory, 'background.mp4');
    const cardOnePath = join(assetsDirectory, 'card-one.png');
    const cardTwoPath = join(assetsDirectory, 'card-two.png');
    const memeVideoPath = join(assetsDirectory, 'meme-video.mp4');
    const extraSoundPath = join(assetsDirectory, 'meme-extra.mp3');
    const introPath = join(assetsDirectory, 'intro.mp3');
    const transitionPath = join(assetsDirectory, 'transition.mp3');
    const musicPath = join(assetsDirectory, 'music.mp3');
    const narrationOnePath = join(tempDirectory, 'narration-one.wav');
    const narrationTwoPath = join(tempDirectory, 'narration-two.wav');

    try {
      await Promise.all([
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=30:d=5',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', backgroundPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=red:s=640x200', '-frames:v', '1', cardOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=blue:s=400x500', '-frames:v', '1', cardTwoPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'color=c=orange:s=320x240:r=30:d=0.5',
          '-f', 'lavfi', '-i', 'sine=frequency=1760:sample_rate=48000:duration=0.5',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', memeVideoPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=2200:sample_rate=48000:duration=1.2',
          '-c:a', 'libmp3lame', '-q:a', '4', extraSoundPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
          '-c:a', 'libmp3lame', '-q:a', '4', introPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.25',
          '-c:a', 'libmp3lame', '-q:a', '4', transitionPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=0.6',
          '-c:a', 'libmp3lame', '-q:a', '4', musicPath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.6',
          '-c:a', 'pcm_s16le', narrationOnePath,
        ]),
        runFfmpeg(binaries.ffmpegPath, [
          '-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000:duration=0.5',
          '-c:a', 'pcm_s16le', narrationTwoPath,
        ]),
      ]);

      const request: renderer.RenderVideoRequest = {
        jobId: 'video-meme-job',
        snapshot: {
          project: {
            schemaVersion: 2,
            id: 'video-meme-project',
            name: 'Video Meme Project',
            templateId: 'video-meme-template',
            tts: { provider: 'google', voiceId: 'fixture-voice', speakingRate: 1 },
            output: { width: 720, height: 1280, fps: 30, crf: 20 },
            introSoundPath: 'assets/intro.mp3',
            transitionSoundPath: 'assets/transition.mp3',
            backgroundMusicPath: 'assets/music.mp3',
            cards: [
              {
                id: 'one', imagePath: 'assets/card-one.png', script: 'One', order: 0,
                layout: { x: 0.1, y: 0.1, width: 0.5, height: 0.25 },
                postCardMeme: {
                  videoPath: 'assets/meme-video.mp4',
                  soundPath: 'assets/meme-extra.mp3',
                  layout: { x: 0.55, y: 0.55, width: 0.35, height: 0.25 },
                },
              },
              { id: 'two', imagePath: 'assets/card-two.png', script: 'Two', order: 1 },
            ],
          },
          template: {
            schemaVersion: 2,
            id: 'video-meme-template',
            name: 'Video Meme Template',
            backgroundPath: 'assets/background.mp4',
            canvas: { width: 720, height: 1280, fps: 30 },
            cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
            memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
          },
        },
        dataDirectory,
        outputDirectory,
        tempDirectory,
        providerReady: true,
        narrationAudioPaths: [narrationOnePath, narrationTwoPath],
        minimumFreeBytes: 1,
      };

      const result = await renderer.renderVideo(request, {
        binaryResolver: () => binaries,
        now: () => new Date('2026-08-24T08:00:00.000Z'),
      });

      expect(result.probe.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'video', codec: 'h264', width: 720, height: 1280, fps: 30 }),
        expect.objectContaining({ type: 'audio', codec: 'aac' }),
      ]));
      expect(result.durationSeconds).toBeCloseTo(3.15, 1);
      expect(Math.abs(result.probe.durationSeconds - 3.15)).toBeLessThanOrEqual(0.1);

      const heldFramePath = join(tempDirectory, 'held-meme.rgb');
      await runFfmpeg(binaries.ffmpegPath, [
        '-ss', '2.0', '-i', result.outputPath,
        '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:450:800',
        '-f', 'rawvideo', heldFramePath,
      ]);
      const heldFrame = await readFile(heldFramePath);
      const [red = 0, green = 0, blue = 0] = heldFrame;
      expect(red).toBeGreaterThan(120);
      expect(green).toBeGreaterThan(60);
      expect(blue).toBeLessThan(80);

      const memeAudio = await decodeAudioSegment(
        binaries.ffmpegPath,
        result.outputPath,
        join(tempDirectory, 'video-meme-audio.s16le'),
        1.2,
        0.2,
      );
      expect(toneMagnitude(memeAudio, 8000, 1760)).toBeGreaterThan(
        toneMagnitude(memeAudio, 8000, 330) * 2,
      );
      expect(toneMagnitude(memeAudio, 8000, 2200)).toBeGreaterThan(
        toneMagnitude(memeAudio, 8000, 330) * 2,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('rejects a probetable video with midstream corruption during strict full decode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-corrupt-media-'));
    const cleanPath = join(root, 'clean.ts');
    const corruptPath = join(root, 'corrupt.ts');
    const binaries = renderer.resolveBundledBinaries();

    try {
      await runFfmpeg(binaries.ffmpegPath, [
        '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
        '-c:v', 'mpeg2video', '-f', 'mpegts', cleanPath,
      ]);
      const bytes = await readFile(cleanPath);
      const packetSize = 188;
      const midpoint = Math.floor(bytes.length / 2 / packetSize) * packetSize;
      bytes.fill(0, midpoint, Math.min(bytes.length, midpoint + packetSize * 10));
      await writeFile(corruptPath, bytes);

      await expect(renderer.probeMedia(corruptPath, {
        binaryResolver: () => binaries,
      })).resolves.toMatchObject({ streams: expect.arrayContaining([
        expect.objectContaining({ type: 'video' }),
      ]) });
      await expect(renderer.inspectMediaFully(corruptPath, 'video', {
        binaryResolver: () => binaries,
      })).rejects.toMatchObject({
        payload: { code: 'RENDER_FAILED', message: 'Managed media is invalid' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('prepares a validated partial publication for the worker boundary without linking early', async () => {
    const fixture = await createPublicationFixture('reelforge-prepared-publication-', 'prepared-job');
    const prepared = createDeferred<unknown>();
    const outputPath = join(
      fixture.outputDirectory,
      'Publication-Fixture-20260824-060000000-prepared-job.mp4',
    );
    const operation = renderer.startRender(fixture.request, {
      binaryResolver: () => fixture.binaries,
      now: () => new Date('2026-08-24T06:00:00.000Z'),
      fileOperations: {
        link: async () => {
          throw new Error('renderer linked before worker settlement');
        },
      },
      publicationGuard: (publication) => {
        prepared.resolve(publication);
      },
    });

    try {
      const result = await operation.completion;
      const publication = await prepared.promise as {
        readonly partialPath: string;
        readonly outputPath: string;
        publish(): void;
      };
      expect(result.outputPath).toBe(outputPath);
      expect(publication.outputPath).toBe(outputPath);
      await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });

      publication.publish();
      await expect(access(outputPath)).resolves.toBeUndefined();
    } finally {
      await operation.completion.catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('lets cancellation win immediately before publication and waits for cancelled completion', async () => {
    const fixture = await createPublicationFixture('reelforge-cancel-before-publish-', 'before-job');
    const publicationReady = createDeferred<void>();
    const releasePublication = createDeferred<void>();
    const outputPath = join(
      fixture.outputDirectory,
      'Publication-Fixture-20260824-060000000-before-job.mp4',
    );
    const operation = renderer.startRender(fixture.request, {
      binaryResolver: () => fixture.binaries,
      now: () => new Date('2026-08-24T06:00:00.000Z'),
      beforePublication: async () => {
        publicationReady.resolve(undefined);
        await releasePublication.promise;
      },
    });
    let cancelSettled = false;

    try {
      await withTimeout(publicationReady.promise, 10_000);
      const firstCancellation = operation.cancel();
      expect(operation.cancel()).toBe(firstCancellation);
      const cancellation = firstCancellation.finally(() => {
        cancelSettled = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      expect(cancelSettled).toBe(false);
      releasePublication.resolve(undefined);
      await cancellation;
      await expect(operation.completion).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
      await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releasePublication.resolve(undefined);
      await operation.completion.catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('lets publication win after entry and keeps cancel pending until success settles', async () => {
    const fixture = await createPublicationFixture('reelforge-cancel-after-publish-', 'after-job');
    const publicationEntered = createDeferred<void>();
    const releaseLink = createDeferred<void>();
    const operation = renderer.startRender(fixture.request, {
      binaryResolver: () => fixture.binaries,
      now: () => new Date('2026-08-24T06:00:01.000Z'),
      fileOperations: {
        link: async (partialPath, outputPath) => {
          publicationEntered.resolve(undefined);
          await releaseLink.promise;
          await linkFile(partialPath, outputPath);
        },
      },
    });
    let cancelSettled = false;

    try {
      await withTimeout(publicationEntered.promise, 10_000);
      const firstCancellation = operation.cancel();
      expect(operation.cancel()).toBe(firstCancellation);
      const cancellation = firstCancellation.finally(() => {
        cancelSettled = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      expect(cancelSettled).toBe(false);
      releaseLink.resolve(undefined);
      const result = await operation.completion;
      await cancellation;
      await expect(access(result.outputPath)).resolves.toBeUndefined();
    } finally {
      releaseLink.resolve(undefined);
      await operation.completion.catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);
});

function fixtureSnapshot(): RenderJobSnapshot {
  return {
    project: {
      schemaVersion: 2,
      id: 'fixture-project',
      name: 'Fixture Project',
      templateId: 'fixture-template',
      tts: { provider: 'google', voiceId: 'fixture-voice', speakingRate: 1 },
      output: { width: 720, height: 1280, fps: 30, crf: 20 },
      cards: [
        { id: 'one', imagePath: 'assets/card-one.png', script: 'First', order: 0 },
        { id: 'two', imagePath: 'assets/card-two.png', script: 'Second', order: 1 },
      ],
    },
    template: {
      schemaVersion: 2,
      id: 'fixture-template',
      name: 'Fixture Template',
      backgroundPath: 'assets/background.mp4',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    },
  };
}

async function runFfmpeg(binaryPath: string, args: readonly string[]): Promise<void> {
  await execFileAsync(binaryPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
    windowsHide: true,
  });
}

async function decodeAudioSegment(
  binaryPath: string,
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<number[]> {
  await runFfmpeg(binaryPath, [
    '-i', inputPath, '-map', '0:a:0', '-ss', String(startSeconds), '-t', String(durationSeconds),
    '-ac', '1', '-ar', '8000', '-f', 's16le', outputPath,
  ]);
  return pcm16Samples(await readFile(outputPath));
}

function pcm16Samples(bytes: Buffer): number[] {
  const samples: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    samples.push(bytes.readInt16LE(index) / 32768);
  }
  return samples;
}

function toneMagnitude(samples: readonly number[], sampleRate: number, frequency: number): number {
  let real = 0;
  let imaginary = 0;
  samples.forEach((sample, index) => {
    const phase = (2 * Math.PI * frequency * index) / sampleRate;
    real += sample * Math.cos(phase);
    imaginary -= sample * Math.sin(phase);
  });
  return Math.hypot(real, imaginary) / samples.length;
}

async function createPublicationFixture(prefix: string, jobId: string): Promise<{
  root: string;
  outputDirectory: string;
  binaries: renderer.FfmpegBinaries;
  request: renderer.RenderVideoRequest;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDirectory = join(root, 'data');
  const assetsDirectory = join(dataDirectory, 'assets');
  const outputDirectory = join(root, 'outputs');
  const tempDirectory = join(root, 'temp');
  await Promise.all([
    mkdir(assetsDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(tempDirectory, { recursive: true }),
  ]);
  const binaries = renderer.resolveBundledBinaries();
  const backgroundPath = join(assetsDirectory, 'background.mp4');
  const cardPath = join(assetsDirectory, 'card.png');
  const narrationPath = join(tempDirectory, 'narration.wav');
  await Promise.all([
    runFfmpeg(binaries.ffmpegPath, [
      '-f', 'lavfi', '-i', 'color=c=green:s=160x120:r=30:d=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', backgroundPath,
    ]),
    runFfmpeg(binaries.ffmpegPath, [
      '-f', 'lavfi', '-i', 'color=c=red:s=320x160', '-frames:v', '1', cardPath,
    ]),
    runFfmpeg(binaries.ffmpegPath, [
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.2',
      '-c:a', 'pcm_s16le', narrationPath,
    ]),
  ]);
  const snapshot: RenderJobSnapshot = {
    project: {
      schemaVersion: 2,
      id: 'publication-fixture',
      name: 'Publication Fixture',
      templateId: 'publication-template',
      tts: { provider: 'google', voiceId: 'fixture-voice', speakingRate: 1 },
      output: { width: 720, height: 1280, fps: 30, crf: 20 },
      cards: [{ id: 'one', imagePath: 'assets/card.png', script: 'One', order: 0 }],
    },
    template: {
      schemaVersion: 2,
      id: 'publication-template',
      name: 'Publication Template',
      backgroundPath: 'assets/background.mp4',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    },
  };
  return {
    root,
    outputDirectory,
    binaries,
    request: {
      jobId,
      snapshot,
      dataDirectory,
      outputDirectory,
      tempDirectory,
      providerReady: true,
      narrationAudioPaths: [narrationPath],
      minimumFreeBytes: 1,
    },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for lifecycle phase')), timeoutMs);
      timeout.unref();
    }),
  ]);
}
