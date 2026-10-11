import { createRequire } from 'node:module';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';

import { ReelForgeError, createErrorPayload } from '@reelforge/core';

export interface OwnedMediaProcessOptions {
  readonly binaryResolver?: () => { readonly ffmpegPath: string };
  readonly processSpawner?: ProcessSpawner;
  readonly terminateProcessTree?: ProcessTreeTerminator;
  readonly signal?: AbortSignal;
}

export type ProcessSpawner = (
  binaryPath: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ProcessTreeTerminator = (child: ChildProcess) => Promise<boolean>;

export async function prepareAudioAtSpeed(
  inputPath: string,
  outputPath: string,
  speakingRate: number,
  options: OwnedMediaProcessOptions = {},
): Promise<string> {
  assertSpeakingRate(speakingRate);
  throwIfAborted(options.signal);
  if (speakingRate === 1) return inputPath;
  if (inputPath === outputPath) {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Speed output must use a separate path'));
  }

  let completed = false;
  try {
    const binaries = (options.binaryResolver ?? resolveBundledFfmpeg)();
    await runOwnedFfmpeg(
      binaries.ffmpegPath,
      [
        '-hide_banner', '-nostdin', '-y', '-i', inputPath,
        '-vn', '-filter:a', `atempo=${decimal(speakingRate)}`,
        '-c:a', 'pcm_s16le', outputPath,
      ],
      options,
    );
    await assertValidAudio(outputPath);
    completed = true;
    return outputPath;
  } catch (error) {
    if (error instanceof ReelForgeError) throw error;
    if (options.signal?.aborted) throw cancellationError();
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Audio speed adjustment failed'));
  } finally {
    if (!completed) await rm(outputPath, { force: true }).catch(() => undefined);
  }
}

function assertSpeakingRate(value: number): void {
  if (!Number.isFinite(value) || value < 0.5 || value > 2) {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Speaking rate must be between 0.5 and 2'));
  }
}

function resolveBundledFfmpeg(): { readonly ffmpegPath: string } {
  const require = createRequire(import.meta.url);
  const ffmpegPath: unknown = require('ffmpeg-static');
  if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) {
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Bundled media tools are unavailable'));
  }
  return { ffmpegPath };
}

async function assertValidAudio(path: string): Promise<void> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size === 0) throw new Error('empty audio');
  } catch {
    throw new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Audio speed adjustment produced no audio'));
  }
}

async function runOwnedFfmpeg(
  binaryPath: string,
  args: readonly string[],
  options: OwnedMediaProcessOptions,
): Promise<void> {
  throwIfAborted(options.signal);
  await new Promise<void>((resolve, reject) => {
    const child = (options.processSpawner ?? defaultProcessSpawner)(binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let cancelled = false;
    let cancellationPromise: Promise<void> | undefined;
    const closed = childClosure(child);
    const cancel = (): Promise<void> => {
      if (!cancellationPromise) {
        cancelled = true;
        cancellationPromise = child.exitCode !== null || child.signalCode !== null
          ? closed
          : terminateAndAwaitChild(child, closed, options.terminateProcessTree);
      }
      return cancellationPromise;
    };
    const onAbort = (): void => {
      void cancel().catch(reject);
    };
    const cleanup = (): void => options.signal?.removeEventListener('abort', onAbort);
    child.once('error', (error) => {
      cleanup();
      reject(new ReelForgeError(createErrorPayload('RENDER_FAILED', error.message || 'FFmpeg could not be started')));
    });
    child.once('close', (code) => {
      cleanup();
      if (cancelled || options.signal?.aborted) {
        reject(cancellationError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new ReelForgeError(createErrorPayload('RENDER_FAILED', 'FFmpeg speed adjustment failed')));
      }
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
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
    return new Promise<boolean>((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve(false));
      killer.once('close', (code) => resolve(code === 0));
    });
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
  let terminated = false;
  try {
    terminated = await terminateProcessTree(child);
  } catch {
    terminated = false;
  }
  if (!terminated) child.kill('SIGKILL');
  await closed;
}

function childClosure(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError();
}

function cancellationError(): ReelForgeError {
  return new ReelForgeError(createErrorPayload('CANCELLED', 'Audio speed adjustment was cancelled'));
}

function decimal(value: number): string {
  return Number(value.toFixed(6)).toString();
}
