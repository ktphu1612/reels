import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  ReelForgeError,
  createErrorPayload,
  safeFilename,
  type StructuredErrorPayload,
  type TtsProvider,
  type TtsProviderId,
  type TtsSynthesisRequest,
} from '@reelforge/core';
import {
  redactSensitiveText,
  type QueueJob,
  type QueueStore,
  type SynchronousPublication,
  type WorkerLease,
} from '@reelforge/queue';
import type {
  PreparedRenderPublication,
  RenderOperation,
  RenderPreflightRequest,
  RenderPreflightResult,
  RenderVideoOptions,
  RenderVideoRequest,
  RenderVideoResult,
} from '@reelforge/renderer';
import { prepareAudioAtSpeed } from '@reelforge/renderer';
import { resolveDataPath, writeJsonFileAtomic, type AppPaths } from '@reelforge/storage';
import { createBaseSynthesisRequest, type TtsCacheEntry } from '@reelforge/tts';

const DEFAULT_LEASE_MILLISECONDS = 15_000;

export interface WorkerTtsCache {
  getOrCreate(
    request: TtsSynthesisRequest,
    synthesize: (signal?: AbortSignal) => ReturnType<TtsProvider['synthesize']>,
    signal?: AbortSignal,
  ): Promise<TtsCacheEntry>;
}

export type WorkerRenderOperation = RenderOperation & {
  readonly cleanupPendingPaths?: readonly string[];
};

export interface WorkerRenderer {
  preflight(request: RenderPreflightRequest): Promise<RenderPreflightResult>;
  start(request: RenderVideoRequest, options?: RenderVideoOptions): WorkerRenderOperation;
}

export interface WorkerRuntimeDependencies {
  readonly queue: QueueStore;
  readonly paths: AppPaths;
  readonly providers: Record<TtsProviderId, TtsProvider>;
  readonly cache: WorkerTtsCache;
  readonly renderer: WorkerRenderer;
  readonly isProviderReady: (provider: TtsProviderId) => Promise<boolean>;
  readonly refreshRedactionValues?: () => Promise<void>;
  readonly redactValues?: () => readonly string[];
  readonly removePath?: (path: string) => void;
  readonly pollIntervalMilliseconds?: number;
  readonly workerId?: string;
  readonly leaseMilliseconds?: number;
  readonly heartbeatMilliseconds?: number;
}

interface ActiveAttempt {
  readonly key: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly controller: AbortController;
  readonly watcherController: AbortController;
  operation?: WorkerRenderOperation;
  task?: Promise<void>;
  watcher?: Promise<void>;
  publicationSettled: boolean;
}

type AttemptOutcome =
  | { readonly status: 'succeeded'; readonly result: RenderVideoResult }
  | { readonly status: 'failed'; readonly error: StructuredErrorPayload }
  | { readonly status: 'cancelled' };

export class WorkerRuntime {
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly activeByJob = new Map<string, string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly removePath: (path: string) => void;
  private readonly pollIntervalMilliseconds: number;
  private readonly workerId: string;
  private readonly leaseMilliseconds: number;
  private readonly heartbeatMilliseconds: number;
  private initialized = false;
  private lease: WorkerLease | undefined;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private loopController: AbortController | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pollFailureTeardown: Promise<void> | undefined;
  private readonly loopFailurePromise: Promise<never>;
  private rejectLoopFailure!: (error: unknown) => void;
  private loopFailed = false;
  private loopError: unknown;

  constructor(private readonly dependencies: WorkerRuntimeDependencies) {
    this.removePath = dependencies.removePath ?? ((path) => {
      rmSync(path, { recursive: true, force: true });
    });
    this.loopFailurePromise = new Promise<never>((_resolve, reject) => {
      this.rejectLoopFailure = reject;
    });
    void this.loopFailurePromise.catch(() => undefined);
    this.pollIntervalMilliseconds = dependencies.pollIntervalMilliseconds ?? 100;
    this.workerId = dependencies.workerId ?? randomUUID();
    this.leaseMilliseconds = dependencies.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    this.heartbeatMilliseconds = dependencies.heartbeatMilliseconds
      ?? Math.max(100, Math.floor(this.leaseMilliseconds / 3));
  }

  waitForFailure(): Promise<never> {
    return this.loopFailurePromise;
  }

  async initialize(): Promise<{ requeued: number; cancelled: number }> {
    if (this.initialized && this.lease) return { requeued: 0, cancelled: 0 };
    const lease = this.dependencies.queue.acquireWorkerLease(this.workerId, this.leaseMilliseconds);
    if (!lease) {
      throw new ReelForgeError(createErrorPayload('CONFLICT', 'Another worker owns this queue'));
    }
    this.lease = lease;
    this.startHeartbeat();
    try {
      const recovery = this.initialized
        ? { requeued: 0, cancelled: 0 }
        : this.dependencies.queue.recoverInterrupted(lease);
      await this.serviceCleanupPendingPaths();
      this.requireLease();
      this.initialized = true;
      return recovery;
    } catch (error) {
      this.releaseLease();
      throw error;
    }
  }

  async runNext(): Promise<boolean> {
    await this.initialize();
    try {
      const job = this.dependencies.queue.claimNext(this.requireLease());
      if (!job) return false;
      await this.startClaimedJob(job);
      return true;
    } finally {
      if (!this.running) this.releaseLease();
    }
  }

  async drain(): Promise<void> {
    await this.initialize();
    try {
      while (true) {
        const concurrency = this.dependencies.queue.getSettings().concurrency;
        while (this.tasks.size < concurrency) {
          const job = this.dependencies.queue.claimNext(this.requireLease());
          if (!job) break;
          void this.startClaimedJob(job);
        }
        if (this.tasks.size === 0) return;
        await Promise.race(this.tasks);
      }
    } catch (error) {
      try {
        await this.teardownActiveAttempts();
      } catch {
        // Preserve the first task failure after bounded cleanup attempts.
      }
      throw error;
    } finally {
      if (!this.running) this.releaseLease();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.loopFailed) throw this.loopError;
    await this.initialize();
    this.running = true;
    this.loopController = new AbortController();
    this.loopPromise = this.pollLoop(this.loopController.signal);
    void this.loopPromise.catch((error: unknown) => {
      if (this.pollFailureTeardown) return;
      this.loopFailed = true;
      this.loopError = error;
      this.rejectLoopFailure(error);
      this.running = false;
      this.loopController?.abort();
      this.stopHeartbeat();
      const teardown = (async (): Promise<void> => {
        await this.teardownActiveAttempts();
        this.releaseLease();
      })();
      this.pollFailureTeardown = teardown;
      void teardown.catch(() => undefined);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.loopController?.abort();
    for (const active of this.active.values()) active.watcherController.abort();
    const loopPromise = this.loopPromise;
    let loopError = this.loopError;
    let activeError: unknown;
    let releaseError: unknown;
    try {
      await loopPromise?.catch((error: unknown) => {
        if (!this.loopFailed) {
          this.loopFailed = true;
          this.loopError = error;
          loopError = error;
        }
      });
      if (this.pollFailureTeardown) {
        await waitForBoundedTeardown(this.pollFailureTeardown);
        this.pollFailureTeardown = undefined;
      } else {
        try {
          const results = await this.teardownActiveAttempts();
          const rejection = results?.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          activeError = rejection?.reason;
        } catch (error) {
          activeError = error;
        }
      }
    } finally {
      this.stopHeartbeat();
      this.loopPromise = undefined;
      this.loopController = undefined;
      releaseError = this.releaseLease();
    }
    if (this.loopFailed) throw loopError;
    if (activeError !== undefined) throw activeError;
    if (releaseError !== undefined) throw releaseError;
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.dependencies.queue.cancel(jobId);
    if (job.status !== 'running') return;
    const key = this.activeByJob.get(jobId) ?? attemptKey(jobId, job.attempts);
    const active = this.active.get(key);
    active?.controller.abort();
    await active?.operation?.cancel();
    await active?.task;
  }

  retry(jobId: string): QueueJob {
    return this.dependencies.queue.retry(jobId);
  }

  async serviceCleanupPendingPaths(): Promise<void> {
    for (const job of this.dependencies.queue.listJobs()) {
      if (job.cleanupPendingPaths.length === 0) continue;
      const remaining: string[] = [];
      for (const path of job.cleanupPendingPaths) {
        if (!this.isPersistedCleanupPathSafe(path, job)) {
          remaining.push(path);
          continue;
        }
        if (!this.removePathIfFenced(path)) remaining.push(path);
      }
      try {
        this.dependencies.queue.setCleanupPendingPaths(job.id, remaining, this.requireLease(), job.attempts);
      } catch {
        // A lost fence leaves the durable debt for the current or next owner.
      }
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.running) {
      const concurrency = this.dependencies.queue.getSettings().concurrency;
      while (this.running && this.tasks.size < concurrency) {
        const job = this.dependencies.queue.claimNext(this.requireLease());
        if (!job) break;
        void this.startClaimedJob(job);
      }
      if (!this.running) break;
      if (this.tasks.size > 0) {
        await Promise.race([...this.tasks, waitForAbort(signal)]);
      } else {
        await interruptibleDelay(this.pollIntervalMilliseconds, signal);
      }
    }
  }

  private startClaimedJob(job: QueueJob): Promise<void> {
    const key = attemptKey(job.id, job.attempts);
    const active: ActiveAttempt = {
      key,
      jobId: job.id,
      attemptNumber: job.attempts,
      controller: new AbortController(),
      watcherController: new AbortController(),
      publicationSettled: false,
    };
    this.active.set(key, active);
    this.activeByJob.set(job.id, key);
    active.watcher = this.watchDurableCancellation(active);
    const task = this.processJob(job, active).finally(async () => {
      active.watcherController.abort();
      await active.watcher;
      this.active.delete(key);
      if (this.activeByJob.get(job.id) === key) this.activeByJob.delete(job.id);
      this.tasks.delete(task);
    });
    active.task = task;
    this.tasks.add(task);
    void task.catch(() => undefined);
    return task;
  }

  private async watchDurableCancellation(active: ActiveAttempt): Promise<void> {
    const signal = active.watcherController.signal;
    while (!signal.aborted) {
      const current = this.dependencies.queue.getJob(active.jobId);
      if (
        !current
        || current.status !== 'running'
        || current.attempts !== active.attemptNumber
      ) return;
      if (current.cancelRequested) {
        active.controller.abort();
        await active.operation?.cancel();
        return;
      }
      await interruptibleDelay(this.pollIntervalMilliseconds, signal);
    }
  }

  private async processJob(job: QueueJob, active: ActiveAttempt): Promise<void> {
    const attemptNumber = job.attempts;
    const workspaceDirectory = this.attemptWorkspace(job.id, attemptNumber);
    const logPath = join(workspaceDirectory, 'worker.log');
    const settings = this.dependencies.queue.getSettings();
    let outcome: AttemptOutcome;
    let publicationFailureCleanupPaths: readonly string[] = [];
    try {
      await this.dependencies.refreshRedactionValues?.();
      await mkdir(workspaceDirectory, { recursive: true });
      await writeJsonFileAtomic(join(workspaceDirectory, 'manifest.json'), {
        schemaVersion: 1,
        jobId: job.id,
        attempt: attemptNumber,
        snapshot: job.snapshot,
      });
      await this.log(job, logPath, 'info', 'Worker attempt started');
      this.resolveManagedSnapshotPaths(job);
      await this.log(job, logPath, 'info', 'Managed asset paths resolved');

      const providerId = job.snapshot.project.tts.provider;
      const cards = job.snapshot.project.cards;
      const requiresProvider = cards.some((card) => card.script.trim().length > 0);
      const providerReady = requiresProvider
        ? await this.dependencies.isProviderReady(providerId)
        : true;
      await this.dependencies.renderer.preflight({
        snapshot: job.snapshot,
        dataDirectory: this.dependencies.paths.data,
        outputDirectory: settings.outputDirectory,
        tempDirectory: workspaceDirectory,
        providerReady,
        signal: active.controller.signal,
      });
      this.checkCancellation(job.id, attemptNumber, active.controller.signal);
      this.dependencies.queue.updateProgress(job.id, 5, this.requireLease(), attemptNumber);

      const provider = this.dependencies.providers[providerId];
      const narrationAudioPaths: Array<string | undefined> = [];
      for (const [index, card] of cards.entries()) {
        this.checkCancellation(job.id, attemptNumber, active.controller.signal);
        if (!card.script.trim()) {
          narrationAudioPaths[index] = undefined;
          this.dependencies.queue.updateProgress(
            job.id,
            5 + ((index + 1) / cards.length) * 35,
            this.requireLease(),
            attemptNumber,
          );
          continue;
        }
        const requestedRate = job.snapshot.project.tts.speakingRate;
        const request: TtsSynthesisRequest = createBaseSynthesisRequest({
          provider: providerId,
          voiceId: job.snapshot.project.tts.voiceId,
          ...(job.snapshot.project.tts.modelId ? { modelId: job.snapshot.project.tts.modelId } : {}),
          text: card.script,
          speakingRate: requestedRate,
          audioFormat: 'mp3',
        });
        await this.dependencies.refreshRedactionValues?.();
        const entry = await this.dependencies.cache.getOrCreate(
          request,
          async (signal) => {
            await this.dependencies.refreshRedactionValues?.();
            return provider.synthesize(request, { signal });
          },
          active.controller.signal,
        );
        narrationAudioPaths[index] = await prepareAudioAtSpeed(
          entry.absolutePath,
          join(workspaceDirectory, `narration-${index}.wav`),
          requestedRate,
          { signal: active.controller.signal },
        );
        this.checkCancellation(job.id, attemptNumber, active.controller.signal);
        this.dependencies.queue.updateProgress(
          job.id,
          5 + ((index + 1) / cards.length) * 35,
          this.requireLease(),
          attemptNumber,
        );
      }

      this.checkCancellation(job.id, attemptNumber, active.controller.signal);
      const commitPublication = (
        publication: PreparedRenderPublication,
        additionalCleanupPaths: readonly string[] = [],
      ): void => {
        this.dependencies.queue.succeedWithPublication(
          job.id,
          publication as SynchronousPublication,
          this.requireLease(),
          [...new Set([
            publication.partialPath,
            ...additionalCleanupPaths,
            workspaceDirectory,
          ])],
          attemptNumber,
        );
        active.publicationSettled = true;
      };
      const operation = this.dependencies.renderer.start({
        jobId: job.id,
        snapshot: job.snapshot,
        dataDirectory: this.dependencies.paths.data,
        outputDirectory: settings.outputDirectory,
        tempDirectory: workspaceDirectory,
        providerReady,
        narrationAudioPaths,
      }, {
        onProgress: (progress) => {
          const current = this.dependencies.queue.getJob(job.id);
          if (current?.status !== 'running' || current.attempts !== attemptNumber) return;
          this.dependencies.queue.updateProgress(
            job.id,
            Math.min(99, 40 + progress * 0.59),
            this.requireLease(),
            attemptNumber,
          );
        },
        publicationGuard: (publication) => {
          commitPublication(publication);
        },
      });
      active.operation = operation;
      const result = await this.awaitRender(job.id, attemptNumber, operation, active.controller.signal);
      if (!active.publicationSettled) {
        if (!result.publication) {
          throw new ReelForgeError(
            createErrorPayload('INTERNAL', 'Renderer did not provide a guarded publication'),
          );
        }
        commitPublication(result.publication, result.cleanupPendingPaths);
      }
      outcome = {
        status: 'succeeded',
        result,
      };
    } catch (error) {
      await this.dependencies.refreshRedactionValues?.().catch(() => undefined);
      if (isPublicationError(error)) {
        publicationFailureCleanupPaths = error.cleanupPendingPaths;
      }
      const current = this.dependencies.queue.getJob(job.id);
      outcome = current?.status === 'running'
        && current.attempts === attemptNumber
        && current.cancelRequested
        ? { status: 'cancelled' }
        : {
            status: 'failed',
            error: publicWorkerError(
              isCancellation(error) ? new Error('Unexpected dependency cancellation') : error,
              this.dependencies.redactValues?.() ?? [],
            ),
          };
    }

    const outputPath = outcome.status === 'succeeded' ? outcome.result.outputPath : undefined;
    const rendererCleanup = outcome.status === 'succeeded'
      ? [
          ...(outcome.result.publication ? [outcome.result.publication.partialPath] : []),
          ...outcome.result.cleanupPendingPaths,
          ...(active.operation?.cleanupPendingPaths ?? []),
        ]
      : [
          ...(active.operation?.cleanupPendingPaths ?? []),
          ...publicationFailureCleanupPaths,
        ];
    const removedCleanupPaths = new Set<string>();
    const cleanupPendingPaths = await this.cleanupRendererPaths(
      [...new Set(rendererCleanup)],
      job,
      settings.outputDirectory,
      outputPath,
      removedCleanupPaths,
    );

    if (outcome.status === 'succeeded' || outcome.status === 'cancelled') {
      await this.log(job, logPath, 'info', outcome.status === 'succeeded'
        ? 'Worker attempt succeeded'
        : 'Worker attempt cancelled').catch(() => undefined);
      if (this.removePathIfFenced(workspaceDirectory)) {
        removedCleanupPaths.add(workspaceDirectory);
      } else {
        cleanupPendingPaths.push(workspaceDirectory);
      }
    } else {
      await this.log(job, logPath, 'error', 'Worker attempt failed').catch(() => undefined);
    }

    const current = this.dependencies.queue.getJob(job.id);
    const uniqueCleanupPaths = [...new Set(cleanupPendingPaths)];
    if (outcome.status === 'succeeded' && active.publicationSettled) {
      if (current?.attempts !== attemptNumber || current.status !== 'succeeded') return;
      try {
        const retainedCleanupPaths = current.cleanupPendingPaths.filter(
          (path) => !removedCleanupPaths.has(path),
        );
        this.dependencies.queue.setCleanupPendingPaths(
          job.id,
          [...new Set([...retainedCleanupPaths, ...uniqueCleanupPaths])],
          this.requireLease(),
          attemptNumber,
        );
      } catch {
        // The atomic settlement already retained the full cleanup debt.
      }
      return;
    }
    if (current?.status !== 'running' || current.attempts !== attemptNumber) return;
    if (outcome.status === 'succeeded') {
      this.dependencies.queue.succeed(
        job.id,
        outcome.result.outputPath,
        this.requireLease(),
        uniqueCleanupPaths,
        attemptNumber,
      );
    } else if (outcome.status === 'cancelled') {
      this.dependencies.queue.markCancelled(
        job.id,
        this.requireLease(),
        uniqueCleanupPaths,
        attemptNumber,
      );
    } else {
      this.dependencies.queue.fail(
        job.id,
        outcome.error,
        this.requireLease(),
        uniqueCleanupPaths,
        attemptNumber,
      );
    }
  }

  private resolveManagedSnapshotPaths(job: QueueJob): void {
    resolveManagedAssetPath(this.dependencies.paths, job.snapshot.template.backgroundPath);
    for (const card of job.snapshot.project.cards) {
      resolveManagedAssetPath(this.dependencies.paths, card.imagePath);
      if (card.postCardMeme === undefined) continue;
      if ('imagePath' in card.postCardMeme) {
        resolveManagedResourcePath(this.dependencies.paths, card.postCardMeme.imagePath, card.id, 'meme-image');
      } else {
        resolveManagedResourcePath(this.dependencies.paths, card.postCardMeme.videoPath, card.id, 'meme-video');
      }
      if (card.postCardMeme.soundPath !== undefined) {
        resolveManagedResourcePath(this.dependencies.paths, card.postCardMeme.soundPath, card.id, 'meme-sound');
      }
    }
    if (job.snapshot.project.transitionSoundPath !== undefined) {
      resolveManagedResourcePath(
        this.dependencies.paths,
        job.snapshot.project.transitionSoundPath,
        undefined,
        'transition-sound',
      );
    }
    if (job.snapshot.project.backgroundMusicPath !== undefined) {
      resolveManagedResourcePath(
        this.dependencies.paths,
        job.snapshot.project.backgroundMusicPath,
        undefined,
        'background-music',
      );
    }
    if (job.snapshot.project.introSoundPath !== undefined) {
      resolveManagedResourcePath(
        this.dependencies.paths,
        job.snapshot.project.introSoundPath,
        undefined,
        'intro-sound',
      );
    }
  }

  private checkCancellation(jobId: string, attemptNumber: number, signal: AbortSignal): void {
    const current = this.dependencies.queue.getJob(jobId);
    if (signal.aborted || current?.cancelRequested || current?.attempts !== attemptNumber) {
      throw new ReelForgeError(createErrorPayload('CANCELLED', 'Job was cancelled'));
    }
  }

  private async awaitRender(
    jobId: string,
    attemptNumber: number,
    operation: WorkerRenderOperation,
    signal: AbortSignal,
  ): Promise<RenderVideoResult> {
    while (true) {
      const current = this.dependencies.queue.getJob(jobId);
      if (signal.aborted || current?.cancelRequested || current?.attempts !== attemptNumber) {
        await operation.cancel();
        return await operation.completion;
      }
      const result = await Promise.race([
        operation.completion.then(
          (value) => ({ settled: true as const, value }),
          (error: unknown) => ({ settled: true as const, error }),
        ),
        interruptibleDelay(this.pollIntervalMilliseconds, signal).then(() => ({ settled: false as const })),
      ]);
      if (result.settled) {
        if ('error' in result) throw result.error;
        return result.value;
      }
    }
  }

  private async cleanupRendererPaths(
    paths: readonly string[],
    job: QueueJob,
    outputDirectory: string,
    outputPath?: string,
    removedPaths?: Set<string>,
  ): Promise<string[]> {
    const pending: string[] = [];
    for (const path of paths) {
      if (!this.isAttemptRendererPathSafe(path, job, outputDirectory, outputPath)) {
        pending.push(path);
        continue;
      }
      if (this.removePathIfFenced(path)) {
        removedPaths?.add(path);
      } else {
        pending.push(path);
      }
    }
    return pending;
  }

  private removePathIfFenced(path: string): boolean {
    const lease = this.lease;
    if (!lease) return false;
    try {
      this.dependencies.queue.withWorkerLease(lease, () => {
        this.removePath(path);
      });
      return true;
    } catch {
      return false;
    }
  }

  private isPersistedCleanupPathSafe(path: string, job: QueueJob): boolean {
    if (!isAbsolute(path)) return false;
    const candidate = resolve(path);
    if (job.status !== 'succeeded' && job.outputPath && candidate === resolve(job.outputPath)) return true;
    for (let attempt = 1; attempt <= job.attempts; attempt += 1) {
      if (candidate === resolve(this.attemptWorkspace(job.id, attempt))) return true;
    }
    return Boolean(job.outputPath && isOutputPartialFor(candidate, resolve(job.outputPath)));
  }

  private isAttemptRendererPathSafe(
    path: string,
    job: QueueJob,
    outputDirectory: string,
    outputPath?: string,
  ): boolean {
    if (!isAbsolute(path)) return false;
    const candidate = resolve(path);
    if (outputPath && isOutputPartialFor(candidate, resolve(outputPath))) return true;
    if (dirname(candidate) !== resolve(outputDirectory)) return false;
    const name = basename(candidate);
    return name.startsWith('.')
      && name.endsWith('.partial.mp4')
      && name.includes(`-${safeFilename(job.id)}.mp4.`);
  }

  private attemptWorkspace(jobId: string, attemptNumber: number): string {
    return join(this.dependencies.paths.jobs, jobId, `attempt-${attemptNumber}`);
  }

  private async log(job: QueueJob, filePath: string, level: 'info' | 'error', message: string): Promise<void> {
    const safe = redactSensitiveText(message, this.dependencies.redactValues?.() ?? []);
    this.dependencies.queue.appendLog(
      job.id,
      { level, message: safe, attemptNumber: job.attempts },
      this.requireLease(),
    );
    await appendFile(filePath, `${new Date().toISOString()} ${level.toUpperCase()} ${safe}\n`, 'utf8');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      try {
        const lease = this.lease;
        if (!lease || !this.dependencies.queue.renewWorkerLease(
          this.workerId,
          lease.fencingToken,
          this.leaseMilliseconds,
        )) this.fenceLease();
      } catch {
        this.fenceLease();
      }
    }, this.heartbeatMilliseconds);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async teardownActiveAttempts(): Promise<PromiseSettledResult<void>[] | undefined> {
    for (const active of this.active.values()) {
      active.watcherController.abort();
      active.controller.abort();
    }
    await waitForBoundedTeardown(this.cancelActiveAttempts());
    return waitForBoundedTeardown(Promise.allSettled([...this.tasks]));
  }

  private async cancelActiveAttempts(): Promise<void> {
    await Promise.all([...this.active.values()].map(async (active) => {
      try {
        active.watcherController.abort();
        active.controller.abort();
        await active.operation?.cancel();
      } catch {
        // A bounded caller may detach; the lease is still released and fences late writes.
      }
    }));
  }

  private fenceLease(): void {
    if (!this.lease) return;
    this.lease = undefined;
    this.stopHeartbeat();
    this.running = false;
    this.loopController?.abort();
    void this.cancelActiveAttempts().catch(() => undefined);
  }

  private requireLease(): WorkerLease {
    if (!this.lease) {
      throw new ReelForgeError(createErrorPayload('CONFLICT', 'Worker lease ownership was lost'));
    }
    return this.lease;
  }

  private releaseLease(): unknown {
    const lease = this.lease;
    if (!lease) return undefined;
    this.stopHeartbeat();
    let error: unknown;
    try {
      this.dependencies.queue.releaseWorkerLease(this.workerId, lease.fencingToken);
    } catch (releaseError) {
      error = releaseError;
    } finally {
      this.lease = undefined;
    }
    return error;
  }
}

function publicWorkerError(error: unknown, sensitiveValues: readonly string[]): StructuredErrorPayload {
  if (error instanceof ReelForgeError) {
    return createErrorPayload(
      error.payload.code,
      redactSensitiveText(error.payload.message, sensitiveValues),
      error.payload.details
        ? sanitizeWorkerDetails(error.payload.details, sensitiveValues) as Record<string, unknown>
        : undefined,
    );
  }
  return createErrorPayload('RENDER_FAILED', 'Job processing failed');
}

type ManagedResourceKind = 'meme-image' | 'meme-video' | 'meme-sound' | 'transition-sound' | 'intro-sound' | 'background-music';

function resolveManagedAssetPath(paths: AppPaths, relativePath: string): string {
  const absolutePath = resolveDataPath(paths, relativePath);
  const assetsRoot = resolve(paths.assets);
  const fromAssets = relative(assetsRoot, absolutePath);
  if (
    !fromAssets
    || fromAssets === '..'
    || fromAssets.startsWith('../')
    || fromAssets.startsWith('..\\')
    || isAbsolute(fromAssets)
  ) {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Managed media path is invalid'));
  }
  return absolutePath;
}

function resolveManagedResourcePath(
  paths: AppPaths,
  relativePath: string,
  cardId: string | undefined,
  resourceKind: ManagedResourceKind,
): void {
  try {
    resolveManagedAssetPath(paths, relativePath);
  } catch {
    throw new ReelForgeError(createErrorPayload(
      'INVALID_INPUT',
      'Selected media resource is invalid',
      {
        ...(cardId === undefined ? {} : { cardId }),
        resourceKind,
      },
    ));
  }
}

function sanitizeWorkerDetails(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === 'string') return redactSensitiveText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => sanitizeWorkerDetails(item, sensitiveValues));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /(?:api.?key|authorization|password|secret|token)/i.test(key)
        ? '[REDACTED]'
        : sanitizeWorkerDetails(item, sensitiveValues),
    ]));
  }
  return value;
}

function isCancellation(error: unknown): boolean {
  return error instanceof ReelForgeError && error.payload.code === 'CANCELLED';
}

function isPublicationError(
  error: unknown,
): error is ReelForgeError & { readonly cleanupPendingPaths: readonly string[] } {
  return error instanceof ReelForgeError
    && error.name === 'PublicationError'
    && typeof (error as { cleanupPendingPaths?: unknown }).cleanupPendingPaths !== 'undefined'
    && Array.isArray((error as { cleanupPendingPaths?: unknown }).cleanupPendingPaths);
}

function attemptKey(jobId: string, attemptNumber: number): string {
  return `${jobId}:${attemptNumber}`;
}

function isOutputPartialFor(candidate: string, outputPath: string): boolean {
  return dirname(candidate) === dirname(outputPath)
    && basename(candidate).startsWith(`.${basename(outputPath)}.`)
    && basename(candidate).endsWith('.partial.mp4');
}

const TEARDOWN_BOUND_MILLISECONDS = 1_000;

async function waitForBoundedTeardown<T>(promise: Promise<T> | undefined): Promise<T | undefined> {
  if (!promise) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), TEARDOWN_BOUND_MILLISECONDS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function interruptibleDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => signal.addEventListener('abort', () => resolveAbort(), { once: true }));
}
