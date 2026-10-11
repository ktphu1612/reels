import { ReelForgeError, createErrorPayload } from '@reelforge/core';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type Timeout = <T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  milliseconds: number,
  clock: Clock,
) => Promise<T>;
export type Clock = () => number;

export interface NetworkDependencies {
  readonly fetch?: FetchLike;
  readonly sleep?: Sleep;
  readonly timeout?: Timeout;
  readonly clock?: Clock;
  readonly timeoutMilliseconds?: number;
}

const RETRY_DELAYS = [2000, 5000, 15000] as const;

export function createNetworkDependencies(input: NetworkDependencies = {}): Required<NetworkDependencies> {
  return {
    fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
    sleep: input.sleep ?? abortableSleep,
    timeout: input.timeout ?? withTimeout,
    clock: input.clock ?? Date.now,
    timeoutMilliseconds: input.timeoutMilliseconds ?? 30_000,
  };
}

export async function fetchWithRetry(
  dependencies: Required<NetworkDependencies>,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchAndReadWithRetry(dependencies, url, init, async (response) => response, signal);
}

export async function fetchAndReadWithRetry<T>(
  dependencies: Required<NetworkDependencies>,
  url: string,
  init: RequestInit,
  readBody: (response: Response) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    throwIfCancelled(signal);
    try {
      const result = await dependencies.timeout<FetchAttemptResult<T>>(
        async (timeoutSignal) => {
          const requestSignal = combineSignals(signal, timeoutSignal);
          const response = await dependencies.fetch(url, {
          ...init,
            signal: requestSignal,
          });
          if (!response.ok) return { response };
          const value = await raceWithTransportAbort(readBody(response), requestSignal) as T;
          return { response, value } as const;
        },
        dependencies.timeoutMilliseconds,
        dependencies.clock,
      );
      throwIfCancelled(signal);
      if (result.response.ok && 'value' in result) {
        return result.value;
      }
      if (!isRetryableStatus(result.response.status)) {
        throw responseError(result.response.status);
      }
      if (attempt === RETRY_DELAYS.length) {
        throw unavailableError();
      }
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (error instanceof ReelForgeError) {
        throw error;
      }
      if (attempt === RETRY_DELAYS.length) {
        throw unavailableError();
      }
    }
    await raceWithCancellation(
      dependencies.sleep(RETRY_DELAYS[attempt] as number, signal),
      signal,
    );
  }
  throw unavailableError();
}

type FetchAttemptResult<T> = { readonly response: Response; readonly value: T } | { readonly response: Response };

export function cancellationError(): ReelForgeError {
  return new ReelForgeError(createErrorPayload('CANCELLED', 'TTS synthesis was cancelled'));
}

export function unavailableError(): ReelForgeError {
  return new ReelForgeError(createErrorPayload('PROVIDER_UNAVAILABLE', 'TTS provider is temporarily unavailable'));
}

export function invalidProviderResponse(): ReelForgeError {
  return new ReelForgeError(createErrorPayload('PROVIDER_UNAVAILABLE', 'TTS provider returned an invalid response'));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function responseError(status: number): ReelForgeError {
  if (status === 401 || status === 403) {
    return new ReelForgeError(createErrorPayload('UNAUTHORIZED', 'TTS provider credentials were rejected'));
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ReelForgeError(createErrorPayload('INVALID_INPUT', 'TTS provider rejected the request'));
  }
  return unavailableError();
}

function withTimeout<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  milliseconds: number,
  clock: Clock,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const deadline = clock() + milliseconds;
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('TTS request timed out'));
    }, Math.max(0, deadline - clock()));
    void operation(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError();
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancellationError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function raceWithCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancellationError());
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function raceWithTransportAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error('TTS transport was aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('TTS transport was aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
