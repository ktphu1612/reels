import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TtsProvider } from '@reelforge/core';
import { QueueStore } from '@reelforge/queue';
import { AssetStore, ProjectStore, TemplateStore, createAppPaths, ensureAppDirectories } from '@reelforge/storage';
import { EnvSecretStore, TtsCache } from '@reelforge/tts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer, startServer } from './app.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createDependencies(root: string, staticDirectory?: string) {
  const paths = createAppPaths(root);
  await ensureAppDirectories(paths);
  const assets = new AssetStore(paths);
  const projects = new ProjectStore(paths, assets);
  const templates = new TemplateStore(paths, assets);
  const queue = new QueueStore({ databasePath: join(paths.data, 'queue.sqlite'), defaultOutputDirectory: paths.outputs });
  const secrets = new EnvSecretStore(join(root, '.env.local'));
  const provider: TtsProvider = {
    validateCredentials: async () => ({ ready: true }),
    listVoices: async () => ({ voices: [] }),
    synthesize: async () => ({ audioBase64: 'c29tZQ==', contentType: 'audio/mpeg' }),
  };
  return {
    dependencies: {
      paths,
      projects,
      templates,
      queue,
      secrets,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(paths),
      openOutputDirectory: async () => undefined,
      ...(staticDirectory === undefined ? {} : { staticDirectory }),
    },
    queue,
  };
}

describe('production packaging server', () => {
  it('serves same-origin SPA routes, safe static files, and rejects traversal/dotfiles/maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-server-packaging-'));
    roots.push(root);
    const staticDirectory = join(root, 'web-dist');
    await writeFile(join(root, 'outside-secret.txt'), 'must-not-leak', 'utf8');
    await writeFile(join(await import('node:fs/promises').then(({ mkdir }) => mkdir(staticDirectory, { recursive: true }).then(() => staticDirectory)), 'index.html'), '<html>spa</html>', 'utf8');
    await writeFile(join(staticDirectory, 'app.js'), 'console.log("safe");', 'utf8');
    await writeFile(join(staticDirectory, '.env'), 'SECRET=must-not-leak', 'utf8');
    await writeFile(join(staticDirectory, 'app.js.map'), '{"version":3}', 'utf8');
    const harness = await createDependencies(root, staticDirectory);
    const app = buildServer(harness.dependencies);
    try {
      const spa = await app.inject({ method: 'GET', url: '/projects/abc' });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain('<html>spa</html>');

      const asset = await app.inject({ method: 'GET', url: '/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('safe');

      const assetRange = await app.inject({
        method: 'GET',
        url: '/app.js',
        headers: { range: 'bytes=0-5' },
      });
      expect(assetRange.statusCode).toBe(206);
      expect(assetRange.headers['content-range']).toBe('bytes 0-5/20');
      expect(assetRange.headers['content-length']).toBe('6');
      expect(assetRange.body).toBe('consol');

      for (const url of ['/.env', '/app.js.map', '/..%2Foutside-secret.txt', '/%2e%2e%2foutside-secret.txt']) {
        const rejected = await app.inject({ method: 'GET', url });
        expect([400, 404]).toContain(rejected.statusCode);
        expect(rejected.body).not.toContain('must-not-leak');
      }
    } finally {
      await app.close();
      harness.queue.close();
    }
  });

  it('rejects non-loopback host configuration before opening a listener', async () => {
    const app = { listen: async () => { throw new Error('listener should not be called'); } } as never;
    await expect(startServer(app, 0, '0.0.0.0')).rejects.toThrow(/127\.0\.0\.1/);
  });
});
