import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RenderJobSnapshot, TtsProvider } from '@reelforge/core';
import { QueueStore } from '@reelforge/queue';
import { AssetStore, ProjectStore, TemplateStore, createAppPaths, ensureAppDirectories } from '@reelforge/storage';
import { EnvSecretStore, TtsCache } from '@reelforge/tts';
import { describe, expect, it } from 'vitest';

import * as serverApi from './app.js';

describe('real-listen SSE', () => {
  it('binds to loopback, replays Last-Event-ID, streams live events and heartbeat, then closes cleanly', async () => {
    // Production break caught: the server can bind externally, SSE reconnect can miss state, or disconnected timers can hang shutdown.
    const root = await mkdtemp(join(tmpdir(), 'reelforge-sse-'));
    const paths = createAppPaths(root);
    await ensureAppDirectories(paths);
    const queue = new QueueStore({ databasePath: join(paths.data, 'queue.sqlite'), defaultOutputDirectory: paths.outputs });
    const assets = new AssetStore(paths);
    const provider: TtsProvider = {
      validateCredentials: async () => ({ ready: true }),
      listVoices: async () => ({ voices: [] }),
      synthesize: async () => ({ audioBase64: 'c291bmQ=', contentType: 'audio/mpeg' }),
    };
    const build = (serverApi as Record<string, unknown>).buildServer;
    const listen = (serverApi as Record<string, unknown>).startServer;
    let app: { close(): Promise<void> } | undefined;
    let controller: AbortController | undefined;
    try {
      expect(typeof build).toBe('function');
      expect(typeof listen).toBe('function');
      const job = queue.enqueue(snapshotFixture());
      const cursor = queue.readEvents().at(-1)!.id;
      const replayEvent = queue.appendEvent({ jobId: job.id, type: 'job.replay', payload: { sequence: 2 } });
      let boundaryEvent: ReturnType<QueueStore['appendEvent']> | undefined;
      const boundaryQueue = new Proxy(queue, {
        get(target, property) {
          if (property === 'readEvents') {
            return (afterId?: number, limit?: number) => {
              const events = target.readEvents(afterId, limit);
              if (!boundaryEvent) {
                boundaryEvent = target.appendEvent({ jobId: job.id, type: 'job.boundary', payload: { sequence: 3 } });
              }
              return events;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      app = (build as (dependencies: unknown) => { close(): Promise<void> })({
        paths,
        projects: new ProjectStore(paths, assets),
        templates: new TemplateStore(paths, assets),
        queue: boundaryQueue,
        secrets: new EnvSecretStore(join(root, '.env.local')),
        providers: { google: provider, elevenlabs: provider },
        cache: new TtsCache(paths),
        openOutputDirectory: async () => undefined,
        eventPollIntervalMilliseconds: 10,
        heartbeatMilliseconds: 20,
      });
      const address = await (listen as (app: unknown, port?: number) => Promise<string>)(app, 0);
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:/);
      controller = new AbortController();
      const response = await fetch(`${address}/api/events`, {
        headers: { 'last-event-id': String(cursor) },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const liveEvent = queue.appendEvent({ jobId: job.id, type: 'job.live', payload: { sequence: 4 } });
      const text = await readUntil(reader, (value) => value.includes('event: job.replay')
        && value.includes('event: job.boundary')
        && value.includes('event: job.live')
        && value.includes(': heartbeat'));
      expect(text).toContain(`id: ${replayEvent.id}`);
      expect(text).toContain('"sequence":2');
      expect(text).toContain('"sequence":3');
      expect(text).toContain('"sequence":4');
      for (const id of [replayEvent.id, boundaryEvent!.id, liveEvent.id]) {
        expect([...text.matchAll(new RegExp(`^id: ${id}$`, 'gm'))]).toHaveLength(1);
      }
      await withDeadline(app.close(), 500);
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      app = undefined;
      controller.abort();
    } finally {
      controller?.abort();
      await app?.close();
      queue.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (value: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let value = '';
  const deadline = Date.now() + 5_000;
  while (!done(value)) {
    if (Date.now() > deadline) throw new Error(`Timed out reading SSE: ${value}`);
    const chunk = await reader.read();
    if (chunk.done) break;
    value += decoder.decode(chunk.value, { stream: true });
  }
  return value;
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
      timer.unref();
    }),
  ]);
}

function snapshotFixture(): RenderJobSnapshot {
  return {
    project: {
      schemaVersion: 2,
      id: 'sse-project',
      name: 'SSE project',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 },
      output: { width: 720, height: 1280, fps: 30, crf: 20 },
      cards: [{ id: 'card-1', imagePath: 'assets/card.png', script: 'Narration', order: 0 }],
    },
    template: {
      schemaVersion: 2,
      id: 'template-1',
      name: 'Template',
      backgroundPath: 'assets/background.mp4',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    },
  };
}
