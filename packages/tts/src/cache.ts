import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, link, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { ReelForgeError, createErrorPayload, type TtsSynthesisRequest, type TtsSynthesisResult } from '@reelforge/core';
import type { AppPaths } from '@reelforge/storage';

import { cancellationError } from './network.js';

const CACHE_VERSION = 1;

export interface TtsCacheEntry {
  readonly cacheHit: boolean;
  readonly key: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly contentType: string;
}

interface CacheMetadata {
  readonly cacheVersion: number;
  readonly key: string;
  readonly contentType: string;
  readonly relativePath: string;
}

interface InFlightSynthesis {
  readonly controller: AbortController;
  promise: Promise<TtsCacheEntry>;
  consumers: number;
  settled: boolean;
}

export class TtsCache {
  private readonly inFlight = new Map<string, InFlightSynthesis>();

  constructor(private readonly paths: AppPaths) {}

  async getOrCreate(
    request: TtsSynthesisRequest,
    synthesize: (signal?: AbortSignal) => Promise<TtsSynthesisResult>,
    signal?: AbortSignal,
  ): Promise<TtsCacheEntry> {
    if (signal?.aborted) throw cancellationError();
    const key = createTtsCacheKey(request);
    let active = this.inFlight.get(key);
    if (!active) {
      const controller = new AbortController();
      active = {
        controller,
        consumers: 0,
        settled: false,
        promise: Promise.resolve(undefined as never),
      };
      const created = active;
      created.promise = this.resolveEntry(key, request, synthesize, controller.signal).finally(() => {
        created.settled = true;
        if (this.inFlight.get(key) === created) this.inFlight.delete(key);
      });
      this.inFlight.set(key, created);
    }
    active.consumers += 1;
    const release = createConsumerRelease(this.inFlight, key, active);
    try {
      return await waitForCaller(active.promise, signal, release);
    } finally {
      await release();
    }
  }

  private async resolveEntry(
    key: string,
    request: TtsSynthesisRequest,
    synthesize: (signal?: AbortSignal) => Promise<TtsSynthesisResult>,
    signal: AbortSignal,
  ): Promise<TtsCacheEntry> {
    const existing = await this.readEntry(key, request.audioFormat);
    if (existing) {
      return { ...existing, cacheHit: true };
    }

    const result = await synthesize(signal);
    throwIfCancelled(signal);
    const audio = decodeSynthesisResult(result);
    const entry = createEntry(this.paths, key, request.audioFormat, false);
    return this.writeEntry(entry, request.audioFormat, audio, signal);
  }

  private async readEntry(key: string, audioFormat: TtsSynthesisRequest['audioFormat']): Promise<TtsCacheEntry | undefined> {
    const expected = createEntry(this.paths, key, audioFormat, false);
    const published = await readPublishedEntry(expected);
    if (published) return published;
    return readLegacyEntry(this.paths, key, audioFormat);
  }

  private async writeEntry(
    entry: TtsCacheEntry,
    audioFormat: TtsSynthesisRequest['audioFormat'],
    audio: Buffer,
    signal: AbortSignal,
  ): Promise<TtsCacheEntry> {
    const temporaryPath = join(this.paths.ttsCache, `.${entry.key}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.paths.ttsCache, { recursive: true });
      await writeFile(temporaryPath, audio);
      const temporaryDetails = await stat(temporaryPath);
      if (!temporaryDetails.isFile() || temporaryDetails.size === 0) {
        throw unavailableError();
      }
      throwIfCancelled(signal);

      try {
        await link(temporaryPath, entry.absolutePath);
        return entry;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const winner = await this.readEntry(entry.key, audioFormat);
        if (winner) return { ...winner, cacheHit: true };
        throw unavailableError();
      }
    } catch (error) {
      if (signal.aborted || isCancellation(error)) throw cancellationError();
      throw unavailableError();
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function createConsumerRelease(
  inFlight: Map<string, InFlightSynthesis>,
  key: string,
  active: InFlightSynthesis,
): () => Promise<void> {
  let released = false;
  return () => {
    if (released) return Promise.resolve();
    released = true;
    active.consumers -= 1;
    if (active.consumers !== 0 || active.settled) return Promise.resolve();
    if (inFlight.get(key) === active) inFlight.delete(key);
    active.controller.abort();
    return active.promise.then(
      () => undefined,
      () => undefined,
    );
  };
}

function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal | undefined, release: () => Promise<void>): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    return release().then(
      () => Promise.reject(cancellationError()),
      () => Promise.reject(cancellationError()),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let cancellation: Promise<void> | undefined;
    let settled = false;
    const onAbort = (): void => {
      if (cancellation) return;
      cancellation = release();
      void cancellation.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            reject(cancellationError());
          }
        },
        () => {
          signal.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            reject(cancellationError());
          }
        },
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        if (cancellation || settled) return;
        signal.removeEventListener('abort', onAbort);
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        if (cancellation || settled) return;
        signal.removeEventListener('abort', onAbort);
        settled = true;
        reject(error);
      },
    );
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError();
}

function isCancellation(error: unknown): boolean {
  return error instanceof ReelForgeError && error.payload.code === 'CANCELLED';
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ReelForgeError && error.payload.code === 'PROVIDER_UNAVAILABLE';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readPublishedEntry(expected: TtsCacheEntry): Promise<TtsCacheEntry | undefined> {
  try {
    const details = await lstat(expected.absolutePath);
    if (!details.isFile()) throw unavailableError();
    const audio = await readFile(expected.absolutePath);
    if (audio.byteLength === 0) throw unavailableError();
    return expected;
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (isUnavailable(error)) throw error;
    throw unavailableError();
  }
}

async function readLegacyEntry(
  paths: AppPaths,
  key: string,
  audioFormat: TtsSynthesisRequest['audioFormat'],
): Promise<TtsCacheEntry | undefined> {
  const expected = createLegacyEntry(paths, key, audioFormat);
  try {
    const details = await lstat(expected.absolutePath);
    if (!details.isFile()) return undefined;
    const audio = await readFile(expected.absolutePath);
    if (audio.byteLength === 0) return undefined;
    const source = await readFile(join(paths.ttsCache, key, 'metadata.json'), 'utf8');
    parseMetadata(source, expected);
    return expected;
  } catch {
    return undefined;
  }
}

export function createTtsCacheKey(request: TtsSynthesisRequest): string {
  const canonical = JSON.stringify({
    cacheVersion: CACHE_VERSION,
    provider: request.provider,
    voiceId: request.voiceId,
    modelId: effectiveModelId(request),
    text: request.text,
    speakingRate: request.speakingRate,
    audioFormat: request.audioFormat,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function effectiveModelId(request: Pick<TtsSynthesisRequest, 'provider' | 'modelId'>): string {
  if (request.modelId) {
    return request.modelId;
  }
  return request.provider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'google-default';
}

function createEntry(
  paths: AppPaths,
  key: string,
  audioFormat: TtsSynthesisRequest['audioFormat'],
  cacheHit: boolean,
): TtsCacheEntry {
  const absolutePath = join(paths.ttsCache, `${key}.${audioFormat}`);
  return {
    cacheHit,
    key,
    absolutePath,
    relativePath: relative(paths.data, absolutePath).replace(/\\/g, '/'),
    contentType: contentTypeForAudioFormat(audioFormat),
  };
}

function createLegacyEntry(
  paths: AppPaths,
  key: string,
  audioFormat: TtsSynthesisRequest['audioFormat'],
): TtsCacheEntry {
  const absolutePath = join(paths.ttsCache, key, `audio.${audioFormat}`);
  return {
    cacheHit: false,
    key,
    absolutePath,
    relativePath: relative(paths.data, absolutePath).replace(/\\/g, '/'),
    contentType: contentTypeForAudioFormat(audioFormat),
  };
}

function contentTypeForAudioFormat(audioFormat: TtsSynthesisRequest['audioFormat']): string {
  return audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

function decodeSynthesisResult(result: TtsSynthesisResult): Buffer {
  if (!isNonEmptyString(result.contentType) || !isValidBase64(result.audioBase64)) {
    throw unavailableError();
  }
  const audio = Buffer.from(result.audioBase64, 'base64');
  if (audio.byteLength === 0) {
    throw unavailableError();
  }
  return audio;
}

function parseMetadata(source: string, expected: Pick<TtsCacheEntry, 'key' | 'relativePath'>): CacheMetadata {
  const value: unknown = JSON.parse(source);
  if (
    !isRecord(value) ||
    value.cacheVersion !== CACHE_VERSION ||
    value.key !== expected.key ||
    value.relativePath !== expected.relativePath ||
    !isNonEmptyString(value.contentType)
  ) {
    throw new Error('invalid cache metadata');
  }
  return {
    cacheVersion: value.cacheVersion,
    key: value.key,
    relativePath: value.relativePath,
    contentType: value.contentType,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidBase64(value: unknown): value is string {
  return isNonEmptyString(value) && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && Buffer.from(value, 'base64').byteLength > 0;
}

function unavailableError(): ReelForgeError {
  return new ReelForgeError(createErrorPayload('PROVIDER_UNAVAILABLE', 'TTS audio could not be cached'));
}
