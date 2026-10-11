import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { RenderJob, RenderJobSnapshot } from '@reelforge/core';

import * as queueApi from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'reelforge-queue-'));
  temporaryDirectories.push(directory);
  return join(directory, 'queue.sqlite');
}

function snapshotFixture(projectId = 'project-1'): RenderJobSnapshot {
  return {
    project: {
      schemaVersion: 2,
      id: projectId,
      name: `Project ${projectId}`,
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'vi-VN-Neural2-A', speakingRate: 1 },
      output: { width: 720, height: 1280, fps: 30, crf: 20 },
      cards: [
        { id: 'card-1', imagePath: 'assets/card.png', script: 'Xin chào', order: 0 },
      ],
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

describe('QueueStore migrations', () => {
  it('applies idempotent versioned migrations with WAL and connection safety pragmas', async () => {
    // Production break caught: a fresh or reopened queue can omit durability and integrity pragmas.
    const api = queueApi as Record<string, unknown>;
    expect(typeof api.QueueStore).toBe('function');
    const QueueStore = api.QueueStore as new (options: { databasePath: string }) => {
      close(): void;
      diagnostics(): { journalMode: string; foreignKeys: number; busyTimeout: number; schemaVersion: number };
    };
    const databasePath = await createDatabasePath();

    const first = new QueueStore({ databasePath });
    expect(first.diagnostics()).toEqual({
      journalMode: 'wal',
      foreignKeys: 1,
      busyTimeout: 5_000,
      schemaVersion: 3,
    });
    first.close();

    const reopened = new QueueStore({ databasePath });
    expect(reopened.diagnostics()).toEqual({
      journalMode: 'wal',
      foreignKeys: 1,
      busyTimeout: 5_000,
      schemaVersion: 3,
    });
    reopened.close();
  });
});

describe('QueueStore enqueue durability', () => {
  it('validates and serializes a deep copy of the snapshot at enqueue time', async () => {
    // Production break caught: caller mutation or invalid snapshots can change durable queued work.
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    const api = store as unknown as {
      enqueue(snapshot: RenderJobSnapshot): RenderJob;
      getJob(id: string): RenderJob | undefined;
    };
    try {
      expect(typeof api.enqueue).toBe('function');
      const snapshot = snapshotFixture();

      const queued = api.enqueue(snapshot);
      snapshot.project.name = 'Mutated caller project';
      queued.snapshot.project.cards[0]!.script = 'Mutated returned job';

      expect(api.getJob(queued.id)?.snapshot).toMatchObject({
        project: {
          name: 'Project project-1',
          cards: [{ script: 'Xin chào' }],
        },
      });
      expect(() => api.enqueue({ project: { id: 'invalid' }, template: {} } as never)).toThrow();
    } finally {
      store.close();
    }
  });

  it('enqueues a batch atomically in input order and retains all jobs after reopen', async () => {
    // Production break caught: a partial batch or unstable ordering loses selected projects across restart.
    const databasePath = await createDatabasePath();
    const first = new queueApi.QueueStore({ databasePath });
    const api = first as unknown as {
      enqueueBatch(snapshots: readonly RenderJobSnapshot[]): RenderJob[];
      listJobs(): RenderJob[];
    };
    let enqueued: RenderJob[] = [];
    try {
      expect(typeof api.enqueueBatch).toBe('function');

      expect(() => api.enqueueBatch([snapshotFixture('one'), { project: {}, template: {} } as never])).toThrow();
      expect(api.listJobs()).toEqual([]);
      enqueued = api.enqueueBatch([
        snapshotFixture('one'),
        snapshotFixture('two'),
        snapshotFixture('three'),
      ]);
      expect(enqueued.map((job) => job.snapshot.project.id)).toEqual(['one', 'two', 'three']);
    } finally {
      first.close();
    }

    const reopened = new queueApi.QueueStore({ databasePath });
    try {
      const jobs = (reopened as unknown as { listJobs(): RenderJob[] }).listJobs();
      expect(jobs.map((job) => job.snapshot.project.id)).toEqual(['one', 'two', 'three']);
      expect(jobs).toEqual(enqueued);
    } finally {
      reopened.close();
    }
  });
});

describe('QueueStore state machine', () => {
  it('rolls back job state when its event cannot persist and rejects stale attempt writes', async () => {
    // Production break caught: a committed state without its event, or a late callback from an earlier attempt, corrupts durable history.
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    const observer = new queueApi.QueueStore({ databasePath });
    const raw = new DatabaseSync(databasePath);
    try {
      const job = store.enqueue(snapshotFixture());
      const lease = store.acquireWorkerLease('state-machine', 60_000)!;
      const attemptOne = store.claimNext(lease)!;
      const beforeProgressEvents = observer.readEvents().length;
      raw.exec(`
        CREATE TRIGGER reject_progress_event
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.progress'
        BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END;
      `);

      expect(() => store.updateProgress(job.id, 25, lease, attemptOne.attempts)).toThrow(/fixture event failure/);
      expect(observer.getJob(job.id)).toMatchObject({ status: 'running', progress: 0, attempts: 1 });
      expect(observer.readEvents()).toHaveLength(beforeProgressEvents);

      raw.exec('DROP TRIGGER reject_progress_event');
      store.fail(job.id, { code: 'RENDER_FAILED', message: 'attempt one' }, lease, [], attemptOne.attempts);
      store.retry(job.id);
      const attemptTwo = store.claimNext(lease)!;
      const beforeStaleEvents = observer.readEvents().length;

      expect(captureSyncError(() => store.updateProgress(job.id, 80, lease, attemptOne.attempts))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(captureSyncError(() => store.succeed(job.id, 'stale.mp4', lease, [], attemptOne.attempts))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(observer.getJob(job.id)).toMatchObject({ status: 'running', progress: 0, attempts: attemptTwo.attempts });
      expect(observer.readEvents()).toHaveLength(beforeStaleEvents);
    } finally {
      raw.close();
      observer.close();
      store.close();
    }
  });

  it('rolls back cancel, retry, cleanup debt, and recovery when their event insert fails', async () => {
    // Production break caught: transitions assembled from autocommit statements can expose state that has no replayable durable event.
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    const raw = new DatabaseSync(databasePath);
    try {
      const lease = store.acquireWorkerLease('rollback-state-machine', 60_000)!;
      const queued = store.enqueue(snapshotFixture('queued-rollback'));
      raw.exec(`
        CREATE TRIGGER reject_cancel_event
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.cancelled'
        BEGIN SELECT RAISE(ABORT, 'fixture cancel event failure'); END;
      `);
      expect(() => store.cancel(queued.id)).toThrow(/fixture cancel event failure/);
      expect(store.getJob(queued.id)).toMatchObject({ status: 'queued', cancelRequested: false });
      raw.exec('DROP TRIGGER reject_cancel_event');

      store.cancel(queued.id);
      raw.exec(`
        CREATE TRIGGER reject_retry_event
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.retried'
        BEGIN SELECT RAISE(ABORT, 'fixture retry event failure'); END;
      `);
      expect(() => store.retry(queued.id)).toThrow(/fixture retry event failure/);
      expect(store.getJob(queued.id)).toMatchObject({ status: 'cancelled' });
      raw.exec('DROP TRIGGER reject_retry_event');

      store.retry(queued.id);
      const running = store.claimNext(lease)!;
      raw.exec(`
        CREATE TRIGGER reject_cleanup_event
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.cleanup-pending'
        BEGIN SELECT RAISE(ABORT, 'fixture cleanup event failure'); END;
      `);
      expect(() => store.setCleanupPendingPaths(running.id, ['attempt-workspace'], lease, running.attempts)).toThrow(/fixture cleanup event failure/);
      expect(store.getJob(running.id)?.cleanupPendingPaths).toEqual([]);
      raw.exec('DROP TRIGGER reject_cleanup_event');

      raw.exec(`
        CREATE TRIGGER reject_recovery_event
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.recovered'
        BEGIN SELECT RAISE(ABORT, 'fixture recovery event failure'); END;
      `);
      expect(() => store.recoverInterrupted(lease)).toThrow(/fixture recovery event failure/);
      expect(store.getJob(running.id)).toMatchObject({ status: 'running', attempts: 1 });
      expect(store.getAttempts(running.id)).toEqual([expect.objectContaining({ status: 'running' })]);
    } finally {
      raw.close();
      store.close();
    }
  });

  it('claims each queued job at most once and creates its attempt only on claim', async () => {
    // Production break caught: competing workers can run the same job or count an attempt before work starts.
    const databasePath = await createDatabasePath();
    const first = new queueApi.QueueStore({ databasePath });
    const second = new queueApi.QueueStore({ databasePath });
    const api = first as unknown as {
      enqueueBatch(snapshots: readonly RenderJobSnapshot[]): RenderJob[];
      claimNext(lease: queueApi.WorkerLeaseFence): RenderJob | undefined;
      getAttempts(id: string): Array<{ attemptNumber: number; status: string }>;
    };
    try {
      expect(typeof api.claimNext).toBe('function');
      const enqueued = api.enqueueBatch([
        snapshotFixture('one'),
        snapshotFixture('two'),
        snapshotFixture('three'),
      ]);
      const lease = first.acquireWorkerLease('claim-order', 60_000)!;
      expect(api.getAttempts(enqueued[0]!.id)).toEqual([]);

      const claims = [
        api.claimNext(lease),
        (second as unknown as typeof api).claimNext(lease),
        api.claimNext(lease),
        (second as unknown as typeof api).claimNext(lease),
      ];
      expect(claims.slice(0, 3).map((job) => job?.snapshot.project.id)).toEqual([
        'one',
        'two',
        'three',
      ]);
      expect(claims[3]).toBeUndefined();
      expect(new Set(claims.slice(0, 3).map((job) => job?.id)).size).toBe(3);
      expect(api.getAttempts(enqueued[0]!.id)).toEqual([
        expect.objectContaining({ attemptNumber: 1, status: 'running' }),
      ]);
    } finally {
      first.close();
      second.close();
    }
  });

  it('keeps running progress monotonic and rejects illegal terminal transitions', async () => {
    // Production break caught: late renderer callbacks can regress progress or overwrite terminal results.
    const store = new queueApi.QueueStore({ databasePath: await createDatabasePath() });
    const api = store as unknown as {
      enqueue(snapshot: RenderJobSnapshot): RenderJob;
      claimNext(lease: queueApi.WorkerLeaseFence): RenderJob | undefined;
      updateProgress(id: string, progress: number, lease: queueApi.WorkerLeaseFence, expectedAttempt?: number): RenderJob;
      succeed(id: string, outputPath: string, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths?: readonly string[], expectedAttempt?: number): RenderJob;
      fail(id: string, error: { code: string; message: string }, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths?: readonly string[], expectedAttempt?: number): RenderJob;
      getAttempts(id: string): Array<{ status: string }>;
    };
    try {
      expect(typeof api.updateProgress).toBe('function');
      const queued = api.enqueue(snapshotFixture());
      const lease = store.acquireWorkerLease('state-transitions', 60_000)!;
      expect(() => api.succeed(queued.id, 'output.mp4', lease)).toThrow();
      api.claimNext(lease);

      expect(api.updateProgress(queued.id, 40, lease).progress).toBe(40);
      expect(api.updateProgress(queued.id, 12, lease).progress).toBe(40);
      const succeeded = api.succeed(queued.id, 'output.mp4', lease, ['partial.mp4']);
      expect(succeeded).toMatchObject({
        status: 'succeeded',
        progress: 100,
        outputPath: 'output.mp4',
        cleanupPendingPaths: ['partial.mp4'],
      });
      expect(api.getAttempts(queued.id)).toEqual([
        expect.objectContaining({ status: 'succeeded' }),
      ]);
      expect(() => api.fail(queued.id, { code: 'RENDER_FAILED', message: 'late failure' }, lease)).toThrow();
      expect(() => api.updateProgress(queued.id, 99, lease)).toThrow();
    } finally {
      store.close();
    }
  });

  it('cancels queued work immediately and marks running work requested until settlement', async () => {
    // Production break caught: queued cancellation can still be claimed, or a running job can be terminal before its renderer settles.
    const store = new queueApi.QueueStore({ databasePath: await createDatabasePath() });
    const api = store as unknown as {
      enqueueBatch(snapshots: readonly RenderJobSnapshot[]): RenderJob[];
      claimNext(lease: queueApi.WorkerLeaseFence): RenderJob | undefined;
      cancel(id: string): RenderJob & { cancelRequested: boolean };
      markCancelled(id: string, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths?: readonly string[], expectedAttempt?: number): RenderJob & { cancelRequested: boolean };
      getAttempts(id: string): Array<{ status: string }>;
    };
    try {
      expect(typeof api.cancel).toBe('function');
      const [queued, running] = api.enqueueBatch([snapshotFixture('queued'), snapshotFixture('running')]);
      const lease = store.acquireWorkerLease('cancel-state-machine', 60_000)!;
      expect(api.cancel(queued!.id)).toMatchObject({ status: 'cancelled', attempts: 0 });
      expect(api.claimNext(lease)?.id).toBe(running!.id);
      expect(api.cancel(running!.id)).toMatchObject({ status: 'running', cancelRequested: true });
      expect(api.markCancelled(running!.id, lease, [], 1)).toMatchObject({ status: 'cancelled', cancelRequested: true });
      expect(api.getAttempts(running!.id)).toEqual([
        expect.objectContaining({ status: 'cancelled' }),
      ]);
      expect(api.claimNext(lease)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('retries failed or cancelled jobs without erasing prior attempts', async () => {
    // Production break caught: retry can overwrite history or create an attempt before a worker claims it.
    const store = new queueApi.QueueStore({ databasePath: await createDatabasePath() });
    const api = store as unknown as {
      enqueue(snapshot: RenderJobSnapshot): RenderJob;
      claimNext(lease: queueApi.WorkerLeaseFence): RenderJob | undefined;
      fail(id: string, error: { code: string; message: string }, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths?: readonly string[], expectedAttempt?: number): RenderJob;
      retry(id: string): RenderJob;
      succeed(id: string, outputPath: string, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths?: readonly string[], expectedAttempt?: number): RenderJob;
      getAttempts(id: string): Array<{ attemptNumber: number; status: string }>;
    };
    try {
      expect(typeof api.retry).toBe('function');
      const job = api.enqueue(snapshotFixture());
      const lease = store.acquireWorkerLease('retry-state-machine', 60_000)!;
      api.claimNext(lease);
      api.fail(job.id, { code: 'RENDER_FAILED', message: 'first attempt failed' }, lease, [], 1);

      expect(api.retry(job.id)).toMatchObject({ status: 'queued', attempts: 1, progress: 0 });
      expect(api.getAttempts(job.id)).toEqual([
        expect.objectContaining({ attemptNumber: 1, status: 'failed' }),
      ]);
      expect(api.claimNext(lease)).toMatchObject({ id: job.id, status: 'running', attempts: 2 });
      api.succeed(job.id, 'second.mp4', lease, [], 2);
      expect(api.getAttempts(job.id)).toEqual([
        expect.objectContaining({ attemptNumber: 1, status: 'failed' }),
        expect.objectContaining({ attemptNumber: 2, status: 'succeeded' }),
      ]);
    } finally {
      store.close();
    }
  });

  it('recovers interrupted attempts deterministically after restart', async () => {
    // Production break caught: a crash can strand running jobs forever or ignore an already-persisted cancel request.
    const databasePath = await createDatabasePath();
    let now = new Date('2026-08-24T00:00:00.000Z');
    const first = new queueApi.QueueStore({ databasePath, now: () => now });
    const api = first as unknown as {
      enqueueBatch(snapshots: readonly RenderJobSnapshot[]): RenderJob[];
      claimNext(lease: queueApi.WorkerLeaseFence): RenderJob | undefined;
      cancel(id: string): RenderJob;
      recoverInterrupted(lease: queueApi.WorkerLeaseFence): { requeued: number; cancelled: number };
    };
    let firstClosed = false;
    let requeue: RenderJob | undefined;
    let cancel: RenderJob | undefined;
    try {
      expect(typeof api.claimNext).toBe('function');
      expect(typeof api.recoverInterrupted).toBe('function');
      [requeue, cancel] = api.enqueueBatch([snapshotFixture('requeue'), snapshotFixture('cancel')]);
      const lease = first.acquireWorkerLease('recovery-worker', 60_000)!;
      expect(api.claimNext(lease)?.id).toBe(requeue!.id);
      expect(api.claimNext(lease)?.id).toBe(cancel!.id);
      api.cancel(cancel!.id);
      first.close();
      firstClosed = true;
    } finally {
      if (!firstClosed) first.close();
    }

    now = new Date('2026-08-24T00:01:00.001Z');
    const reopened = new queueApi.QueueStore({ databasePath, now: () => now });
    const recovery = reopened as unknown as {
      recoverInterrupted(lease: queueApi.WorkerLeaseFence): { requeued: number; cancelled: number };
      getJob(id: string): (RenderJob & { cancelRequested: boolean }) | undefined;
      getAttempts(id: string): Array<{ status: string }>;
    };
    try {
      expect(typeof recovery.recoverInterrupted).toBe('function');
      const lease = reopened.acquireWorkerLease('recovery-worker-restarted', 60_000)!;
      expect(recovery.recoverInterrupted(lease)).toEqual({ requeued: 1, cancelled: 1 });
      expect(recovery.getJob(requeue!.id)).toMatchObject({ status: 'queued', attempts: 1, progress: 0 });
      expect(recovery.getJob(cancel!.id)).toMatchObject({ status: 'cancelled', attempts: 1 });
      expect(recovery.getAttempts(requeue!.id)).toEqual([
        expect.objectContaining({ status: 'interrupted' }),
      ]);
      expect(recovery.getAttempts(cancel!.id)).toEqual([
        expect.objectContaining({ status: 'interrupted' }),
      ]);
      expect(recovery.recoverInterrupted(lease)).toEqual({ requeued: 0, cancelled: 0 });
    } finally {
      reopened.close();
    }
  });
});

function captureSyncError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

describe('QueueStore events, settings, and safe logs', () => {
  it('unions cleanup debt across failed and successful retry settlements', async () => {
    // Production break caught: a successful retry with no new cleanup failures can erase an older locked partial.
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    try {
      const job = store.enqueue(snapshotFixture('cleanup-union'));
      const lease = store.acquireWorkerLease('cleanup-union-worker', 60_000)!;
      const firstAttempt = store.claimNext(lease)!;
      store.setCleanupPendingPaths(job.id, ['D:\\outputs\\.old.partial.mp4'], lease, firstAttempt.attempts);
      store.fail(job.id, { code: 'RENDER_FAILED', message: 'first attempt failed' }, lease, [], firstAttempt.attempts);
      expect(store.getJob(job.id)?.cleanupPendingPaths).toEqual(['D:\\outputs\\.old.partial.mp4']);

      store.retry(job.id);
      const secondAttempt = store.claimNext(lease)!;
      store.succeed(job.id, 'D:\\outputs\\final.mp4', lease, [], secondAttempt.attempts);

      expect(store.getJob(job.id)).toMatchObject({
        status: 'succeeded',
        cleanupPendingPaths: ['D:\\outputs\\.old.partial.mp4'],
      });
    } finally {
      store.close();
    }
  });

  it('redacts quoted and field-prefixed POSIX paths without masking routes or URLs', async () => {
    // Production break caught: native errors leak POSIX paths, or path defense over-redacts harmless API routes.
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    try {
      const job = store.enqueue(snapshotFixture('path-redaction'));
      const lease = store.acquireWorkerLease('path-redaction-worker', 60_000)!;
      store.appendLog(job.id, {
        level: 'error',
        message: "open '/var/lib/private/file' path:/srv/private/file GET /api/jobs https://example.test/api/jobs",
      }, lease);

      expect(store.readLogs(job.id)[0]?.message).toBe(
        "open '[REDACTED]' path:[REDACTED] GET /api/jobs https://example.test/api/jobs",
      );
    } finally {
      store.close();
    }
  });

  it('preserves nested quoted and unquoted API routes while redacting POSIX paths', () => {
    const input = `quoted "/api/jobs/123" '/api/assets/abcdef.png' /api/jobs/123 /api/assets/abcdef.png path:/srv/private/file '/var/lib/private/file' https://example.test/api/jobs/123`;

    expect(queueApi.redactSensitiveText(input)).toBe(
      `quoted "/api/jobs/123" '/api/assets/abcdef.png' /api/jobs/123 /api/assets/abcdef.png path:[REDACTED] '[REDACTED]' https://example.test/api/jobs/123`,
    );
  });

  it('redacts short filesystem paths and file query values while preserving routes and full URLs', () => {
    const input = 'GET /api/jobs/123.js "/api/nested/route.ext" /home/user /tmp/foo file=/var/lib/private/file ?file=/var/lib/private/file /status https://example.test/api/jobs?file=/var/lib/private/file';

    expect(queueApi.redactSensitiveText(input)).toBe(
      'GET /api/jobs/123.js "/api/nested/route.ext" [REDACTED] [REDACTED] file=[REDACTED] ?file=[REDACTED] /status https://example.test/api/jobs?file=[REDACTED]',
    );
  });

  it('redacts UNC query values and short POSIX paths without masking API routes or URL structure', () => {
    const input = 'file=//server/share/file.mp4 /project/cache /api/jobs/123 https://example.test/api/jobs?file=//server/share/file.mp4';

    expect(queueApi.redactSensitiveText(input)).toBe(
      'file=[REDACTED] [REDACTED] /api/jobs/123 https://example.test/api/jobs?file=[REDACTED]',
    );
  });

  it('sanitizes rotated keys and all absolute path forms at raw failure/log persistence boundaries', async () => {
    // Production break caught: callers can bypass adapter redaction by passing a structured error directly to QueueStore.fail.
    const databasePath = await createDatabasePath();
    const initialKey = 'initial-secret-key-1111';
    const rotatedKey = 'rotated-secret-key-2222';
    const sensitive = new Set([initialKey]);
    const windowsPath = 'C:\\Users\\Operator Name\\Secret Folder\\input file.png';
    const uncPath = '\\\\media-server\\Private Share\\Render Jobs\\source.mov';
    const posixPath = '/var/lib/reelforge/private assets/source.mp4';
      const store = new queueApi.QueueStore({ databasePath, redactValues: () => [...sensitive] });
    try {
      const job = store.enqueue(snapshotFixture('raw-failure-redaction'));
      const lease = store.acquireWorkerLease('raw-failure-redaction-worker', 60_000)!;
      const running = store.claimNext(lease)!;
      sensitive.add(rotatedKey);
      store.appendLog(job.id, {
        level: 'error',
        attemptNumber: running.attempts,
        message: `${windowsPath} | ${uncPath} | ${posixPath} | ${rotatedKey}`,
      }, lease);
      store.fail(job.id, {
        code: 'PROVIDER_UNAVAILABLE',
        message: `${windowsPath} | ${uncPath} | ${posixPath} | https://provider.invalid?key=${rotatedKey}`,
        details: {
          apiKey: rotatedKey,
          nested: { authorization: `Bearer ${initialKey}`, path: uncPath },
        },
      }, lease, [], running.attempts);

      const publicState = JSON.stringify({
        job: store.getJob(job.id),
        attempts: store.getAttempts(job.id),
        events: store.readEvents(),
        logs: store.readLogs(job.id),
      });
      for (const secret of [initialKey, rotatedKey, windowsPath, uncPath, posixPath]) {
        expect(publicState).not.toContain(secret);
      }
      expect(publicState).toContain('[REDACTED]');
      const databaseBytes = await Promise.all(
        [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((path) => readFile(path).catch(() => Buffer.alloc(0))),
      );
      for (const bytes of databaseBytes) {
        expect(bytes.toString('latin1')).not.toContain(rotatedKey);
      }
    } finally {
      store.close();
    }
  });

  it('fences stale workers from claims and recovery after lease takeover', async () => {
    // Production break caught: independent worker processes can each enforce local concurrency while oversubscribing the shared queue.
    const databasePath = await createDatabasePath();
    let now = new Date('2026-08-24T00:00:00.000Z');
    const first = new queueApi.QueueStore({ databasePath, now: () => now });
    const second = new queueApi.QueueStore({ databasePath, now: () => now });
    try {
      const firstLease = first.acquireWorkerLease('worker-one', 1_000);
      expect(firstLease).toMatchObject({ ownerId: 'worker-one', fencingToken: 1 });
      expect(second.acquireWorkerLease('worker-two', 1_000)).toBeUndefined();
      expect(first.renewWorkerLease('worker-one', firstLease!.fencingToken, 1_000)).toBe(true);
      const running = first.claimNext(firstLease!);
      expect(running).toBeUndefined();

      const queued = first.enqueue(snapshotFixture('fenced-claim'));

      now = new Date('2026-08-24T00:00:01.001Z');
      const secondLease = second.acquireWorkerLease('worker-two', 1_000);
      expect(secondLease).toMatchObject({ ownerId: 'worker-two', fencingToken: 2 });
      expect(first.renewWorkerLease('worker-one', firstLease!.fencingToken, 1_000)).toBe(false);
      expect(captureSyncError(() => first.claimNext(firstLease!))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });

      const claimed = second.claimNext(secondLease!);
      expect(claimed?.id).toBe(queued.id);
      now = new Date('2026-08-24T00:00:02.002Z');
      const thirdLease = first.acquireWorkerLease('worker-three', 1_000)!;
      expect(captureSyncError(() => second.recoverInterrupted(secondLease!))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(first.getJob(queued.id)?.status).toBe('running');
      expect(first.recoverInterrupted(thirdLease)).toEqual({ requeued: 1, cancelled: 0 });
      expect(second.releaseWorkerLease('worker-two', secondLease!.fencingToken)).toBe(false);
      expect(first.releaseWorkerLease('worker-three', thirdLease.fencingToken)).toBe(true);
    } finally {
      second.close();
      first.close();
    }
  });

  it('monotonically increases fencing tokens across clean release and same-owner reacquisition', async () => {
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    try {
      const first = store.acquireWorkerLease('same-worker', 60_000)!;
      expect(first.fencingToken).toBe(1);
      expect(store.releaseWorkerLease(first.ownerId, first.fencingToken)).toBe(true);

      const second = store.acquireWorkerLease('same-worker', 60_000)!;
      expect(second.fencingToken).toBe(2);
      expect(store.releaseWorkerLease(second.ownerId, second.fencingToken)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('holds the lease transaction through synchronous publication so takeover cannot interleave before link', async () => {
    const databasePath = await createDatabasePath();
    let now = new Date('2026-08-24T00:00:00.000Z');
    const first = new queueApi.QueueStore({ databasePath, now: () => now });
    const second = new queueApi.QueueStore({ databasePath, now: () => now });
    const api = first as unknown as {
      succeedWithPublication(
        id: string,
        publication: { outputPath: string; publish(): void; compensate(): void },
        lease: queueApi.WorkerLeaseFence,
        cleanupPendingPaths: readonly string[],
        expectedAttempt: number,
      ): RenderJob;
    };
    const partialPath = join(databasePath, '..', 'publication.partial.mp4');
    const outputPath = join(databasePath, '..', 'publication.mp4');
    let linked = false;
    let takeover: Promise<queueApi.WorkerLease | undefined> | undefined;
    try {
      writeFileSync(partialPath, 'partial');
      const job = first.enqueue(snapshotFixture('atomic-publication'));
      const lease = first.acquireWorkerLease('publication-owner', 1_000)!;
      const claimed = first.claimNext(lease)!;
      const published = api.succeedWithPublication(job.id, {
        outputPath,
        publish: () => {
          linkSync(partialPath, outputPath);
          linked = true;
          takeover = new Promise((resolveTakeover) => {
            setImmediate(() => {
              now = new Date('2026-08-24T00:00:01.001Z');
              resolveTakeover(second.acquireWorkerLease('takeover-owner', 1_000))
            });
          });
        },
        compensate: () => {
          try { unlinkSync(outputPath); } catch { /* fixture cleanup */ }
        },
      }, lease, [partialPath], claimed.attempts);

      expect(linked).toBe(true);
      expect(published).toMatchObject({ status: 'succeeded', outputPath });
      const takeoverLease = await takeover;
      expect(takeoverLease).toMatchObject({ ownerId: 'takeover-owner', fencingToken: 2 });
      expect(first.getJob(job.id)).toMatchObject({ status: 'succeeded', outputPath });
    } finally {
      try { unlinkSync(outputPath); } catch { /* fixture cleanup */ }
      try { unlinkSync(partialPath); } catch { /* fixture cleanup */ }
      second.close();
      first.close();
    }
  });

  it('compensates a linked output when the settlement transaction rolls back', async () => {
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    const raw = new DatabaseSync(databasePath);
    const api = store as unknown as {
      succeedWithPublication(
        id: string,
        publication: { outputPath: string; publish(): void; compensate(): void },
        lease: queueApi.WorkerLeaseFence,
        cleanupPendingPaths: readonly string[],
        expectedAttempt: number,
      ): RenderJob;
    };
    const partialPath = join(databasePath, '..', 'rollback.partial.mp4');
    const outputPath = join(databasePath, '..', 'rollback.mp4');
    try {
      writeFileSync(partialPath, 'partial');
      const job = store.enqueue(snapshotFixture('publication-rollback'));
      const lease = store.acquireWorkerLease('rollback-owner', 60_000)!;
      const claimed = store.claimNext(lease)!;
      raw.exec(`
        CREATE TRIGGER reject_publication_event
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.succeeded'
        BEGIN SELECT RAISE(ABORT, 'fixture publication event failure'); END;
      `);

      expect(() => api.succeedWithPublication(job.id, {
        outputPath,
        publish: () => linkSync(partialPath, outputPath),
        compensate: () => unlinkSync(outputPath),
      }, lease, [partialPath], claimed.attempts)).toThrow(/fixture publication event failure/);
      expect(store.getJob(job.id)).toMatchObject({ status: 'running', attempts: 1 });
      expect(() => unlinkSync(outputPath)).toThrow(/ENOENT|no such file/i);
      expect(() => unlinkSync(partialPath)).not.toThrow();
    } finally {
      raw.close();
      store.close();
      try { unlinkSync(outputPath); } catch { /* fixture cleanup */ }
      try { unlinkSync(partialPath); } catch { /* fixture cleanup */ }
    }
  });

  it('surfaces a publication error and persists final-output cleanup debt when compensation is locked', async () => {
    const databasePath = await createDatabasePath();
    const store = new queueApi.QueueStore({ databasePath });
    const raw = new DatabaseSync(databasePath);
    const partialPath = join(databasePath, '..', 'locked-compensation.partial.mp4');
    const outputPath = join(databasePath, '..', 'locked-compensation.mp4');

    try {
      writeFileSync(partialPath, 'partial');
      const job = store.enqueue(snapshotFixture('locked-compensation'));
      const lease = store.acquireWorkerLease('locked-compensation-owner', 60_000)!;
      const claimed = store.claimNext(lease)!;
      raw.exec(`
        CREATE TRIGGER reject_locked_compensation_event
        BEFORE INSERT ON job_events WHEN NEW.type = 'job.succeeded'
        BEGIN SELECT RAISE(ABORT, 'fixture publication commit failure'); END;
      `);

      const error = captureSyncError(() => store.succeedWithPublication(job.id, {
        outputPath,
        publish: () => linkSync(partialPath, outputPath),
        compensate: () => { throw new Error('fixture final unlink is locked'); },
      }, lease, [partialPath], claimed.attempts));

      expect(error).toBeInstanceOf(queueApi.PublicationError);
      expect(error).toMatchObject({
        name: 'PublicationError',
        outputPath,
        cleanupPendingPaths: expect.arrayContaining([outputPath, partialPath]),
        payload: {
          code: 'RENDER_FAILED',
          details: expect.objectContaining({
            outputPath,
            cleanupPendingPaths: expect.arrayContaining([outputPath, partialPath]),
            compensationFailed: true,
            cleanupDebtPersisted: true,
          }),
        },
      });
      expect(readFileSync(outputPath, 'utf8')).toBe('partial');
      expect(store.getJob(job.id)).toMatchObject({
        status: 'failed',
        outputPath,
        cleanupPendingPaths: expect.arrayContaining([outputPath, partialPath]),
        error: {
          details: expect.objectContaining({
            compensationFailed: true,
            cleanupDebtPersisted: true,
            outputPath: '[REDACTED]',
            cleanupPendingPaths: ['[REDACTED]', '[REDACTED]'],
          }),
        },
      });
    } finally {
      raw.close();
      store.close();
      try { unlinkSync(outputPath); } catch { /* fixture cleanup */ }
      try { unlinkSync(partialPath); } catch { /* fixture cleanup */ }
    }
  });

  it('fences stale worker progress, settlement, cleanup, and logs after lease takeover', async () => {
    const databasePath = await createDatabasePath();
    let now = new Date('2026-08-24T00:00:00.000Z');
    const first = new queueApi.QueueStore({ databasePath, now: () => now });
    const second = new queueApi.QueueStore({ databasePath, now: () => now });
    const api = first as unknown as {
      updateProgress(id: string, progress: number, lease: queueApi.WorkerLeaseFence, expectedAttempt: number): RenderJob;
      succeed(id: string, outputPath: string, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths: readonly string[], expectedAttempt: number): RenderJob;
      fail(id: string, error: { code: string; message: string }, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths: readonly string[], expectedAttempt: number): RenderJob;
      markCancelled(id: string, lease: queueApi.WorkerLeaseFence, cleanupPendingPaths: readonly string[], expectedAttempt: number): RenderJob;
      setCleanupPendingPaths(id: string, paths: readonly string[], lease: queueApi.WorkerLeaseFence, expectedAttempt: number): RenderJob;
      appendLog(jobId: string, input: { level: 'error'; message: string; attemptNumber?: number }, lease: queueApi.WorkerLeaseFence): unknown;
    };

    try {
      const job = first.enqueue(snapshotFixture('stale-settlement'));
      const firstLease = first.acquireWorkerLease('worker-a', 1_000)!;
      const claimed = first.claimNext(firstLease)!;

      now = new Date('2026-08-24T00:00:01.001Z');
      const secondLease = second.acquireWorkerLease('worker-b', 1_000)!;
      expect(secondLease).toMatchObject({ ownerId: 'worker-b', fencingToken: 2 });

      expect(captureSyncError(() => api.updateProgress(job.id, 25, firstLease, claimed.attempts))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(captureSyncError(() => api.setCleanupPendingPaths(job.id, ['stale.partial.mp4'], firstLease, claimed.attempts))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(captureSyncError(() => api.appendLog(job.id, {
        level: 'error',
        attemptNumber: claimed.attempts,
        message: 'stale worker log',
      }, firstLease))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(captureSyncError(() => api.succeed(job.id, 'stale.mp4', firstLease, [], claimed.attempts))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(captureSyncError(() => api.fail(job.id, { code: 'RENDER_FAILED', message: 'stale failure' }, firstLease, [], claimed.attempts))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });

      expect(second.cancel(job.id)).toMatchObject({ status: 'running', cancelRequested: true });
      expect(captureSyncError(() => api.markCancelled(job.id, firstLease, [], claimed.attempts))).toMatchObject({
        payload: { code: 'CONFLICT' },
      });
      expect(first.getJob(job.id)).toMatchObject({
        status: 'running',
        progress: 0,
        cancelRequested: true,
        cleanupPendingPaths: [],
      });
      expect(first.getAttempts(job.id)).toEqual([
        expect.objectContaining({ status: 'running' }),
      ]);
      expect(first.readLogs(job.id)).toEqual([]);
    } finally {
      second.close();
      first.close();
    }
  });

  it('persists globally ordered events and replays only events after a cursor', async () => {
    // Production break caught: reconnecting SSE clients can miss or reorder durable queue updates.
    const databasePath = await createDatabasePath();
    const first = new queueApi.QueueStore({ databasePath });
    const api = first as unknown as {
      enqueue(snapshot: RenderJobSnapshot): RenderJob;
      appendEvent(event: { jobId?: string; type: string; payload?: unknown }): { id: number; type: string };
      readEvents(afterId?: number): Array<{ id: number; type: string; payload: unknown }>;
    };
    let cursor = 0;
    try {
      expect(typeof api.appendEvent).toBe('function');
      const job = api.enqueue(snapshotFixture());
      const initial = api.readEvents();
      expect(initial).toEqual([
        expect.objectContaining({ id: 1, type: 'job.queued', payload: { progress: 0 } }),
      ]);
      cursor = initial[0]!.id;
      api.appendEvent({ jobId: job.id, type: 'job.note', payload: { value: 2 } });
    } finally {
      first.close();
    }

    const reopened = new queueApi.QueueStore({ databasePath });
    try {
      const replay = (reopened as unknown as typeof api).readEvents(cursor);
      expect(replay).toEqual([
        expect.objectContaining({ id: 2, type: 'job.note', payload: { value: 2 } }),
      ]);
    } finally {
      reopened.close();
    }
  });

  it('persists output directory and validates concurrency from one through four', async () => {
    // Production break caught: invalid concurrency can oversubscribe the worker or settings can reset on restart.
    const databasePath = await createDatabasePath();
    const first = new queueApi.QueueStore({ databasePath, defaultOutputDirectory: 'D:\\default-output' } as never);
    const api = first as unknown as {
      getSettings(): { outputDirectory: string; concurrency: number };
      updateSettings(update: { outputDirectory?: string; concurrency?: number }): { outputDirectory: string; concurrency: number };
    };
    try {
      expect(typeof api.getSettings).toBe('function');
      expect(api.getSettings()).toEqual({ outputDirectory: 'D:\\default-output', concurrency: 1 });
      expect(api.updateSettings({ outputDirectory: 'D:\\renders', concurrency: 4 })).toEqual({
        outputDirectory: 'D:\\renders',
        concurrency: 4,
      });
      expect(() => api.updateSettings({ concurrency: 0 })).toThrow();
      expect(() => api.updateSettings({ concurrency: 5 })).toThrow();
    } finally {
      first.close();
    }

    const reopened = new queueApi.QueueStore({ databasePath, defaultOutputDirectory: 'ignored' } as never);
    try {
      expect((reopened as unknown as typeof api).getSettings()).toEqual({
        outputDirectory: 'D:\\renders',
        concurrency: 4,
      });
    } finally {
      reopened.close();
    }
  });

  it('redacts paths and keys, caps logs, and leaves fixture credentials out of SQLite files', async () => {
    // Production break caught: diagnostic text, event payloads, snapshots, or WAL pages can persist backend credentials.
    const databasePath = await createDatabasePath();
    const fixtureKey = 'fixture-api-key-DO-NOT-PERSIST-1234';
    const localPath = 'C:\\Users\\operator\\secret\\input.png';
    const store = new queueApi.QueueStore({
      databasePath,
      redactValues: () => [fixtureKey],
    } as never);
    const api = store as unknown as {
      enqueue(snapshot: RenderJobSnapshot): RenderJob;
      appendEvent(event: { jobId?: string; type: string; payload?: unknown }): unknown;
      appendLog(jobId: string, input: { level: string; message: string; attemptNumber?: number }, lease: queueApi.WorkerLeaseFence): unknown;
      readEvents(afterId?: number): unknown[];
      readLogs(jobId: string): Array<{ message: string }>;
      getJob(id: string): RenderJob | undefined;
    };
    try {
      expect(typeof api.appendLog).toBe('function');
      const job = api.enqueue(snapshotFixture());
      expect(() => api.enqueue({
        ...snapshotFixture(),
        project: {
          ...snapshotFixture().project,
          tts: { ...snapshotFixture().project.tts, apiKey: fixtureKey },
        },
      } as never)).toThrow();
      const lease = store.acquireWorkerLease('safe-log-worker', 60_000)!;
      api.appendLog(job.id, {
        level: 'error',
        message: `${localPath} failed with ${fixtureKey} at https://provider.invalid/synth?key=${fixtureKey} ${'x'.repeat(100_000)}`,
      }, lease);
      api.appendEvent({
        jobId: job.id,
        type: 'job.safe-error',
        payload: { apiKey: fixtureKey, path: localPath },
      });

      const logs = api.readLogs(job.id);
      const publicState = JSON.stringify({ logs, events: api.readEvents(), job: api.getJob(job.id) });
      expect(logs[0]!.message.length).toBeLessThanOrEqual(4_096);
      expect(publicState).not.toContain(fixtureKey);
      expect(publicState).not.toContain(localPath);
      expect(publicState).toContain('[REDACTED]');

      const databaseBytes = await Promise.all(
        [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async (path) =>
          readFile(path).catch(() => Buffer.alloc(0)),
        ),
      );
      for (const bytes of databaseBytes) {
        expect(bytes.toString('latin1')).not.toContain(fixtureKey);
      }
    } finally {
      store.close();
    }
  });
});
