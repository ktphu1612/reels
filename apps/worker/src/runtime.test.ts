import { rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ReelForgeError, createErrorPayload, type RenderJobSnapshot, type TtsProvider } from '@reelforge/core';
import { QueueStore, type WorkerLeaseFence } from '@reelforge/queue';
import { preflightRender, type RenderOperation, type RenderPreflightRequest, type RenderVideoOptions, type RenderVideoRequest, type RenderVideoResult } from '@reelforge/renderer';
import { createAppPaths, ensureAppDirectories } from '@reelforge/storage';
import { TtsCache } from '@reelforge/tts';
import { afterEach, describe, expect, it } from 'vitest';

import * as workerApi from './runtime.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createHarness(concurrency = 1) {
  const root = await mkdtemp(join(tmpdir(), 'reelforge-worker-'));
  temporaryDirectories.push(root);
  const paths = createAppPaths(root);
  await ensureAppDirectories(paths);
  const queue = new QueueStore({ databasePath: join(paths.data, 'queue.sqlite'), defaultOutputDirectory: paths.outputs });
  queue.updateSettings({ concurrency });
  return { root, paths, queue };
}

function snapshotFixture(projectId: string, script = 'Xin chào'): RenderJobSnapshot {
  return {
    project: {
      schemaVersion: 2,
      id: projectId,
      name: `Project ${projectId}`,
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'vi-VN-Neural2-A', speakingRate: 1 },
      output: { width: 720, height: 1280, fps: 30, crf: 20 },
      cards: [{ id: 'card-1', imagePath: 'assets/card.png', script, order: 0 }],
    },
    template: {
      schemaVersion: 2,
      id: 'template-1',
      name: 'Gameplay',
      backgroundPath: 'assets/background.mp4',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    },
  };
}

function providerWith(synthesize: TtsProvider['synthesize']): TtsProvider {
  return {
    validateCredentials: async () => ({ ready: true }),
    listVoices: async () => ({ voices: [] }),
    synthesize,
  };
}

function preparedRenderResult(
  outputPath: string,
  cleanupPendingPaths: readonly string[] = [],
): RenderVideoResult {
  return {
    outputPath,
    probe: { durationSeconds: 1, streams: [] },
    durationSeconds: 1,
    cleanupPendingPaths,
    publication: {
      partialPath: join(dirname(outputPath), `.${basename(outputPath)}.fixture.partial.mp4`),
      outputPath,
      publish: () => undefined,
      compensate: () => undefined,
    },
  };
}

describe('WorkerRuntime pipeline', () => {
  it('synthesizes at 1x and prepares the requested local speed before rendering', async () => {
    const harness = await createHarness();
    const requests: number[] = [];
    const renderer = {
      preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
      start: (request: RenderVideoRequest): RenderOperation => {
        expect(request.narrationAudioPaths[0]).toMatch(/\.wav$/);
        return {
          pid: 42,
          cancel: async () => undefined,
          completion: Promise.resolve(preparedRenderResult(join(harness.paths.outputs, `${request.jobId}.mp4`))),
        };
      },
    };
    const provider = providerWith(async (request) => {
      requests.push(request.speakingRate);
      return { audioBase64: createPcmWav(0.2).toString('base64'), contentType: 'audio/mpeg' };
    });
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer,
      isProviderReady: async () => true,
    });
    try {
      const snapshot = snapshotFixture('local-speed');
      snapshot.project.tts.speakingRate = 1.5;
      harness.queue.enqueue(snapshot);
      await runtime.runNext();
      expect(requests).toEqual([1]);
      expect(harness.queue.listJobs()[0]?.status).toBe('succeeded');
    } finally {
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  }, 60_000);

  it('keeps narration paths aligned with cards when a preceding card is blank', async () => {
    const harness = await createHarness();
    const synthesizedTexts: string[] = [];
    let renderRequest: RenderVideoRequest | undefined;
    const renderer = {
      preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
      start: (request: RenderVideoRequest): RenderOperation => {
        renderRequest = request;
        return {
          pid: 42,
          cancel: async () => undefined,
          completion: Promise.resolve(preparedRenderResult(join(harness.paths.outputs, `${request.jobId}.mp4`))),
        };
      },
    };
    const provider = providerWith(async (request) => {
      synthesizedTexts.push(request.text);
      return { audioBase64: createPcmWav(0.2).toString('base64'), contentType: 'audio/mpeg' };
    });
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer,
      isProviderReady: async () => true,
    });

    try {
      const snapshot = snapshotFixture('aligned-narration');
      snapshot.project.tts.speakingRate = 1.5;
      snapshot.project.cards[0]!.script = '';
      snapshot.project.cards[0]!.holdSeconds = 3;
      snapshot.project.cards.push({
        id: 'card-2',
        imagePath: 'assets/card.png',
        script: 'Card hai',
        order: 1,
      });
      harness.queue.enqueue(snapshot);

      await runtime.runNext();

      expect(synthesizedTexts).toEqual(['Card hai']);
      expect(renderRequest?.narrationAudioPaths).toHaveLength(2);
      expect(renderRequest?.narrationAudioPaths).toEqual([
        undefined,
        expect.stringMatching(/narration-1\.wav$/),
      ]);
    } finally {
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  }, 60_000);

  it('renders an all-blank project without checking provider readiness or synthesizing', async () => {
    const harness = await createHarness();
    let providerReadinessChecks = 0;
    let synthesisCalls = 0;
    let renderRequest: RenderVideoRequest | undefined;
    const renderer = {
      preflight: async (request: RenderPreflightRequest) => {
        expect(request.providerReady).toBe(true);
        return { assetCount: 2, availableBytes: 1_000_000_000 };
      },
      start: (request: RenderVideoRequest): RenderOperation => {
        renderRequest = request;
        return {
          pid: 42,
          cancel: async () => undefined,
          completion: Promise.resolve(preparedRenderResult(join(harness.paths.outputs, `${request.jobId}.mp4`))),
        };
      },
    };
    const provider = providerWith(async () => {
      synthesisCalls += 1;
      return { audioBase64: createPcmWav(0.2).toString('base64'), contentType: 'audio/mpeg' };
    });
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer,
      isProviderReady: async () => {
        providerReadinessChecks += 1;
        return false;
      },
    });

    try {
      const snapshot = snapshotFixture('blank-project');
      snapshot.project.cards[0]!.script = '';
      snapshot.project.cards[0]!.holdSeconds = 3;
      snapshot.project.cards.push({
        id: 'card-2',
        imagePath: 'assets/card.png',
        script: '',
        order: 1,
        holdSeconds: 4,
      });
      harness.queue.enqueue(snapshot);

      await runtime.runNext();

      expect(providerReadinessChecks).toBe(0);
      expect(synthesisCalls).toBe(0);
      expect(renderRequest?.narrationAudioPaths).toEqual([undefined, undefined]);
    } finally {
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  }, 60_000);

  it('fails before paid TTS when a selected meme sound is missing', async () => {
    const harness = await createHarness();
    await mkdir(join(harness.paths.data, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(harness.paths.data, 'assets', 'background.mp4'), 'background'),
      writeFile(join(harness.paths.data, 'assets', 'card.png'), 'card'),
      writeFile(join(harness.paths.data, 'assets', 'meme.png'), 'meme'),
    ]);
    const snapshot = snapshotFixture('missing-meme-sound');
    snapshot.project.cards[0]!.postCardMeme = {
      imagePath: 'assets/meme.png',
      soundPath: 'assets/missing-meme.mp3',
    };
    let synthesisCalls = 0;
    const provider = providerWith(async () => {
      synthesisCalls += 1;
      return { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' };
    });
    const renderer = {
      preflight: (request: RenderPreflightRequest) => preflightRender(request, {
        inspectMedia: async () => undefined,
        availableDiskBytes: async () => 1_000_000_000,
      }),
      start: () => {
        throw new Error('render must not start after preflight failure');
      },
    };
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer,
      isProviderReady: async () => true,
    });

    try {
      const job = harness.queue.enqueue(snapshot);
      await runtime.runNext();
      const failed = harness.queue.getJob(job.id);
      expect(synthesisCalls).toBe(0);
      expect(failed).toMatchObject({
        status: 'failed',
        error: {
          code: 'INVALID_INPUT',
          details: {
            issues: expect.arrayContaining([
              { code: 'ASSET_MISSING', asset: 'resource', cardId: 'card-1', resourceKind: 'meme-sound' },
            ]),
          },
        },
      });
      expect(JSON.stringify(failed?.error)).not.toContain('missing-meme.mp3');
    } finally {
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  });

  it('classifies an invalid intro sound path as intro-sound', async () => {
    const harness = await createHarness();
    await mkdir(join(harness.paths.data, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(harness.paths.data, 'assets', 'background.mp4'), 'background'),
      writeFile(join(harness.paths.data, 'assets', 'card.png'), 'card'),
    ]);
    const snapshot = snapshotFixture('missing-intro-sound');
    snapshot.project.introSoundPath = '../missing-intro.mp3';
    const provider = providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }));
    const renderer = {
      preflight: (request: RenderPreflightRequest) => preflightRender(request, {
        inspectMedia: async () => undefined,
        availableDiskBytes: async () => 1_000_000_000,
      }),
      start: () => {
        throw new Error('render must not start after preflight failure');
      },
    };
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer,
      isProviderReady: async () => true,
    });

    try {
      const job = harness.queue.enqueue(snapshot);
      await runtime.runNext();
      expect(harness.queue.getJob(job.id)).toMatchObject({
        status: 'failed',
        error: {
          code: 'INVALID_INPUT',
          details: {
            resourceKind: 'intro-sound',
          },
        },
      });
    } finally {
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  });

  it('refreshes redaction values before each attempt and sanitizes rotated provider errors', async () => {
    // Production break caught: a long-running worker can retain only startup credentials and persist a newly rotated key on failure.
    const harness = await createHarness();
    const retiredKey = 'worker-retired-secret-7531';
    const rotatedKey = 'worker-rotated-secret-8642';
    const sensitiveValues = new Set<string>();
    let currentKey = retiredKey;
    let refreshes = 0;
    let syntheses = 0;
    const provider = providerWith(async () => {
      syntheses += 1;
      if (syntheses === 1) {
        currentKey = rotatedKey;
        return { audioBase64: 'Zmlyc3Q=', contentType: 'audio/mpeg' };
      }
      throw new ReelForgeError(createErrorPayload(
        'PROVIDER_UNAVAILABLE',
        `${retiredKey} ${rotatedKey} open '/var/lib/private/file' path:/srv/private/file GET /api/jobs https://provider.test/api/jobs`,
      ));
    });
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer: { preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }), start: () => { throw new Error('unused'); } },
      isProviderReady: async () => true,
      refreshRedactionValues: async () => {
        refreshes += 1;
        sensitiveValues.add(currentKey);
      },
      redactValues: () => [...sensitiveValues],
    });
    try {
      const snapshot = snapshotFixture('rotated-worker-key');
      snapshot.project.cards.push({ id: 'card-2', imagePath: 'assets/card.png', script: 'Thẻ hai', order: 1 });
      const job = harness.queue.enqueue(snapshot);
      await runtime.runNext();
      const persisted = JSON.stringify({
        job: harness.queue.getJob(job.id),
        attempts: harness.queue.getAttempts(job.id),
        events: harness.queue.readEvents(),
        logs: harness.queue.readLogs(job.id),
      });
      expect(refreshes).toBeGreaterThanOrEqual(4);
      expect(persisted).not.toContain(retiredKey);
      expect(persisted).not.toContain(rotatedKey);
      expect(persisted).not.toContain('/var/lib/private/file');
      expect(persisted).not.toContain('/srv/private/file');
      expect(persisted).toContain('GET /api/jobs');
      expect(persisted).toContain('https://provider.test/api/jobs');
    } finally {
      harness.queue.close();
    }
  });

  it('uses one immutable output-directory setting for an entire attempt', async () => {
    // Production break caught: changing settings during synthesis can make preflight validate one directory while render publishes to another.
    const harness = await createHarness();
    const firstOutput = join(harness.root, 'first-output');
    const laterOutput = join(harness.root, 'later-output');
    harness.queue.updateSettings({ outputDirectory: firstOutput });
    const observed: string[] = [];
    const renderer = {
      preflight: async (request: RenderPreflightRequest) => {
        observed.push(request.outputDirectory);
        harness.queue.updateSettings({ outputDirectory: laterOutput });
        return { assetCount: 2, availableBytes: 1_000_000_000 };
      },
      start: (request: RenderVideoRequest): RenderOperation => {
        observed.push(request.outputDirectory);
        return {
          pid: 1,
          cancel: async () => undefined,
          completion: Promise.resolve(preparedRenderResult(
            join(request.outputDirectory, `${request.jobId}.mp4`),
          )),
        };
      },
    };
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      cache: new TtsCache(harness.paths),
      renderer,
      isProviderReady: async () => true,
    });
    try {
      harness.queue.enqueue(snapshotFixture('settings-snapshot'));
      await runtime.runNext();
      expect(observed).toEqual([firstOutput, firstOutput]);
    } finally {
      harness.queue.close();
    }
  });

  it('interrupts hung synthesis and publishes no cache entry when cancelled', async () => {
    // Production break caught: cancellation between cards cannot help when the current provider request never settles.
    const harness = await createHarness();
    const synthesisStarted = deferred<void>();
    let renderStarted = false;
    let receivedSignal: AbortSignal | undefined;
    const provider = providerWith(async (_request, options) => {
      const signal = options?.signal;
      receivedSignal = signal;
      synthesisStarted.resolve(undefined);
      if (!signal) throw new Error('worker omitted attempt abort signal');
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: () => {
          renderStarted = true;
          throw new Error('render must not start');
        },
      },
      isProviderReady: async () => true,
    });
    try {
      const job = harness.queue.enqueue(snapshotFixture('hung-tts'));
      const processing = runtime.runNext();
      await synthesisStarted.promise;
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      await withDeadline(runtime.cancel(job.id), 500);
      await processing;
      expect(harness.queue.getJob(job.id)).toMatchObject({ status: 'cancelled' });
      expect(renderStarted).toBe(false);
      expect(await readdir(harness.paths.ttsCache)).toEqual([]);
    } finally {
      harness.queue.close();
    }
  });

  it.each(['preflight', 'synthesis'] as const)('observes an API-process cancel while blocked in %s and terminalizes only after teardown', async (phase) => {
    // Production break caught: POST cancel mutates SQLite in another process but never reaches the attempt AbortController.
    const harness = await createHarness();
    const apiQueue = new QueueStore({
      databasePath: join(harness.paths.data, 'queue.sqlite'),
      defaultOutputDirectory: harness.paths.outputs,
    });
    const blocked = deferred<void>();
    const aborted = deferred<void>();
    const teardownStarted = deferred<void>();
    const allowTeardown = deferred<void>();
    let rejectBlocked: ((error: unknown) => void) | undefined;
    const waitForAttemptAbort = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) => {
      rejectBlocked = reject;
      blocked.resolve(undefined);
      const cancel = (): void => {
        aborted.resolve(undefined);
        reject(new ReelForgeError(createErrorPayload('CANCELLED', 'fixture cancelled')));
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
    const provider = providerWith(async (_request, options) => (
      phase === 'synthesis'
        ? waitForAttemptAbort(options?.signal)
        : { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }
    ));
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async (request) => (
          phase === 'preflight'
            ? waitForAttemptAbort(request.signal)
            : { assetCount: 2, availableBytes: 1_000_000_000 }
        ),
        start: () => { throw new Error('render must not start'); },
      },
      isProviderReady: async () => true,
      pollIntervalMilliseconds: 5,
      removePath: (path) => {
        teardownStarted.resolve(undefined);
        rmSync(path, { recursive: true, force: true });
      },
    });
    const job = harness.queue.enqueue(snapshotFixture(`api-cancel-${phase}`));
    const processing = runtime.runNext();
    let prompt = true;
    let fallbackCancellation: Promise<void> | undefined;
    try {
      await blocked.promise;
      apiQueue.cancel(job.id);
      try {
        await withDeadline(aborted.promise, 100);
      } catch {
        prompt = false;
        rejectBlocked?.(new ReelForgeError(createErrorPayload('CANCELLED', 'fixture cleanup fallback')));
        fallbackCancellation = runtime.cancel(job.id);
      }
      await teardownStarted.promise;
      allowTeardown.resolve(undefined);
      await fallbackCancellation;
      await processing;
      expect(prompt).toBe(true);
      expect(apiQueue.getJob(job.id)).toMatchObject({ status: 'cancelled' });
    } finally {
      allowTeardown.resolve(undefined);
      rejectBlocked?.(new ReelForgeError(createErrorPayload('CANCELLED', 'fixture cleanup')));
      await processing.catch(() => undefined);
      apiQueue.close();
      harness.queue.close();
    }
  });

  it('fails safely when a dependency reports CANCELLED without a durable cancel request', async () => {
    // Production break caught: unexpected cancellation tries an illegal cancelled transition and leaves the durable attempt running.
    const harness = await createHarness();
    const provider = providerWith(async () => {
      throw new ReelForgeError(createErrorPayload('CANCELLED', 'provider aborted unexpectedly'));
    });
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer: { preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }), start: () => { throw new Error('unused'); } },
      isProviderReady: async () => true,
    });
    try {
      const job = harness.queue.enqueue(snapshotFixture('unexpected-cancel'));
      await expect(runtime.runNext()).resolves.toBe(true);
      expect(harness.queue.getJob(job.id)).toMatchObject({ status: 'failed', cancelRequested: false });
      expect(harness.queue.getAttempts(job.id)).toEqual([
        expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'RENDER_FAILED' }) }),
      ]);
    } finally {
      harness.queue.close();
    }
  });

  it('terminalizes a cancelled attempt only after synchronous teardown completes', async () => {
    // Production break caught: exposing cancelled before cleanup permits retry to overlap the prior attempt and delete its workspace.
    const harness = await createHarness();
    const renderStarted = deferred<void>();
    const renderSettled = deferred<RenderVideoResult>();
    const cleanupStarted = deferred<void>();
    let cleanupCompleted = false;
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: () => {
          renderStarted.resolve(undefined);
          return {
            pid: 2,
            completion: renderSettled.promise,
            cancel: async () => {
              renderSettled.reject(new ReelForgeError(createErrorPayload('CANCELLED', 'cancelled')));
              await renderSettled.promise.catch(() => undefined);
            },
          };
        },
      },
      isProviderReady: async () => true,
      removePath: (path) => {
        cleanupStarted.resolve(undefined);
        rmSync(path, { recursive: true, force: true });
        cleanupCompleted = true;
      },
    });
    try {
      const job = harness.queue.enqueue(snapshotFixture('teardown-order'));
      const processing = runtime.runNext();
      await renderStarted.promise;
      const cancelling = runtime.cancel(job.id);
      await cleanupStarted.promise;
      await cancelling;
      await processing;
      expect(cleanupCompleted).toBe(true);
      expect(harness.queue.getJob(job.id)).toMatchObject({ status: 'cancelled', attempts: 1 });
      expect(harness.queue.retry(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    } finally {
      harness.queue.close();
    }
  });

  it('stop prevents backlog claims immediately and awaits only already-active attempts', async () => {
    // Production break caught: stop can remain inside drain and consume the entire queued backlog before process shutdown.
    const harness = await createHarness(1);
    const firstStarted = deferred<void>();
    const finishFirst = deferred<RenderVideoResult>();
    let starts = 0;
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: (request) => {
          starts += 1;
          if (starts === 1) firstStarted.resolve(undefined);
          return {
            pid: starts,
            cancel: async () => undefined,
            completion: starts === 1 ? finishFirst.promise : Promise.resolve(preparedRenderResult(
              join(harness.paths.outputs, `${request.jobId}.mp4`),
            )),
          };
        },
      },
      isProviderReady: async () => true,
      pollIntervalMilliseconds: 60_000,
    });
    try {
      harness.queue.enqueueBatch([snapshotFixture('stop-1'), snapshotFixture('stop-2'), snapshotFixture('stop-3')]);
      await runtime.start();
      await firstStarted.promise;
      const stopping = runtime.stop();
      finishFirst.resolve(preparedRenderResult(join(harness.paths.outputs, 'first.mp4')));
      await withDeadline(stopping, 500);
      expect(starts).toBe(1);
      expect(harness.queue.listJobs().map((job) => job.status)).toEqual(['succeeded', 'queued', 'queued']);
    } finally {
      harness.queue.close();
    }
  });

  it('passes a publication fence and cannot settle after the lease is taken over', async () => {
    const harness = await createHarness();
    const started = deferred<void>();
    const completion = deferred<RenderVideoResult>();
    let capturedOptions: Record<string, unknown> | undefined;
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: {
        google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
        elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
      },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: (_request: RenderVideoRequest, options?: RenderVideoOptions): RenderOperation => {
          capturedOptions = options as Record<string, unknown> | undefined;
          started.resolve(undefined);
          return { pid: 1, cancel: async () => undefined, completion: completion.promise };
        },
      },
      isProviderReady: async () => true,
      workerId: 'worker-a',
      leaseMilliseconds: 10_000,
      heartbeatMilliseconds: 10_000,
    });
    let processing: Promise<boolean> | undefined;

    try {
      const job = harness.queue.enqueue(snapshotFixture('publication-fence'));
      processing = runtime.runNext();
      await started.promise;

      const firstLease = harness.queue.getWorkerLease()!;
      expect(firstLease).toMatchObject({ ownerId: 'worker-a', fencingToken: 1 });
      expect(harness.queue.releaseWorkerLease('worker-a', firstLease.fencingToken)).toBe(true);
      const secondLease = harness.queue.acquireWorkerLease('worker-b', 10_000)!;
      expect(secondLease).toMatchObject({ ownerId: 'worker-b', fencingToken: 2 });

      const publicationGuard = capturedOptions?.publicationGuard as ((publication: {
        partialPath: string;
        outputPath: string;
        publish(): void;
        compensate(): void;
      }) => void) | undefined;
      expect(typeof publicationGuard).toBe('function');
      let guardError: unknown;
      try {
        publicationGuard!({
          partialPath: join(harness.paths.outputs, '.stale.partial.mp4'),
          outputPath: join(harness.paths.outputs, 'stale.mp4'),
          publish: () => undefined,
          compensate: () => undefined,
        });
      } catch (error) {
        guardError = error;
      }
      expect(guardError).toMatchObject({ payload: { code: 'CONFLICT' } });

      completion.resolve(preparedRenderResult(join(harness.paths.outputs, `${job.id}.mp4`)));
      await expect(processing).rejects.toMatchObject({ payload: { code: 'CONFLICT' } });
      expect(harness.queue.getJob(job.id)).toMatchObject({ status: 'running', attempts: 1 });
      expect(harness.queue.getAttempts(job.id)).toEqual([
        expect.objectContaining({ status: 'running' }),
      ]);
      expect(harness.queue.releaseWorkerLease('worker-b', secondLease.fencingToken)).toBe(true);
    } finally {
      completion.resolve(preparedRenderResult(join(harness.paths.outputs, 'cleanup.mp4')));
      await processing?.catch(() => undefined);
      const lease = harness.queue.getWorkerLease();
      if (lease) harness.queue.releaseWorkerLease(lease.ownerId, lease.fencingToken);
      harness.queue.close();
    }
  });

  it('does not use an unguarded renderer result as the worker production publication path', async () => {
    const harness = await createHarness();
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: {
        google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
        elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
      },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: (request: RenderVideoRequest): RenderOperation => ({
          pid: 77,
          cancel: async () => undefined,
          completion: Promise.resolve({
            outputPath: join(harness.paths.outputs, `${request.jobId}.mp4`),
            probe: { durationSeconds: 1, streams: [] },
            durationSeconds: 1,
            cleanupPendingPaths: [],
          }),
        }),
      },
      isProviderReady: async () => true,
    });

    try {
      const job = harness.queue.enqueue(snapshotFixture('unguarded-publication'));
      await runtime.runNext();
      expect(harness.queue.getJob(job.id)).toMatchObject({
        status: 'failed',
        error: expect.objectContaining({ code: 'INTERNAL' }),
      });
    } finally {
      harness.queue.close();
    }
  });

  it('stop releases the lease and rethrows a rejected polling loop', async () => {
    const harness = await createHarness();
    const originalGetSettings = harness.queue.getSettings.bind(harness.queue);
    let pollFailureObserved = false;
    (harness.queue as unknown as { getSettings: () => ReturnType<QueueStore['getSettings']> }).getSettings = () => {
      pollFailureObserved = true;
      throw new Error('injected poll failure');
    };
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: {
        google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
        elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
      },
      cache: new TtsCache(harness.paths),
      renderer: { preflight: async () => ({ assetCount: 0, availableBytes: 1 }), start: () => { throw new Error('unused'); } },
      isProviderReady: async () => true,
      workerId: 'poll-failure-worker',
    });

    try {
      await runtime.start();
      expect(pollFailureObserved).toBe(true);
      await expect(runtime.stop()).rejects.toThrow('injected poll failure');
      expect(harness.queue.getWorkerLease()).toBeUndefined();
    } finally {
      (harness.queue as unknown as { getSettings: () => ReturnType<QueueStore['getSettings']> }).getSettings = originalGetSettings;
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  });

  it('cancels active attempts when another task rejects the polling loop and preserves the loop error', async () => {
    const harness = await createHarness(2);
    const firstStarted = deferred<void>();
    const firstCompletion = deferred<RenderVideoResult>();
    const loopError = new Error('injected active poll failure');
    const loopFailed = deferred<void>();
    let firstCancelled = false;
    let starts = 0;
    const originalFail = harness.queue.fail.bind(harness.queue);
    const runtimeQueue = harness.queue as unknown as {
      fail: typeof harness.queue.fail;
    };
    runtimeQueue.fail = (...args: Parameters<QueueStore['fail']>) => {
      if (starts > 1) {
        loopFailed.resolve(undefined);
        throw loopError;
      }
      return originalFail(...args);
    };
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: {
        google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
        elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
      },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: (): RenderOperation => {
          starts += 1;
          if (starts > 1) throw new Error('second attempt should fail through queue');
          firstStarted.resolve(undefined);
          return {
            pid: 123,
            completion: firstCompletion.promise,
            cancel: async () => {
              firstCancelled = true;
              firstCompletion.reject(new ReelForgeError(createErrorPayload('CANCELLED', 'poll teardown')));
            },
          };
        },
      },
      isProviderReady: async () => true,
      pollIntervalMilliseconds: 5,
    });

    try {
      harness.queue.enqueueBatch([snapshotFixture('poll-active-one'), snapshotFixture('poll-active-two')]);
      await runtime.start();
      await firstStarted.promise;
      await loopFailed.promise;
      await waitUntil(() => harness.queue.getWorkerLease() === undefined, 500);
      expect(firstCancelled).toBe(true);
      const stopping = runtime.stop();
      const stoppedEarly = await Promise.race([
        stopping.then(() => false, () => false),
        new Promise<boolean>((resolveWait) => {
          const timer = setTimeout(() => resolveWait(true), 100);
          timer.unref();
        }),
      ]);
      expect(stoppedEarly).toBe(false);
      await expect(stopping).rejects.toBe(loopError);
      expect(firstCancelled).toBe(true);
      expect(harness.queue.getWorkerLease()).toBeUndefined();
    } finally {
      firstCompletion.reject(new ReelForgeError(createErrorPayload('CANCELLED', 'fixture cleanup')));
      await runtime.stop().catch(() => undefined);
      runtimeQueue.fail = originalFail;
      harness.queue.close();
    }
  });

  it('cancels remaining drain tasks before releasing the lease and rethrows the first task error', async () => {
    const harness = await createHarness(2);
    const secondStarted = deferred<void>();
    const secondCompletion = deferred<RenderVideoResult>();
    const drainError = new Error('injected drain task failure');
    let starts = 0;
    let secondCancelled = false;
    let failureInjected = false;
    const originalFail = harness.queue.fail.bind(harness.queue);
    (harness.queue as unknown as { fail: typeof harness.queue.fail }).fail = (...args: Parameters<QueueStore['fail']>) => {
      if (!failureInjected) {
        failureInjected = true;
        throw drainError;
      }
      return originalFail(...args);
    };
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: {
        google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
        elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
      },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: (request): RenderOperation => {
          starts += 1;
          if (starts === 1) {
            return {
              pid: 201,
              completion: Promise.reject(new ReelForgeError(createErrorPayload('RENDER_FAILED', 'first render failed'))),
              cancel: async () => undefined,
            };
          }
          secondStarted.resolve(undefined);
          return {
            pid: 202,
            completion: secondCompletion.promise,
            cancel: async () => {
              secondCancelled = true;
              expect(harness.queue.getWorkerLease()).toMatchObject({ ownerId: 'drain-failure-worker' });
              secondCompletion.reject(new ReelForgeError(createErrorPayload('CANCELLED', 'drain teardown')));
            },
          };
        },
      },
      isProviderReady: async () => true,
      workerId: 'drain-failure-worker',
      pollIntervalMilliseconds: 5,
    });

    try {
      harness.queue.enqueueBatch([
        snapshotFixture('drain-failure-one'),
        snapshotFixture('drain-active-two'),
      ]);
      const draining = runtime.drain();
      await secondStarted.promise;
      await expect(draining).rejects.toBe(drainError);
      expect(secondCancelled).toBe(true);
      expect(harness.queue.getWorkerLease()).toBeUndefined();
    } finally {
      secondCompletion.reject(new ReelForgeError(createErrorPayload('CANCELLED', 'fixture cleanup')));
      await runtime.stop().catch(() => undefined);
      (harness.queue as unknown as { fail: typeof harness.queue.fail }).fail = originalFail;
      harness.queue.close();
    }
  });

  it('rejects a second runtime while the first owns the queue worker lease', async () => {
    // Production break caught: per-process task counts do not enforce configured concurrency across two worker processes.
    const harness = await createHarness();
    const dependencies = {
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      cache: new TtsCache(harness.paths),
      renderer: { preflight: async () => ({ assetCount: 0, availableBytes: 1 }), start: () => { throw new Error('unused'); } },
      isProviderReady: async () => true,
    };
    const first = new workerApi.WorkerRuntime({ ...dependencies, workerId: 'worker-one' });
    const second = new workerApi.WorkerRuntime({ ...dependencies, workerId: 'worker-two' });
    try {
      await first.initialize();
      await expect(second.initialize()).rejects.toMatchObject({ payload: { code: 'CONFLICT' } });
      await first.stop();
      await expect(second.initialize()).resolves.toEqual({ requeued: 0, cancelled: 0 });
      await second.stop();
    } finally {
      harness.queue.close();
    }
  });

  it('keeps renewing its lease while stop waits for active attempts to settle', async () => {
    // Production break caught: releasing heartbeat at the start of stop lets another worker recover an attempt that is still running.
    const harness = await createHarness();
    const started = deferred<void>();
    const completion = deferred<RenderVideoResult>();
    const dependencies = {
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: () => {
          started.resolve(undefined);
          return { pid: 5, cancel: async () => undefined, completion: completion.promise };
        },
      },
      isProviderReady: async () => true,
      leaseMilliseconds: 40,
      heartbeatMilliseconds: 10,
    };
    const first = new workerApi.WorkerRuntime({ ...dependencies, workerId: 'stopping-worker' });
    const second = new workerApi.WorkerRuntime({
      ...dependencies,
      cache: new TtsCache(harness.paths),
      workerId: 'takeover-worker',
    });
    let stopping: Promise<void> | undefined;
    try {
      const job = harness.queue.enqueue(snapshotFixture('lease-during-stop'));
      await first.start();
      await started.promise;
      stopping = first.stop();
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      await expect(second.initialize()).rejects.toMatchObject({ payload: { code: 'CONFLICT' } });
      completion.resolve(preparedRenderResult(join(harness.paths.outputs, `${job.id}.mp4`)));
      await stopping;
      stopping = undefined;
      await expect(second.initialize()).resolves.toEqual({ requeued: 0, cancelled: 0 });
      await second.stop();
    } finally {
      completion.resolve(preparedRenderResult(join(harness.paths.outputs, 'cleanup.mp4')));
      await stopping?.catch(() => undefined);
      await first.stop().catch(() => undefined);
      await second.stop().catch(() => undefined);
      harness.queue.close();
    }
  });

  it.each(['runNext', 'drain'] as const)('keeps a fenced lease alive while %s runs longer than its TTL', async (method) => {
    // Production break caught: one-shot worker paths acquire a lease but never heartbeat, allowing takeover and recovery mid-attempt.
    const harness = await createHarness();
    const observerQueue = new QueueStore({
      databasePath: join(harness.paths.data, 'queue.sqlite'),
      defaultOutputDirectory: harness.paths.outputs,
    });
    const started = deferred<void>();
    const completion = deferred<RenderVideoResult>();
    const common = {
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: () => {
          started.resolve(undefined);
          return { pid: 9, cancel: async () => undefined, completion: completion.promise };
        },
      },
      isProviderReady: async () => true,
      leaseMilliseconds: 40,
      heartbeatMilliseconds: 10,
    };
    const first = new workerApi.WorkerRuntime({ ...common, queue: harness.queue, cache: new TtsCache(harness.paths), workerId: `first-${method}` });
    const second = new workerApi.WorkerRuntime({ ...common, queue: observerQueue, cache: new TtsCache(harness.paths), workerId: `second-${method}` });
    let execution: Promise<unknown> | undefined;
    let secondAcquired = false;
    try {
      const job = harness.queue.enqueue(snapshotFixture(`lease-${method}`));
      execution = first[method]();
      await started.promise;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      const takeover = await second.initialize().then(
        () => ({ acquired: true, error: undefined }),
        (error: unknown) => ({ acquired: false, error }),
      );
      secondAcquired = takeover.acquired;
      expect(takeover.error).toMatchObject({ payload: { code: 'CONFLICT' } });
      expect(observerQueue.getJob(job.id)).toMatchObject({ status: 'running', attempts: 1 });
      completion.resolve(preparedRenderResult(join(harness.paths.outputs, `${job.id}.mp4`)));
      await execution;
      execution = undefined;
      await first.stop();
      await expect(second.initialize()).resolves.toEqual({ requeued: 0, cancelled: 0 });
      secondAcquired = true;
    } finally {
      completion.resolve(preparedRenderResult(join(harness.paths.outputs, 'cleanup.mp4')));
      await execution?.catch(() => undefined);
      await first.stop().catch(() => undefined);
      if (secondAcquired || observerQueue.getWorkerLease()?.ownerId === `second-${method}`) {
        await second.stop().catch(() => undefined);
      }
      observerQueue.close();
      harness.queue.close();
    }
  });

  it('preflights without narration before synthesis, reuses cache, maps progress, and cleans successful workspaces', async () => {
    // Production break caught: provider spend can happen before readiness checks, cached audio can be ignored, or successful temp work can leak.
    const harness = await createHarness();
    const order: string[] = [];
    const removed: string[] = [];
    let synthesisCalls = 0;
    const provider = providerWith(async () => {
      order.push('synthesize');
      synthesisCalls += 1;
      return { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' };
    });
    const renderer = {
      preflight: async (request: RenderPreflightRequest) => {
        order.push('preflight');
        expect(request.narrationAudioPaths).toBeUndefined();
        await expect(readFile(join(request.tempDirectory, 'manifest.json'), 'utf8')).resolves.toContain('Project shared');
        return { assetCount: 2, availableBytes: 1_000_000_000 };
      },
      start: (request: RenderVideoRequest, options: RenderVideoOptions): RenderOperation => {
        order.push('render');
        expect(request.narrationAudioPaths).toHaveLength(1);
        options.onProgress?.(25);
        options.onProgress?.(10);
        options.onProgress?.(100);
        return {
          pid: 42,
          cancel: async () => undefined,
          completion: Promise.resolve(preparedRenderResult(
            join(harness.paths.outputs, `${request.jobId}.mp4`),
            [join(request.outputDirectory, `.${request.jobId}.mp4.fixture.partial.mp4`)],
          )),
        };
      },
    };
    const Runtime = (workerApi as Record<string, unknown>).WorkerRuntime as new (dependencies: unknown) => {
      drain(): Promise<void>;
    };
    try {
      expect(typeof Runtime).toBe('function');
      harness.queue.enqueueBatch([snapshotFixture('shared'), snapshotFixture('shared')]);
      const runtime = new Runtime({
        queue: harness.queue,
        paths: harness.paths,
        providers: { google: provider, elevenlabs: provider },
        cache: new TtsCache(harness.paths),
        renderer,
        isProviderReady: async () => {
          order.push('provider-ready');
          return true;
        },
      removePath: (path: string) => {
        removed.push(path);
        rmSync(path, { recursive: true, force: true });
      },
      });
      await runtime.drain();

      expect(order.slice(0, 4)).toEqual(['provider-ready', 'preflight', 'synthesize', 'render']);
      expect(synthesisCalls).toBe(1);
      expect(harness.queue.listJobs()).toEqual([
        expect.objectContaining({ status: 'succeeded', progress: 100, cleanupPendingPaths: [] }),
        expect.objectContaining({ status: 'succeeded', progress: 100, cleanupPendingPaths: [] }),
      ]);
      for (const job of harness.queue.listJobs()) {
        const progress = harness.queue.readEvents()
          .filter((event) => event.jobId === job.id && event.type === 'job.progress')
          .map((event) => (event.payload as { progress: number }).progress);
        expect(progress).toEqual([...progress].sort((left, right) => left - right));
      }
      expect(removed.some((path) => path.endsWith('partial.mp4'))).toBe(true);
      for (const job of harness.queue.listJobs()) {
        await expect(access(join(harness.paths.jobs, job.id, 'attempt-1'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      harness.queue.close();
    }
  });

  it('retains a safe failed workspace, retries with a later attempt, and cleans it after success', async () => {
    // Production break caught: failures can delete diagnostics, leak provider detail, or retry by overwriting attempt history.
    const harness = await createHarness();
    const fixtureKey = 'worker-secret-key-1234';
    let fail = true;
    const provider = providerWith(async () => {
      if (fail) {
        throw new ReelForgeError(createErrorPayload(
          'PROVIDER_UNAVAILABLE',
          `C:\\Users\\operator\\private provider URL https://provider.invalid?key=${fixtureKey}`,
        ));
      }
      return { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' };
    });
    const renderer = {
      preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
      start: (request: RenderVideoRequest): RenderOperation => ({
        pid: 1,
        cancel: async () => undefined,
          completion: Promise.resolve(preparedRenderResult(
            join(harness.paths.outputs, `${request.jobId}.mp4`),
          )),
      }),
    };
    const Runtime = (workerApi as Record<string, unknown>).WorkerRuntime as new (dependencies: unknown) => {
      runNext(): Promise<boolean>;
    };
    try {
      expect(typeof Runtime).toBe('function');
      const job = harness.queue.enqueue(snapshotFixture('retry'));
      const runtime = new Runtime({
        queue: harness.queue,
        paths: harness.paths,
        providers: { google: provider, elevenlabs: provider },
        cache: new TtsCache(harness.paths),
        renderer,
        isProviderReady: async () => true,
        redactValues: () => [fixtureKey],
      });
      await runtime.runNext();
      expect(harness.queue.getJob(job.id)).toMatchObject({ status: 'failed', attempts: 1 });
      const retained = join(harness.paths.jobs, job.id, 'attempt-1');
      const retainedText = `${await readFile(join(retained, 'manifest.json'), 'utf8')}\n${await readFile(join(retained, 'worker.log'), 'utf8')}`;
      expect(retainedText).not.toContain(fixtureKey);
      expect(JSON.stringify(harness.queue.readLogs(job.id))).not.toContain(fixtureKey);
      expect(JSON.stringify(harness.queue.getJob(job.id))).not.toContain(fixtureKey);
      const databaseBytes = await Promise.all([
        join(harness.paths.data, 'queue.sqlite'),
        join(harness.paths.data, 'queue.sqlite-wal'),
        join(harness.paths.data, 'queue.sqlite-shm'),
      ].map((path) => readFile(path).catch(() => Buffer.alloc(0))));
      expect(databaseBytes.map((bytes) => bytes.toString('latin1')).join('\n')).not.toContain(fixtureKey);

      harness.queue.retry(job.id);
      fail = false;
      await runtime.runNext();
      expect(harness.queue.getAttempts(job.id).map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
      await expect(access(join(harness.paths.jobs, job.id, 'attempt-1'))).resolves.toBeUndefined();
      await expect(access(join(harness.paths.jobs, job.id, 'attempt-2'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      harness.queue.close();
    }
  });

  it('cancels a running renderer and waits for settlement before marking the job cancelled', async () => {
    // Production break caught: API cancellation can return while FFmpeg still runs or mark cancellation before renderer settlement.
    const harness = await createHarness();
    const started = deferred<void>();
    const settled = deferred<RenderVideoResult>();
    let cancelled = false;
    let partialPath = '';
    const provider = providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }));
    const renderer = {
      preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
      start: (request: RenderVideoRequest): RenderOperation => {
        started.resolve(undefined);
        partialPath = join(request.outputDirectory, `.render-${request.jobId}.mp4.fixture.partial.mp4`);
        return {
          pid: 99,
          cleanupPendingPaths: [partialPath],
          completion: settled.promise,
          cancel: async () => {
            cancelled = true;
            settled.reject(new ReelForgeError(createErrorPayload('CANCELLED', 'Render was cancelled')));
            await settled.promise.catch(() => undefined);
          },
        };
      },
    };
    const Runtime = (workerApi as Record<string, unknown>).WorkerRuntime as new (dependencies: unknown) => {
      runNext(): Promise<boolean>;
      cancel(jobId: string): Promise<void>;
    };
    try {
      expect(typeof Runtime).toBe('function');
      const job = harness.queue.enqueue(snapshotFixture('cancel'));
      const runtime = new Runtime({
        queue: harness.queue,
        paths: harness.paths,
        providers: { google: provider, elevenlabs: provider },
        cache: new TtsCache(harness.paths),
        renderer,
        isProviderReady: async () => true,
        removePath: (path: string) => {
          if (path === partialPath) throw new Error('fixture partial is locked');
          rmSync(path, { recursive: true, force: true });
        },
      });
      const processing = runtime.runNext();
      await started.promise;
      await runtime.cancel(job.id);
      await processing;
      expect(cancelled).toBe(true);
      expect(harness.queue.getJob(job.id)).toMatchObject({
        status: 'cancelled',
        cleanupPendingPaths: [partialPath],
      });
      await expect(access(join(harness.paths.jobs, job.id, 'attempt-1'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      harness.queue.close();
    }
  });

  it('records success when publication wins a concurrent cancellation request', async () => {
    // Production break caught: cancel requested after renderer publication begins must not relabel a successfully published output as cancelled.
    const harness = await createHarness();
    const started = deferred<void>();
    const completion = deferred<RenderVideoResult>();
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: () => {
          started.resolve(undefined);
          return {
            pid: 6,
            completion: completion.promise,
            cancel: async () => { await completion.promise.then(() => undefined, () => undefined); },
          };
        },
      },
      isProviderReady: async () => true,
    });
    try {
      const job = harness.queue.enqueue(snapshotFixture('publication-wins'));
      const processing = runtime.runNext();
      await started.promise;
      const cancelling = runtime.cancel(job.id);
      const outputPath = join(harness.paths.outputs, 'published.mp4');
      completion.resolve(preparedRenderResult(outputPath));
      await cancelling;
      await processing;
      expect(harness.queue.getJob(job.id)).toMatchObject({ status: 'succeeded', outputPath });
    } finally {
      harness.queue.close();
    }
  });

  it('persists an owned renderer partial as cleanup debt when rendering fails', async () => {
    // Production break caught: rejected render completion has no result payload, so its undeletable partial can disappear from durable cleanup state.
    const harness = await createHarness();
    let partialPath = '';
    let shouldFail = true;
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })), elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })) },
      cache: new TtsCache(harness.paths),
      renderer: {
        preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
        start: (request) => {
          partialPath = join(request.outputDirectory, `.render-${request.jobId}.mp4.fixture.partial.mp4`);
          return {
            pid: 4,
            cleanupPendingPaths: shouldFail ? [partialPath] : [],
            cancel: async () => undefined,
            completion: shouldFail
              ? Promise.reject(new ReelForgeError(createErrorPayload('RENDER_FAILED', 'fixture failure')))
              : Promise.resolve(preparedRenderResult(
                  join(request.outputDirectory, `${request.jobId}.mp4`),
                )),
          };
        },
      },
      isProviderReady: async () => true,
      removePath: (path) => {
        if (path === partialPath) throw new Error('fixture partial is locked');
        rmSync(path, { recursive: true, force: true });
      },
    });
    try {
      const job = harness.queue.enqueue(snapshotFixture('failed-render-debt'));
      await runtime.runNext();
      expect(harness.queue.getJob(job.id)).toMatchObject({
        status: 'failed',
        cleanupPendingPaths: [partialPath],
      });
      await expect(access(join(harness.paths.jobs, job.id, 'attempt-1', 'manifest.json'))).resolves.toBeUndefined();

      harness.queue.retry(job.id);
      shouldFail = false;
      await runtime.runNext();
      expect(harness.queue.getJob(job.id)).toMatchObject({
        status: 'succeeded',
        cleanupPendingPaths: [partialPath],
      });
      expect(harness.queue.getAttempts(job.id).map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
    } finally {
      harness.queue.close();
    }
  });

  it('persists cleanup debt when renderer partials or the job workspace cannot be removed and services it later', async () => {
    // Production break caught: successful publication can hide undeletable partials/workspaces with no durable retry path.
    const harness = await createHarness();
    let removalBlocked = true;
    const removed: string[] = [];
    const provider = providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }));
    const renderer = {
      preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
      start: (request: RenderVideoRequest): RenderOperation => ({
        pid: 1,
        cancel: async () => undefined,
        completion: Promise.resolve(preparedRenderResult(
          join(harness.paths.outputs, `${request.jobId}.mp4`),
          [join(request.outputDirectory, `.${request.jobId}.mp4.fixture.partial.mp4`)],
        )),
      }),
    };
    const Runtime = (workerApi as Record<string, unknown>).WorkerRuntime as new (dependencies: unknown) => {
      initialize(): Promise<{ requeued: number; cancelled: number }>;
      runNext(): Promise<boolean>;
      stop(): Promise<void>;
      serviceCleanupPendingPaths(): Promise<void>;
    };
    const job = harness.queue.enqueue(snapshotFixture('cleanup-debt'));
    const runtime = new Runtime({
      queue: harness.queue,
      paths: harness.paths,
      providers: { google: provider, elevenlabs: provider },
      cache: new TtsCache(harness.paths),
      renderer,
      isProviderReady: async () => true,
      removePath: (path: string) => {
        if (removalBlocked) throw new Error('fixture ACL denied');
        removed.push(path);
        rmSync(path, { recursive: true, force: true });
      },
    });

    try {
      await runtime.runNext();
      const workspace = join(harness.paths.jobs, job.id, 'attempt-1');
      expect(harness.queue.getJob(job.id)).toMatchObject({
        status: 'succeeded',
        cleanupPendingPaths: expect.arrayContaining([
          expect.stringMatching(/\.partial\.mp4$/),
          workspace,
        ]),
      });

      const unsafeExternalPartial = join(harness.root, 'outside.partial.mp4');
      const otherJobWorkspace = join(harness.paths.jobs, 'another-job', 'attempt-1');
      await mkdir(otherJobWorkspace, { recursive: true });
      const pending = harness.queue.getJob(job.id)!.cleanupPendingPaths;
      await runtime.initialize();
      const cleanupLease = harness.queue.getWorkerLease()!;
      harness.queue.setCleanupPendingPaths(
        job.id,
        [...pending, unsafeExternalPartial, otherJobWorkspace],
        cleanupLease,
        harness.queue.getJob(job.id)!.attempts,
      );
      removalBlocked = false;
      await runtime.serviceCleanupPendingPaths();
      expect(harness.queue.getJob(job.id)?.cleanupPendingPaths).toEqual([unsafeExternalPartial, otherJobWorkspace]);
      expect(removed).toEqual(expect.arrayContaining([workspace]));
      expect(removed).not.toContain(unsafeExternalPartial);
      expect(removed).not.toContain(otherJobWorkspace);
      await expect(access(otherJobWorkspace)).resolves.toBeUndefined();
    } finally {
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  });

  it('services a final output path recorded as publication cleanup debt after a failed settlement', async () => {
    const harness = await createHarness();
    const raw = new DatabaseSync(join(harness.paths.data, 'queue.sqlite'));
    const removed: string[] = [];
    const outputPath = join(harness.paths.outputs, 'publication-debt.mp4');
    const partialPath = join(harness.paths.outputs, '.publication-debt.mp4.fixture.partial.mp4');
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: {
        google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
        elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
      },
      cache: new TtsCache(harness.paths),
      renderer: { preflight: async () => ({ assetCount: 0, availableBytes: 1 }), start: () => { throw new Error('unused'); } },
      isProviderReady: async () => true,
      workerId: 'publication-debt-owner',
      removePath: (path) => {
        removed.push(path);
        rmSync(path, { recursive: true, force: true });
      },
    });

    try {
      const job = harness.queue.enqueue(snapshotFixture('publication-debt-service'));
      const lease = harness.queue.acquireWorkerLease('publication-debt-owner', 60_000)!;
      const claimed = harness.queue.claimNext(lease)!;
      raw.exec(`
        CREATE TRIGGER reject_publication_debt_service
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.succeeded'
        BEGIN SELECT RAISE(ABORT, 'fixture publication event failure'); END;
      `);
      expect(() => harness.queue.succeedWithPublication(job.id, {
        outputPath,
        publish: () => undefined,
        compensate: () => { throw new Error('fixture final unlink is locked'); },
      }, lease, [partialPath], claimed.attempts)).toThrow();

      await runtime.initialize();
      expect(removed).toEqual(expect.arrayContaining([outputPath, partialPath]));
      expect(harness.queue.getJob(job.id)?.cleanupPendingPaths).toEqual([]);
    } finally {
      raw.close();
      await runtime.stop().catch(() => undefined);
      harness.queue.close();
    }
  });

  it('retains cleanup debt and skips removal when the lease is lost before the fenced removal', async () => {
    const harness = await createHarness();
    const observer = new QueueStore({
      databasePath: join(harness.paths.data, 'queue.sqlite'),
      defaultOutputDirectory: harness.paths.outputs,
    });
    const removed: string[] = [];
    const runtime = new workerApi.WorkerRuntime({
      queue: harness.queue,
      paths: harness.paths,
      providers: {
        google: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
        elevenlabs: providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' })),
      },
      cache: new TtsCache(harness.paths),
      renderer: { preflight: async () => ({ assetCount: 0, availableBytes: 1 }), start: () => { throw new Error('unused'); } },
      isProviderReady: async () => true,
      removePath: (path) => {
        removed.push(path);
        rmSync(path, { recursive: true, force: true });
      },
    });
    let takeoverDone = false;
    const fencedQueue = harness.queue as unknown as {
      withWorkerLease<T>(lease: WorkerLeaseFence, operation: () => T): T;
    };
    const originalWithWorkerLease = fencedQueue.withWorkerLease.bind(harness.queue);
    fencedQueue.withWorkerLease = <T>(lease: WorkerLeaseFence, operation: () => T): T => {
      if (!takeoverDone) {
        takeoverDone = true;
        expect(harness.queue.releaseWorkerLease(lease.ownerId, lease.fencingToken)).toBe(true);
        expect(observer.acquireWorkerLease('cleanup-takeover', 60_000)).toMatchObject({ fencingToken: 2 });
      }
      return originalWithWorkerLease(lease, operation);
    };

    try {
      const job = harness.queue.enqueue(snapshotFixture('fenced-cleanup'));
      await runtime.initialize();
      const lease = harness.queue.getWorkerLease()!;
      const claimed = harness.queue.claimNext(lease)!;
      const workspace = join(harness.paths.jobs, job.id, 'attempt-1');
      await mkdir(workspace, { recursive: true });
      harness.queue.setCleanupPendingPaths(job.id, [workspace], lease, claimed.attempts);

      await expect(runtime.serviceCleanupPendingPaths()).resolves.toBeUndefined();
      expect(removed).toEqual([]);
      expect(harness.queue.getJob(job.id)?.cleanupPendingPaths).toEqual([workspace]);
    } finally {
      fencedQueue.withWorkerLease = originalWithWorkerLease;
      await runtime.stop().catch(() => undefined);
      observer.close();
      harness.queue.close();
    }
  });

  it('processes fifty durable jobs within configured concurrency and isolates failures', async () => {
    // Production break caught: scheduler oversubscription, one rejection aborting the drain, or restart loss can strand a batch.
    const harness = await createHarness(3);
    const provider = providerWith(async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }));
    let active = 0;
    let maximumActive = 0;
    const renderer = {
      preflight: async () => ({ assetCount: 2, availableBytes: 1_000_000_000 }),
      start: (request: RenderVideoRequest): RenderOperation => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const index = Number(request.snapshot.project.id.replace('job-', ''));
        const completion = new Promise<RenderVideoResult>((resolve, reject) => {
          setTimeout(() => {
            active -= 1;
            if (index % 10 === 0) {
              reject(new ReelForgeError(createErrorPayload('RENDER_FAILED', 'Fixture render failed')));
            } else {
              resolve(preparedRenderResult(join(harness.paths.outputs, `${request.jobId}.mp4`)));
            }
          }, 2);
        });
        return { pid: index, completion, cancel: async () => undefined };
      },
    };
    const Runtime = (workerApi as Record<string, unknown>).WorkerRuntime as new (dependencies: unknown) => {
      drain(): Promise<void>;
    };
    let closed = false;
    try {
      expect(typeof Runtime).toBe('function');
      harness.queue.enqueueBatch(Array.from({ length: 50 }, (_, index) => snapshotFixture(`job-${index + 1}`, 'shared narration')));
      const runtime = new Runtime({
        queue: harness.queue,
        paths: harness.paths,
        providers: { google: provider, elevenlabs: provider },
        cache: new TtsCache(harness.paths),
        renderer,
        isProviderReady: async () => true,
      });
      await runtime.drain();
      const jobs = harness.queue.listJobs();
      expect(jobs).toHaveLength(50);
      expect(jobs.filter((job) => job.status === 'failed')).toHaveLength(5);
      expect(jobs.filter((job) => job.status === 'succeeded')).toHaveLength(45);
      expect(jobs.at(-1)?.status).toBe('failed');
      expect(maximumActive).toBe(3);
      harness.queue.close();
      closed = true;

      const reopened = new QueueStore({ databasePath: join(harness.paths.data, 'queue.sqlite') });
      expect(reopened.listJobs()).toHaveLength(50);
      reopened.close();
    } finally {
      if (!closed) harness.queue.close();
    }
  });
});

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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
      timer.unref();
    }),
  ]);
}

async function waitUntil(check: () => boolean, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${milliseconds}ms`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}
