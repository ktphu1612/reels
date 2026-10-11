import { describe, expect, it } from 'vitest';

import { startWorkerKeepAlive, stopWorkerKeepAlive } from './index.js';

describe('worker process lifecycle', () => {
  it('keeps an idle production worker resident until shutdown', () => {
    const keepAlive = startWorkerKeepAlive();
    try {
      expect(keepAlive.hasRef()).toBe(true);
    } finally {
      stopWorkerKeepAlive(keepAlive);
    }
  });
});
