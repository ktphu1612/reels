import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReelForgeError, RenderJobSchema, createErrorPayload, type ProjectV2, type TtsProvider } from '@reelforge/core';
import { QueueStore } from '@reelforge/queue';
import {
  AssetStore,
  ProjectStore,
  ResourceStore,
  TemplateStore,
  createAppPaths,
  ensureAppDirectories,
} from '@reelforge/storage';
import { EnvSecretStore, TtsCache } from '@reelforge/tts';
import { afterEach, describe, expect, it } from 'vitest';

import * as serverApi from './app.js';

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = unknown>(): T;
  rawPayload: Buffer;
}

interface TestServer {
  inject(options: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<InjectResponse>;
  close(): Promise<void>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createHarness(provider?: TtsProvider) {
  const root = await mkdtemp(join(tmpdir(), 'reelforge-server-'));
  temporaryDirectories.push(root);
  const paths = createAppPaths(root);
  await ensureAppDirectories(paths);
  const assets = new AssetStore(paths);
  const resources = new ResourceStore(paths, assets);
  const projects = new ProjectStore(paths, assets);
  const templates = new TemplateStore(paths, assets);
  const queue = new QueueStore({ databasePath: join(paths.data, 'queue.sqlite'), defaultOutputDirectory: paths.outputs });
  const secrets = new EnvSecretStore(join(root, '.env.local'));
  const defaultProvider: TtsProvider = provider ?? {
    validateCredentials: async () => ({ ready: true }),
    listVoices: async (request) => ({ voices: [{ id: 'voice-1', name: 'Voice One', languageCode: request.languageCode ?? 'vi-VN' }] }),
    synthesize: async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }),
  };
  const opened: string[] = [];
  const sensitiveValues = new Set<string>();
  const refreshRedactionValues = async (): Promise<void> => {
    const values = await Promise.all([
      secrets.read('GOOGLE_TTS_API_KEY'),
      secrets.read('ELEVENLABS_API_KEY'),
    ]);
    for (const value of values) if (value) sensitiveValues.add(value);
  };
  return {
    root,
    paths,
    assets,
    resources,
    projects,
    templates,
    queue,
    secrets,
    opened,
    dependencies: {
      paths,
      resources,
      projects,
      templates,
      queue,
      secrets,
      providers: { google: defaultProvider, elevenlabs: defaultProvider },
      cache: new TtsCache(paths),
      openOutputDirectory: async (path: string) => { opened.push(path); },
      redactValues: () => [...sensitiveValues],
      refreshRedactionValues,
      eventPollIntervalMilliseconds: 10,
      heartbeatMilliseconds: 20,
    },
  };
}

function requireFactory(): (dependencies: unknown) => TestServer {
  const factory = (serverApi as Record<string, unknown>).buildServer;
  expect(typeof factory).toBe('function');
  return factory as (dependencies: unknown) => TestServer;
}

describe('Fastify project and template contracts', () => {
  it('serves the production SPA without exposing dotfiles, source maps, or traversed files', async () => {
    const harness = await createHarness();
    const webRoot = join(harness.root, 'web-dist');
    await mkdir(join(webRoot, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(webRoot, 'index.html'), '<!doctype html><title>ReelForge production</title>'),
      writeFile(join(webRoot, 'assets', 'app.js'), 'window.REELFORGE=true'),
      writeFile(join(webRoot, 'assets', 'app.js.map'), '{"secret":"source-map"}'),
      writeFile(join(webRoot, '.env.local'), 'GOOGLE_TTS_API_KEY=must-not-leak'),
    ]);
    let app: TestServer | undefined;
    try {
      app = requireFactory()({ ...harness.dependencies, webRoot });
      const spa = await app.inject({ method: 'GET', url: '/projects/example' });
      expect(spa.statusCode).toBe(200);
      expect(spa.headers['content-type']).toContain('text/html');
      expect(spa.body).toContain('ReelForge production');
      expect(spa.headers['cache-control']).toContain('no-cache');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      expect(asset.headers['cache-control']).toContain('immutable');

      for (const url of ['/assets/app.js.map', '/.env.local', '/%2e%2e/.env.local']) {
        const rejected = await app.inject({ method: 'GET', url });
        expect([400, 404], `expected ${url} to be rejected`).toContain(rejected.statusCode);
        expect(rejected.body).not.toContain('must-not-leak');
        expect(rejected.body).not.toContain('source-map');
      }
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ status: 'ok' });
      const missingApi = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.headers['content-type']).toContain('application/json');
      expect(missingApi.body).not.toContain('ReelForge production');
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('serves only canonical managed assets with MIME and single-range video seeking', async () => {
    // Production break caught: the editor either cannot seek managed video or an asset route can become an arbitrary local-file reader.
    const harness = await createHarness();
    const source = join(harness.root, 'range-source.mp4');
    const bytes = mp4Bytes();
    await writeFile(source, bytes);
    const asset = await harness.assets.importFile(source, 'background');
    const filename = asset.relativePath.slice('assets/'.length);
    let app: TestServer | undefined;
    try {
      app = requireFactory()(harness.dependencies);
      const full = await app.inject({ method: 'GET', url: `/api/assets/${filename}` });
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toContain('video/mp4');
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.headers['content-length']).toBe(String(bytes.length));
      expect(full.rawPayload).toEqual(bytes);

      const range = await app.inject({
        method: 'GET',
        url: `/api/assets/${filename}`,
        headers: { range: 'bytes=4-7' },
      });
      expect(range.statusCode).toBe(206);
      expect(range.headers['content-range']).toBe(`bytes 4-7/${bytes.length}`);
      expect(range.headers['content-length']).toBe('4');
      expect(range.rawPayload).toEqual(bytes.subarray(4, 8));

      const unsatisfiable = await app.inject({
        method: 'GET', url: `/api/assets/${filename}`, headers: { range: 'bytes=999-' },
      });
      expect(unsatisfiable.statusCode).toBe(416);
      expect(unsatisfiable.headers['content-range']).toBe(`bytes */${bytes.length}`);

      for (const url of [
        '/api/assets/not-a-content-hash.mp4',
        '/api/assets/%2e%2e%2fprojects%2fprivate.json',
        `/api/assets/${filename.toUpperCase()}`,
      ]) {
        const rejected = await app.inject({ method: 'GET', url });
        expect([400, 404]).toContain(rejected.statusCode);
        expect(rejected.body).not.toContain(harness.root);
        expect(rejected.body).not.toContain('projects\\private');
      }
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('serves managed meme MP4 assets with video MIME and byte ranges', async () => {
    const harness = await createHarness();
    const source = join(harness.root, 'meme.mp4');
    const bytes = Buffer.concat([mp4Bytes(), Buffer.from([1, 2, 3, 4])]);
    await writeFile(source, bytes);
    let app: TestServer | undefined;
    try {
      const asset = await harness.assets.importFile(source, 'meme-video');
      const filename = asset.relativePath.slice('assets/'.length);
      app = requireFactory()(harness.dependencies);
      const response = await app.inject({ method: 'GET', url: `/api/assets/${filename}` });
      expect(response.headers['content-type']).toContain('video/mp4');

      const rangeResponse = await app.inject({
        method: 'GET',
        url: `/api/assets/${filename}`,
        headers: { range: 'bytes=4-7' },
      });
      expect(rangeResponse.statusCode).toBe(206);
      expect(rangeResponse.headers['accept-ranges']).toBe('bytes');
      expect(rangeResponse.rawPayload).toEqual(bytes.subarray(4, 8));
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('lists managed resources without source paths and serves MP3 ranges', async () => {
    const harness = await createHarness();
    const sourceDirectory = join(harness.root, 'meme sounds');
    const bytes = Buffer.from('ID3Klonk');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'Klonk.mp3'), bytes);
    await harness.resources.seedDirectories([{ directory: sourceDirectory, kind: 'meme-sound' }]);
    let app: TestServer | undefined;
    try {
      app = requireFactory()(harness.dependencies);
      const listed = await app.inject({ method: 'GET', url: '/api/resources?kind=meme-sound' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ resources: Array<{ kind: string; name: string; assetPath: string }> }>().resources).toMatchObject([
        {
          kind: 'meme-sound',
          name: 'Klonk.mp3',
          assetPath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.mp3$/),
        },
      ]);
      expect(listed.body).not.toContain(harness.root);

      const resource = listed.json<{ resources: Array<{ assetPath: string }> }>().resources[0];
      const filename = resource.assetPath.slice('assets/'.length);
      const range = await app.inject({
        method: 'GET',
        url: `/api/assets/${filename}`,
        headers: { range: 'bytes=0-2' },
      });
      expect(range.statusCode).toBe(206);
      expect(range.headers['content-type']).toBe('audio/mpeg');
      expect(range.headers['content-range']).toBe(`bytes 0-2/${bytes.length}`);
      expect(range.rawPayload).toEqual(bytes.subarray(0, 3));
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('implements health, project CRUD/import/duplicate/card multipart, and template multipart/list/get/delete', async () => {
    // Production break caught: a stable route can be missing, accept escaping paths, or fail to preserve canonical imported assets.
    const harness = await createHarness();
    let app: TestServer | undefined;
    try {
      app = requireFactory()(harness.dependencies);
      await expect(app.inject({ method: 'GET', url: '/api/health' })).resolves.toMatchObject({ statusCode: 200 });

      const templateUpload = multipart([
        { name: 'name', value: 'Gameplay template' },
        { name: 'layout', value: JSON.stringify({ cardSlot: { x: 0.1, y: 0.2, width: 0.7, height: 0.3 } }) },
        { name: 'background', filename: '../../host.mp4', contentType: 'video/mp4', bytes: mp4Bytes() },
        { name: 'thumbnail', filename: 'thumbnail.jpg', contentType: 'image/jpeg', bytes: jpegBytes() },
      ]);
      const templateResponse = await app.inject({ method: 'POST', url: '/api/templates/import', ...templateUpload });
      expect(templateResponse.statusCode).toBe(201);
      const template = templateResponse.json<{ id: string; backgroundPath: string; cardSlot: unknown }>();
      expect(template).toMatchObject({
        backgroundPath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.mp4$/),
        cardSlot: { x: 0.1, y: 0.2, width: 0.7, height: 0.3 },
      });
      expect((await app.inject({ method: 'GET', url: '/api/templates' })).json<{ templates: unknown[] }>().templates).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: `/api/templates/${template.id}` })).statusCode).toBe(200);

      const createdResponse = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Episode one',
          templateId: template.id,
          tts: { provider: 'google', voiceId: 'voice-1', speakingRate: 1 },
        },
      });
      expect(createdResponse.statusCode).toBe(201);
      const created = createdResponse.json<ProjectV2>();

      const cardUpload = multipart([
        { name: 'script', value: 'Xin chào' },
        { name: 'image', filename: '..\\..\\private.png', contentType: 'image/png', bytes: pngBytes() },
      ]);
      const cardResponse = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/cards`, ...cardUpload });
      expect(cardResponse.statusCode).toBe(201);
      const card = cardResponse.json<{ imagePath: string }>();
      expect(card.imagePath).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
      await expect(readdir(join(harness.paths.data, 'uploads'))).resolves.toEqual([]);

      const fetched = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json<ProjectV2>();
      const renamed = { ...fetched, name: 'Renamed episode' };
      expect((await app.inject({ method: 'PUT', url: `/api/projects/${created.id}`, payload: renamed })).json<ProjectV2>().name).toBe('Renamed episode');
      const duplicate = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/duplicate`, payload: { name: 'Episode copy' } });
      expect(duplicate.statusCode).toBe(201);
      expect(duplicate.json<ProjectV2>()).toMatchObject({ name: 'Episode copy', cards: [{ imagePath: card.imagePath }] });

      const imported = await app.inject({
        method: 'POST',
        url: '/api/projects/import',
        payload: { ...fetched, id: 'imported-project', name: 'Imported episode' },
      });
      expect(imported.statusCode).toBe(201);
      expect((await app.inject({ method: 'GET', url: '/api/projects' })).json<{ projects: unknown[] }>().projects).toHaveLength(3);

      expect((await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` })).statusCode).toBe(204);
      expect((await app.inject({ method: 'DELETE', url: `/api/templates/${template.id}` })).statusCode).toBe(204);
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('imports a blank multipart card with a three-second hold', async () => {
    const harness = await createHarness();
    let app: TestServer | undefined;
    try {
      app = requireFactory()(harness.dependencies);
      const created = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Blank card project',
          templateId: 'template-1',
          tts: { provider: 'google', voiceId: 'voice-1', speakingRate: 1 },
        },
      });
      const project = created.json<{ id: string }>();

      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/cards`,
        ...multipart([
          { name: 'script', value: '' },
          { name: 'image', filename: 'card.png', contentType: 'image/png', bytes: pngBytes() },
        ]),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ script: '', holdSeconds: 3 });
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });
});

describe('Fastify settings, TTS, queue, and error contracts', () => {
  it('refreshes the shared redaction source after credential rotation and clear', async () => {
    // Production break caught: startup-captured keys let a newly saved credential leak through later structured adapter errors.
    const rotatedKey = 'server-rotated-secret-2468';
    const provider = {
      ...providerWithDefaults(),
      validateCredentials: async () => {
        throw new ReelForgeError(createErrorPayload(
          'PROVIDER_UNAVAILABLE',
          `${rotatedKey} at C:\\Users\\Operator Name\\Provider Logs\\failure.txt`,
        ));
      },
    } satisfies TtsProvider;
    const harness = await createHarness(provider);
    let app: TestServer | undefined;
    try {
      app = requireFactory()(harness.dependencies);
      expect((await app.inject({
        method: 'PUT', url: '/api/settings', payload: { googleApiKey: rotatedKey },
      })).statusCode).toBe(200);
      const afterRotation = await app.inject({
        method: 'POST', url: '/api/tts/credentials/validate', payload: { provider: 'google' },
      });
      expect(afterRotation.statusCode).toBe(503);
      expect(afterRotation.body).not.toContain(rotatedKey);
      expect(afterRotation.body).not.toContain('C:\\Users');

      expect((await app.inject({
        method: 'PUT', url: '/api/settings', payload: { googleApiKey: null },
      })).statusCode).toBe(200);
      const afterClear = await app.inject({
        method: 'POST', url: '/api/tts/credentials/validate', payload: { provider: 'google' },
      });
      expect(afterClear.body).not.toContain(rotatedKey);
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('masks credential settings and implements provider, preview, enqueue, cancel, retry, status, and opener routes', async () => {
    // Production break caught: secrets can round-trip through settings or queue snapshots, and control routes can diverge from durable state.
    const fixtureKey = 'api-fixture-secret-9876';
    const harness = await createHarness();
    const background = join(harness.root, 'background.mp4');
    const image = join(harness.root, 'card.png');
    await Promise.all([writeFile(background, mp4Bytes()), writeFile(image, pngBytes())]);
    const template = await harness.templates.import({ name: 'Gameplay', backgroundFile: background });
    const project = await harness.projects.create({
      name: 'Queued episode',
      templateId: template.id,
      tts: { provider: 'google', voiceId: 'voice-1', speakingRate: 1 },
    });
    await harness.projects.importCardImage(project.id, image, 'Xin chào');
    let app: TestServer | undefined;
    const responses: string[] = [];
    try {
      app = requireFactory()(harness.dependencies);
      const updated = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { outputDirectory: join(harness.root, 'renders'), concurrency: 2, googleApiKey: fixtureKey },
      });
      responses.push(updated.body);
      expect(updated.json<{ concurrency: number; providers: { google: { ready: boolean; maskedKey?: string } } }>()).toMatchObject({
        concurrency: 2,
        providers: { google: { ready: true, maskedKey: expect.stringMatching(/9876$/) } },
      });
      expect(updated.body).not.toContain(fixtureKey);
      expect((await app.inject({ method: 'GET', url: '/api/settings' })).body).not.toContain(fixtureKey);

      expect((await app.inject({ method: 'POST', url: '/api/tts/credentials/validate', payload: { provider: 'google' } })).json()).toEqual({ ready: true });
      expect((await app.inject({ method: 'GET', url: '/api/tts/voices?provider=google&languageCode=vi-VN' })).json()).toEqual({
        voices: [{ id: 'voice-1', name: 'Voice One', languageCode: 'vi-VN' }],
      });
      const preview = await app.inject({
        method: 'POST',
        url: '/api/tts/preview',
        payload: { provider: 'google', voiceId: 'voice-1', text: 'Preview', speakingRate: 1, audioFormat: 'mp3' },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toContain('audio/mpeg');
      expect(preview.rawPayload).toEqual(Buffer.from('sound'));

      const enqueue = await app.inject({ method: 'POST', url: '/api/jobs/enqueue', payload: { projectIds: [project.id] } });
      // Production break caught: public job responses can leak queue-only fields that strict web clients reject.
      const queued = RenderJobSchema.parse(enqueue.json<{ jobs: unknown[] }>().jobs[0]);
      expect(enqueue.statusCode).toBe(202);
      expect(enqueue.body).not.toContain('outputPath');
      await harness.projects.save({ ...await harness.projects.get(project.id), name: 'Mutated after enqueue' });
      const detail = await app.inject({ method: 'GET', url: `/api/jobs/${queued.id}` });
      expect(detail.json<typeof queued>().snapshot.project.name).toBe('Queued episode');
      expect(detail.body).not.toContain('outputPath');
      const listing = await app.inject({ method: 'GET', url: '/api/jobs' });
      expect(listing.json<{ jobs: unknown[] }>().jobs).toHaveLength(1);
      expect(listing.body).not.toContain('outputPath');
      const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/cancel` });
      expect(cancelled.json<{ status: string }>().status).toBe('cancelled');
      expect(cancelled.body).not.toContain('outputPath');
      const retried = await app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/retry` });
      expect(retried.json<{ status: string }>().status).toBe('queued');
      expect(retried.body).not.toContain('outputPath');

      expect((await app.inject({ method: 'POST', url: '/api/system/open-output-directory' })).statusCode).toBe(204);
      expect(harness.opened).toEqual([join(harness.root, 'renders')]);
      const cleared = await app.inject({ method: 'PUT', url: '/api/settings', payload: { googleApiKey: null } });
      expect(cleared.json<{ providers: { google: { ready: boolean } } }>().providers.google.ready).toBe(false);

      const persistedProject = await readFile(join(harness.paths.projects, project.id, 'project.json'), 'utf8');
      const databaseBytes = await Promise.all([join(harness.paths.data, 'queue.sqlite'), join(harness.paths.data, 'queue.sqlite-wal'), join(harness.paths.data, 'queue.sqlite-shm')].map((path) => readFile(path).catch(() => Buffer.alloc(0))));
      expect([persistedProject, ...responses, ...databaseBytes.map((bytes) => bytes.toString('latin1')), JSON.stringify(harness.queue.readLogs(queued.id))].join('\n')).not.toContain(fixtureKey);
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('returns structured safe errors without stacks, provider URLs, secrets, or raw filesystem paths', async () => {
    // Production break caught: adapter or filesystem exceptions can cross the local HTTP boundary verbatim.
    const fixtureKey = 'error-secret-key-1234';
    const provider = {
      ...providerWithDefaults(),
      synthesize: async () => { throw new Error(`C:\\Users\\operator\\private at https://provider.invalid?key=${fixtureKey}`); },
    } satisfies TtsProvider;
    const harness = await createHarness(provider);
    let app: TestServer | undefined;
    try {
      app = requireFactory()(harness.dependencies);
      const response = await app.inject({
        method: 'POST',
        url: '/api/tts/preview',
        payload: { provider: 'google', voiceId: 'voice', text: 'fail', speakingRate: 1, audioFormat: 'mp3' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: 'INTERNAL', message: 'Request could not be completed' });
      expect(response.body).not.toContain(fixtureKey);
      expect(response.body).not.toContain('provider.invalid');
      expect(response.body).not.toContain('C:\\Users');
      expect(response.body).not.toContain('stack');
      expect((await app.inject({ method: 'GET', url: '/api/projects/missing' })).json()).toEqual({ code: 'NOT_FOUND', message: 'Project was not found' });
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });

  it('normalizes preview synthesis to 1x and applies the requested local speed', async () => {
    const requests: Array<{ speakingRate: number }> = [];
    const provider = createPreviewAudioProvider(requests);
    const harness = await createHarness(provider);
    let app: TestServer | undefined;
    try {
      app = requireFactory()(harness.dependencies);
      const preview = await app.inject({
        method: 'POST',
        url: '/api/tts/preview',
        payload: {
          provider: 'google',
          voiceId: 'voice-1',
          text: 'Preview',
          speakingRate: 1.5,
          audioFormat: 'mp3',
        },
      });

      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toContain('audio/wav');
      expect(preview.rawPayload.byteLength).toBeGreaterThan(44);
      expect(requests).toEqual([{ speakingRate: 1 }]);
    } finally {
      await app?.close();
      harness.queue.close();
    }
  });
});

function createPreviewAudioProvider(requests: Array<{ speakingRate: number }>): TtsProvider {
  return {
    validateCredentials: async () => ({ ready: true }),
    listVoices: async () => ({ voices: [] }),
    synthesize: async (request) => {
      requests.push({ speakingRate: request.speakingRate });
      return { audioBase64: createPcmWav(0.2).toString('base64'), contentType: 'audio/mpeg' };
    },
  };
}

function createPcmWav(durationSeconds: number): Buffer {
  const sampleRate = 48_000;
  const samples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function providerWithDefaults(): TtsProvider {
  return {
    validateCredentials: async () => ({ ready: true }),
    listVoices: async () => ({ voices: [] }),
    synthesize: async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }),
  };
}

type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; bytes: Buffer };

function multipart(parts: readonly MultipartPart[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `reelforge-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in part) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
      ));
      chunks.push(part.bytes);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function pngBytes(): Buffer {
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
}

function jpegBytes(): Buffer {
  return Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 255, 217]);
}

function mp4Bytes(): Buffer {
  return Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
}
