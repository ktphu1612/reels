import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAutosave } from './autosave';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('revision-safe autosave', () => {
  afterEach(() => vi.useRealTimers());

  it('serializes an edit that arrives while an earlier save is in flight', async () => {
    const first = deferred<void>();
    const saves: string[] = [];
    const autosave = createAutosave<string>({
      delayMs: 0,
      save: async (value: string) => {
        saves.push(value);
        if (value === 'bản nháp 1') await first.promise;
      },
    });

    autosave.update('bản nháp 1');
    const firstFlush = autosave.flush();
    await Promise.resolve();
    autosave.update('bản nháp 2');
    first.resolve();
    await firstFlush;
    await autosave.flush();

    expect(saves).toEqual(['bản nháp 1', 'bản nháp 2']);
  });

  it('does not discard the newest value when update happens during the save call', async () => {
    const first = deferred<void>();
    const saves: string[] = [];
    const autosave = createAutosave<string>({
      delayMs: 0,
      save: async (value: string) => {
        saves.push(value);
        if (value === 'a') await first.promise;
      },
    });

    autosave.update('a');
    const firstFlush = autosave.flush();
    autosave.update('b');
    first.resolve();
    await firstFlush;
    await autosave.flush();

    expect(saves).toEqual(['a', 'b']);
  });

  it('persists only the latest debounced revision once when disposed', async () => {
    vi.useFakeTimers();
    const saves: string[] = [];
    const autosave = createAutosave<string>({
      delayMs: 10_000,
      save: async (value) => { saves.push(value); },
    });

    autosave.update('bản nháp cũ');
    autosave.update('bản nháp mới nhất');
    autosave.dispose();
    await vi.runAllTimersAsync();

    expect(saves).toEqual(['bản nháp mới nhất']);
  });

  it('waits for an in-flight save before persisting the pending revision during disposal', async () => {
    const first = deferred<void>();
    const saves: string[] = [];
    const autosave = createAutosave<string>({
      delayMs: 10_000,
      save: async (value) => {
        saves.push(value);
        if (value === 'revision 1') await first.promise;
      },
    });

    autosave.update('revision 1');
    const firstFlush = autosave.flush();
    await Promise.resolve();
    autosave.update('revision 2');
    autosave.dispose();
    first.resolve();
    await firstFlush;

    expect(saves).toEqual(['revision 1', 'revision 2']);
  });

  it('does not notify status listeners after disposal', async () => {
    const first = deferred<void>();
    const statusesAfterDispose: string[] = [];
    let disposed = false;
    const autosave = createAutosave<string>({
      delayMs: 10_000,
      save: async () => { await first.promise; },
      onStatusChange: (status) => {
        if (disposed) statusesAfterDispose.push(status);
      },
    });

    autosave.update('revision 1');
    const flush = autosave.flush();
    await Promise.resolve();
    disposed = true;
    autosave.dispose();
    first.resolve();
    await flush;

    expect(statusesAfterDispose).toEqual([]);
  });

  it('contains a failed pending save started by disposal', async () => {
    vi.useFakeTimers();
    const failure = new Error('save failed during navigation');
    let attempts = 0;
    const autosave = createAutosave<string>({
      delayMs: 10_000,
      save: async () => {
        attempts += 1;
        throw failure;
      },
    });

    autosave.update('revision lỗi');
    autosave.dispose();
    await vi.runAllTimersAsync();

    expect(attempts).toBe(1);
  });
});
