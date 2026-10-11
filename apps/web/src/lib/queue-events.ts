export interface QueueEvent {
  readonly id: string;
  readonly jobId?: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface QueueJobLike {
  readonly id: string;
  readonly status: string;
  readonly progress: number;
  readonly [key: string]: unknown;
}

export function dedupeJobEvents<T extends { id: string }>(events: readonly T[]): T[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

export function applyJobEvent<T extends QueueJobLike>(event: QueueEvent, job: T): T {
  if (!event.jobId || event.jobId !== job.id) return job;
  const payload = event.payload;
  switch (event.type) {
    case 'job.queued':
      return { ...job, status: 'queued', progress: numberPayload(payload.progress, 0) };
    case 'job.running':
      return { ...job, status: 'running' };
    case 'job.progress':
      return { ...job, status: 'running', progress: numberPayload(payload.progress, job.progress) };
    case 'job.succeeded':
      return { ...job, status: 'succeeded', progress: numberPayload(payload.progress, 100) };
    case 'job.failed':
      return { ...job, status: 'failed', progress: numberPayload(payload.progress, job.progress) };
    case 'job.cancelled':
      return { ...job, status: 'cancelled' };
    default:
      return job;
  }
}

function numberPayload(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
