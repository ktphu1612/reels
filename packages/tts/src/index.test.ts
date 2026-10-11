import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppPaths } from '@reelforge/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ElevenLabsTtsProvider, EnvSecretStore, GoogleTtsProvider, TtsCache, createNetworkDependencies, createTtsCacheKey, fetchWithRetry } from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createEnvFile(contents: string): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, '.env.local');
  await writeFile(filePath, contents, 'utf8');
  return { directory, filePath };
}

describe('EnvSecretStore', () => {
  it('persists only allowlisted secrets while preserving comments and unrelated variables', async () => {
    // Production break caught: rewriting the full dotenv file can erase comments or unrelated application settings.
    const { filePath } = await createEnvFile('# local secrets\nKEEP_ME=unchanged\nGOOGLE_TTS_API_KEY=old-value\n');
    const store = new EnvSecretStore(filePath);

    await store.update({ GOOGLE_TTS_API_KEY: 'google-secret-1234', ELEVENLABS_API_KEY: 'eleven-secret-5678' });
    const publicStatus = await store.publicStatus('D:\\output', 2);
    const persisted = await readFile(filePath, 'utf8');

    expect(await store.read('GOOGLE_TTS_API_KEY')).toBe('google-secret-1234');
    expect(persisted).toContain('# local secrets\nKEEP_ME=unchanged\n');
    expect(persisted).toContain('GOOGLE_TTS_API_KEY=google-secret-1234');
    expect(persisted).toContain('ELEVENLABS_API_KEY=eleven-secret-5678');
    expect(publicStatus).toMatchObject({
      outputDirectory: 'D:\\output',
      concurrency: 2,
      providers: { google: { ready: true }, elevenlabs: { ready: true } },
    });
    expect(publicStatus.providers.google.maskedKey).toMatch(/1234$/);
    expect(publicStatus.providers.google.maskedKey).not.toContain('google-secret');

    await store.clear(['GOOGLE_TTS_API_KEY']);

    expect(await store.read('GOOGLE_TTS_API_KEY')).toBeUndefined();
    expect(await readFile(filePath, 'utf8')).not.toContain('GOOGLE_TTS_API_KEY=');
  });

  it('rejects control-character injection before writing secret values', async () => {
    // Production break caught: newline injection could persist arbitrary dotenv variables beside an allowlisted key.
    const { filePath } = await createEnvFile('KEEP_ME=unchanged\n');
    const store = new EnvSecretStore(filePath);

    await expect(store.update({ GOOGLE_TTS_API_KEY: 'safe\nINJECTED=value' })).rejects.toMatchObject({
      payload: { code: 'INVALID_INPUT' },
    });

    await expect(readFile(filePath, 'utf8')).resolves.toBe('KEEP_ME=unchanged\n');
  });

  it.each(['$&', "$'", '$`'])('stores the literal replacement token %s without reproducing dotenv lines', async (secretValue) => {
    // Production break caught: String.replace expands $&, $', and $` in a replacement string, which can duplicate existing dotenv assignments.
    const { filePath } = await createEnvFile('KEEP_ME=unchanged\nGOOGLE_TTS_API_KEY=old-value\nEVIL=must-not-change\n');
    const store = new EnvSecretStore(filePath);

    await store.update({ GOOGLE_TTS_API_KEY: secretValue });

    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      `KEEP_ME=unchanged\nGOOGLE_TTS_API_KEY=${secretValue}\nEVIL=must-not-change\n`,
    );
  });
});

describe('network timeout boundary', () => {
  it('passes an abort signal to the real fetch operation', async () => {
    // Production break caught: a timeout that only rejects its wrapper leaves a real HTTP request running after retries begin.
    let receivedSignal: AbortSignal | null | undefined;
    const network = createNetworkDependencies({
      fetch: async (_url, init) => {
        receivedSignal = init?.signal;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      timeoutMilliseconds: 100,
    });

    await fetchWithRetry(network, 'https://example.invalid/voices', { method: 'GET' });

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('propagates caller cancellation through fetch and does not retry or back off', async () => {
    // Production break caught: cancelling an attempt can leave a hung provider request or retry sleep alive until its timeout.
    const controller = new AbortController();
    let calls = 0;
    const network = createNetworkDependencies({
      fetch: async (_url, init) => {
        calls += 1;
        const signal = init?.signal;
        if (!signal) throw new Error('caller signal was not propagated');
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      sleep: async () => { throw new Error('cancelled request must not back off'); },
      timeout: async (operation) => operation(),
    });

    const pending = fetchWithRetry(network, 'https://example.invalid/synthesize', { method: 'POST' }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
    expect(calls).toBe(1);
  });
});

describe('GoogleTtsProvider', () => {
  it('keeps timeout ownership through a successful response body and retries body transport failure', async () => {
    // Production break caught: returning at HTTP headers disables the timeout/retry policy while response.json is still pending.
    let calls = 0;
    let timeoutAttempts = 0;
    const delays: number[] = [];
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => 'google-key-1234' },
      fetch: async (_url, init) => {
        calls += 1;
        const requestSignal = init?.signal;
        return {
          ok: true,
          status: 200,
          json: () => new Promise<unknown>((resolve, reject) => {
            if (calls === 2) {
              resolve({ audioContent: 'c291bmQ=' });
              return;
            }
            const fail = (): void => reject(new Error('response body transport failed'));
            if (requestSignal?.aborted) fail();
            else requestSignal?.addEventListener('abort', fail, { once: true });
          }),
        } as Response;
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      timeout: async (operation) => {
        timeoutAttempts += 1;
        if (timeoutAttempts > 1) return operation();
        const controller = new AbortController();
        const pending = operation(controller.signal);
        await Promise.resolve();
        controller.abort();
        return pending;
      },
    });

    await expect(provider.synthesize({
      provider: 'google', voiceId: 'vi-VN-Neural2-A', text: 'body timeout', speakingRate: 1, audioFormat: 'mp3',
    })).resolves.toEqual({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' });
    expect(calls).toBe(2);
    expect(delays).toEqual([2000]);
  });

  it('does not retry an external abort while reading a successful response body', async () => {
    // Production break caught: body-level cancellation can be mistaken for a retryable transport failure and spend more provider calls.
    const controller = new AbortController();
    let calls = 0;
    let bodyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => 'google-key-1234' },
      fetch: async (_url, init) => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: () => new Promise<unknown>((_resolve, reject) => {
            bodyStarted?.();
            const signal = init?.signal;
            const fail = (): void => reject(new Error('body aborted'));
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          }),
        } as Response;
      },
      sleep: async () => { throw new Error('external cancellation must not back off'); },
      timeout: async (operation) => operation(),
    });

    const pending = provider.synthesize({
      provider: 'google', voiceId: 'vi-VN-Neural2-A', text: 'cancel body', speakingRate: 1, audioFormat: 'mp3',
    }, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
    expect(calls).toBe(1);
  });

  it('retries a throttled voices request with the prescribed delays and maps complete voice records', async () => {
    // Production break caught: transient Google throttling could fail a voice picker instead of retrying safely.
    let calls = 0;
    const delays: number[] = [];
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => 'google-key-1234' },
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { code: 429, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
        }
        return new Response(JSON.stringify({
          voices: [{ languageCodes: ['vi-VN'], name: 'vi-VN-Neural2-A', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      timeout: async (operation) => operation(),
    });

    await expect(provider.listVoices({ provider: 'google', languageCode: 'vi-VN' })).resolves.toEqual({
      voices: [{ id: 'vi-VN-Neural2-A', name: 'vi-VN-Neural2-A', languageCode: 'vi-VN' }],
    });
    expect(calls).toBe(2);
    expect(delays).toEqual([2000]);
  });

  it('reports rejected credentials safely without retrying', async () => {
    // Production break caught: an invalid key could be retried and expose provider response text to a public settings screen.
    let calls = 0;
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => 'google-key-1234' },
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: 401, message: 'key=google-key-1234 is invalid', status: 'UNAUTHENTICATED' } }), { status: 401 });
      },
      sleep: async () => undefined,
      timeout: async (operation) => operation(),
    });

    const result = await provider.validateCredentials({ provider: 'google' });

    expect(result).toEqual({ ready: false, message: 'TTS provider credentials were rejected' });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('google-key-1234');
  });

  it('reports missing credentials safely without calling the network', async () => {
    // Production break caught: an absent key could make a request with an empty credential instead of giving a safe not-ready result.
    let called = false;
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => undefined },
      fetch: async () => { called = true; return new Response(null, { status: 500 }); },
      sleep: async () => undefined,
      timeout: async (operation) => operation(),
    });

    await expect(provider.validateCredentials({ provider: 'google' })).resolves.toEqual({
      ready: false,
      message: 'TTS provider credentials are not configured',
    });
    expect(called).toBe(false);
  });

  it.each([
    [400, 'INVALID_INPUT'],
    [401, 'UNAUTHORIZED'],
    [403, 'UNAUTHORIZED'],
    [404, 'INVALID_INPUT'],
    [422, 'INVALID_INPUT'],
  ] as const)('does not retry HTTP %i validation or authentication failures', async (status, code) => {
    // Production break caught: a non-retryable client failure can waste retries and delay user-facing credential feedback.
    let calls = 0;
    const delays: number[] = [];
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => 'google-key-1234' },
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: status, message: 'invalid request', status: 'FAILED_PRECONDITION' } }), { status });
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      timeout: async (operation) => operation(),
    });

    await expect(provider.listVoices({ provider: 'google' })).rejects.toMatchObject({ payload: { code } });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries an injected timeout and sends a Google synthesis request with derived language and base64 audio', async () => {
    // Production break caught: timeout failures could skip retries or synthesis could omit the selected voice language/format.
    let timeoutCalls = 0;
    const delays: number[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => 'google-key-1234' },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ audioContent: 'c291bmQ=' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      timeout: async (operation) => {
        timeoutCalls += 1;
        if (timeoutCalls === 1) {
          throw new Error('deadline exceeded');
        }
        return operation();
      },
    });

    await expect(provider.synthesize({
      provider: 'google',
      voiceId: 'en-US-Neural2-C',
      text: 'Hello',
      speakingRate: 1.25,
      audioFormat: 'wav',
    })).resolves.toEqual({ audioBase64: 'c291bmQ=', contentType: 'audio/wav' });
    expect(delays).toEqual([2000]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize?key=google-key-1234');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      input: { text: 'Hello' },
      voice: { name: 'en-US-Neural2-C', languageCode: 'en-US' },
      audioConfig: { audioEncoding: 'LINEAR16', speakingRate: 1.25 },
    });
  });

  it('retries server failures at most three times and redacts provider response details', async () => {
    // Production break caught: a 5xx could either fail without retrying or surface a key-bearing provider body in a structured error.
    let calls = 0;
    const delays: number[] = [];
    const provider = new GoogleTtsProvider({
      secrets: { read: async () => 'google-key-1234' },
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: 500, message: 'https://example.invalid?key=google-key-1234 body=Hello', status: 'INTERNAL' } }), { status: 500 });
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      timeout: async (operation) => operation(),
    });

    await expect(provider.listVoices({ provider: 'google' })).rejects.toMatchObject({
      payload: { code: 'PROVIDER_UNAVAILABLE', message: 'TTS provider is temporarily unavailable' },
    });
    expect(calls).toBe(4);
    expect(delays).toEqual([2000, 5000, 15000]);
  });
});

describe('ElevenLabsTtsProvider', () => {
  it('maps complete voice records using requested language and sends encoded binary synthesis requests', async () => {
    // Production break caught: an adapter can accidentally drop ElevenLabs voice metadata or issue an unencoded synthesis request.
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new ElevenLabsTtsProvider({
      secrets: { read: async () => 'eleven-key-5678' },
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({
            voices: [{
              voice_id: 'voice/id', name: 'Vietnamese Voice', samples: [], category: 'generated',
              fine_tuning: { is_allowed_to_fine_tune: true, state: { eleven_multilingual_v2: 'fine_tuned' }, verification_failures: [], verification_attempts_count: 0, manual_verification_requested: false },
              labels: { language: 'Vietnamese' }, description: 'A voice', preview_url: 'https://cdn.example/voice.mp3', available_for_tiers: ['free'],
              settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
              verified_languages: [{ language: 'vi', model_id: 'eleven_multilingual_v2', accent: 'VN', locale: 'vi-VN', preview_url: 'https://cdn.example/voice.mp3' }],
              collection_ids: [], is_owner: true, is_legacy: false, is_mixed: false,
            }],
            has_more: false, total_count: 1, next_page_token: null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/wav' } });
      },
      sleep: async () => undefined,
      timeout: async (operation) => operation(),
    });

    await expect(provider.listVoices({ provider: 'elevenlabs', languageCode: 'vi' })).resolves.toEqual({
      voices: [{ id: 'voice/id', name: 'Vietnamese Voice', languageCode: 'vi' }],
    });
    await expect(provider.synthesize({
      provider: 'elevenlabs', voiceId: 'voice/id', modelId: 'eleven_v3', text: 'Xin chào', speakingRate: 1.1, audioFormat: 'wav',
    })).resolves.toEqual({ audioBase64: 'AQID', contentType: 'audio/wav' });
    expect(requests[0]?.url).toBe('https://api.elevenlabs.io/v2/voices?page_size=100');
    expect(requests[0]?.init?.headers).toEqual({ 'xi-api-key': 'eleven-key-5678' });
    expect(requests[1]?.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid?output_format=wav_44100');
    expect(requests[1]?.init?.headers).toEqual({ 'content-type': 'application/json', 'xi-api-key': 'eleven-key-5678' });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      text: 'Xin chào', model_id: 'eleven_v3',
    });
  });

  it('uses metadata language or multilingual when no requested language is available', async () => {
    // Production break caught: voices lacking a requested locale could produce an invalid empty language in the shared contract.
    const provider = new ElevenLabsTtsProvider({
      secrets: { read: async () => 'eleven-key-5678' },
      fetch: async () => new Response(JSON.stringify({
        voices: [
          { voice_id: 'metadata', name: 'Metadata', labels: { language: 'Vietnamese' }, verified_languages: [] },
          { voice_id: 'fallback', name: 'Fallback', labels: {}, verified_languages: [] },
        ],
        has_more: false, total_count: 2, next_page_token: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      sleep: async () => undefined,
      timeout: async (operation) => operation(),
    });

    await expect(provider.listVoices({ provider: 'elevenlabs' })).resolves.toEqual({
      voices: [
        { id: 'metadata', name: 'Metadata', languageCode: 'Vietnamese' },
        { id: 'fallback', name: 'Fallback', languageCode: 'multilingual' },
      ],
    });
  });

  it('aggregates every cursor page and URL-encodes next_page_token', async () => {
    // Production break caught: only loading the first ElevenLabs page silently omits selectable voices beyond the default page size.
    const requests: string[] = [];
    const provider = new ElevenLabsTtsProvider({
      secrets: { read: async () => 'eleven-key-5678' },
      fetch: async (url) => {
        requests.push(url);
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            voices: [{ voice_id: 'first', name: 'First', labels: { language: 'vi' }, verified_languages: [] }],
            has_more: true, total_count: 2, next_page_token: 'next token/plus?',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          voices: [{ voice_id: 'second', name: 'Second', labels: { language: 'en' }, verified_languages: [] }],
          has_more: false, total_count: 2, next_page_token: null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      sleep: async () => undefined,
      timeout: async (operation) => operation(),
    });

    await expect(provider.listVoices({ provider: 'elevenlabs' })).resolves.toEqual({
      voices: [
        { id: 'first', name: 'First', languageCode: 'vi' },
        { id: 'second', name: 'Second', languageCode: 'en' },
      ],
    });
    expect(requests).toEqual([
      'https://api.elevenlabs.io/v2/voices?page_size=100',
      'https://api.elevenlabs.io/v2/voices?page_size=100&next_page_token=next+token%2Fplus%3F',
    ]);
  });

  it.each([
    { name: 'missing', nextPageToken: null },
    { name: 'repeated', nextPageToken: 'first-page' },
  ])('rejects a %s pagination cursor instead of looping indefinitely', async ({ nextPageToken }) => {
    // Production break caught: has_more without a fresh cursor can make the provider loop forever or return an incomplete voice list.
    let calls = 0;
    const provider = new ElevenLabsTtsProvider({
      secrets: { read: async () => 'eleven-key-5678' },
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          voices: [{ voice_id: `voice-${calls}`, name: 'Voice', labels: {}, verified_languages: [] }],
          has_more: true, total_count: 2, next_page_token: nextPageToken,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      sleep: async () => undefined,
      timeout: async (operation) => operation(),
    });

    await expect(provider.listVoices({ provider: 'elevenlabs' })).rejects.toMatchObject({
      payload: { code: 'PROVIDER_UNAVAILABLE' },
    });
  });
});

describe('TtsCache', () => {
  it('starts a fresh producer immediately after abort instead of joining the aborted producer', async () => {
    // Production break caught: the abort wrapper rejected before its async finally released the last consumer.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'synchronous handoff', speakingRate: 1, audioFormat: 'mp3' as const,
    };
    const controller = new AbortController();
    let calls = 0;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let releaseFirst: (() => void) | undefined;
    const synthesize = async (signal?: AbortSignal) => {
      calls += 1;
      if (calls === 1) {
        firstStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
          signal?.addEventListener('abort', () => undefined, { once: true });
        });
      }
      return { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' };
    };

    const cancelled = cache.getOrCreate(request, synthesize, controller.signal);
    await started;
    controller.abort();
    const fresh = cache.getOrCreate(request, synthesize);

    let observedError: unknown;
    try {
      await vi.waitFor(() => expect(calls).toBe(2));
    } catch (error) {
      observedError = error;
    } finally {
      releaseFirst?.();
    }

    await expect(cancelled).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
    await expect(fresh).resolves.toMatchObject({ cacheHit: false });
    if (observedError) throw observedError;
  });

  it('keeps last-consumer cancellation pending until producer cleanup completes', async () => {
    // Production break caught: last-consumer cancellation returned before the provider had finished unwinding.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'cleanup gate', speakingRate: 1, audioFormat: 'mp3' as const,
    };
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const synthesis = async (signal?: AbortSignal) => {
      markStarted?.();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          markCleanupStarted?.();
          void cleanupGate.then(() => reject(new Error('provider cleanup complete')));
        }, { once: true });
      });
    };

    const pending = cache.getOrCreate(request, synthesis, controller.signal);
    await started;
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    controller.abort();
    await cleanupStarted;
    await Promise.resolve();
    const settledBeforeCleanup = settled;
    releaseCleanup?.();

    expect(settledBeforeCleanup).toBe(false);
    await expect(pending).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
  });

  it('converges simultaneous two-instance publication on one immutable file', async () => {
    // Production break caught: two processes racing a miss must converge on one closed file instead of failing the link loser.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const firstCache = new TtsCache(paths);
    const secondCache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'simultaneous link winner', speakingRate: 1, audioFormat: 'mp3' as const,
    };
    const key = createTtsCacheKey(request);
    let producers = 0;
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
    let releaseProducers: (() => void) | undefined;
    const producerGate = new Promise<void>((resolve) => { releaseProducers = resolve; });
    const producer = async () => {
      const producerId = ++producers;
      if (producerId === 2) markBothStarted?.();
      await producerGate;
      return producerId === 1
        ? { audioBase64: 'Zmlyc3Q=', contentType: 'audio/mpeg' }
        : { audioBase64: 'c2Vjb25k', contentType: 'audio/mpeg' };
    };

    const first = firstCache.getOrCreate(request, producer);
    const second = secondCache.getOrCreate(request, producer);
    await bothStarted;
    releaseProducers?.();

    const entries = await Promise.all([first, second]);
    expect(entries.map((entry) => entry.cacheHit).sort()).toEqual([false, true]);
    expect(entries[0]?.absolutePath).toBe(join(paths.ttsCache, `${key}.mp3`));
    const finalBytes = await readFile(join(paths.ttsCache, `${key}.mp3`));
    expect(['first', 'second']).toContain(finalBytes.toString());
    await expect(readdir(paths.ttsCache)).resolves.toEqual([`${key}.mp3`]);
  });

  it('does not let a suspended old producer overwrite a later immutable winner', async () => {
    // Production break caught: a producer that resumes after another instance wins must converge to that winner, never replace it.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const oldCache = new TtsCache(paths);
    const newCache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'suspended old producer', speakingRate: 1, audioFormat: 'wav' as const,
    };
    let oldStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { oldStarted = resolve; });
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const old = oldCache.getOrCreate(request, async () => {
      oldStarted?.();
      await oldGate;
      return { audioBase64: 'b2xk', contentType: 'audio/wav' };
    });

    await started;
    const winner = await newCache.getOrCreate(request, async () => ({
      audioBase64: 'bmV3', contentType: 'audio/wav',
    }));
    releaseOld?.();

    expect(winner).toMatchObject({ cacheHit: false });
    await expect(old).resolves.toMatchObject({ cacheHit: true });
    await expect(readFile(join(paths.ttsCache, `${createTtsCacheKey(request)}.wav`))).resolves.toEqual(Buffer.from('new'));
  });

  it('does not let a late loser delete the winner after a publication collision', async () => {
    // Production break caught: loser cleanup must never remove or replace a final file that another instance already published.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const loserCache = new TtsCache(paths);
    const winnerCache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'loser cleanup', speakingRate: 1, audioFormat: 'mp3' as const,
    };
    let loserStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { loserStarted = resolve; });
    let releaseLoser: (() => void) | undefined;
    const loserGate = new Promise<void>((resolve) => { releaseLoser = resolve; });
    const loser = loserCache.getOrCreate(request, async () => {
      loserStarted?.();
      await loserGate;
      return { audioBase64: 'b2xk', contentType: 'audio/mpeg' };
    });

    await started;
    await expect(winnerCache.getOrCreate(request, async () => ({
      audioBase64: 'd2lubmVy', contentType: 'audio/mpeg',
    }))).resolves.toMatchObject({ cacheHit: false });
    releaseLoser?.();

    await expect(loser).resolves.toMatchObject({ cacheHit: true });
    const finalPath = join(paths.ttsCache, `${createTtsCacheKey(request)}.mp3`);
    await expect(readFile(finalPath)).resolves.toEqual(Buffer.from('winner'));
    await expect(readdir(paths.ttsCache)).resolves.toEqual([`${createTtsCacheKey(request)}.mp3`]);
  });

  it('fails safely and preserves an externally corrupt final file', async () => {
    // Production break caught: an invalid final must surface a structured error without being deleted or overwritten by a replacement.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'external corrupt final', speakingRate: 1, audioFormat: 'wav' as const,
    };
    const finalPath = join(paths.ttsCache, `${createTtsCacheKey(request)}.wav`);
    await mkdir(paths.ttsCache, { recursive: true });
    await writeFile(finalPath, Buffer.alloc(0));
    let synthesisCalls = 0;

    await expect(cache.getOrCreate(request, async () => {
      synthesisCalls += 1;
      return { audioBase64: 'bmV3', contentType: 'audio/wav' };
    })).rejects.toMatchObject({ payload: { code: 'PROVIDER_UNAVAILABLE' } });

    expect(synthesisCalls).toBe(0);
    await expect(readFile(finalPath)).resolves.toEqual(Buffer.alloc(0));
    await expect(readdir(paths.ttsCache)).resolves.toEqual([`${createTtsCacheKey(request)}.wav`]);
  });

  it('converges repeated two-instance races without extra final or temporary files', async () => {
    // Production break caught: repeated independent races must remain deterministic and leave only immutable winners behind.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const firstCache = new TtsCache(paths);
    const secondCache = new TtsCache(paths);

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const request = {
        provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: `repeated race ${iteration}`, speakingRate: 1, audioFormat: 'mp3' as const,
      };
      let producers = 0;
      let markBothStarted: (() => void) | undefined;
      const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
      let releaseProducers: (() => void) | undefined;
      const producerGate = new Promise<void>((resolve) => { releaseProducers = resolve; });
      const producer = async () => {
        const producerId = ++producers;
        if (producerId === 2) markBothStarted?.();
        await producerGate;
        return { audioBase64: producerId === 1 ? 'QQ==' : 'Qg==', contentType: 'audio/mpeg' };
      };

      const first = firstCache.getOrCreate(request, producer);
      const second = secondCache.getOrCreate(request, producer);
      await bothStarted;
      releaseProducers?.();
      const entries = await Promise.all([first, second]);

      expect(entries.map((entry) => entry.cacheHit).sort()).toEqual([false, true]);
      const finalBytes = await readFile(join(paths.ttsCache, `${createTtsCacheKey(request)}.mp3`));
      expect(['A', 'B']).toContain(finalBytes.toString());
    }

    await expect(readdir(paths.ttsCache)).resolves.toHaveLength(20);
  });

  it('evicts an aborted unshared producer before it settles so a new caller starts fresh', async () => {
    // Production break caught: retry can join an already-aborted producer that is still unwinding and inherit its cancellation.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'handoff', speakingRate: 1, audioFormat: 'mp3' as const,
    };
    const controller = new AbortController();
    let calls = 0;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let releaseFirst: (() => void) | undefined;
    const synthesize = async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted?.();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' };
    };

    const cancelled = cache.getOrCreate(request, synthesize, controller.signal);
    await started;
    controller.abort();
    const fresh = cache.getOrCreate(request, synthesize);
    await vi.waitFor(() => expect(calls).toBe(2));
    releaseFirst?.();

    await expect(cancelled).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
    await expect(fresh).resolves.toMatchObject({ cacheHit: false });
    await expect(readFile(join(paths.ttsCache, `${createTtsCacheKey(request)}.mp3`))).resolves.toEqual(Buffer.from('sound'));
  });

  it('aborts an unshared hung synthesis without publishing a cache entry', async () => {
    // Production break caught: worker cancellation can remain stuck in TTS and later publish audio for a cancelled attempt.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'hung', speakingRate: 1, audioFormat: 'mp3' as const,
    };
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const synthesisStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = cache.getOrCreate(request, async (signal) => {
      started?.();
      if (!signal) throw new Error('cache did not provide a producer signal');
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }, controller.signal);
    const outcome = pending.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await synthesisStarted;
    controller.abort();

    expect((await outcome).error).toMatchObject({ payload: { code: 'CANCELLED' } });
    await expect(readdir(paths.ttsCache)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps shared synthesis alive when one cache caller cancels', async () => {
    // Production break caught: aborting one duplicate narration can cancel another active job that safely shares the same cache producer.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'shared', speakingRate: 1, audioFormat: 'mp3' as const,
    };
    const firstController = new AbortController();
    let calls = 0;
    let markStarted: (() => void) | undefined;
    const synthesisStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let finish: (() => void) | undefined;
    const synthesis = async (signal?: AbortSignal) => {
      calls += 1;
      markStarted?.();
      if (!signal) throw new Error('cache did not provide a producer signal');
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' };
    };

    const first = cache.getOrCreate(request, synthesis, firstController.signal);
    const second = cache.getOrCreate(request, synthesis);
    const firstOutcome = first.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    const secondOutcome = second.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await synthesisStarted;
    firstController.abort();
    finish?.();

    expect((await firstOutcome).error).toMatchObject({ payload: { code: 'CANCELLED' } });
    expect((await secondOutcome).value).toMatchObject({ cacheHit: false });
    expect(calls).toBe(1);
    await expect(readdir(paths.ttsCache)).resolves.toHaveLength(1);
  });

  it('uses a canonical secret-free key and reuses a validated cached audio file', async () => {
    // Production break caught: cache keys can become unstable or include credentials, causing misses and a secret disclosure risk.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'elevenlabs' as const, voiceId: 'voice-a', text: 'Xin chào', speakingRate: 1.1, audioFormat: 'mp3' as const,
    };
    const expectedKey = createHash('sha256').update(
      '{"cacheVersion":1,"provider":"elevenlabs","voiceId":"voice-a","modelId":"eleven_multilingual_v2","text":"Xin chào","speakingRate":1.1,"audioFormat":"mp3"}',
    ).digest('hex');
    let synthesisCalls = 0;
    const synthesize = async () => {
      synthesisCalls += 1;
      return { audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' };
    };

    const first = await cache.getOrCreate(request, synthesize);
    const second = await cache.getOrCreate(request, synthesize);

    expect(first).toEqual({
      cacheHit: false,
      key: expectedKey,
      absolutePath: join(paths.ttsCache, `${expectedKey}.mp3`),
      relativePath: `cache/tts/${expectedKey}.mp3`,
      contentType: 'audio/mpeg',
    });
    expect(second).toEqual({ ...first, cacheHit: true });
    expect(synthesisCalls).toBe(1);
    await expect(readFile(first.absolutePath)).resolves.toEqual(Buffer.from('sound'));
  });

  it('deduplicates concurrent synthesis and leaves no cache files after an invalid result or failure', async () => {
    // Production break caught: parallel cards can spend twice for the same narration or failed writes can poison future cache hits.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = {
      provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'Xin chào', speakingRate: 1, audioFormat: 'wav' as const,
    };
    let synthesisCalls = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolveSynthesis: ((value: { audioBase64: string; contentType: string }) => void) | undefined;
    const synthesis = () => {
      synthesisCalls += 1;
      markStarted?.();
      return new Promise<{ audioBase64: string; contentType: string }>((resolve) => { resolveSynthesis = resolve; });
    };

    const first = cache.getOrCreate(request, synthesis);
    const second = cache.getOrCreate(request, synthesis);
    await started;
    resolveSynthesis?.({ audioBase64: 'c291bmQ=', contentType: 'audio/wav' });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(synthesisCalls).toBe(1);

    const failingRequest = { ...request, text: 'Will fail' };
    await expect(cache.getOrCreate(failingRequest, async () => ({ audioBase64: 'not base64!', contentType: 'audio/wav' }))).rejects.toMatchObject({
      payload: { code: 'PROVIDER_UNAVAILABLE' },
    });
    const entryNames = await readdir(paths.ttsCache);
    expect(entryNames).toEqual([`${createTtsCacheKey(request)}.wav`]);
  });

  it('reads a safe legacy directory entry without creating a manifest for new entries', async () => {
    // Production break caught: a valid entry from the previous directory layout should remain readable during the single-file migration.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = { provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'safe legacy', speakingRate: 1, audioFormat: 'wav' as const };
    await mkdir(paths.ttsCache, { recursive: true });
    const key = createTtsCacheKey(request);
    const legacyAudioPath = join(paths.ttsCache, key, 'audio.wav');
    await mkdir(join(paths.ttsCache, key), { recursive: true });
    await writeFile(legacyAudioPath, 'legacy audio');
    await writeFile(join(paths.ttsCache, key, 'metadata.json'), JSON.stringify({
      cacheVersion: 1,
      key,
      contentType: 'audio/wav',
      relativePath: `cache/tts/${key}/audio.wav`,
    }));
    let synthesisCalls = 0;

    await expect(cache.getOrCreate(request, async () => {
      synthesisCalls += 1;
      return { audioBase64: 'bmV3', contentType: 'audio/wav' };
    })).resolves.toEqual({
      cacheHit: true,
      key,
      absolutePath: legacyAudioPath,
      relativePath: `cache/tts/${key}/audio.wav`,
      contentType: 'audio/wav',
    });
    expect(synthesisCalls).toBe(0);
    await expect(readFile(legacyAudioPath)).resolves.toEqual(Buffer.from('legacy audio'));
  });

  it('leaves an incomplete legacy directory untouched while publishing a new single-file entry', async () => {
    // Production break caught: migrating a bad old entry must not destructively clean bytes that another process may still own.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = { provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'incomplete legacy', speakingRate: 1, audioFormat: 'wav' as const };
    const key = createTtsCacheKey(request);
    const legacyDirectory = join(paths.ttsCache, key);
    const legacyAudioPath = join(legacyDirectory, 'audio.wav');
    const legacyMetadataPath = join(legacyDirectory, 'metadata.json');
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(legacyAudioPath, 'legacy bytes');
    await writeFile(legacyMetadataPath, 'not json');

    await expect(cache.getOrCreate(request, async () => ({
      audioBase64: 'bmV3', contentType: 'audio/wav',
    }))).resolves.toMatchObject({
      cacheHit: false,
      absolutePath: join(paths.ttsCache, `${key}.wav`),
    });
    await expect(readFile(legacyAudioPath)).resolves.toEqual(Buffer.from('legacy bytes'));
    await expect(readFile(legacyMetadataPath, 'utf8')).resolves.toBe('not json');
    await expect(readFile(join(paths.ttsCache, `${key}.wav`))).resolves.toEqual(Buffer.from('new'));
  });

  it('leaves no final or temporary entry when the producer or cache write fails', async () => {
    // Production break caught: a failed producer or filesystem write can leave a published cache directory or an abandoned temporary sibling.
    const directory = await mkdtemp(join(tmpdir(), 'reelforge-tts-cache-'));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const cache = new TtsCache(paths);
    const request = { provider: 'google' as const, voiceId: 'vi-VN-Neural2-A', text: 'producer-failure', speakingRate: 1, audioFormat: 'wav' as const };

    await expect(cache.getOrCreate(request, async () => { throw new Error('provider failed'); })).rejects.toThrow('provider failed');
    await expect(readdir(paths.ttsCache)).rejects.toMatchObject({ code: 'ENOENT' });

    const blockedCachePath = join(directory, 'blocked-cache');
    await writeFile(blockedCachePath, 'not a directory');
    const blockedCache = new TtsCache({ ...paths, ttsCache: blockedCachePath });
    await expect(blockedCache.getOrCreate({ ...request, text: 'write-failure' }, async () => ({
      audioBase64: 'c291bmQ=', contentType: 'audio/wav',
    }))).rejects.toMatchObject({ payload: { code: 'PROVIDER_UNAVAILABLE' } });
    await expect(readdir(directory)).resolves.toEqual(['blocked-cache']);
  });
});
