export type AutosaveStatus = 'idle' | 'scheduled' | 'saving' | 'saved' | 'error';

export interface AutosaveOptions<T> {
  readonly delayMs?: number;
  readonly save: (value: T) => Promise<void>;
  readonly onStatusChange?: (status: AutosaveStatus, error?: unknown) => void;
}

export interface AutosaveController<T> {
  update(value: T): void;
  flush(): Promise<void>;
  dispose(): void;
}

export function createAutosave<T>({ delayMs = 500, save, onStatusChange }: AutosaveOptions<T>): AutosaveController<T> {
  let latestValue: T | undefined;
  let latestRevision = 0;
  let persistedRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainPromise: Promise<void> | undefined;
  let disposed = false;

  const setStatus = (status: AutosaveStatus, error?: unknown) => {
    if (!disposed) onStatusChange?.(status, error);
  };

  const drain = (): Promise<void> => {
    if (!drainPromise) {
      drainPromise = (async () => {
        while (latestValue !== undefined && persistedRevision < latestRevision) {
          const value = latestValue;
          const revision = latestRevision;
          setStatus('saving');
          try {
            await save(value);
          } catch (error: unknown) {
            setStatus('error', error);
            throw error;
          }
          persistedRevision = Math.max(persistedRevision, revision);
          setStatus('saved');
        }
      })().finally(() => {
        drainPromise = undefined;
      });
    }
    return drainPromise;
  };

  return {
    update(value) {
      if (disposed) return;
      latestValue = value;
      latestRevision += 1;
      if (timer) clearTimeout(timer);
      setStatus('scheduled');
      timer = setTimeout(() => {
        timer = undefined;
        void drain().catch(() => undefined);
      }, delayMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await drain();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      void drain().catch(() => undefined);
    },
  };
}
