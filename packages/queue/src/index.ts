import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ReelForgeError,
  RenderJobSchema,
  RenderJobSnapshotSchema,
  StructuredErrorPayloadSchema,
  createErrorPayload,
  type RenderJob,
  type RenderJobSnapshot,
  type StructuredErrorPayload,
} from '@reelforge/core';

const BUSY_TIMEOUT_MILLISECONDS = 5_000;
const SCHEMA_VERSION = 3;
export const MAX_LOG_MESSAGE_CHARS = 4_096;
export const MAX_JOB_LOG_CHARS = 65_536;

export interface QueueStoreOptions {
  readonly databasePath: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly defaultOutputDirectory?: string;
  readonly redactValues?: () => readonly string[];
}

export interface QueueDiagnostics {
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly schemaVersion: number;
}

export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface JobAttempt {
  readonly id: number;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: StructuredErrorPayload;
}

export type QueueJob = RenderJob & {
  readonly cancelRequested: boolean;
  readonly cleanupPendingPaths: readonly string[];
};

export interface QueueEvent {
  readonly id: number;
  readonly jobId?: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export type QueueLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface QueueLogEntry {
  readonly id: number;
  readonly jobId: string;
  readonly attemptNumber?: number;
  readonly level: QueueLogLevel;
  readonly message: string;
  readonly createdAt: string;
}

export interface QueueSettings {
  readonly outputDirectory: string;
  readonly concurrency: number;
}

export interface WorkerLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export type WorkerLeaseFence = Pick<WorkerLease, 'ownerId' | 'fencingToken'>;

export interface SynchronousPublication {
  readonly outputPath: string;
  publish(): void;
  compensate(): void;
}

export interface PublicationErrorOptions {
  readonly outputPath: string;
  readonly cleanupPendingPaths: readonly string[];
  readonly transactionError: unknown;
  readonly compensationError: unknown;
  readonly cleanupDebtPersisted: boolean;
  readonly persistenceError?: unknown;
}

export class PublicationError extends ReelForgeError {
  readonly outputPath: string;
  readonly cleanupPendingPaths: readonly string[];
  readonly transactionError: unknown;
  readonly compensationError: unknown;
  readonly persistenceError: unknown;

  constructor(options: PublicationErrorOptions) {
    const cleanupPendingPaths = [...new Set(options.cleanupPendingPaths)];
    super(createErrorPayload('RENDER_FAILED', 'Rendered output publication failed', {
      outputPath: options.outputPath,
      cleanupPendingPaths,
      compensationFailed: true,
      cleanupDebtPersisted: options.cleanupDebtPersisted,
      transactionError: errorMessage(options.transactionError),
      compensationError: errorMessage(options.compensationError),
      ...(options.persistenceError !== undefined
        ? { persistenceError: errorMessage(options.persistenceError) }
        : {}),
    }));
    this.name = 'PublicationError';
    this.outputPath = options.outputPath;
    this.cleanupPendingPaths = cleanupPendingPaths;
    this.transactionError = options.transactionError;
    this.compensationError = options.compensationError;
    this.persistenceError = options.persistenceError;
  }
}

export class QueueStore {
  private readonly database: DatabaseSync;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly redactValues: () => readonly string[];

  constructor(options: QueueStoreOptions) {
    const databasePath = resolve(options.databasePath);
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.redactValues = options.redactValues ?? (() => []);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS};
    `);
    this.migrate();
    this.ensureSettings(
      options.defaultOutputDirectory ?? resolve(dirname(databasePath), '..', 'outputs'),
    );
  }

  diagnostics(): QueueDiagnostics {
    const journal = this.database.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
    const foreignKeys = this.database.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>;
    const busyTimeout = this.database.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>;
    const schemaVersion = this.database.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    return {
      journalMode: String(journal.journal_mode),
      foreignKeys: Number(foreignKeys.foreign_keys),
      busyTimeout: Number(busyTimeout.timeout),
      schemaVersion: Number(schemaVersion.user_version),
    };
  }

  enqueue(snapshot: RenderJobSnapshot): QueueJob {
    return this.enqueueBatch([snapshot])[0] as QueueJob;
  }

  enqueueBatch(snapshots: readonly RenderJobSnapshot[]): QueueJob[] {
    const serializedSnapshots = snapshots.map(serializeSnapshot);
    if (serializedSnapshots.length === 0) return [];

    const insert = this.database.prepare(`
      INSERT INTO jobs (
        id, status, snapshot_json, progress, attempts, created_at, updated_at,
        cancel_requested, cleanup_pending_json
      ) VALUES (?, 'queued', ?, 0, 0, ?, ?, 0, '[]')
    `);
    const jobs: QueueJob[] = [];
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const snapshotJson of serializedSnapshots) {
        const id = this.idFactory();
        const timestamp = this.now().toISOString();
        insert.run(id, snapshotJson, timestamp, timestamp);
        this.insertEvent({ jobId: id, type: 'job.queued', payload: { progress: 0 } }, timestamp);
        jobs.push(this.requireJob(id));
      }
      this.database.exec('COMMIT');
      return jobs;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listJobs(): QueueJob[] {
    return this.database
      .prepare('SELECT * FROM jobs ORDER BY sequence ASC')
      .all()
      .map(parseJobRow);
  }

  getJob(id: string): QueueJob | undefined {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? parseJobRow(row as Record<string, unknown>) : undefined;
  }

  claimNext(lease: WorkerLeaseFence): QueueJob | undefined {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.assertWorkerLeaseInTransaction(lease);
      const row = this.database.prepare(`
        SELECT id FROM jobs
        WHERE status = 'queued' AND cancel_requested = 0
        ORDER BY sequence ASC
        LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      if (!row) {
        this.database.exec('COMMIT');
        return undefined;
      }

      const id = String(row.id);
      const timestamp = this.now().toISOString();
      const updated = this.database.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, progress = 0,
            started_at = ?, completed_at = NULL, output_path = NULL,
            error_json = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued' AND cancel_requested = 0
      `).run(timestamp, timestamp, id);
      if (Number(updated.changes) !== 1) throw transitionConflict();
      const job = this.requireJob(id);
      this.database.prepare(`
        INSERT INTO job_attempts(job_id, attempt_number, status, started_at)
        VALUES (?, ?, 'running', ?)
      `).run(id, job.attempts, timestamp);
      this.insertEvent({ jobId: id, type: 'job.running', payload: { attempt: job.attempts } }, timestamp);
      this.database.exec('COMMIT');
      return this.requireJob(id);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  updateProgress(
    id: string,
    progress: number,
    lease: WorkerLeaseFence,
    expectedAttempt?: number,
  ): QueueJob {
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw invalidInput('Job progress must be between 0 and 100');
    }
    return this.withImmediateTransaction(() => {
      this.assertWorkerLeaseInTransaction(lease);
      const job = this.requireJob(id);
      this.assertStatus(job, ['running']);
      this.assertAttempt(job, expectedAttempt);
      if (progress <= job.progress) return job;
      const timestamp = this.now().toISOString();
      const result = this.database.prepare(`
        UPDATE jobs SET progress = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND attempts = ? AND progress < ?
      `).run(progress, timestamp, id, job.attempts, progress);
      if (Number(result.changes) !== 1) throw transitionConflict();
      this.insertEvent({ jobId: id, type: 'job.progress', payload: { progress } }, timestamp);
      return this.requireJob(id);
    });
  }

  succeed(
    id: string,
    outputPath: string,
    lease: WorkerLeaseFence,
    cleanupPendingPaths: readonly string[] = [],
    expectedAttempt?: number,
  ): QueueJob {
    if (!outputPath) throw invalidInput('A successful job requires an output path');
    return this.completeRunning(id, 'succeeded', {
      progress: 100,
      outputPath,
      cleanupPendingPaths,
    }, lease, expectedAttempt);
  }

  succeedWithPublication(
    id: string,
    publication: SynchronousPublication,
    lease: WorkerLeaseFence,
    cleanupPendingPaths: readonly string[] = [],
    expectedAttempt?: number,
  ): QueueJob {
    if (!publication || typeof publication.outputPath !== 'string' || !publication.outputPath) {
      throw invalidInput('A successful job requires a publication output path');
    }
    if (typeof publication.publish !== 'function' || typeof publication.compensate !== 'function') {
      throw invalidInput('A successful job requires synchronous publication callbacks');
    }
    return this.completeRunningWithPublication(id, publication, cleanupPendingPaths, lease, expectedAttempt);
  }

  fail(
    id: string,
    error: StructuredErrorPayload,
    lease: WorkerLeaseFence,
    cleanupPendingPaths: readonly string[] = [],
    expectedAttempt?: number,
  ): QueueJob {
    let payload: StructuredErrorPayload;
    try {
      payload = StructuredErrorPayloadSchema.parse(
        sanitizeUnknown(error, (value) => this.redact(value)),
      );
    } catch {
      throw invalidInput('A failed job requires a structured error');
    }
    return this.completeRunning(id, 'failed', { error: payload, cleanupPendingPaths }, lease, expectedAttempt);
  }

  cancel(id: string): QueueJob {
    return this.withImmediateTransaction(() => {
      const job = this.requireJob(id);
      if (job.status === 'cancelled') return job;
      const timestamp = this.now().toISOString();
      if (job.status === 'queued') {
        const result = this.database.prepare(`
          UPDATE jobs
          SET status = 'cancelled', cancel_requested = 1, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'queued' AND cancel_requested = 0 AND attempts = ?
        `).run(timestamp, timestamp, id, job.attempts);
        if (Number(result.changes) !== 1) throw transitionConflict();
        this.insertEvent({ jobId: id, type: 'job.cancelled', payload: { queued: true } }, timestamp);
        return this.requireJob(id);
      }
      this.assertStatus(job, ['running']);
      if (job.cancelRequested) return job;
      const result = this.database.prepare(`
        UPDATE jobs SET cancel_requested = 1, updated_at = ?
        WHERE id = ? AND status = 'running' AND attempts = ? AND cancel_requested = 0
      `).run(timestamp, id, job.attempts);
      if (Number(result.changes) !== 1) throw transitionConflict();
      this.insertEvent({ jobId: id, type: 'job.cancel-requested', payload: {} }, timestamp);
      return this.requireJob(id);
    });
  }

  markCancelled(
    id: string,
    lease: WorkerLeaseFence,
    cleanupPendingPaths: readonly string[] = [],
    expectedAttempt?: number,
  ): QueueJob {
    return this.completeRunning(id, 'cancelled', { cleanupPendingPaths }, lease, expectedAttempt);
  }

  retry(id: string): QueueJob {
    return this.withImmediateTransaction(() => {
      const job = this.requireJob(id);
      this.assertStatus(job, ['failed', 'cancelled']);
      const timestamp = this.now().toISOString();
      const result = this.database.prepare(`
        UPDATE jobs
        SET status = 'queued', progress = 0, started_at = NULL, completed_at = NULL,
            output_path = NULL, error_json = NULL, cancel_requested = 0, updated_at = ?
        WHERE id = ? AND status = ? AND attempts = ?
      `).run(timestamp, id, job.status, job.attempts);
      if (Number(result.changes) !== 1) throw transitionConflict();
      this.insertEvent({ jobId: id, type: 'job.retried', payload: { attempts: job.attempts } }, timestamp);
      return this.requireJob(id);
    });
  }

  getAttempts(id: string): JobAttempt[] {
    this.requireJob(id);
    return this.database.prepare(`
      SELECT id, job_id, attempt_number, status, started_at, completed_at, error_json
      FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC
    `).all(id).map(parseAttemptRow);
  }

  appendEvent(input: { readonly jobId?: string; readonly type: string; readonly payload?: unknown }): QueueEvent {
    if (!input.type.trim()) throw invalidInput('An event type is required');
    if (input.jobId) this.requireJob(input.jobId);
    const id = this.insertEvent(input);
    return this.requireEvent(id);
  }

  readEvents(afterId = 0, limit = 1_000): QueueEvent[] {
    if (!Number.isInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw invalidInput('Event replay cursor or limit is invalid');
    }
    return this.database.prepare(`
      SELECT id, job_id, type, payload_json, created_at
      FROM job_events WHERE id > ? ORDER BY id ASC LIMIT ?
    `).all(afterId, limit).map(parseEventRow);
  }

  appendLog(
    jobId: string,
    input: { readonly level: QueueLogLevel; readonly message: string; readonly attemptNumber?: number },
    lease: WorkerLeaseFence,
  ): QueueLogEntry {
    if (!(['debug', 'info', 'warn', 'error'] as const).includes(input.level)) {
      throw invalidInput('Log level is invalid');
    }
    return this.withImmediateTransaction(() => {
      this.assertWorkerLeaseInTransaction(lease);
      this.requireJob(jobId);
      const message = this.redact(input.message).slice(0, MAX_LOG_MESSAGE_CHARS);
      const result = this.database.prepare(`
        INSERT INTO job_logs(job_id, attempt_number, level, message, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(jobId, input.attemptNumber ?? null, input.level, message, this.now().toISOString());
      this.capLogs(jobId);
      return this.requireLog(Number(result.lastInsertRowid));
    });
  }

  readLogs(jobId: string): QueueLogEntry[] {
    this.requireJob(jobId);
    return this.database.prepare(`
      SELECT id, job_id, attempt_number, level, message, created_at
      FROM job_logs WHERE job_id = ? ORDER BY id ASC
    `).all(jobId).map(parseLogRow);
  }

  setCleanupPendingPaths(
    id: string,
    paths: readonly string[],
    lease: WorkerLeaseFence,
    expectedAttempt?: number,
  ): QueueJob {
    if (!paths.every((path) => typeof path === 'string' && path.length > 0)) {
      throw invalidInput('Cleanup paths must be non-empty strings');
    }
    return this.withImmediateTransaction(() => {
      this.assertWorkerLeaseInTransaction(lease);
      const job = this.requireJob(id);
      this.assertAttempt(job, expectedAttempt);
      const normalized = [...new Set(paths)];
      if (JSON.stringify(normalized) === JSON.stringify(job.cleanupPendingPaths)) return job;
      const timestamp = this.now().toISOString();
      const result = this.database.prepare(`
        UPDATE jobs SET cleanup_pending_json = ?, updated_at = ?
        WHERE id = ? AND status = ? AND attempts = ? AND cleanup_pending_json = ?
      `).run(
        JSON.stringify(normalized),
        timestamp,
        id,
        job.status,
        job.attempts,
        JSON.stringify(job.cleanupPendingPaths),
      );
      if (Number(result.changes) !== 1) throw transitionConflict();
      this.insertEvent({
        jobId: id,
        type: 'job.cleanup-pending',
        payload: { count: normalized.length, attempt: job.attempts },
      }, timestamp);
      return this.requireJob(id);
    });
  }

  getSettings(): QueueSettings {
    const rows = this.database.prepare(`
      SELECT key, value FROM app_settings WHERE key IN ('outputDirectory', 'concurrency')
    `).all() as Array<Record<string, unknown>>;
    const settings = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
    return {
      outputDirectory: settings.outputDirectory as string,
      concurrency: Number(settings.concurrency),
    };
  }

  updateSettings(update: Partial<QueueSettings>): QueueSettings {
    const keys = Object.keys(update);
    if (keys.some((key) => key !== 'outputDirectory' && key !== 'concurrency')) {
      throw invalidInput('Only public queue settings may be stored');
    }
    if (update.outputDirectory !== undefined && !update.outputDirectory.trim()) {
      throw invalidInput('Output directory must be non-empty');
    }
    if (
      update.concurrency !== undefined
      && (!Number.isInteger(update.concurrency) || update.concurrency < 1 || update.concurrency > 4)
    ) {
      throw invalidInput('Concurrency must be an integer from 1 through 4');
    }
    const write = this.database.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const timestamp = this.now().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (update.outputDirectory !== undefined) {
        write.run('outputDirectory', update.outputDirectory, timestamp);
      }
      if (update.concurrency !== undefined) {
        write.run('concurrency', String(update.concurrency), timestamp);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getSettings();
  }

  acquireWorkerLease(ownerId: string, leaseMilliseconds: number): WorkerLease | undefined {
    validateLeaseInput(ownerId, leaseMilliseconds);
    return this.withImmediateTransaction(() => {
      const now = this.now();
      const timestamp = now.toISOString();
      const expiresAt = new Date(now.getTime() + leaseMilliseconds).toISOString();
      const current = this.database.prepare(`
        SELECT owner_id, fencing_token, expires_at FROM worker_lease WHERE singleton_id = 1
      `).get() as Record<string, unknown> | undefined;
      if (!current) {
        const result = this.database.prepare(`
          INSERT INTO worker_lease(singleton_id, owner_id, fencing_token, heartbeat_at, expires_at)
          VALUES (1, ?, 1, ?, ?)
        `).run(ownerId, timestamp, expiresAt);
        if (Number(result.changes) !== 1) throw transitionConflict();
        return this.requireWorkerLease();
      }
      const currentOwner = String(current.owner_id);
      const currentExpiresAt = String(current.expires_at);
      const currentToken = Number(current.fencing_token);
      if (currentOwner !== ownerId && currentExpiresAt > timestamp) return undefined;
      const fencingToken = currentOwner === ownerId && currentExpiresAt > timestamp
        ? currentToken
        : currentToken + 1;
      const result = this.database.prepare(`
        UPDATE worker_lease
        SET owner_id = ?, fencing_token = ?, heartbeat_at = ?, expires_at = ?
        WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ? AND expires_at = ?
      `).run(
        ownerId,
        fencingToken,
        timestamp,
        expiresAt,
        currentOwner,
        currentToken,
        currentExpiresAt,
      );
      if (Number(result.changes) !== 1) throw transitionConflict();
      return this.requireWorkerLease();
    });
  }

  renewWorkerLease(ownerId: string, fencingToken: number, leaseMilliseconds: number): boolean {
    validateLeaseInput(ownerId, leaseMilliseconds);
    validateFencingToken(fencingToken);
    return this.withImmediateTransaction(() => {
      const now = this.now();
      const timestamp = now.toISOString();
      const expiresAt = new Date(now.getTime() + leaseMilliseconds).toISOString();
      const result = this.database.prepare(`
        UPDATE worker_lease SET heartbeat_at = ?, expires_at = ?
        WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?
      `).run(timestamp, expiresAt, ownerId, fencingToken, timestamp);
      return Number(result.changes) === 1;
    });
  }

  releaseWorkerLease(ownerId: string, fencingToken: number): boolean {
    if (!ownerId.trim()) throw invalidInput('Worker lease owner is required');
    validateFencingToken(fencingToken);
    return this.withImmediateTransaction(() => {
      const result = this.database.prepare(`
        UPDATE worker_lease
        SET owner_id = '', heartbeat_at = ?, expires_at = ?
        WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?
      `).run(this.now().toISOString(), this.now().toISOString(), ownerId, fencingToken);
      return Number(result.changes) === 1;
    });
  }

  getWorkerLease(): WorkerLease | undefined {
    const row = this.database.prepare(`
      SELECT owner_id, fencing_token, heartbeat_at, expires_at
      FROM worker_lease WHERE singleton_id = 1 AND owner_id <> ''
    `).get() as Record<string, unknown> | undefined;
    return row ? {
      ownerId: String(row.owner_id),
      fencingToken: Number(row.fencing_token),
      heartbeatAt: String(row.heartbeat_at),
      expiresAt: String(row.expires_at),
    } : undefined;
  }

  assertWorkerLease(lease: WorkerLeaseFence): void {
    this.withImmediateTransaction(() => {
      this.assertWorkerLeaseInTransaction(lease);
    });
  }

  withWorkerLease<T>(lease: WorkerLeaseFence, operation: () => T): T {
    return this.withImmediateTransaction(() => {
      this.assertWorkerLeaseInTransaction(lease);
      return operation();
    });
  }

  recoverInterrupted(lease: WorkerLeaseFence): { requeued: number; cancelled: number } {
    return this.withImmediateTransaction(() => {
      this.assertWorkerLeaseInTransaction(lease);
      const running = this.database.prepare(`
        SELECT id, attempts, cancel_requested FROM jobs WHERE status = 'running' ORDER BY sequence ASC
      `).all() as Array<Record<string, unknown>>;
      let requeued = 0;
      let cancelled = 0;
      const timestamp = this.now().toISOString();
      for (const row of running) {
        const id = String(row.id);
        const attemptNumber = Number(row.attempts);
        const attemptResult = this.database.prepare(`
          UPDATE job_attempts SET status = 'interrupted', completed_at = ?
          WHERE job_id = ? AND attempt_number = ? AND status = 'running'
        `).run(timestamp, id, attemptNumber);
        if (Number(attemptResult.changes) !== 1) throw transitionConflict();
        if (Number(row.cancel_requested) === 1) {
          const jobResult = this.database.prepare(`
            UPDATE jobs SET status = 'cancelled', completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND attempts = ? AND cancel_requested = 1
          `).run(timestamp, timestamp, id, attemptNumber);
          if (Number(jobResult.changes) !== 1) throw transitionConflict();
          this.insertEvent({ jobId: id, type: 'job.cancelled', payload: { recovered: true } }, timestamp);
          cancelled += 1;
        } else {
          const jobResult = this.database.prepare(`
            UPDATE jobs
            SET status = 'queued', progress = 0, started_at = NULL, completed_at = NULL,
                error_json = NULL, cancel_requested = 0, updated_at = ?
            WHERE id = ? AND status = 'running' AND attempts = ? AND cancel_requested = 0
          `).run(timestamp, id, attemptNumber);
          if (Number(jobResult.changes) !== 1) throw transitionConflict();
          this.insertEvent({ jobId: id, type: 'job.recovered', payload: { attempts: attemptNumber } }, timestamp);
          requeued += 1;
        }
      }
      return { requeued, cancelled };
    });
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const row = this.database.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const currentVersion = Number(row.user_version);
    if (currentVersion >= SCHEMA_VERSION) return;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        CREATE TABLE IF NOT EXISTS jobs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          snapshot_json TEXT NOT NULL,
          progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 100),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          output_path TEXT,
          error_json TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          cleanup_pending_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS job_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
          status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          error_json TEXT,
          UNIQUE(job_id, attempt_number)
        );
        CREATE TABLE IF NOT EXISTS job_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS job_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          attempt_number INTEGER,
          level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS worker_lease (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          owner_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
          heartbeat_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_claim_order ON jobs(status, cancel_requested, sequence);
        CREATE INDEX IF NOT EXISTS job_events_replay ON job_events(id);
        CREATE INDEX IF NOT EXISTS job_logs_by_job ON job_logs(job_id, id);
      `);
      const leaseColumns = this.database.prepare('PRAGMA table_info(worker_lease)').all() as Array<Record<string, unknown>>;
      if (!leaseColumns.some((column) => String(column.name) === 'fencing_token')) {
        this.database.exec(`
          ALTER TABLE worker_lease
          ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 1 CHECK (fencing_token > 0);
        `);
      }
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private requireJob(id: string): QueueJob {
    const job = this.getJob(id);
    if (!job) {
      throw new ReelForgeError(createErrorPayload('INTERNAL', 'Queued job could not be read'));
    }
    return job;
  }

  private requireWorkerLease(): WorkerLease {
    const lease = this.getWorkerLease();
    if (!lease) throw transitionConflict();
    return lease;
  }

  private assertWorkerLeaseInTransaction(lease: WorkerLeaseFence): void {
    validateWorkerLeaseFence(lease);
    const row = this.database.prepare(`
      SELECT 1 FROM worker_lease
      WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?
    `).get(lease.ownerId, lease.fencingToken, this.now().toISOString());
    if (!row) throw transitionConflict();
  }

  private assertStatus(job: QueueJob, allowed: readonly QueueJob['status'][]): void {
    if (!allowed.includes(job.status)) {
      throw new ReelForgeError(
        createErrorPayload('CONFLICT', `Job cannot transition from ${job.status}`),
      );
    }
  }

  private assertAttempt(job: QueueJob, expectedAttempt: number | undefined): void {
    if (expectedAttempt !== undefined && job.attempts !== expectedAttempt) {
      throw transitionConflict();
    }
  }

  private completeRunning(
    id: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: {
      readonly progress?: number;
      readonly outputPath?: string;
      readonly error?: StructuredErrorPayload;
      readonly cleanupPendingPaths?: readonly string[];
    },
    lease: WorkerLeaseFence,
    expectedAttempt?: number,
  ): QueueJob {
    return this.withImmediateTransaction(() => this.completeRunningInTransaction(
      id,
      status,
      result,
      lease,
      expectedAttempt,
    ));
  }

  private completeRunningWithPublication(
    id: string,
    publication: SynchronousPublication,
    cleanupPendingPaths: readonly string[],
    lease: WorkerLeaseFence,
    expectedAttempt?: number,
  ): QueueJob {
    this.database.exec('BEGIN IMMEDIATE');
    let linked = false;
    try {
      this.assertWorkerLeaseInTransaction(lease);
      publication.publish();
      linked = true;
      this.assertWorkerLeaseInTransaction(lease);
      const result = this.completeRunningInTransaction(
        id,
        'succeeded',
        {
          progress: 100,
          outputPath: publication.outputPath,
          cleanupPendingPaths,
        },
        lease,
        expectedAttempt,
      );
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      let compensationFailed = false;
      let compensationError: unknown;
      if (linked) {
        try {
          publication.compensate();
        } catch (failure) {
          compensationFailed = true;
          compensationError = failure;
        }
      }
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original transition or publication failure.
      }
      if (compensationFailed) {
        throw this.persistPublicationFailure(
          id,
          publication,
          cleanupPendingPaths,
          lease,
          expectedAttempt,
          error,
          compensationError,
        );
      }
      throw error;
    }
  }

  private persistPublicationFailure(
    id: string,
    publication: SynchronousPublication,
    cleanupPendingPaths: readonly string[],
    lease: WorkerLeaseFence,
    expectedAttempt: number | undefined,
    transactionError: unknown,
    compensationError: unknown,
  ): PublicationError {
    const debt = [...new Set([...cleanupPendingPaths, publication.outputPath])];
    let persistenceError: unknown;
    let cleanupDebtPersisted = false;
    const persistedError = new PublicationError({
      outputPath: publication.outputPath,
      cleanupPendingPaths: debt,
      transactionError,
      compensationError,
      cleanupDebtPersisted: true,
    });
    const safeError = StructuredErrorPayloadSchema.parse(
      sanitizeUnknown(persistedError.payload, (value) => this.redact(value)),
    );

    try {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.assertWorkerLeaseInTransaction(lease);
        const job = this.requireJob(id);
        this.assertStatus(job, ['running']);
        this.assertAttempt(job, expectedAttempt);
        this.completeRunningInTransaction(
          id,
          job.cancelRequested ? 'cancelled' : 'failed',
          {
            progress: job.progress,
            outputPath: publication.outputPath,
            error: safeError,
            cleanupPendingPaths: debt,
          },
          lease,
          expectedAttempt,
        );
        this.database.exec('COMMIT');
        cleanupDebtPersisted = true;
      } catch (error) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          // Preserve the failure that prevented durable compensation debt.
        }
        persistenceError = error;
      }
    } catch (error) {
      persistenceError = error;
    }

    return new PublicationError({
      outputPath: publication.outputPath,
      cleanupPendingPaths: debt,
      transactionError,
      compensationError,
      cleanupDebtPersisted,
      ...(persistenceError !== undefined ? { persistenceError } : {}),
    });
  }

  private completeRunningInTransaction(
    id: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: {
      readonly progress?: number;
      readonly outputPath?: string;
      readonly error?: StructuredErrorPayload;
      readonly cleanupPendingPaths?: readonly string[];
    },
    lease: WorkerLeaseFence,
    expectedAttempt?: number,
  ): QueueJob {
    this.assertWorkerLeaseInTransaction(lease);
    const job = this.requireJob(id);
    this.assertStatus(job, ['running']);
    this.assertAttempt(job, expectedAttempt);
    if (status === 'cancelled' && !job.cancelRequested) throw transitionConflict();
    if (status === 'failed' && job.cancelRequested) throw transitionConflict();
    const timestamp = this.now().toISOString();
    const errorJson = result.error ? JSON.stringify(result.error) : null;
    const cleanupJson = JSON.stringify([
      ...new Set([...job.cleanupPendingPaths, ...(result.cleanupPendingPaths ?? [])]),
    ]);
    const attemptResult = this.database.prepare(`
      UPDATE job_attempts
      SET status = ?, completed_at = ?, error_json = ?
      WHERE job_id = ? AND attempt_number = ? AND status = 'running'
    `).run(status, timestamp, errorJson, id, job.attempts);
    if (Number(attemptResult.changes) !== 1) throw transitionConflict();
    const jobResult = this.database.prepare(`
      UPDATE jobs
      SET status = ?, progress = ?, completed_at = ?, output_path = ?,
          error_json = ?, cleanup_pending_json = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempts = ? AND cancel_requested = ?
    `).run(
      status,
      result.progress ?? job.progress,
      timestamp,
      result.outputPath ?? null,
      errorJson,
      cleanupJson,
      timestamp,
      id,
      job.attempts,
      job.cancelRequested ? 1 : 0,
    );
    if (Number(jobResult.changes) !== 1) throw transitionConflict();
    this.insertEvent({
      jobId: id,
      type: `job.${status}`,
      payload: {
        progress: result.progress ?? job.progress,
        ...(result.outputPath ? { outputPath: result.outputPath } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    }, timestamp);
    return this.requireJob(id);
  }

  private withImmediateTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureSettings(defaultOutputDirectory: string): void {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
    `);
    const timestamp = this.now().toISOString();
    insert.run('outputDirectory', defaultOutputDirectory, timestamp);
    insert.run('concurrency', '1', timestamp);
  }

  private insertEvent(
    input: { readonly jobId?: string; readonly type: string; readonly payload?: unknown },
    timestamp = this.now().toISOString(),
  ): number {
    const payload = sanitizeUnknown(input.payload ?? {}, (value) => this.redact(value));
    const result = this.database.prepare(`
      INSERT INTO job_events(job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)
    `).run(input.jobId ?? null, input.type, JSON.stringify(payload), timestamp);
    return Number(result.lastInsertRowid);
  }

  private requireEvent(id: number): QueueEvent {
    const row = this.database.prepare(`
      SELECT id, job_id, type, payload_json, created_at FROM job_events WHERE id = ?
    `).get(id);
    if (!row) throw new ReelForgeError(createErrorPayload('INTERNAL', 'Queue event could not be read'));
    return parseEventRow(row as Record<string, unknown>);
  }

  private requireLog(id: number): QueueLogEntry {
    const row = this.database.prepare(`
      SELECT id, job_id, attempt_number, level, message, created_at FROM job_logs WHERE id = ?
    `).get(id);
    if (!row) throw new ReelForgeError(createErrorPayload('INTERNAL', 'Queue log could not be read'));
    return parseLogRow(row as Record<string, unknown>);
  }

  private capLogs(jobId: string): void {
    const rows = this.database.prepare(`
      SELECT id, length(message) AS size FROM job_logs WHERE job_id = ? ORDER BY id DESC
    `).all(jobId) as Array<Record<string, unknown>>;
    let total = 0;
    const remove: number[] = [];
    for (const row of rows) {
      total += Number(row.size);
      if (total > MAX_JOB_LOG_CHARS) remove.push(Number(row.id));
    }
    const statement = this.database.prepare('DELETE FROM job_logs WHERE id = ?');
    for (const id of remove) statement.run(id);
  }

  private redact(value: string): string {
    return redactSensitiveText(value, this.redactValues());
  }
}

function serializeSnapshot(snapshot: RenderJobSnapshot): string {
  try {
    return JSON.stringify(RenderJobSnapshotSchema.parse(snapshot));
  } catch {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Render job snapshot is invalid'));
  }
}

function parseJobRow(row: Record<string, unknown>): QueueJob {
  const job = RenderJobSchema.parse({
    id: String(row.id),
    status: String(row.status),
    snapshot: JSON.parse(String(row.snapshot_json)),
    progress: Number(row.progress),
    attempts: Number(row.attempts),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    ...(row.output_path ? { outputPath: String(row.output_path) } : {}),
    ...(row.error_json ? { error: JSON.parse(String(row.error_json)) } : {}),
  });
  return {
    ...job,
    cancelRequested: Number(row.cancel_requested) === 1,
    cleanupPendingPaths: parseStringArray(row.cleanup_pending_json),
  };
}

function parseAttemptRow(row: Record<string, unknown>): JobAttempt {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    attemptNumber: Number(row.attempt_number),
    status: String(row.status) as AttemptStatus,
    startedAt: String(row.started_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    ...(row.error_json ? { error: StructuredErrorPayloadSchema.parse(JSON.parse(String(row.error_json))) } : {}),
  };
}

function parseEventRow(row: Record<string, unknown>): QueueEvent {
  return {
    id: Number(row.id),
    ...(row.job_id ? { jobId: String(row.job_id) } : {}),
    type: String(row.type),
    payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at),
  };
}

function parseLogRow(row: Record<string, unknown>): QueueLogEntry {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    ...(row.attempt_number === null || row.attempt_number === undefined
      ? {}
      : { attemptNumber: Number(row.attempt_number) }),
    level: String(row.level) as QueueLogLevel,
    message: String(row.message),
    createdAt: String(row.created_at),
  };
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function invalidInput(message: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('INVALID_INPUT', message));
}

function transitionConflict(): ReelForgeError {
  return new ReelForgeError(createErrorPayload('CONFLICT', 'Job state changed before the transition completed'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateLeaseInput(ownerId: string, leaseMilliseconds: number): void {
  if (!ownerId.trim() || !Number.isInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
    throw invalidInput('Worker lease owner and duration are invalid');
  }
}

function validateFencingToken(fencingToken: number): void {
  if (!Number.isInteger(fencingToken) || fencingToken < 1) {
    throw invalidInput('Worker lease fencing token is invalid');
  }
}

function validateWorkerLeaseFence(lease: WorkerLeaseFence): void {
  if (!lease || typeof lease.ownerId !== 'string' || !lease.ownerId.trim()) {
    throw invalidInput('Worker lease owner is required');
  }
  validateFencingToken(lease.fencingToken);
}

export function redactSensitiveText(value: string, sensitiveValues: readonly string[] = []): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive) redacted = redacted.replaceAll(sensitive, '[REDACTED]');
  }
  redacted = redacted
    .replace(/([?&](?:key|api[_-]?key|token|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:file|path|directory|dir|cwd|source|target|output)=)(?:\/\/|\/(?!\/))[^&\s|;,)"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/gi, '[REDACTED]')
    .replace(/\\\\[^\r\n|;,)"']+/g, '[REDACTED]')
    .replace(/\b[A-Za-z]:\\[^\r\n|;,)"']+/g, '[REDACTED]')
    ;

  const protectedValues: string[] = [];
  const protect = (match: string): string => {
    const token = `\u0000${protectedValues.length}\u0000`;
    protectedValues.push(match);
    return token;
  };

  redacted = redacted
    .replace(/https?:\/\/[^\s|;,)"']+/gi, protect)
    .replace(/\/api(?:\/[^\s|;,)"']*)?/gi, (match, offset: number, source: string) => {
      const previous = offset > 0 ? source[offset - 1] : undefined;
      return previous && /[A-Za-z0-9_.-]/.test(previous) ? match : protect(match);
    })
    .replace(/(['"])(\/(?!\/)[^'"\r\n]+)\1/g, (match, quote: string, path: string) => (
      isApiRoute(path) ? match : `${quote}[REDACTED]${quote}`
    ))
     .replace(/(\b(?:path|file|directory|dir|cwd|source|target|output)\s*[:=]\s*)((?:\/\/|\/(?!\/))[^\s\r\n|;,)"']+)/gi, (match, prefix: string, path: string) => (
      isApiRoute(path) ? match : `${prefix}[REDACTED]`
    ))
    .replace(/(\b(?:open|read|write|unlink|stat|access)\s+)(\/(?!\/)[^\s\r\n|;,)"']+)/gi, (match, prefix: string, path: string) => (
      isApiRoute(path) ? match : `${prefix}[REDACTED]`
    ))
    .replace(/(^|[\s=(])(\/(?!\/)[^\r\n|;,)"']+\.[A-Za-z0-9]{1,8})(?=\s*(?:[|;,)"']|$))/g, (match, prefix: string, path: string) => (
      isApiRoute(path) ? match : `${prefix}[REDACTED]`
    ))
    .replace(/(^|[\s=(])(\/(?!\/)[^\s\r\n|;,)"']+)/g, (match, prefix: string, path: string) => (
      isApiRoute(path) || !looksLikeFilesystemPath(path)
        ? match
        : `${prefix}[REDACTED]`
    ));

  return redacted.replace(/\u0000(\d+)\u0000/g, (match, index: string) => (
    protectedValues[Number(index)] ?? '[REDACTED]'
  ));
}

function isApiRoute(path: string): boolean {
  return /^\/api(?:\/|$)/i.test(path);
}

function looksLikeFilesystemPath(path: string): boolean {
  const root = path.split('/').filter(Boolean)[0]?.toLowerCase();
  return new Set([
    'home', 'tmp', 'var', 'srv', 'opt', 'mnt', 'etc', 'usr', 'private', 'data', 'reelforge',
  ]).has(root)
    || path.split('/').filter(Boolean).length >= 2
    || /\/[^/]+\.[A-Za-z0-9]{1,8}$/.test(path);
}

function sanitizeUnknown(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /(?:api.?key|authorization|password|secret|token)/i.test(key)
        ? '[REDACTED]'
        : sanitizeUnknown(item, redact),
    ]));
  }
  return value;
}
