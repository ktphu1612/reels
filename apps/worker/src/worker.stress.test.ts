import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  ReelForgeError,
  createErrorPayload,
  type RenderJobSnapshot,
  type TtsProvider,
} from '@reelforge/core';
import { QueueStore } from '@reelforge/queue';
import type {
  RenderOperation,
  RenderVideoRequest,
  RenderVideoResult,
} from '@reelforge/renderer';
import { createAppPaths, ensureAppDirectories } from '@reelforge/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  WorkerRuntime,
  type WorkerRenderer,
  type WorkerTtsCache,
} from './runtime.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('durable worker queue stress', () => {
  it('recovers an interrupted job after restart, caps three renders, and drains all 50 jobs after failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-worker-stress-'));
    temporaryDirectories.push(root);
    const paths = createAppPaths(root);
    await ensureAppDirectories(paths);
    const databasePath = join(paths.data, 'queue.sqlite');
    const snapshots = Array.from({ length: 50 }, (_, index) => snapshotFixture(`job-${index + 1}`));

    const firstProcessNow = new Date('2026-01-01T00:00:00.000Z');
    const firstProcessQueue = new QueueStore({
      databasePath,
      defaultOutputDirectory: paths.outputs,
      now: () => firstProcessNow,
      idFactory: (() => {
        let nextId = 0;
        return () => `job-${++nextId}`;
      })(),
    });
    try {
      firstProcessQueue.updateSettings({ concurrency: 3 });
      firstProcessQueue.enqueueBatch(snapshots);

      const crashedLease = firstProcessQueue.acquireWorkerLease('worker-before-restart', 1)!;
      expect(crashedLease).toBeDefined();
      const interruptedJob = firstProcessQueue.claimNext(crashedLease!);
      expect(interruptedJob).toMatchObject({ id: 'job-1', status: 'running', attempts: 1 });
    } finally {
      firstProcessQueue.close();
    }

    const restartedQueue = new QueueStore({
      databasePath,
      defaultOutputDirectory: paths.outputs,
      now: () => new Date(firstProcessNow.getTime() + 2),
    });
    let runtime: WorkerRuntime | undefined;
    try {
      const observed = createStressDependencies(paths);
      runtime = new WorkerRuntime({
        queue: restartedQueue,
        paths,
        providers: { google: observed.provider, elevenlabs: observed.provider },
        cache: observed.cache,
        renderer: observed.renderer,
        isProviderReady: async () => true,
        workerId: 'worker-after-restart',
      });
      const recovery = await runtime.initialize();
      await runtime.drain();

      expect(recovery).toEqual({ requeued: 1, cancelled: 0 });
      expect(observed.maximumActive).toBe(3);

      const jobs = restartedQueue.listJobs();
      expect(jobs).toHaveLength(50);
      expect(jobs.filter((job) => job.status === 'succeeded')).toHaveLength(45);
      expect(jobs.filter((job) => job.status === 'failed')).toHaveLength(5);
      expect(jobs.at(-1)).toMatchObject({ id: 'job-50', status: 'failed' });
      expect(restartedQueue.getJob('job-1')).toMatchObject({
        status: 'succeeded',
        attempts: 2,
      });
      expect(restartedQueue.getAttempts('job-1').map((attempt) => attempt.status)).toEqual([
        'interrupted',
        'succeeded',
      ]);
      expect(restartedQueue.getJob('job-49')).toMatchObject({ status: 'succeeded' });
      expect(restartedQueue.getAttempts('job-50').map((attempt) => attempt.status)).toEqual(['failed']);
    } finally {
      await runtime?.stop().catch(() => undefined);
      restartedQueue.close();
    }
  });
});

function createStressDependencies(paths: ReturnType<typeof createAppPaths>): {
  readonly provider: TtsProvider;
  readonly cache: WorkerTtsCache;
  readonly renderer: WorkerRenderer;
  readonly maximumActive: number;
} {
  let active = 0;
  let maximumActive = 0;

  const provider: TtsProvider = {
    validateCredentials: async () => ({ ready: true }),
    listVoices: async () => ({ voices: [] }),
    synthesize: async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }),
  };
  const cache: WorkerTtsCache = {
    getOrCreate: async (_request, synthesize, signal) => {
      await synthesize(signal);
      return {
        cacheHit: false,
        key: 'worker-stress-fixture',
        absolutePath: join(paths.ttsCache, 'worker-stress-fixture.mp3'),
        relativePath: 'cache/tts/worker-stress-fixture.mp3',
        contentType: 'audio/mpeg',
      };
    },
  };
  const renderer: WorkerRenderer = {
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
            return;
          }
          resolve(preparedRenderResult(join(paths.outputs, `${request.jobId}.mp4`)));
        }, 15);
      });
      return {
        pid: index,
        completion,
        cancel: async () => undefined,
      };
    },
  };

  return {
    provider,
    cache,
    renderer,
    get maximumActive() {
      return maximumActive;
    },
  };
}

function snapshotFixture(projectId: string): RenderJobSnapshot {
  return {
    project: {
      schemaVersion: 2,
      id: projectId,
      name: `Project ${projectId}`,
      templateId: 'template-stress',
      tts: { provider: 'google', voiceId: 'vi-VN-Neural2-A', speakingRate: 1 },
      output: { width: 720, height: 1280, fps: 30, crf: 20 },
      cards: [{ id: 'card-1', imagePath: 'assets/card.png', script: 'Nội dung fixture', order: 0 }],
    },
    template: {
      schemaVersion: 2,
      id: 'template-stress',
      name: 'Stress fixture',
      backgroundPath: 'assets/background.mp4',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    },
  };
}

function preparedRenderResult(outputPath: string): RenderVideoResult {
  return {
    outputPath,
    probe: { durationSeconds: 1, streams: [] },
    durationSeconds: 1,
    cleanupPendingPaths: [],
    publication: {
      partialPath: join(dirname(outputPath), `.${basename(outputPath)}.fixture.partial.mp4`),
      outputPath,
      publish: () => undefined,
      compensate: () => undefined,
    },
  };
}
