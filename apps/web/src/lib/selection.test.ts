import { describe, expect, it } from 'vitest';

import { batchEnqueuePayload, reconcileSelection } from './selection';

describe('project selection', () => {
  it('keeps selected projects that still exist after a list refresh', () => {
    expect(reconcileSelection(new Set(['one', 'gone']), [{ id: 'one' }, { id: 'two' }])).toEqual(new Set(['one']));
  });

  it('creates one unique batch enqueue payload from selected IDs', () => {
    expect(batchEnqueuePayload(new Set(['two', 'one', 'two']))).toEqual({ projectIds: ['one', 'two'] });
  });
});
