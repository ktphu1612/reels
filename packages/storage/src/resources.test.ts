import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AssetStore,
  createAppPaths,
  ensureAppDirectories,
  readJsonFile,
  resolveDataPath,
} from './index.js';
import { ResourceStore } from './resources.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestApp() {
  const directory = await mkdtemp(join(tmpdir(), 'reelforge-resource-'));
  temporaryDirectories.push(directory);
  const paths = createAppPaths(directory);
  await ensureAppDirectories(paths);
  return { directory, paths };
}

async function writeFixture(directory: string, name: string, bytes: number[]): Promise<string> {
  const filePath = join(directory, name);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(bytes));
  return filePath;
}

function pngBytes(seed = 0): number[] {
  return [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, seed];
}

function mp3Bytes(seed = 0): number[] {
  return [73, 68, 51, 4, 0, 0, 0, 0, 0, 0, seed];
}

function mp4Bytes(seed = 0): number[] {
  return [0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, seed];
}

describe('AssetStore audio resources', () => {
  it('imports audio by content hash, rejects audio as an image, and rejects WAV', async () => {
    const { directory, paths } = await createTestApp();
    const assets = new AssetStore(paths);
    const mp3 = await writeFixture(directory, 'effect.mp3', mp3Bytes());
    const frameMp3 = await writeFixture(directory, 'frame-effect.mp3', [255, 251, 144, 100]);
    const wav = await writeFixture(directory, 'effect.wav', mp3Bytes(1));
    const digest = createHash('sha256').update(Buffer.from(mp3Bytes())).digest('hex');

    await expect(assets.importFile(mp3, 'meme-sound')).resolves.toMatchObject({
      relativePath: `assets/${digest}.mp3`,
      mediaKind: 'audio',
    });
    await expect(assets.importFile(frameMp3, 'transition-sound')).resolves.toMatchObject({
      mediaKind: 'audio',
    });
    await expect(assets.importFile(mp3, 'intro-sound')).resolves.toMatchObject({
      mediaKind: 'audio',
    });
    await expect(assets.importFile(mp3, 'meme-image')).rejects.toMatchObject({
      payload: { code: 'INVALID_INPUT' },
    });
    await expect(assets.importFile(wav, 'meme-sound')).rejects.toMatchObject({
      payload: { code: 'INVALID_INPUT' },
    });
  });
});

describe('ResourceStore', () => {
  it('seeds direct MP3 files idempotently without recursing or storing source paths', async () => {
    const { directory, paths } = await createTestApp();
    const sourceDirectory = join(directory, 'meme sounds');
    const nestedDirectory = join(sourceDirectory, 'nested');
    await mkdir(nestedDirectory, { recursive: true });
    const firstSource = await writeFixture(sourceDirectory, 'effect-a.mp3', mp3Bytes(1));
    await writeFixture(sourceDirectory, 'effect-b.mp3', mp3Bytes(2));
    await writeFixture(nestedDirectory, 'ignored.mp3', mp3Bytes(3));
    const sourceBefore = await readFile(firstSource);
    const resources = new ResourceStore(paths, new AssetStore(paths));
    const input = [{ directory: sourceDirectory, kind: 'meme-sound' as const }];

    const first = await resources.seedDirectories(input);
    const second = await resources.seedDirectories(input);

    expect(first.resources).toHaveLength(2);
    expect(second.resources).toEqual(first.resources);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(await resources.list()).toEqual(first.resources);
    expect(await resources.list('meme-sound')).toEqual(first.resources);
    expect(await readdir(nestedDirectory)).toEqual(['ignored.mp3']);
    expect(await readFile(firstSource)).toEqual(sourceBefore);
    expect(JSON.stringify(await resources.list())).not.toContain(sourceDirectory);

    const firstResource = first.resources[0];
    expect(firstResource).toBeDefined();
    await expect(resources.get(firstResource.id)).resolves.toEqual(firstResource);

    const manifestPath = resolveDataPath(paths, `resources/${firstResource.id}/resource.json`);
    const manifestText = await readFile(manifestPath, 'utf8');
    expect(manifestText).not.toContain(sourceDirectory);
    await expect(readJsonFile(manifestPath)).resolves.toEqual(firstResource);
  });

  it('recognizes intro sound IDs before looking up their manifests', async () => {
    const { paths } = await createTestApp();
    const id = `intro-sound-${'a'.repeat(64)}`;
    await expect(new ResourceStore(paths, new AssetStore(paths)).get(id)).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND' },
    });
  });

  it('seeds intro and transition sounds independently, cleans stale intros, and reports WAV files', async () => {
    const { directory, paths } = await createTestApp();
    const introDirectory = join(directory, 'intro sounds');
    const transitionDirectory = join(directory, 'transition sound');
    const introSource = await writeFixture(introDirectory, 'opening.mp3', mp3Bytes(1));
    await writeFixture(transitionDirectory, 'whoosh.mp3', mp3Bytes(2));
    const inputs = [
      { directory: introDirectory, kind: 'intro-sound' as const },
      { directory: transitionDirectory, kind: 'transition-sound' as const },
    ];
    let resources = new ResourceStore(paths, new AssetStore(paths));

    const first = await resources.seedDirectories(inputs);

    expect(first.errors).toEqual([]);
    expect((await resources.list('intro-sound')).map((item) => item.name)).toEqual(['opening.mp3']);
    expect((await resources.list('transition-sound')).map((item) => item.name)).toEqual(['whoosh.mp3']);
    const introResource = first.resources.find((item) => item.kind === 'intro-sound');
    expect(introResource).toBeDefined();
    if (!introResource) throw new Error('Expected the intro resource to be seeded');

    await rm(introSource);
    resources = new ResourceStore(paths, new AssetStore(paths));
    await resources.seedDirectories(inputs);

    expect(await resources.list('intro-sound')).toEqual([]);
    expect((await resources.list('transition-sound')).map((item) => item.name)).toEqual(['whoosh.mp3']);
    await expect(resources.get(introResource.id)).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND' },
    });

    await writeFixture(introDirectory, 'opening.wav', mp3Bytes(3));
    const third = await resources.seedDirectories(inputs);

    expect(third.errors).toEqual([{ name: 'opening.wav', code: 'INVALID_INPUT' }]);
    expect(await resources.list('intro-sound')).toEqual([]);
    expect((await resources.list('transition-sound')).map((item) => item.name)).toEqual(['whoosh.mp3']);
  });

  it('classifies one stickers scan into image and video meme manifests', async () => {
    const { directory, paths } = await createTestApp();
    const stickersDirectory = join(directory, 'stickers');
    await writeFixture(stickersDirectory, 'meme.png', pngBytes(1));
    await writeFixture(stickersDirectory, 'reaction.mp4', mp4Bytes(2));
    const resources = new ResourceStore(paths, new AssetStore(paths));

    const result = await resources.seedDirectories([{ directory: stickersDirectory, kind: 'meme' }]);

    expect(result.errors).toEqual([]);
    expect(result.resources).toHaveLength(2);
    expect(result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'meme-image',
        name: 'meme.png',
        assetPath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.png$/),
      }),
      expect.objectContaining({
        kind: 'meme-video',
        name: 'reaction.mp4',
        assetPath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.mp4$/),
      }),
    ]));
  });

  it('removes deleted source files from the catalog without deleting managed assets', async () => {
    const { directory, paths } = await createTestApp();
    const sourceDirectory = join(directory, 'background audio');
    const oldSource = await writeFixture(sourceDirectory, 'music.mp3', mp3Bytes(1));
    let resources = new ResourceStore(paths, new AssetStore(paths));
    const input = [{ directory: sourceDirectory, kind: 'background-music' as const }];

    const first = await resources.seedDirectories(input);
    const oldResource = first.resources[0];
    expect(oldResource).toBeDefined();

    await rm(oldSource);
    await writeFixture(sourceDirectory, 'music_cut.mp3', mp3Bytes(2));
    resources = new ResourceStore(paths, new AssetStore(paths));
    await resources.seedDirectories(input);

    expect((await resources.list('background-music')).map((resource) => resource.name)).toEqual([
      'music_cut.mp3',
    ]);
    await expect(resources.get(oldResource.id)).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND' },
    });
    await expect(readFile(resolveDataPath(paths, oldResource.assetPath))).resolves.toEqual(
      Buffer.from(mp3Bytes(1)),
    );

    const stickersDirectory = join(directory, 'stickers');
    const oldVideoSource = await writeFixture(stickersDirectory, 'old.mp4', mp4Bytes(3));
    const stickerInput = { directory: stickersDirectory, kind: 'meme' as const };
    const firstVideos = await resources.seedDirectories([stickerInput]);
    const oldVideoResource = firstVideos.resources[0];
    expect(oldVideoResource).toBeDefined();

    await rm(oldVideoSource);
    await writeFixture(stickersDirectory, 'new.mp4', mp4Bytes(4));
    resources = new ResourceStore(paths, new AssetStore(paths));
    await resources.seedDirectories([stickerInput]);

    expect((await resources.list('meme-video')).map((resource) => resource.name)).toEqual(['new.mp4']);
    await expect(resources.get(oldVideoResource.id)).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND' },
    });
    await expect(readFile(resolveDataPath(paths, oldVideoResource.assetPath))).resolves.toEqual(
      Buffer.from(mp4Bytes(3)),
    );
  });

  it('keeps catalog entries for a kind whose source directory could not be read', async () => {
    const { directory, paths } = await createTestApp();
    const musicDirectory = join(directory, 'background audio');
    const memeDirectory = join(directory, 'meme sounds');
    await writeFixture(musicDirectory, 'music.mp3', mp3Bytes(1));
    await writeFixture(memeDirectory, 'meme.mp3', mp3Bytes(2));
    const inputs = [
      { directory: musicDirectory, kind: 'background-music' as const },
      { directory: memeDirectory, kind: 'meme-sound' as const },
    ];
    let resources = new ResourceStore(paths, new AssetStore(paths));
    await resources.seedDirectories(inputs);

    await rm(memeDirectory, { recursive: true });
    resources = new ResourceStore(paths, new AssetStore(paths));
    await resources.seedDirectories(inputs);

    expect((await resources.list('meme-sound')).map((resource) => resource.name)).toEqual([
      'meme.mp3',
    ]);
  });

  it('keeps valid direct resources when a sibling is invalid and reports only its name', async () => {
    const { directory, paths } = await createTestApp();
    const sourceDirectory = join(directory, 'meme images');
    await writeFixture(sourceDirectory, 'valid.png', pngBytes());
    await writeFixture(sourceDirectory, 'broken.png', [1, 2, 3]);
    await writeFixture(join(sourceDirectory, 'nested'), 'ignored.png', pngBytes(1));
    const resources = new ResourceStore(paths, new AssetStore(paths));

    await expect(resources.seedDirectories([{ directory: sourceDirectory, kind: 'meme-image' }])).resolves.toMatchObject({
      resources: [expect.objectContaining({ kind: 'meme-image', name: 'valid.png' })],
      errors: [{ name: 'broken.png', code: 'INVALID_INPUT' }],
    });
  });
});
