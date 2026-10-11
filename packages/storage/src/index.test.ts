import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CARD_SLOT, DEFAULT_MEME_SLOT, DEFAULT_OUTPUT, ReelForgeError, type Project } from '@reelforge/core';

import {
  AssetStore,
  ProjectStore,
  TemplateStore,
  createAppPaths,
  ensureAppDirectories,
  readJsonFile,
  resolveDataPath,
  writeJsonFileAtomic,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestApp() {
  const directory = await mkdtemp(join(tmpdir(), 'reelforge-storage-'));
  temporaryDirectories.push(directory);
  const paths = createAppPaths(directory);
  await ensureAppDirectories(paths);
  return { directory, paths };
}

async function writeFixture(directory: string, name: string, bytes: number[]): Promise<string> {
  const filePath = join(directory, name);
  await writeFile(filePath, Buffer.from(bytes));
  return filePath;
}

function pngBytes(): number[] {
  return [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
}

function jpegBytes(): number[] {
  return [255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 255, 217];
}

function webpBytes(): number[] {
  return [82, 73, 70, 70, 12, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32];
}

function mp4Bytes(): number[] {
  return [0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0];
}

function movBytes(): number[] {
  return [0, 0, 0, 20, 102, 116, 121, 112, 113, 116, 32, 32, 0, 0, 0, 0];
}

function webmBytes(): number[] {
  return [26, 69, 223, 163, 159, 66, 134, 129, 1];
}

function pngBytesV2(): number[] {
  return [...pngBytes(), 1];
}

function mp4BytesV2(): number[] {
  return [...mp4Bytes(), 1];
}

function createIds(...ids: string[]) {
  let next = 0;
  return () => ids[next++] ?? `unexpected-${next}`;
}

describe('application paths and atomic JSON', () => {
  it('creates the complete app-managed directory layout', async () => {
    // Production break caught: omitting a required directory makes later store writes fail.
    const { paths } = await createTestApp();

    await expect(Promise.all([paths.assets, paths.projects, paths.templates, paths.ttsCache, paths.jobs, paths.outputs, paths.resources].map((path) => readdir(path)))).resolves.toHaveLength(7);
  });

  it('rejects absolute and traversal paths instead of escaping the data root', async () => {
    // Production break caught: resolving untrusted paths outside app data exposes arbitrary files.
    const { paths } = await createTestApp();

    expect(() => resolveDataPath(paths, '../private.json')).toThrow(ReelForgeError);
    expect(() => resolveDataPath(paths, 'assets/../../private.json')).toThrow(ReelForgeError);
    expect(() => resolveDataPath(paths, join(paths.data, 'private.json'))).toThrow(ReelForgeError);
  });

  it('atomically writes and reads JSON without leaving a successful temp file behind', async () => {
    // Production break caught: direct writes can leave partial JSON or stray temp artifacts after a save.
    const { paths } = await createTestApp();
    const filePath = resolveDataPath(paths, 'projects/example/project.json');

    await writeJsonFileAtomic(filePath, { name: 'Episode 1', count: 2 });

    await expect(readJsonFile<{ name: string; count: number }>(filePath)).resolves.toEqual({ name: 'Episode 1', count: 2 });
    await expect(readdir(join(paths.projects, 'example'))).resolves.toEqual(['project.json']);
  });
});

describe('AssetStore', () => {
  it('imports every allowed image and background video using a sha256-relative immutable path', async () => {
    // Production break caught: rejecting a supported media format or leaking a source path breaks valid imports.
    const { directory, paths } = await createTestApp();
    const store = new AssetStore(paths);
    const fixtures: Array<[string, number[], 'card' | 'background', string]> = [
      ['card.png', pngBytes(), 'card', 'image'],
      ['card.jpg', jpegBytes(), 'card', 'image'],
      ['card.webp', webpBytes(), 'card', 'image'],
      ['background.mp4', mp4Bytes(), 'background', 'video'],
      ['background.mov', movBytes(), 'background', 'video'],
      ['background.webm', webmBytes(), 'background', 'video'],
    ];

    for (const [name, bytes, intendedUse, expectedKind] of fixtures) {
      const source = await writeFixture(directory, name, bytes);
      const imported = await store.importFile(source, intendedUse);
      const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');

      expect(imported).toEqual({
        relativePath: `assets/${digest}.${name.split('.').at(-1)}`,
        sha256: digest,
        byteSize: bytes.length,
        mediaKind: expectedKind,
      });
      await expect(readFile(resolveDataPath(paths, imported.relativePath))).resolves.toEqual(Buffer.from(bytes));
    }
  });

  it('imports MP4 meme videos and rejects other video containers for meme use', async () => {
    const { directory, paths } = await createTestApp();
    const store = new AssetStore(paths);
    const mp4 = await writeFixture(directory, 'meme.mp4', mp4Bytes());
    const mov = await writeFixture(directory, 'meme.mov', movBytes());
    const webm = await writeFixture(directory, 'meme.webm', webmBytes());

    const imported = await store.importFile(mp4, 'meme-video');
    const digest = createHash('sha256').update(Buffer.from(mp4Bytes())).digest('hex');
    expect(imported).toEqual({
      relativePath: `assets/${digest}.mp4`,
      sha256: digest,
      byteSize: mp4Bytes().length,
      mediaKind: 'video',
    });
    await expect(store.importFile(mov, 'meme-video')).rejects.toMatchObject({
      payload: { code: 'INVALID_INPUT' },
    });
    await expect(store.importFile(webm, 'meme-video')).rejects.toMatchObject({
      payload: { code: 'INVALID_INPUT' },
    });
  });

  it('rejects media with an unsupported extension, mismatched magic bytes, or wrong intended use', async () => {
    // Production break caught: accepting renamed or incorrectly typed bytes lets invalid media reach rendering.
    const { directory, paths } = await createTestApp();
    const store = new AssetStore(paths);
    const renamedImage = await writeFixture(directory, 'renamed.png', mp4Bytes());
    const unsupported = await writeFixture(directory, 'card.gif', pngBytes());
    const image = await writeFixture(directory, 'card.png', pngBytes());

    for (const source of [renamedImage, unsupported]) {
      await expect(store.importFile(source, 'card')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    }
    await expect(store.importFile(image, 'background')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });

  it('reuses matching content and never overwrites an existing hash asset', async () => {
    // Production break caught: copying on every import or overwriting a hash target violates content-addressed immutability.
    const { directory, paths } = await createTestApp();
    const store = new AssetStore(paths);
    const source = await writeFixture(directory, 'card.png', pngBytes());
    const first = await store.importFile(source, 'card');
    const target = resolveDataPath(paths, first.relativePath);

    await writeFile(target, Buffer.from([1, 2, 3]));
    const second = await store.importFile(source, 'card');

    expect(second).toEqual(first);
    await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it('uses one immutable asset path when identical JPEG bytes use either supported extension', async () => {
    // Production break caught: deriving the path from a filename alias duplicates identical content-addressed assets.
    const { directory, paths } = await createTestApp();
    const store = new AssetStore(paths);
    const jpg = await writeFixture(directory, 'card.jpg', jpegBytes());
    const jpeg = await writeFixture(directory, 'card.jpeg', jpegBytes());

    const first = await store.importFile(jpg, 'card');
    const second = await store.importFile(jpeg, 'card');

    expect(second.relativePath).toBe(first.relativePath);
    await expect(readdir(paths.assets)).resolves.toEqual([basename(first.relativePath)]);
  });
});

describe('ProjectStore', () => {
  it('creates, lists, saves, and reads core-validated projects', async () => {
    // Production break caught: persistence that bypasses core parsing stores invalid project manifests.
    const { paths } = await createTestApp();
    const assets = new AssetStore(paths);
    const projects = new ProjectStore(paths, assets, createIds('project-1'));
    const created = await projects.create({
      name: 'First project',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'vi-VN-Standard-A', speakingRate: 1 },
    });

    await projects.save({ ...created, name: 'Renamed project' });

    await expect(projects.list()).resolves.toEqual([expect.objectContaining({ id: 'project-1', name: 'Renamed project', output: DEFAULT_OUTPUT, cards: [] })]);
    await expect(projects.get('project-1')).resolves.toMatchObject({ name: 'Renamed project' });
  });

  it('round-trips video memes, optional sound, card layout, blank script, hold, and intro sound', async () => {
    const { paths } = await createTestApp();
    const projects = new ProjectStore(paths, new AssetStore(paths), createIds('unused'));
    const imageHash = 'a'.repeat(64);
    const videoHash = 'b'.repeat(64);
    const soundHash = 'c'.repeat(64);
    const introHash = 'd'.repeat(64);
    const project: Project = {
      schemaVersion: 2,
      id: 'rich-project',
      name: 'Flexible media project',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 },
      output: DEFAULT_OUTPUT,
      introSoundPath: `assets/${introHash}.mp3`,
      cards: [
        {
          id: 'card-without-sound',
          imagePath: `assets/${imageHash}.png`,
          script: '',
          order: 0,
          holdSeconds: 3,
          layout: { x: 0.1, y: 0.2, width: 0.7, height: 0.3 },
          postCardMeme: { videoPath: `assets/${videoHash}.mp4` },
        },
        {
          id: 'card-with-sound',
          imagePath: `assets/${imageHash}.png`,
          script: 'Narration',
          order: 1,
          postCardMeme: {
            videoPath: `assets/${videoHash}.mp4`,
            soundPath: `assets/${soundHash}.mp3`,
          },
        },
      ],
    };

    await projects.save(project);

    await expect(projects.get(project.id)).resolves.toEqual(project);
  });

  it('imports a card asset, duplicates with new IDs and name, and leaves global assets after delete', async () => {
    // Production break caught: duplication changing asset identity or deletion garbage-collecting a shared asset breaks queued snapshots.
    const { directory, paths } = await createTestApp();
    const assets = new AssetStore(paths);
    const projects = new ProjectStore(paths, assets, createIds('project-1', 'card-1', 'project-2'));
    await projects.create({ name: 'Original', templateId: 'template-1', tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 } });
    const cardSource = await writeFixture(directory, 'card.png', pngBytes());
    const card = await projects.importCardImage('project-1', cardSource, 'Narration');
    const duplicate = await projects.duplicate('project-1', 'Copy');

    expect(card).toMatchObject({ id: 'card-1', imagePath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.png$/), script: 'Narration', order: 0 });
    expect(duplicate).toMatchObject({ id: 'project-2', name: 'Copy', cards: [expect.objectContaining({ imagePath: card.imagePath, id: 'card-1' })] });
    await projects.delete('project-1');

    await expect(projects.get('project-1')).rejects.toMatchObject({ payload: { code: 'NOT_FOUND' } });
    await expect(readFile(resolveDataPath(paths, card.imagePath))).resolves.toEqual(Buffer.from(pngBytes()));
  });

  it('reports missing and malformed project entities as structured errors without a source path', async () => {
    // Production break caught: raw filesystem or schema errors leak host paths and violate the public error contract.
    const { paths } = await createTestApp();
    const projects = new ProjectStore(paths, new AssetStore(paths), createIds('unused'));
    const malformedPath = resolveDataPath(paths, 'projects/bad/project.json');
    await writeJsonFileAtomic(malformedPath, { schemaVersion: 2, id: 'bad' });

    await expect(projects.get('missing')).rejects.toMatchObject({ payload: { code: 'NOT_FOUND' } });
    await expect(projects.get('bad')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await expect(projects.get('bad')).rejects.not.toThrow(basename(paths.data));
  });

  it('rejects persisted project asset paths that are absolute or escape data storage', async () => {
    // Production break caught: accepting a persisted external asset path exposes arbitrary host files to later workers.
    const { paths } = await createTestApp();
    const projects = new ProjectStore(paths, new AssetStore(paths), createIds('unused'));
    await writeJsonFileAtomic(resolveDataPath(paths, 'projects/bad-path/project.json'), {
      schemaVersion: 2,
      id: 'bad-path',
      name: 'Bad path',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 },
      cards: [{ id: 'card-1', imagePath: 'C:\\outside.png', script: 'Narration', order: 0 }],
    });

    await expect(projects.get('bad-path')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });

  it('rejects persisted card paths that are not direct canonical image assets', async () => {
    // Production break caught: accepting a noncanonical card path permits aliases, subdirectories, and non-image media in persisted projects.
    const { paths } = await createTestApp();
    const projects = new ProjectStore(paths, new AssetStore(paths), createIds('unused'));
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const invalidPaths = [
      'assets/not-a-hash.png',
      `assets/nested/${hash}.png`,
      `assets/../assets/${hash}.png`,
      `assets/${hash}.gif`,
      `assets/${hash}.mp4`,
    ];

    for (const [index, imagePath] of invalidPaths.entries()) {
      const id = `bad-card-${index}`;
      await writeJsonFileAtomic(resolveDataPath(paths, `projects/${id}/project.json`), {
        schemaVersion: 2,
        id,
        name: 'Bad card path',
        templateId: 'template-1',
        tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 },
        cards: [{ id: 'card-1', imagePath, script: 'Narration', order: 0 }],
      });

      await expect(projects.get(id)).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    }
  });

  it('rejects noncanonical project media paths before save writes a manifest', async () => {
    // Production break caught: optional meme and project-level media paths could bypass canonical asset validation and leak into saved JSON.
    const { paths } = await createTestApp();
    const projects = new ProjectStore(paths, new AssetStore(paths), createIds('unused'));
    const hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const validProject: Project = {
      schemaVersion: 2,
      id: 'valid-project',
      name: 'Valid project',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 },
      output: DEFAULT_OUTPUT,
      transitionSoundPath: `assets/${hash}.mp3`,
      backgroundMusicPath: `assets/${hash}.mp3`,
      cards: [{
        id: 'card-1',
        imagePath: `assets/${hash}.png`,
        script: 'Narration',
        order: 0,
        postCardMeme: {
          imagePath: `assets/${hash}.png`,
          soundPath: `assets/${hash}.mp3`,
        },
      }],
    };
    const invalidProjects: Project[] = [];
    const withChange = (id: string, change: (project: Project) => void): void => {
      const project = structuredClone(validProject);
      project.id = id;
      change(project);
      invalidProjects.push(project);
    };

    withChange('bad-meme-image-absolute', (project) => {
      const meme = project.cards[0]!.postCardMeme;
      if (!meme || !('imagePath' in meme)) throw new Error('expected image meme');
      meme.imagePath = 'C:\\outside.png';
    });
    withChange('bad-meme-image-kind', (project) => {
      const meme = project.cards[0]!.postCardMeme;
      if (!meme || !('imagePath' in meme)) throw new Error('expected image meme');
      meme.imagePath = `assets/${hash}.mp3`;
    });
    withChange('bad-meme-sound-kind', (project) => {
      project.cards[0]!.postCardMeme!.soundPath = `assets/${hash}.png`;
    });
    withChange('bad-meme-video-kind', (project) => {
      project.cards[0]!.postCardMeme = { videoPath: `assets/${hash}.mov` };
    });
    withChange('bad-transition-kind', (project) => {
      project.transitionSoundPath = `assets/${hash}.mp4`;
    });
    withChange('bad-background-kind', (project) => {
      project.backgroundMusicPath = `assets/${hash}.mp4`;
    });
    withChange('bad-background-traversal', (project) => {
      project.backgroundMusicPath = `assets/../assets/${hash}.mp3`;
    });
    withChange('bad-intro-kind', (project) => {
      project.introSoundPath = `assets/${hash}.png`;
    });

    for (const project of invalidProjects) {
      await expect(projects.save(project)).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
      await expect(readdir(join(paths.projects, project.id))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects noncanonical project media paths when reading or importing a manifest', async () => {
    // Production break caught: get/import must enforce the same managed-path boundary as save before returning or writing project data.
    const { paths } = await createTestApp();
    const projects = new ProjectStore(paths, new AssetStore(paths), createIds('unused'));
    const hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const invalidProject: Project = {
      schemaVersion: 2,
      id: 'bad-import',
      name: 'Invalid project',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 },
      output: DEFAULT_OUTPUT,
      transitionSoundPath: 'C:\\outside.mp3',
      cards: [{
        id: 'card-1',
        imagePath: `assets/${hash}.png`,
        script: 'Narration',
        order: 0,
      }],
    };

    await writeJsonFileAtomic(resolveDataPath(paths, 'projects/bad-get/project.json'), { ...invalidProject, id: 'bad-get' });
    await expect(projects.get('bad-get')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await expect(projects.import(invalidProject)).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await expect(readdir(join(paths.projects, invalidProject.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a persisted card reference on its original asset when the source file changes', async () => {
    // Production break caught: re-importing a changed source can otherwise rewrite a persisted card asset identity.
    const { directory, paths } = await createTestApp();
    const assets = new AssetStore(paths);
    const projects = new ProjectStore(paths, assets, createIds('project-1', 'card-1'));
    await projects.create({ name: 'Original', templateId: 'template-1', tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 } });
    const source = await writeFixture(directory, 'card.png', pngBytes());
    const card = await projects.importCardImage('project-1', source, 'Narration');

    await writeFile(source, Buffer.from(pngBytesV2()));
    const reimported = await assets.importFile(source, 'card');
    const persisted = await projects.get('project-1');

    expect(reimported.relativePath).not.toBe(card.imagePath);
    expect(persisted.cards[0]?.imagePath).toBe(card.imagePath);
    await expect(readFile(resolveDataPath(paths, card.imagePath))).resolves.toEqual(Buffer.from(pngBytes()));
  });

  it('imports a core-validated project without overwriting an existing project ID', async () => {
    // Production break caught: project import can bypass canonical validation or silently replace user data.
    const { paths } = await createTestApp();
    const projects = new ProjectStore(paths, new AssetStore(paths), createIds('unused'));
    const api = projects as unknown as { import(input: unknown): Promise<{ id: string; name: string }> };
    expect(typeof api.import).toBe('function');
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const imported = await api.import({
      schemaVersion: 2,
      id: 'imported-project',
      name: 'Imported project',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'voice', speakingRate: 1 },
      cards: [{ id: 'card-1', imagePath: `assets/${hash}.png`, script: 'Narration', order: 0 }],
    });

    expect(imported).toMatchObject({ id: 'imported-project', name: 'Imported project' });
    await expect(api.import({ ...await projects.get(imported.id), name: 'Overwrite' })).rejects.toMatchObject({
      payload: { code: 'CONFLICT' },
    });
    await expect(projects.get(imported.id)).resolves.toMatchObject({ name: 'Imported project' });
  });
});

describe('TemplateStore', () => {
  it('imports a template and optional thumbnail with default core canvas and layout', async () => {
    // Production break caught: template import that omits optional asset copying or core defaults creates unusable manifests.
    const { directory, paths } = await createTestApp();
    const templates = new TemplateStore(paths, new AssetStore(paths), createIds('template-1'));
    const background = await writeFixture(directory, 'background.mp4', mp4Bytes());
    const thumbnail = await writeFixture(directory, 'thumbnail.jpg', jpegBytes());

    const imported = await templates.import({ name: 'Gameplay', backgroundFile: background, thumbnailFile: thumbnail });

    expect(imported).toEqual(expect.objectContaining({
      schemaVersion: 2,
      id: 'template-1',
      name: 'Gameplay',
      backgroundPath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.mp4$/),
      thumbnailPath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.jpg$/),
      canvas: { width: DEFAULT_OUTPUT.width, height: DEFAULT_OUTPUT.height, fps: DEFAULT_OUTPUT.fps },
      cardSlot: DEFAULT_CARD_SLOT,
      memeSlot: DEFAULT_MEME_SLOT,
    }));
    await expect(templates.list()).resolves.toEqual([imported]);
    await expect(templates.get('template-1')).resolves.toEqual(imported);
  });

  it('deletes only the template manifest and leaves shared background assets', async () => {
    // Production break caught: deleting a template removes a global asset still referenced by queued work.
    const { directory, paths } = await createTestApp();
    const templates = new TemplateStore(paths, new AssetStore(paths), createIds('template-1'));
    const background = await writeFixture(directory, 'background.mov', movBytes());
    const imported = await templates.import({ name: 'Gameplay', backgroundFile: background });

    await templates.delete('template-1');

    await expect(templates.get('template-1')).rejects.toMatchObject({ payload: { code: 'NOT_FOUND' } });
    await expect(readFile(resolveDataPath(paths, imported.backgroundPath))).resolves.toEqual(Buffer.from(movBytes()));
  });

  it('rejects persisted template asset paths that do not stay under global assets', async () => {
    // Production break caught: a stored template can otherwise make the renderer consume an arbitrary data file.
    const { paths } = await createTestApp();
    const templates = new TemplateStore(paths, new AssetStore(paths), createIds('unused'));
    await writeJsonFileAtomic(resolveDataPath(paths, 'templates/bad-path/template.json'), {
      schemaVersion: 2,
      id: 'bad-path',
      name: 'Bad path',
      backgroundPath: 'projects/other/project.json',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: DEFAULT_CARD_SLOT,
      memeSlot: DEFAULT_MEME_SLOT,
    });

    await expect(templates.get('bad-path')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });

  it('rejects template field paths with the wrong canonical shape or media kind', async () => {
    // Production break caught: a template can otherwise point background or thumbnail fields at incompatible or aliased assets.
    const { paths } = await createTestApp();
    const templates = new TemplateStore(paths, new AssetStore(paths), createIds('unused'));
    const hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const invalidFields = [
      { field: 'backgroundPath', value: `assets/${hash}.png` },
      { field: 'thumbnailPath', value: `assets/${hash}.mov` },
      { field: 'backgroundPath', value: `assets/${hash}.jpeg` },
    ];

    for (const [index, { field, value }] of invalidFields.entries()) {
      const id = `bad-template-${index}`;
      const assetFields = field === 'backgroundPath'
        ? { backgroundPath: value }
        : { backgroundPath: `assets/${hash}.mp4`, [field]: value };
      await writeJsonFileAtomic(resolveDataPath(paths, `templates/${id}/template.json`), {
        schemaVersion: 2,
        id,
        name: 'Bad template path',
        ...assetFields,
        canvas: { width: 720, height: 1280, fps: 30 },
        cardSlot: DEFAULT_CARD_SLOT,
        memeSlot: DEFAULT_MEME_SLOT,
      });

      await expect(templates.get(id)).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    }
  });

  it('keeps a persisted template background on its original asset when the source file changes', async () => {
    // Production break caught: re-importing changed gameplay can otherwise rewrite an existing template's immutable background identity.
    const { directory, paths } = await createTestApp();
    const assets = new AssetStore(paths);
    const templates = new TemplateStore(paths, assets, createIds('template-1'));
    const source = await writeFixture(directory, 'background.mp4', mp4Bytes());
    const template = await templates.import({ name: 'Gameplay', backgroundFile: source });

    await writeFile(source, Buffer.from(mp4BytesV2()));
    const reimported = await assets.importFile(source, 'background');
    const persisted = await templates.get('template-1');

    expect(reimported.relativePath).not.toBe(template.backgroundPath);
    expect(persisted.backgroundPath).toBe(template.backgroundPath);
    await expect(readFile(resolveDataPath(paths, template.backgroundPath))).resolves.toEqual(Buffer.from(mp4Bytes()));
  });

  it('applies a validated optional layout override during template import', async () => {
    // Production break caught: multipart layout data can be ignored or persist rectangles outside the canvas.
    const { directory, paths } = await createTestApp();
    const templates = new TemplateStore(paths, new AssetStore(paths), createIds('template-override', 'invalid-template'));
    const background = await writeFixture(directory, 'background.mp4', mp4Bytes());
    const cardSlot = { x: 0.1, y: 0.2, width: 0.7, height: 0.3 };
    const memeSlot = { x: 0.2, y: 0.6, width: 0.5, height: 0.3 };

    await expect(templates.import({
      name: 'Custom layout',
      backgroundFile: background,
      layout: { cardSlot, memeSlot },
    })).resolves.toMatchObject({ cardSlot, memeSlot });
    await expect(templates.import({
      name: 'Invalid layout',
      backgroundFile: background,
      layout: { cardSlot: { x: 0.8, y: 0, width: 0.5, height: 0.5 } },
    } as never)).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });
});
