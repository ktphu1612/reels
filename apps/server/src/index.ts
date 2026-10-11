import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { QueueStore } from '@reelforge/queue';
import {
  AssetStore,
  ProjectStore,
  ResourceStore,
  TemplateStore,
  createAppPaths,
  ensureAppDirectories,
} from '@reelforge/storage';
import { ElevenLabsTtsProvider, EnvSecretStore, GoogleTtsProvider, TtsCache } from '@reelforge/tts';

import { buildServer, resolveServerHost, startServer } from './app.js';

export * from './app.js';

export async function createDefaultServer(
  baseDirectory = process.env.REELFORGE_HOME || process.cwd(),
  staticDirectory?: string,
  resourceSourceDirectory = process.cwd(),
) {
  const paths = createAppPaths(baseDirectory);
  await ensureAppDirectories(paths);
  const assets = new AssetStore(paths);
  const resources = new ResourceStore(paths, assets);
  const seedResult = await resources.seedDirectories([
    { directory: resolve(resourceSourceDirectory, 'stickers'), kind: 'meme' },
    { directory: resolve(resourceSourceDirectory, 'meme sounds'), kind: 'meme-sound' },
    { directory: resolve(resourceSourceDirectory, 'transition sound'), kind: 'transition-sound' },
    { directory: resolve(resourceSourceDirectory, 'intro sounds'), kind: 'intro-sound' },
    { directory: resolve(resourceSourceDirectory, 'background audio'), kind: 'background-music' },
  ]);
  for (const error of seedResult.errors) {
    process.stderr.write(`${JSON.stringify({ name: error.name, code: error.code })}\n`);
  }
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
  const app = buildServer({
    paths,
    resources,
    ...(staticDirectory ? { staticDirectory } : {}),
    projects: new ProjectStore(paths, assets),
    templates: new TemplateStore(paths, assets),
    queue,
    secrets,
    providers,
    cache: new TtsCache(paths),
    openOutputDirectory: openDirectory,
    refreshRedactionValues,
    redactValues: () => [...configuredSecrets],
  });
  return { app, queue };
}

export async function runServerMain(): Promise<void> {
  const staticDirectory = process.env.REELFORGE_WEB_DIST
    || fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const { app, queue } = await createDefaultServer(
    process.env.REELFORGE_HOME || process.cwd(),
    staticDirectory,
  );
  const requestedPort = Number(process.env.REELFORGE_PORT ?? 3000);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535
    ? requestedPort
    : 3000;
  const host = resolveServerHost(process.env.REELFORGE_HOST);
  const address = await startServer(app, port, host);
  process.stdout.write(`ReelForge API listening at ${address}\n`);
  const stop = (): void => resolveStop?.();
  const onMessage = (message: unknown): void => {
    if (isShutdownMessage(message)) stop();
  };
  let resolveStop: (() => void) | undefined;
  try {
    await new Promise<void>((resolvePromise) => {
      resolveStop = resolvePromise;
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.on('message', onMessage);
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('message', onMessage);
    await app.close();
    queue.close();
    if (process.connected) process.disconnect();
  }
}

function isShutdownMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as { type?: unknown }).type === 'shutdown';
}

async function openDirectory(path: string): Promise<void> {
  const command = process.platform === 'win32'
    ? { executable: 'explorer.exe', args: [path] }
    : process.platform === 'darwin'
      ? { executable: 'open', args: [path] }
      : { executable: 'xdg-open', args: [path] };
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn(command.executable, command.args, {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', rejectOpen);
    child.once('spawn', () => {
      child.unref();
      resolveOpen();
    });
  });
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  void runServerMain().catch(() => {
    process.exitCode = 1;
  });
}
