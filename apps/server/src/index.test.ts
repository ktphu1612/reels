import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultServer, resolveServerHost } from './index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production server binding', () => {
  it('binds only to explicit IPv4 loopback and rejects exposure overrides', () => {
    expect(resolveServerHost(undefined)).toBe('127.0.0.1');
    expect(resolveServerHost('127.0.0.1')).toBe('127.0.0.1');
    expect(() => resolveServerHost('0.0.0.0')).toThrow(/loopback/i);
    expect(() => resolveServerHost('localhost')).toThrow(/127\.0\.0\.1/i);
    expect(() => resolveServerHost('::')).toThrow(/loopback/i);
  });

  it('seeds the five launch-directory resource folders idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-index-'));
    const sourceRoot = join(root, 'launch');
    roots.push(root);
    await Promise.all([
      mkdir(join(sourceRoot, 'stickers'), { recursive: true }),
      mkdir(join(sourceRoot, 'meme sounds'), { recursive: true }),
      mkdir(join(sourceRoot, 'transition sound'), { recursive: true }),
      mkdir(join(sourceRoot, 'intro sounds'), { recursive: true }),
      mkdir(join(sourceRoot, 'background audio'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sourceRoot, 'stickers', 'meme.png'), pngBytes()),
      writeFile(join(sourceRoot, 'stickers', 'reaction.mp4'), mp4Bytes()),
      writeFile(join(sourceRoot, 'meme sounds', 'klonk.mp3'), mp3Bytes()),
      writeFile(join(sourceRoot, 'transition sound', 'whoosh.mp3'), mp3Bytes()),
      writeFile(join(sourceRoot, 'intro sounds', 'opening.mp3'), mp3Bytes()),
      writeFile(join(sourceRoot, 'background audio', 'music.mp3'), mp3Bytes()),
    ]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const first = await createDefaultServer(root, undefined, sourceRoot);
    try {
      const response = await first.app.inject({ method: 'GET', url: '/api/resources' });
      expect(response.statusCode).toBe(200);
      const resources = response.json<{ resources: Array<{ kind: string }> }>().resources;
      expect(resources).toHaveLength(6);
      expect(resources.map((resource) => resource.kind)).toEqual(expect.arrayContaining([
        'meme-image',
        'meme-video',
        'meme-sound',
        'transition-sound',
        'intro-sound',
        'background-music',
      ]));
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      await first.app.close();
      first.queue.close();
    }

    const second = await createDefaultServer(root, undefined, sourceRoot);
    try {
      const response = await second.app.inject({ method: 'GET', url: '/api/resources' });
      expect(response.json<{ resources: unknown[] }>().resources).toHaveLength(6);
      const manifests = await readdir(join(root, 'data', 'resources'), { withFileTypes: true });
      expect(manifests.filter((entry) => entry.isDirectory())).toHaveLength(6);
    } finally {
      await second.app.close();
      second.queue.close();
    }
  });

  it('logs sanitized seed errors without exposing paths or blocking startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-index-invalid-'));
    const sourceRoot = join(root, 'launch');
    const stickerDirectory = join(sourceRoot, 'stickers');
    roots.push(root);
    await mkdir(stickerDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(stickerDirectory, 'valid.png'), pngBytes()),
      writeFile(join(stickerDirectory, 'broken.png'), Buffer.from('invalid-image')),
    ]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const server = await createDefaultServer(root, undefined, sourceRoot);
    try {
      const response = await server.app.inject({ method: 'GET', url: '/api/resources' });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ resources: unknown[] }>().resources).toHaveLength(1);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith('{"name":"broken.png","code":"INVALID_INPUT"}\n');
      expect(stderr.mock.calls.flat().join('')).not.toContain(root);
      expect(stderr.mock.calls.flat().join('')).not.toContain(sourceRoot);
    } finally {
      await server.app.close();
      server.queue.close();
    }
  });
});

function pngBytes(): Buffer {
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
}

function mp3Bytes(): Buffer {
  return Buffer.from('ID3fixture');
}

function mp4Bytes(): Buffer {
  return Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
}
