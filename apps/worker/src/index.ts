import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { TtsProviderId } from '@reelforge/core';
import { QueueStore } from '@reelforge/queue';
import { preflightRender, startRender } from '@reelforge/renderer';
import { createAppPaths, ensureAppDirectories } from '@reelforge/storage';
import { ElevenLabsTtsProvider, EnvSecretStore, GoogleTtsProvider, TtsCache } from '@reelforge/tts';

import { WorkerRuntime } from './runtime.js';

export * from './runtime.js';

export interface WorkerApplication {
  readonly runtime: WorkerRuntime;
  readonly queue: QueueStore;
}

export function startWorkerKeepAlive(): NodeJS.Timeout {
  return setInterval(() => undefined, 1_000);
}

export function stopWorkerKeepAlive(handle: NodeJS.Timeout): void {
  clearInterval(handle);
}

export async function createDefaultWorkerApplication(
  baseDirectory = process.env.REELFORGE_HOME || process.cwd(),
): Promise<WorkerApplication> {
  const paths = createAppPaths(baseDirectory);
  await ensureAppDirectories(paths);
  const secrets = new EnvSecretStore(resolve(paths.base, '.env.local'));
  const configuredSecrets = new Set((
    await Promise.all([
      secrets.read('GOOGLE_TTS_API_KEY'),
      secrets.read('ELEVENLABS_API_KEY'),
    ])
  ).filter((value): value is string => Boolean(value)));
  const refreshRedactionValues = async (): Promise<void> => {
    const values = await Promise.all([
      secrets.read('GOOGLE_TTS_API_KEY'),
      secrets.read('ELEVENLABS_API_KEY'),
    ]);
    for (const value of values) if (value) configuredSecrets.add(value);
  };
  const queue = new QueueStore({
    databasePath: resolve(paths.data, 'queue.sqlite'),
    defaultOutputDirectory: paths.outputs,
    redactValues: () => [...configuredSecrets],
  });
  const providers = {
    google: new GoogleTtsProvider({ secrets }),
    elevenlabs: new ElevenLabsTtsProvider({ secrets }),
  };
  const runtime = new WorkerRuntime({
    queue,
    paths,
    providers,
    cache: new TtsCache(paths),
    renderer: {
      preflight: (request) => preflightRender(request),
      start: (request, options) => startRender(request, options),
    },
    isProviderReady: async (provider: TtsProviderId) => {
      await refreshRedactionValues();
      return Boolean(await secrets.read(
        provider === 'google' ? 'GOOGLE_TTS_API_KEY' : 'ELEVENLABS_API_KEY',
      ));
    },
    refreshRedactionValues,
    redactValues: () => [...configuredSecrets],
  });
  return { runtime, queue };
}

export async function runWorkerMain(): Promise<void> {
  const application = await createDefaultWorkerApplication();
  const keepAlive = startWorkerKeepAlive();
  let resolveStop: (() => void) | undefined;
  const stop = (): void => resolveStop?.();
  const onMessage = (message: unknown): void => {
    if (isShutdownMessage(message)) stop();
  };
  let failed = false;
  let failure: unknown;
  try {
    await application.runtime.start();
    await Promise.race([
      new Promise<void>((resolvePromise) => {
        resolveStop = resolvePromise;
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        process.on('message', onMessage);
      }),
      application.runtime.waitForFailure(),
    ]);
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    await application.runtime.stop();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('message', onMessage);
    stopWorkerKeepAlive(keepAlive);
    application.queue.close();
    if (process.connected) process.disconnect();
  }

  if (failed) throw failure;
}

function isShutdownMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as { type?: unknown }).type === 'shutdown';
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  void runWorkerMain().catch(() => {
    process.exitCode = 1;
  });
}
