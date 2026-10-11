import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { linkSync as linkFileSync, unlinkSync as unlinkFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { access, link, mkdir, open, rm, statfs } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  DEFAULT_CARD_SLOT,
  DEFAULT_MEME_SLOT,
  DEFAULT_OUTPUT,
  ReelForgeError,
  createErrorPayload,
  safeFilename,
  type NormalizedRect,
  type RenderJobSnapshot,
} from '@reelforge/core';
import { createEditTimeline, type EditCardSegment, type TimeRange } from './edit-timeline.js';

export * from './audio-speed.js';
export * from './edit-timeline.js';

export const DEFAULT_CROSSFADE_SECONDS = 0.2;

export interface NarrationClipDuration {
  readonly cardId: string;
  readonly durationSeconds: number;
}

export interface NarrationSegment extends NarrationClipDuration {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
}

export interface NarrationTimeline {
  readonly durationSeconds: number;
  readonly segments: readonly NarrationSegment[];
}

export interface VisualCardWindow {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly fadeInEndSeconds: number;
  readonly fadeOutStartSeconds: number;
}

export function clampCrossfadeSeconds(
  leftDurationSeconds: number,
  rightDurationSeconds: number,
  targetSeconds = DEFAULT_CROSSFADE_SECONDS,
): number {
  return Math.min(targetSeconds, leftDurationSeconds / 2, rightDurationSeconds / 2);
}

export function createNarrationTimeline(
  clips: readonly NarrationClipDuration[],
): NarrationTimeline {
  if (clips.some((clip) => !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0)) {
    throw new ReelForgeError(
      createErrorPayload('INVALID_INPUT', 'Narration duration must be a positive finite number'),
    );
  }
  const boundaries = clips.slice(0, -1).map((clip, index) =>
    clampCrossfadeSeconds(clip.durationSeconds, clips[index + 1]!.durationSeconds),
  );
  let cursor = 0;
  const segments = clips.map((clip, index): NarrationSegment => {
    const startSeconds = cursor;
    const endSeconds = startSeconds + clip.durationSeconds;
    cursor = endSeconds;
    return {
      ...clip,
      startSeconds,
      endSeconds,
      fadeInSeconds: boundaries[index - 1] ?? 0,
      fadeOutSeconds: boundaries[index] ?? 0,
    };
  });

  return { durationSeconds: cursor, segments };
}

export function createVisualCardWindows(timeline: NarrationTimeline): VisualCardWindow[] {
  return timeline.segments.map((segment) => {
    const startSeconds = cleanNumber(Math.max(0, segment.startSeconds - segment.fadeInSeconds / 2));
    const endSeconds = cleanNumber(
      Math.min(timeline.durationSeconds, segment.endSeconds + segment.fadeOutSeconds / 2),
    );
    return {
      startSeconds,
      endSeconds,
      fadeInEndSeconds: cleanNumber(startSeconds + segment.fadeInSeconds),
      fadeOutStartSeconds: cleanNumber(endSeconds - segment.fadeOutSeconds),
    };
  });
}

export function visualCardOpacityAt(window: VisualCardWindow, timeSeconds: number): number {
  if (timeSeconds < window.startSeconds || timeSeconds > window.endSeconds) return 0;
  if (window.fadeInEndSeconds > window.startSeconds && timeSeconds < window.fadeInEndSeconds) {
    return (timeSeconds - window.startSeconds) / (window.fadeInEndSeconds - window.startSeconds);
  }
  if (window.endSeconds > window.fadeOutStartSeconds && timeSeconds > window.fadeOutStartSeconds) {
    return (window.endSeconds - timeSeconds) / (window.endSeconds - window.fadeOutStartSeconds);
  }
  return 1;
}

export interface MediaProbeStream {
  readonly index: number;
  readonly type: 'video' | 'audio' | 'other';
  readonly codec: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly durationSeconds?: number;
  readonly durationTimestamp?: number;
  readonly timeBase?: number;
  readonly attachedPicture?: boolean;
  readonly defaultStream?: boolean;
}

export interface MediaProbe {
  readonly durationSeconds: number;
  readonly formatName?: string;
  readonly streams: readonly MediaProbeStream[];
}

export function parseFfprobeJson(source: string): MediaProbe {
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value) || !Array.isArray(value.streams) || value.streams.length === 0) {
      throw new Error('invalid probe result');
    }
    const format = isRecord(value.format) ? value.format : undefined;
    const streams = value.streams.map(parseProbeStream);
    const formatDuration = positiveNumber(format?.duration);
    const streamDuration = Math.max(
      0,
      ...streams.map((stream) => stream.durationSeconds ?? 0),
    );
    const durationSeconds = formatDuration ?? streamDuration;
    return {
      durationSeconds,
      ...(typeof format?.format_name === 'string' ? { formatName: format.format_name } : {}),
      streams,
    };
  } catch {
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Media inspection failed'));
  }
}

function parseProbeStream(value: unknown): MediaProbeStream {
  if (!isRecord(value) || !Number.isInteger(value.index)) {
    throw new Error('invalid stream');
  }
  const type = value.codec_type === 'video'
    ? 'video'
    : value.codec_type === 'audio'
      ? 'audio'
      : 'other';
  const disposition = isRecord(value.disposition) ? value.disposition : undefined;
  return {
    index: value.index as number,
    type,
    codec: typeof value.codec_name === 'string' ? value.codec_name : 'unknown',
    ...(positiveNumber(value.width) ? { width: positiveNumber(value.width) } : {}),
    ...(positiveNumber(value.height) ? { height: positiveNumber(value.height) } : {}),
    ...(rationalNumber(value.avg_frame_rate) ? { fps: rationalNumber(value.avg_frame_rate) } : {}),
    ...(positiveNumber(value.sample_rate) ? { sampleRate: positiveNumber(value.sample_rate) } : {}),
    ...(positiveNumber(value.channels) ? { channels: positiveNumber(value.channels) } : {}),
    ...(positiveNumber(value.duration) ? { durationSeconds: positiveNumber(value.duration) } : {}),
    ...(positiveNumber(value.duration_ts) ? { durationTimestamp: positiveNumber(value.duration_ts) } : {}),
    ...(rationalNumber(value.time_base) ? { timeBase: rationalNumber(value.time_base) } : {}),
    ...(disposition?.attached_pic === 1 ? { attachedPicture: true } : {}),
    ...(disposition?.default === 1 ? { defaultStream: true } : {}),
  };
}

export function selectAudioDurationSeconds(probe: MediaProbe): number {
  const audioStreams = probe.streams
    .filter((stream) => stream.type === 'audio')
    .sort((left, right) => Number(right.defaultStream ?? false) - Number(left.defaultStream ?? false));
  for (const stream of audioStreams) {
    if (stream.durationSeconds !== undefined && stream.durationSeconds > 0) {
      return stream.durationSeconds;
    }
    if (
      stream.durationTimestamp !== undefined
      && stream.timeBase !== undefined
      && stream.durationTimestamp > 0
      && stream.timeBase > 0
    ) {
      const durationSeconds = stream.durationTimestamp * stream.timeBase;
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) return durationSeconds;
    }
  }
  const hasOnlyAttachedPicturesBesidesAudio = probe.streams.every(
    (stream) => stream.type === 'audio' || stream.attachedPicture === true,
  );
  if (audioStreams.length === 1 && hasOnlyAttachedPicturesBesidesAudio && probe.durationSeconds > 0) {
    return probe.durationSeconds;
  }
  throw new ReelForgeError(
    createErrorPayload('RENDER_FAILED', 'Narration audio duration is unavailable'),
  );
}

function selectVideoDurationSeconds(probe: MediaProbe): number {
  const videoStreams = probe.streams
    .filter((stream) => stream.type === 'video')
    .sort((left, right) => Number(right.defaultStream ?? false) - Number(left.defaultStream ?? false));
  for (const stream of videoStreams) {
    if (stream.durationSeconds !== undefined && stream.durationSeconds > 0) {
      return stream.durationSeconds;
    }
    if (
      stream.durationTimestamp !== undefined
      && stream.timeBase !== undefined
      && stream.durationTimestamp > 0
      && stream.timeBase > 0
    ) {
      const durationSeconds = stream.durationTimestamp * stream.timeBase;
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) return durationSeconds;
    }
  }
  if (probe.durationSeconds > 0) return probe.durationSeconds;
  throw new ReelForgeError(
    createErrorPayload('RENDER_FAILED', 'Video duration is unavailable'),
  );
}

export interface RenderCardInput {
  readonly imagePath: string;
  readonly audioPath?: string;
  readonly layout?: NormalizedRect;
  readonly segment: EditCardSegment;
  readonly meme?: RenderMemeInput;
}

export type RenderMemeInput = RenderImageMemeInput | RenderVideoMemeInput;

export interface RenderImageMemeInput {
  readonly imagePath: string;
  readonly soundPath: string;
  readonly layout?: NormalizedRect;
  readonly range: TimeRange;
}

export interface RenderVideoMemeInput {
  readonly videoPath: string;
  readonly soundPath?: string;
  readonly videoDurationSeconds: number;
  readonly hasAudio: boolean;
  readonly layout?: NormalizedRect;
  readonly range: TimeRange;
}

export interface FfmpegCommandRequest {
  readonly backgroundPath: string;
  readonly cards: readonly RenderCardInput[];
  readonly introSoundPath?: string;
  readonly transitionSoundPath?: string;
  readonly backgroundMusicPath?: string;
  readonly cardSlot?: NormalizedRect;
  readonly memeSlot?: NormalizedRect;
  readonly outputPath: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly crf?: number;
}

export interface FfmpegCommand {
  readonly args: readonly string[];
  readonly filterGraph: string;
}

export function buildFfmpegCommand(request: FfmpegCommandRequest): FfmpegCommand {
  if (request.cards.length === 0) {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'At least one card is required'));
  }
  const width = request.width ?? DEFAULT_OUTPUT.width;
  const height = request.height ?? DEFAULT_OUTPUT.height;
  const fps = request.fps ?? DEFAULT_OUTPUT.fps;
  const crf = request.crf ?? DEFAULT_OUTPUT.crf;
  const totalDuration = request.cards.at(-1)!.segment.visible.endSeconds;
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Timeline duration must be positive'));
  }
  const cardSlot = request.cardSlot ?? DEFAULT_CARD_SLOT;
  const memeCards = request.cards.filter((card) => card.meme !== undefined);
  for (const card of request.cards) {
    if (card.meme !== undefined && card.segment.meme === undefined) {
      throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Meme input has no timeline range'));
    }
    if (card.meme === undefined && card.segment.meme !== undefined) {
      throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Timeline meme has no visual and audio input'));
    }
    if (card.meme !== undefined && 'videoPath' in card.meme) {
      if (!Number.isFinite(card.meme.videoDurationSeconds) || card.meme.videoDurationSeconds <= 0) {
        throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Video meme duration must be positive'));
      }
    }
  }
  const transitionCards = request.cards
    .slice(1)
    .filter((card) => card.segment.transition !== undefined);
  if (transitionCards.length > 0 && request.transitionSoundPath === undefined) {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Timeline transition has no sound'));
  }
  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-stream_loop', '-1', '-i', request.backgroundPath];
  for (const card of request.cards) {
    args.push('-loop', '1', '-framerate', String(fps), '-i', card.imagePath);
  }
  let nextInputIndex = 1 + request.cards.length;
  const memeInputIndexes = new Map<RenderCardInput, number>();
  for (const card of memeCards) {
    const inputIndex = nextInputIndex;
    nextInputIndex += 1;
    memeInputIndexes.set(card, inputIndex);
    const meme = card.meme!;
    if ('imagePath' in meme) {
      args.push('-loop', '1', '-framerate', String(fps), '-i', meme.imagePath);
    } else {
      args.push('-i', meme.videoPath);
    }
  }
  const narrationInputIndexes = new Map<RenderCardInput, number>();
  for (const card of request.cards) {
    if (card.audioPath === undefined || card.segment.narration === undefined) continue;
    const inputIndex = nextInputIndex;
    nextInputIndex += 1;
    narrationInputIndexes.set(card, inputIndex);
    args.push('-i', card.audioPath);
  }
  const memeSoundInputIndexes = new Map<RenderCardInput, number>();
  for (const card of memeCards) {
    const soundPath = card.meme!.soundPath;
    if (soundPath === undefined) continue;
    const inputIndex = nextInputIndex;
    nextInputIndex += 1;
    memeSoundInputIndexes.set(card, inputIndex);
    args.push('-i', soundPath);
  }
  const transitionInputIndex = request.transitionSoundPath === undefined || transitionCards.length === 0
    ? undefined
    : nextInputIndex++;
  if (transitionInputIndex !== undefined) args.push('-i', request.transitionSoundPath!);
  const introInputIndex = request.introSoundPath === undefined
    ? undefined
    : nextInputIndex++;
  if (introInputIndex !== undefined) args.push('-i', request.introSoundPath!);
  const musicInputIndex = request.backgroundMusicPath === undefined
    ? undefined
    : nextInputIndex++;
  if (musicInputIndex !== undefined) {
    args.push('-stream_loop', '-1', '-i', request.backgroundMusicPath!);
  }

  const filters: string[] = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},trim=duration=${decimal(totalDuration)},setpts=PTS-STARTPTS[bg]`,
  ];
  const cardCrossfades = request.cards.slice(0, -1).map((card, index) =>
    clampCrossfadeSeconds(
      rangeDuration(card.segment.visible),
      rangeDuration(request.cards[index + 1]!.segment.visible),
    ),
  );
  request.cards.forEach((card, index) => {
    const range = card.segment.visible;
    const outputCrossfade = cardCrossfades[index] ?? 0;
    const cardRect = pixelRect(card.layout ?? cardSlot, width, height);
    const cardContentLabel = `cardContent${index}`;
    const cardCanvasLabel = `cardCanvas${index}`;
    const chain = [
      'format=rgba',
      `scale=${cardRect.width}:${cardRect.height}:force_original_aspect_ratio=decrease`,
      `pad=${cardRect.width}:${cardRect.height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      'setpts=PTS-STARTPTS',
    ];
    filters.push(`[${index + 1}:v]${chain.join(',')}[${cardContentLabel}]`);
    filters.push(
      `color=c=black@0.0:s=${width}x${height}:r=${fps}:d=${decimal(rangeDuration(range) + outputCrossfade)},format=rgba[${cardCanvasLabel}]`,
    );
    filters.push(
      `[${cardCanvasLabel}][${cardContentLabel}]overlay=x=${cardRect.x}:y=${cardRect.y}:eof_action=pass:shortest=1[cardImage${index}]`,
    );
  });
  let cardLayerLabel = 'cardImage0';
  for (let index = 1; index < request.cards.length; index += 1) {
    const nextCard = request.cards[index]!;
    const nextLabel = `cards${index}`;
    filters.push(
      `[${cardLayerLabel}][cardImage${index}]xfade=transition=fade:duration=${decimal(cardCrossfades[index - 1]!)}:offset=${decimal(nextCard.segment.visible.startSeconds)}[${nextLabel}]`,
    );
    cardLayerLabel = nextLabel;
  }
  filters.push(
    `[bg][${cardLayerLabel}]overlay=x=0:y=0:eof_action=pass:shortest=0[cardLayer]`,
  );
  let videoLayerLabel = 'cardLayer';
  for (const [index, card] of request.cards.entries()) {
    if (card.meme === undefined) continue;
    const range = card.meme.range;
    const inputIndex = memeInputIndexes.get(card);
    if (inputIndex === undefined) throw new Error('Meme visual input is unavailable');
    const meme = card.meme;
    const memeRect = pixelRect(meme.layout ?? request.memeSlot ?? DEFAULT_MEME_SLOT, width, height);
    const chain = [
      'format=rgba',
      `scale=${memeRect.width}:${memeRect.height}:force_original_aspect_ratio=decrease`,
      `pad=${memeRect.width}:${memeRect.height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      `trim=duration=${decimal('imagePath' in meme ? rangeDuration(range) : meme.videoDurationSeconds)}`,
    ];
    if ('videoPath' in meme) {
      const freezeSeconds = Math.max(0, rangeDuration(range) - meme.videoDurationSeconds);
      if (freezeSeconds > 0.000001) {
        chain.push(`tpad=stop_mode=clone:stop_duration=${decimal(freezeSeconds)}`);
      }
    }
    chain.push(`setpts=PTS-STARTPTS+${decimal(range.startSeconds)}/TB`);
    filters.push(`[${inputIndex}:v]${chain.join(',')}[memeImage${index}]`);
    const nextVideoLayer = `memeLayer${index}`;
    filters.push(
      `[${videoLayerLabel}][memeImage${index}]overlay=x=${memeRect.x}:y=${memeRect.y}:eof_action=pass:shortest=0:enable='between(t,${decimal(range.startSeconds)},${decimal(range.endSeconds)})'[${nextVideoLayer}]`,
    );
    videoLayerLabel = nextVideoLayer;
  }
  filters.push(`[${videoLayerLabel}]null[vout]`);

  const foregroundAudioLabels: string[] = [];
  const musicStartSeconds = request.cards[0]!.segment.content.startSeconds;
  if (introInputIndex !== undefined) {
    if (!Number.isFinite(musicStartSeconds) || musicStartSeconds <= 0) {
      throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Intro sound has no timeline range'));
    }
    filters.push(
      `[${introInputIndex}:a]${delayedAudioChain(musicStartSeconds, 0)}[introAudio]`,
    );
    foregroundAudioLabels.push('[introAudio]');
  }
  request.cards.forEach((card, index) => {
    const range = card.segment.narration;
    const inputIndex = narrationInputIndexes.get(card);
    if (range === undefined || inputIndex === undefined) return;
    const delay = delayMilliseconds(range.startSeconds);
    filters.push(
      `[${inputIndex}:a]${delayedAudioChain(rangeDuration(range), delay)}[narration${index}]`,
    );
    foregroundAudioLabels.push(`[narration${index}]`);
  });
  for (const [index, card] of request.cards.entries()) {
    if (card.meme === undefined) continue;
    const range = card.meme.range;
    const delay = delayMilliseconds(range.startSeconds);
    if ('videoPath' in card.meme && card.meme.hasAudio) {
      const inputIndex = memeInputIndexes.get(card);
      if (inputIndex === undefined) throw new Error('Meme video input is unavailable');
      filters.push(
        `[${inputIndex}:a]${delayedAudioChain(rangeDuration(range), delay)}[videoAudio${index}]`,
      );
      foregroundAudioLabels.push(`[videoAudio${index}]`);
    }
    const soundInputIndex = memeSoundInputIndexes.get(card);
    if (soundInputIndex === undefined) continue;
    filters.push(
      `[${soundInputIndex}:a]${delayedAudioChain(rangeDuration(range), delay)}[memeAudio${index}]`,
    );
    foregroundAudioLabels.push(`[memeAudio${index}]`);
  }
  if (transitionInputIndex !== undefined) {
    const transitionLabels = transitionCards.map((_card, index) => `[transitionRaw${index}]`).join('');
    filters.push(
      `[${transitionInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=${transitionCards.length}${transitionLabels}`,
    );
    transitionCards.forEach((card, index) => {
      const range = card.segment.transition!;
      const delay = delayMilliseconds(range.startSeconds);
      filters.push(
        `[transitionRaw${index}]${delayedAudioChain(rangeDuration(range), delay)}[transitionAudio${index + 1}]`,
      );
      foregroundAudioLabels.push(`[transitionAudio${index + 1}]`);
    });
  }
  const foregroundMix = foregroundAudioLabels.length === 0
    ? `anullsrc=r=48000:cl=stereo,atrim=duration=${decimal(totalDuration)},asetpts=PTS-STARTPTS,loudnorm=I=-16:LRA=11:TP=-1.5`
    : `${foregroundAudioLabels.join('')}amix=inputs=${foregroundAudioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${decimal(totalDuration)},asetpts=PTS-STARTPTS,loudnorm=I=-16:LRA=11:TP=-1.5`;
  filters.push(
    `${foregroundMix}${musicInputIndex === undefined ? '[foreground]' : ',asplit=2[foregroundSide][foregroundMix]'}`,
  );
  if (musicInputIndex === undefined) {
    filters.push('[foreground]alimiter=limit=0.95[aout]');
  } else {
    const musicDuration = Math.max(0, totalDuration - musicStartSeconds);
    const musicDelay = delayMilliseconds(musicStartSeconds);
    filters.push(
      `[${musicInputIndex}:a]atrim=duration=${decimal(musicDuration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${musicDelay}|${musicDelay},atrim=duration=${decimal(totalDuration)},volume=0.18[musicBase]`,
    );
    filters.push(
      '[musicBase][foregroundSide]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=250[musicDucked]',
    );
    filters.push(
      `[musicDucked][foregroundMix]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${decimal(totalDuration)},alimiter=limit=0.95[aout]`,
    );
  }
  const filterGraph = filters.join(';');
  args.push(
    '-filter_complex', filterGraph,
    '-map', '[vout]', '-map', '[aout]',
    '-t', decimal(totalDuration),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    '-progress', 'pipe:2', '-nostats', request.outputPath,
  );
  return { args, filterGraph };
}

export interface ProgressParser {
  push(chunk: string): void;
  finish(): void;
  complete(): void;
}

export function createProgressParser(
  durationSeconds: number,
  listener: (percent: number) => void,
  onError: (error: unknown) => void = () => undefined,
): ProgressParser {
  let pending = '';
  let lastPercent = -1;
  let failed = false;
  const emit = (percent: number): void => {
    if (failed) return;
    const normalized = Math.min(100, Math.max(0, Math.round(percent)));
    if (normalized <= lastPercent) return;
    lastPercent = normalized;
    try {
      listener(normalized);
    } catch (error) {
      failed = true;
      onError(error);
    }
  };
  const accept = (line: string): void => {
    const separator = line.indexOf('=');
    if (separator < 0) return;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    let elapsed: number | undefined;
    if (key === 'out_time_us' || key === 'out_time_ms') {
      const microseconds = Number(value);
      if (Number.isFinite(microseconds)) elapsed = microseconds / 1_000_000;
    } else if (key === 'out_time') {
      elapsed = parseTimestamp(value);
    } else if (key === 'progress' && value === 'end') {
      emit(100);
    }
    if (elapsed !== undefined) {
      emit((elapsed / durationSeconds) * 100);
    }
  };
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      lines.forEach(accept);
    },
    finish() {
      if (pending) accept(pending);
      pending = '';
    },
    complete() {
      emit(100);
    },
  };
}

export interface FfmpegBinaries {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
}

export type BinaryResolver = () => FfmpegBinaries;

export function resolveBundledBinaries(): FfmpegBinaries {
  const require = createRequire(import.meta.url);
  const ffmpegPath: unknown = require('ffmpeg-static');
  const ffprobe: unknown = require('ffprobe-static');
  const ffprobePath = isRecord(ffprobe) ? ffprobe.path : undefined;
  if (typeof ffmpegPath !== 'string' || typeof ffprobePath !== 'string') {
    throw new ReelForgeError(
      createErrorPayload('RENDER_FAILED', 'Bundled media tools are unavailable'),
    );
  }
  return { ffmpegPath, ffprobePath };
}

export interface MediaToolOptions {
  readonly binaryResolver?: BinaryResolver;
  readonly processRegistry?: RenderProcessRegistry;
  readonly processSpawner?: ProcessSpawner;
  readonly terminateProcessTree?: ProcessTreeTerminator;
}

export async function probeMedia(
  path: string,
  options: MediaToolOptions = {},
): Promise<MediaProbe> {
  try {
    const binaries = (options.binaryResolver ?? resolveBundledBinaries)();
    const result = await runProcessCollect(binaries.ffprobePath, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
    ], options);
    return parseFfprobeJson(result.stdout);
  } catch (error) {
    if (error instanceof ReelForgeError) throw error;
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Media inspection failed'));
  }
}

export async function inspectMediaFully(
  path: string,
  expectedKind: ManagedMediaKind,
  options: MediaToolOptions = {},
): Promise<MediaProbe> {
  try {
    const binaries = (options.binaryResolver ?? resolveBundledBinaries)();
    const probe = await probeMedia(path, { ...options, binaryResolver: () => binaries });
    const expectedType = expectedKind === 'image' ? 'video' : expectedKind;
    if (!probe.streams.some((stream) => stream.type === expectedType)) {
      throw new Error('expected media stream missing');
    }
    const map = expectedType === 'video' ? '0:v:0' : '0:a:0';
    await runProcessCollect(binaries.ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror',
      '-i', path, '-map', map, '-f', 'null', '-',
    ], options);
    return probe;
  } catch (error) {
    if (isCancelledError(error)) throw error;
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Managed media is invalid'));
  }
}

export type ProcessSpawner = (
  binaryPath: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ProcessTreeTerminator = (child: ChildProcess) => Promise<boolean>;

interface OwnedSubprocess {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  cancel(): Promise<void>;
}

export class RenderProcessRegistry {
  private readonly processes = new Set<OwnedSubprocess>();
  private cancellationRequested = false;
  private cancellationPromise: Promise<void> | undefined;

  own(process: OwnedSubprocess): void {
    this.processes.add(process);
    void process.closed.finally(() => this.processes.delete(process));
    if (this.cancellationRequested) void process.cancel();
  }

  isCancelled(): boolean {
    return this.cancellationRequested;
  }

  throwIfCancelled(): void {
    throwIfCancelled(this.cancellationRequested);
  }

  cancel(): Promise<void> {
    if (!this.cancellationPromise) {
      this.cancellationRequested = true;
      this.cancellationPromise = Promise.all(
        [...this.processes].map((process) => process.cancel()),
      ).then(() => undefined);
    }
    return this.cancellationPromise;
  }
}

export interface OwnedFfmpegProcessRequest {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly durationSeconds: number;
  readonly onProgress?: (percent: number) => void;
  readonly processRegistry?: RenderProcessRegistry;
  readonly processSpawner?: ProcessSpawner;
  readonly terminateProcessTree?: ProcessTreeTerminator;
}

export interface OwnedFfmpegProcess {
  readonly pid: number;
  readonly completion: Promise<void>;
  cancel(): Promise<void>;
}

export function startOwnedFfmpegProcess(request: OwnedFfmpegProcessRequest): OwnedFfmpegProcess {
  request.processRegistry?.throwIfCancelled();
  const child = (request.processSpawner ?? defaultProcessSpawner)(request.binaryPath, request.args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let cancelled = false;
  let progressError: unknown;
  let cancellationPromise: Promise<void> | undefined;
  let requestCancellation: (() => Promise<void>) | undefined;
  const progress = createProgressParser(
    request.durationSeconds,
    request.onProgress ?? (() => undefined),
    (error) => {
      progressError = error;
      cancelled = true;
      void requestCancellation?.().catch(() => undefined);
    },
  );
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => progress.push(chunk));
  const closed = childClosure(child);
  const cancel = (): Promise<void> => {
    if (!cancellationPromise) {
      cancelled = true;
      cancellationPromise = child.exitCode !== null || child.signalCode !== null
        ? closed
        : terminateAndAwaitChild(child, closed, request.terminateProcessTree);
    }
    return cancellationPromise;
  };
  requestCancellation = cancel;
  request.processRegistry?.own({ child, closed, cancel });
  const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
    child.once('error', () => {
      rejectCompletion(new ReelForgeError(createErrorPayload('RENDER_FAILED', 'FFmpeg could not be started')));
    });
    child.once('close', (code) => {
      progress.finish();
      if (progressError !== undefined) {
        rejectCompletion(controlledProgressError(progressError));
      } else if (cancelled) {
        rejectCompletion(new ReelForgeError(createErrorPayload('CANCELLED', 'Render was cancelled')));
      } else if (code === 0) {
        progress.complete();
        resolveCompletion();
      } else {
        rejectCompletion(new ReelForgeError(createErrorPayload('RENDER_FAILED', 'FFmpeg render failed')));
      }
    });
  });
  void completion.catch(() => undefined);
  return {
    pid: child.pid ?? -1,
    completion,
    cancel,
  };
}

export type ManagedMediaKind = 'video' | 'image' | 'audio';

type SelectedResourceKind = 'meme-image' | 'meme-video' | 'meme-sound' | 'intro-sound' | 'transition-sound' | 'background-music';

export interface RenderPreflightRequest {
  readonly snapshot: RenderJobSnapshot;
  readonly dataDirectory: string;
  readonly outputDirectory: string;
  readonly tempDirectory: string;
  readonly providerReady: boolean;
  readonly narrationAudioPaths?: readonly (string | undefined)[];
  readonly minimumFreeBytes?: number;
  readonly signal?: AbortSignal;
}

export interface RenderPreflightDependencies {
  readonly inspectMedia?: (path: string, expectedKind: ManagedMediaKind, signal?: AbortSignal) => Promise<unknown>;
  readonly availableDiskBytes?: (path: string) => Promise<number>;
  readonly fileOperations?: Partial<RenderFileOperations>;
  readonly binaryResolver?: BinaryResolver;
  readonly processSpawner?: ProcessSpawner;
  readonly terminateProcessTree?: ProcessTreeTerminator;
}

export interface RenderFileOperations {
  access(path: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  linkSync(existingPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  makeDirectory(path: string): Promise<void>;
  createExclusive(path: string): Promise<{ close(): Promise<void> }>;
  remove(path: string): Promise<void>;
}

export interface PreflightIssue {
  readonly code:
    | 'PROVIDER_NOT_READY'
    | 'ASSET_MISSING'
    | 'ASSET_PATH_INVALID'
    | 'MEDIA_INVALID'
    | 'LOCATION_NOT_WRITABLE'
    | 'INSUFFICIENT_DISK_SPACE'
    | 'NARRATION_MISSING'
    | 'NO_CARDS';
  readonly asset: 'card' | 'background' | 'narration' | 'provider' | 'output' | 'temp' | 'resource';
  readonly cardId?: string;
  readonly resourceKind?: SelectedResourceKind;
}

export interface RenderPreflightResult {
  readonly assetCount: number;
  readonly availableBytes: number;
}

export interface RenderVideoRequest extends RenderPreflightRequest {
  readonly jobId: string;
  readonly narrationAudioPaths: readonly (string | undefined)[];
}

export interface RenderVideoOptions {
  readonly binaryResolver?: BinaryResolver;
  readonly now?: () => Date;
  readonly onProgress?: (percent: number) => void;
  readonly processSpawner?: ProcessSpawner;
  readonly terminateProcessTree?: ProcessTreeTerminator;
  readonly fileOperations?: Partial<RenderFileOperations>;
  /** Test/lifecycle hook that runs while publication is still cancellable. */
  readonly beforePublication?: () => Promise<void> | void;
  /** Synchronous worker-owned publication boundary invoked after output validation. */
  readonly publicationGuard?: (publication: PreparedRenderPublication) => void;
}

export interface PreparedRenderPublication {
  readonly partialPath: string;
  readonly outputPath: string;
  publish(): void;
  compensate(): void;
}

export interface RenderVideoResult {
  readonly outputPath: string;
  readonly probe: MediaProbe;
  readonly durationSeconds: number;
  readonly cleanupPendingPaths: readonly string[];
  readonly publication?: PreparedRenderPublication;
}

export interface RenderOperation {
  readonly completion: Promise<RenderVideoResult>;
  readonly pid: number | undefined;
  readonly cleanupPendingPaths?: readonly string[];
  cancel(): Promise<void>;
}

export function startRender(
  request: RenderVideoRequest,
  options: RenderVideoOptions = {},
): RenderOperation {
  let renderProcess: OwnedFfmpegProcess | undefined;
  let lifecyclePhase: 'cancellable' | 'publishing' | 'settled' = 'cancellable';
  let cancellationPromise: Promise<void> | undefined;
  let cleanupPendingPaths: readonly string[] = [];
  const processRegistry = new RenderProcessRegistry();
  const binaryResolver = options.binaryResolver ?? resolveBundledBinaries;
  const completion = renderInternal(
    request,
    options,
    binaryResolver,
    processRegistry,
    (process) => {
      renderProcess = process;
    },
    () => {
      processRegistry.throwIfCancelled();
      lifecyclePhase = 'publishing';
    },
    (paths) => {
      cleanupPendingPaths = paths;
    },
  ).then((result) => {
    cleanupPendingPaths = result.cleanupPendingPaths;
    return result;
  }).finally(() => {
    lifecyclePhase = 'settled';
  });
  void completion.catch(() => undefined);
  const cancel = (): Promise<void> => {
    if (!cancellationPromise) {
      cancellationPromise = (async () => {
        if (lifecyclePhase === 'cancellable') await processRegistry.cancel();
        await completion.then(
          () => undefined,
          () => undefined,
        );
      })();
    }
    return cancellationPromise;
  };
  return {
    completion,
    get pid() {
      return renderProcess?.pid;
    },
    get cleanupPendingPaths() {
      return cleanupPendingPaths;
    },
    cancel,
  };
}

export async function renderVideo(
  request: RenderVideoRequest,
  options: RenderVideoOptions = {},
): Promise<RenderVideoResult> {
  return startRender(request, options).completion;
}

async function renderInternal(
  request: RenderVideoRequest,
  options: RenderVideoOptions,
  binaryResolver: BinaryResolver,
  processRegistry: RenderProcessRegistry,
  ownProcess: (process: OwnedFfmpegProcess) => void,
  enterPublication: () => void,
  reportCleanupPendingPaths: (paths: readonly string[]) => void,
): Promise<RenderVideoResult> {
  const fileOperations = resolveFileOperations(options.fileOperations);
  const timestamp = filenameTimestamp((options.now ?? (() => new Date()))());
  const outputName = `${safeFilename(request.snapshot.project.name)}-${timestamp}-${safeFilename(request.jobId)}.mp4`;
  const outputPath = resolve(request.outputDirectory, outputName);
  const partialPath = resolve(
    request.outputDirectory,
    `.${outputName}.${randomUUID()}.partial.mp4`,
  );
  const binaries = binaryResolver();
  let published = false;
  try {
    await assertOutputAbsent(outputPath, fileOperations);
    await preflightRender(request, {
      inspectMedia: (path, kind) => inspectMediaFully(path, kind, {
        binaryResolver: () => binaries,
        processRegistry,
        processSpawner: options.processSpawner,
        terminateProcessTree: options.terminateProcessTree,
      }),
      fileOperations,
    });
    processRegistry.throwIfCancelled();
    const probeOptions = {
      binaryResolver: () => binaries,
      processRegistry,
      processSpawner: options.processSpawner,
      terminateProcessTree: options.terminateProcessTree,
    };
    const project = request.snapshot.project;
    const transitionSoundPath = project.transitionSoundPath === undefined
      ? undefined
      : resolveManagedPath(request.dataDirectory, project.transitionSoundPath);
    const backgroundMusicPath = project.backgroundMusicPath === undefined
      ? undefined
      : resolveManagedPath(request.dataDirectory, project.backgroundMusicPath);
    const introSoundPath = project.introSoundPath === undefined
      ? undefined
      : resolveManagedPath(request.dataDirectory, project.introSoundPath);
    const memeSoundPaths = project.cards.map((card) => {
      const meme = card.postCardMeme;
      return meme?.soundPath === undefined
        ? undefined
        : resolveManagedPath(request.dataDirectory, meme.soundPath);
    });
    const memeVideoPaths = project.cards.map((card) => {
      const meme = card.postCardMeme;
      return meme !== undefined && 'videoPath' in meme
        ? resolveManagedPath(request.dataDirectory, meme.videoPath)
        : undefined;
    });
    const [narrationProbes, transitionProbe, introProbe, memeVideoProbes, memeSoundProbes] = await Promise.all([
      Promise.all(request.narrationAudioPaths.map((path) => path === undefined
        ? Promise.resolve<MediaProbe | undefined>(undefined)
        : probeMedia(path, probeOptions))),
      transitionSoundPath === undefined
        ? Promise.resolve<MediaProbe | undefined>(undefined)
        : probeMedia(transitionSoundPath, probeOptions),
      introSoundPath === undefined
        ? Promise.resolve<MediaProbe | undefined>(undefined)
        : probeMedia(introSoundPath, probeOptions),
      Promise.all(memeVideoPaths.map((path) => path === undefined
        ? Promise.resolve<MediaProbe | undefined>(undefined)
        : probeMedia(path, probeOptions))),
      Promise.all(memeSoundPaths.map((path) => path === undefined
        ? Promise.resolve<MediaProbe | undefined>(undefined)
        : probeMedia(path, probeOptions))),
    ]);
    if (backgroundMusicPath !== undefined) await probeMedia(backgroundMusicPath, probeOptions);
    const timeline = createEditTimeline({
      cards: project.cards.map((card, index) => ({
        cardId: card.id,
        contentSeconds: card.script.trim()
          ? selectAudioDurationSeconds(narrationProbes[index]!)
          : card.holdSeconds ?? 3,
        hasNarration: card.script.trim().length > 0,
        ...(memeVideoProbes[index] === undefined && memeSoundProbes[index] === undefined
          ? {}
          : {
            memeSeconds: Math.max(
              memeVideoProbes[index] === undefined
                ? 0
                : selectVideoDurationSeconds(memeVideoProbes[index]),
              memeSoundProbes[index] === undefined
                ? 0
                : selectAudioDurationSeconds(memeSoundProbes[index]),
            ),
          }),
      })),
      ...(transitionProbe === undefined
        ? {}
        : { transitionSeconds: selectAudioDurationSeconds(transitionProbe) }),
      ...(introProbe === undefined
        ? {}
        : { introSeconds: selectAudioDurationSeconds(introProbe) }),
    });
    const renderCards = project.cards.map((card, index): RenderCardInput => {
      const segment = timeline.cards[index]!;
      const renderCard: RenderCardInput = {
        imagePath: resolveManagedPath(request.dataDirectory, card.imagePath),
        audioPath: request.narrationAudioPaths[index],
        layout: card.layout,
        segment,
      };
      const meme = card.postCardMeme;
      if (meme === undefined) return renderCard;
      if ('imagePath' in meme) {
        return {
          ...renderCard,
          meme: {
            imagePath: resolveManagedPath(request.dataDirectory, meme.imagePath),
            soundPath: resolveManagedPath(request.dataDirectory, meme.soundPath),
            layout: meme.layout,
            range: segment.meme!,
          },
        };
      }
      const videoProbe = memeVideoProbes[index];
      if (videoProbe === undefined) {
        throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Video meme inspection failed'));
      }
      return {
        ...renderCard,
        meme: {
          videoPath: resolveManagedPath(request.dataDirectory, meme.videoPath),
          ...(meme.soundPath === undefined
            ? {}
            : { soundPath: resolveManagedPath(request.dataDirectory, meme.soundPath) }),
          videoDurationSeconds: selectVideoDurationSeconds(videoProbe),
          hasAudio: videoProbe.streams.some((stream) => stream.type === 'audio'),
          layout: meme.layout,
          range: segment.meme!,
        },
      };
    });
    const command = buildFfmpegCommand({
      backgroundPath: resolveManagedPath(request.dataDirectory, request.snapshot.template.backgroundPath),
      cards: renderCards,
      ...(introSoundPath === undefined ? {} : { introSoundPath }),
      ...(transitionSoundPath === undefined ? {} : { transitionSoundPath }),
      ...(backgroundMusicPath === undefined ? {} : { backgroundMusicPath }),
      cardSlot: request.snapshot.template.cardSlot,
      memeSlot: request.snapshot.template.memeSlot,
      outputPath: partialPath,
      width: DEFAULT_OUTPUT.width,
      height: DEFAULT_OUTPUT.height,
      fps: DEFAULT_OUTPUT.fps,
      crf: DEFAULT_OUTPUT.crf,
    });
    processRegistry.throwIfCancelled();
    const process = startOwnedFfmpegProcess({
      binaryPath: binaries.ffmpegPath,
      args: command.args,
       durationSeconds: timeline.durationSeconds,
      onProgress: options.onProgress,
      processRegistry,
      processSpawner: options.processSpawner,
      terminateProcessTree: options.terminateProcessTree,
    });
    ownProcess(process);
    await process.completion;
    processRegistry.throwIfCancelled();
    const probe = await probeMedia(partialPath, {
      binaryResolver: () => binaries,
      processRegistry,
      processSpawner: options.processSpawner,
      terminateProcessTree: options.terminateProcessTree,
    });
    validateRenderedOutput(probe, timeline.durationSeconds);
    await options.beforePublication?.();
    enterPublication();
    const preparedPublication = prepareRenderedOutput(partialPath, outputPath, fileOperations);
    if (options.publicationGuard) {
      options.publicationGuard(preparedPublication);
      published = true;
      reportCleanupPendingPaths([partialPath]);
      return {
        outputPath,
        probe,
        durationSeconds: timeline.durationSeconds,
        cleanupPendingPaths: [partialPath],
        publication: preparedPublication,
      };
    }
    const publication = await publishRenderedOutput(partialPath, outputPath, fileOperations);
    published = true;
    return {
      outputPath,
      probe,
      durationSeconds: timeline.durationSeconds,
      cleanupPendingPaths: publication.cleanupPendingPaths,
    };
  } catch (error) {
    if (processRegistry.isCancelled()) {
      throw new ReelForgeError(createErrorPayload('CANCELLED', 'Render was cancelled'));
    }
    if (error instanceof ReelForgeError) throw error;
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Video render failed'));
  } finally {
    if (!published) {
      const removed = await removeWithRetries(partialPath, fileOperations, 3);
      if (!removed) reportCleanupPendingPaths([partialPath]);
    }
  }
}

export function validateRenderedOutput(probe: MediaProbe, expectedDurationSeconds: number): void {
  const video = probe.streams.find((stream) => stream.type === 'video');
  const audio = probe.streams.find((stream) => stream.type === 'audio');
  const valid = video?.codec === 'h264'
    && video.width === DEFAULT_OUTPUT.width
    && video.height === DEFAULT_OUTPUT.height
    && video.fps !== undefined
    && Math.abs(video.fps - DEFAULT_OUTPUT.fps) < 0.01
    && audio?.codec === 'aac'
    && Math.abs(probe.durationSeconds - expectedDurationSeconds) <= 0.1;
  if (!valid) {
    throw new ReelForgeError(
      createErrorPayload('RENDER_FAILED', 'Rendered output validation failed'),
    );
  }
}

export async function preflightRender(
  request: RenderPreflightRequest,
  dependencies: RenderPreflightDependencies = {},
): Promise<RenderPreflightResult> {
  const processRegistry = new RenderProcessRegistry();
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    cancellation ??= processRegistry.cancel();
  };
  request.signal?.addEventListener('abort', cancel, { once: true });
  if (request.signal?.aborted) cancel();
  try {
    throwIfCancelled(Boolean(request.signal?.aborted));
    const inspectMedia = dependencies.inspectMedia ?? ((path, kind) => inspectMediaFully(path, kind, {
      binaryResolver: dependencies.binaryResolver,
      processRegistry,
      processSpawner: dependencies.processSpawner,
      terminateProcessTree: dependencies.terminateProcessTree,
    }));
    const result = await preflightRenderInternal(request, { ...dependencies, inspectMedia });
    throwIfCancelled(Boolean(request.signal?.aborted));
    return result;
  } finally {
    request.signal?.removeEventListener('abort', cancel);
    await cancellation;
  }
}

async function preflightRenderInternal(
  request: RenderPreflightRequest,
  dependencies: RenderPreflightDependencies,
): Promise<RenderPreflightResult> {
  const issues: PreflightIssue[] = [];
  const project = request.snapshot.project;
  const requiresProvider = project.cards.some((card) => card.script.trim().length > 0);
  if (requiresProvider && !request.providerReady) {
    issues.push({ code: 'PROVIDER_NOT_READY', asset: 'provider' });
  }
  if (project.cards.length === 0) {
    issues.push({ code: 'NO_CARDS', asset: 'card' });
  }
  const assets: Array<{
    path: string;
    kind: ManagedMediaKind;
    asset: PreflightIssue['asset'];
    cardId?: string;
    resourceKind?: SelectedResourceKind;
  }> = [
    { path: request.snapshot.template.backgroundPath, kind: 'video', asset: 'background' },
    ...project.cards.map((card) => ({
      path: card.imagePath,
      kind: 'image' as const,
      asset: 'card' as const,
    })),
  ];
  if (project.transitionSoundPath !== undefined) {
    assets.push({
      path: project.transitionSoundPath,
      kind: 'audio',
      asset: 'resource',
      resourceKind: 'transition-sound',
    });
  }
  if (project.backgroundMusicPath !== undefined) {
    assets.push({
      path: project.backgroundMusicPath,
      kind: 'audio',
      asset: 'resource',
      resourceKind: 'background-music',
    });
  }
  if (project.introSoundPath !== undefined) {
    assets.push({
      path: project.introSoundPath,
      kind: 'audio',
      asset: 'resource',
      resourceKind: 'intro-sound',
    });
  }
  for (const card of project.cards) {
    if (card.postCardMeme === undefined) continue;
    if ('imagePath' in card.postCardMeme) {
      assets.push({
        path: card.postCardMeme.imagePath,
        kind: 'image',
        asset: 'resource',
        cardId: card.id,
        resourceKind: 'meme-image',
      });
    } else {
      assets.push({
        path: card.postCardMeme.videoPath,
        kind: 'video',
        asset: 'resource',
        cardId: card.id,
        resourceKind: 'meme-video',
      });
    }
    if (card.postCardMeme.soundPath !== undefined) {
      assets.push({
        path: card.postCardMeme.soundPath,
        kind: 'audio',
        asset: 'resource',
        cardId: card.id,
        resourceKind: 'meme-sound',
      });
    }
  }
  if (request.narrationAudioPaths) {
    if (request.narrationAudioPaths.length !== project.cards.length) {
      issues.push({ code: 'NARRATION_MISSING', asset: 'narration' });
    }
    project.cards.forEach((card, index) => {
      if (!card.script.trim()) return;
      const path = request.narrationAudioPaths?.[index];
      if (path === undefined) {
        issues.push({ code: 'NARRATION_MISSING', asset: 'narration', cardId: card.id });
        return;
      }
      assets.push({
        path,
        kind: 'audio' as const,
        asset: 'narration' as const,
      });
    });
  }

  const inspectMedia = dependencies.inspectMedia ?? inspectMediaFully;
  for (const asset of assets) {
    throwIfCancelled(Boolean(request.signal?.aborted));
    let absolutePath: string;
    try {
      absolutePath = asset.asset === 'narration' && isAbsolute(asset.path)
        ? asset.path
        : resolveManagedPath(request.dataDirectory, asset.path);
      const handle = await open(absolutePath, 'r');
      await handle.close();
    } catch (error) {
      issues.push({
        code: isPathValidationError(error) ? 'ASSET_PATH_INVALID' : 'ASSET_MISSING',
        asset: asset.asset,
        ...(asset.cardId === undefined ? {} : { cardId: asset.cardId }),
        ...(asset.resourceKind === undefined ? {} : { resourceKind: asset.resourceKind }),
      });
      continue;
    }
    try {
      const probe = await inspectMedia(absolutePath, asset.kind, request.signal);
      validateInspectedMedia(probe, asset.kind);
      throwIfCancelled(Boolean(request.signal?.aborted));
    } catch (error) {
      if (isCancelledError(error)) throw error;
      issues.push({
        code: 'MEDIA_INVALID',
        asset: asset.asset,
        ...(asset.cardId === undefined ? {} : { cardId: asset.cardId }),
        ...(asset.resourceKind === undefined ? {} : { resourceKind: asset.resourceKind }),
      });
    }
  }

  await Promise.all([
    assertWritableDirectory(
      request.outputDirectory,
      'output',
      issues,
      resolveFileOperations(dependencies.fileOperations),
    ),
    assertWritableDirectory(
      request.tempDirectory,
      'temp',
      issues,
      resolveFileOperations(dependencies.fileOperations),
    ),
  ]);
  throwIfCancelled(Boolean(request.signal?.aborted));
  let availableBytes = 0;
  try {
    availableBytes = await (dependencies.availableDiskBytes ?? getAvailableDiskBytes)(request.outputDirectory);
    if (availableBytes < (request.minimumFreeBytes ?? 256 * 1024 * 1024)) {
      issues.push({ code: 'INSUFFICIENT_DISK_SPACE', asset: 'output' });
    }
  } catch {
    issues.push({ code: 'INSUFFICIENT_DISK_SPACE', asset: 'output' });
  }

  if (issues.length > 0) {
    throw new ReelForgeError(
      createErrorPayload('INVALID_INPUT', 'Render preflight failed', { issues }),
    );
  }
  return { assetCount: assets.length, availableBytes };
}

function parseTimestamp(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function resolveManagedPath(dataDirectory: string, value: string): string {
  if (!value || isAbsolute(value)) throw new Error('unsafe-path');
  const assetsRoot = resolve(dataDirectory, 'assets');
  const absolutePath = resolve(resolve(dataDirectory), value);
  const fromAssets = relative(assetsRoot, absolutePath);
  if (!fromAssets || fromAssets === '..' || fromAssets.startsWith(`..\\`) || fromAssets.startsWith('../') || isAbsolute(fromAssets)) {
    throw new Error('unsafe-path');
  }
  return absolutePath;
}

function isPathValidationError(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe-path';
}

function validateInspectedMedia(value: unknown, expectedKind: ManagedMediaKind): void {
  if (!isRecord(value) || !Array.isArray(value.streams)) return;
  const probe = value as unknown as MediaProbe;
  const expectedType = expectedKind === 'image' ? 'video' : expectedKind;
  if (!probe.streams.some((stream) => stream.type === expectedType)) {
    throw new Error('expected media stream missing');
  }
  if (expectedKind === 'audio') {
    selectAudioDurationSeconds(probe);
  } else if (
    expectedKind === 'video'
    && (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0)
  ) {
    throw new Error('media duration is unavailable');
  }
}

async function assertWritableDirectory(
  directory: string,
  asset: 'output' | 'temp',
  issues: PreflightIssue[],
  fileOperations: RenderFileOperations,
): Promise<void> {
  const probePath = resolve(directory, `.reelforge-write-check-${randomUUID()}`);
  let created = false;
  let removed = false;
  try {
    await fileOperations.makeDirectory(directory);
    const handle = await fileOperations.createExclusive(probePath);
    await handle.close();
    created = true;
    await fileOperations.remove(probePath);
    removed = true;
  } catch {
    issues.push({ code: 'LOCATION_NOT_WRITABLE', asset });
  } finally {
    if (created && !removed) await fileOperations.remove(probePath).catch(() => undefined);
  }
}

async function getAvailableDiskBytes(path: string): Promise<number> {
  const info = await statfs(path, { bigint: true });
  return Number(info.bavail * info.bsize);
}

async function assertOutputAbsent(path: string, fileOperations: RenderFileOperations): Promise<void> {
  try {
    await fileOperations.access(path);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Output location is unavailable'));
  }
  throw new ReelForgeError(createErrorPayload('CONFLICT', 'Output file already exists'));
}

export async function publishRenderedOutput(
  partialPath: string,
  outputPath: string,
  overrides: Partial<RenderFileOperations> = {},
): Promise<{ cleanupPendingPaths: readonly string[] }> {
  const fileOperations = resolveFileOperations(overrides);
  try {
    await fileOperations.link(partialPath, outputPath);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new ReelForgeError(createErrorPayload('CONFLICT', 'Output file already exists'));
    }
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Rendered output could not be finalized'));
  }
  const removed = await removeWithRetries(partialPath, fileOperations, 3);
  return { cleanupPendingPaths: removed ? [] : [partialPath] };
}

export function prepareRenderedOutput(
  partialPath: string,
  outputPath: string,
  overrides: Partial<RenderFileOperations> = {},
): PreparedRenderPublication {
  const fileOperations = resolveFileOperations(overrides);
  let linked = false;
  return {
    partialPath,
    outputPath,
    publish() {
      if (linked) return;
      try {
        fileOperations.linkSync(partialPath, outputPath);
        linked = true;
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new ReelForgeError(createErrorPayload('CONFLICT', 'Output file already exists'));
        }
        throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Rendered output could not be finalized'));
      }
    },
    compensate() {
      if (!linked) return;
      fileOperations.unlinkSync(outputPath);
      linked = false;
    },
  };
}

function resolveFileOperations(overrides: Partial<RenderFileOperations> = {}): RenderFileOperations {
  return {
    access: overrides.access ?? (async (path) => access(path)),
    link: overrides.link ?? (async (existingPath, newPath) => link(existingPath, newPath)),
    linkSync: overrides.linkSync ?? ((existingPath, newPath) => linkFileSync(existingPath, newPath)),
    unlinkSync: overrides.unlinkSync ?? ((path) => unlinkFileSync(path)),
    makeDirectory: overrides.makeDirectory ?? (async (path) => {
      await mkdir(path, { recursive: true });
    }),
    createExclusive: overrides.createExclusive ?? (async (path) => open(path, 'wx')),
    remove: overrides.remove ?? (async (path) => rm(path, { force: true })),
  };
}

async function removeWithRetries(
  path: string,
  fileOperations: RenderFileOperations,
  attempts: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fileOperations.remove(path);
      return true;
    } catch {
      // Retry bounded cleanup; a published output remains successful if all attempts fail.
    }
  }
  return false;
}

function filenameTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17).replace(
    /^(\d{8})(\d{9})$/,
    '$1-$2',
  );
}

function throwIfCancelled(cancelled: boolean): void {
  if (cancelled) {
    throw new ReelForgeError(createErrorPayload('CANCELLED', 'Render was cancelled'));
  }
}

function controlledProgressError(error: unknown): ReelForgeError {
  if (error instanceof ReelForgeError) return error;
  return new ReelForgeError(createErrorPayload('RENDER_FAILED', 'FFmpeg progress reporting failed'));
}

function isCancelledError(error: unknown): error is ReelForgeError {
  return error instanceof ReelForgeError && error.payload.code === 'CANCELLED';
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === 'EEXIST';
}

async function runProcessCollect(
  binaryPath: string,
  args: readonly string[],
  options: Pick<MediaToolOptions, 'processRegistry' | 'processSpawner' | 'terminateProcessTree'> = {},
): Promise<{ stdout: string; stderr: string }> {
  options.processRegistry?.throwIfCancelled();
  return new Promise((resolveProcess, rejectProcess) => {
    const child = (options.processSpawner ?? defaultProcessSpawner)(binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = childClosure(child);
    let cancelled = false;
    let cancellationPromise: Promise<void> | undefined;
    const cancel = (): Promise<void> => {
      if (!cancellationPromise) {
        cancelled = true;
        cancellationPromise = child.exitCode !== null || child.signalCode !== null
          ? closed
          : terminateAndAwaitChild(child, closed, options.terminateProcessTree);
      }
      return cancellationPromise;
    };
    options.processRegistry?.own({ child, closed, cancel });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 2_000_000) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.once('error', rejectProcess);
    child.once('close', (code) => {
      if (cancelled || options.processRegistry?.isCancelled()) {
        rejectProcess(new ReelForgeError(createErrorPayload('CANCELLED', 'Render was cancelled')));
      } else if (code === 0) resolveProcess({ stdout, stderr });
      else rejectProcess(new Error('media process failed'));
    });
  });
}

async function killWindowsProcessTree(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolveKill) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => resolveKill(false));
    killer.once('close', (code) => resolveKill(code === 0));
  });
}

function defaultProcessSpawner(
  binaryPath: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(binaryPath, [...args], options);
}

async function defaultProcessTreeTerminator(child: ChildProcess): Promise<boolean> {
  if (process.platform === 'win32' && child.pid) {
    return killWindowsProcessTree(child.pid);
  }
  return child.kill('SIGTERM');
}

async function terminateAndAwaitChild(
  child: ChildProcess,
  closed: Promise<void>,
  terminateProcessTree: ProcessTreeTerminator = defaultProcessTreeTerminator,
): Promise<void> {
  if (child.exitCode !== null) {
    await closed;
    return;
  }
  let treeTerminationAccepted = false;
  try {
    treeTerminationAccepted = await terminateProcessTree(child);
  } catch {
    treeTerminationAccepted = false;
  }
  if (!treeTerminationAccepted) child.kill('SIGKILL');
  if (await closesWithin(closed, 5_000)) return;
  child.kill('SIGKILL');
  if (!(await closesWithin(closed, 5_000))) {
    throw new ReelForgeError(
      createErrorPayload('RENDER_FAILED', 'Owned media process did not terminate'),
    );
  }
}

function childClosure(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveClose) => {
    child.once('close', () => resolveClose());
    child.once('error', () => {
      if (child.pid === undefined) resolveClose();
    });
  });
}

async function closesWithin(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
    timeout.unref();
  });
  const result = await Promise.race([closed.then(() => true), timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function pixelRect(rect: NormalizedRect, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const pixelWidth = evenPixelSize(rect.width * width);
  const pixelHeight = evenPixelSize(rect.height * height);
  return {
    x: Math.max(0, Math.min(Math.round(rect.x * width), width - pixelWidth)),
    y: Math.max(0, Math.min(Math.round(rect.y * height), height - pixelHeight)),
    width: pixelWidth,
    height: pixelHeight,
  };
}

function evenPixelSize(value: number): number {
  return Math.max(2, Math.floor(Math.round(value) / 2) * 2);
}

function decimal(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function delayMilliseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

function rangeDuration(range: TimeRange): number {
  return range.endSeconds - range.startSeconds;
}

function delayedAudioChain(durationSeconds: number, delayMillisecondsValue: number): string {
  return `atrim=duration=${decimal(durationSeconds)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delayMillisecondsValue}|${delayMillisecondsValue}`;
}

function cleanNumber(value: number): number {
  return Number(value.toFixed(12));
}

function rationalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string') return positiveNumber(value);
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
