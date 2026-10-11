import { describe, expect, it } from 'vitest';

import { applyJobEvent, dedupeJobEvents } from './queue-events';

describe('queue event invalidation', () => {
  it('deduplicates replayed SSE events without duplicate visible actions', () => {
    const events = [
      { id: '10', jobId: 'job-1', type: 'job.progress', payload: { progress: 40 } },
      { id: '10', jobId: 'job-1', type: 'job.progress', payload: { progress: 40 } },
      { id: '11', jobId: 'job-1', type: 'job.succeeded', payload: { progress: 100 } },
    ];

    expect(dedupeJobEvents(events)).toHaveLength(2);
    expect(applyJobEvent({
      id: '11',
      jobId: 'job-1',
      type: 'job.succeeded',
      payload: { progress: 100 },
    }, { id: 'job-1', status: 'running', progress: 40 })).toMatchObject({
      status: 'succeeded',
      progress: 100,
    });
  });
});
