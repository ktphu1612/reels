import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  link,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  DEFAULT_CARD_SLOT,
  DEFAULT_OUTPUT,
  DEFAULT_MEME_SLOT,
  NormalizedRectSchema,
  ReelForgeError,
  createErrorPayload,
  parseProject,
  parseTemplateManifest,
  type Project,
  type ProjectCard,
  type ProjectTtsSettings,
  type NormalizedRect,
  type TemplateManifest,
} from '@reelforge/core';

export interface AppPaths {
  readonly base: string;
  readonly data: string;
  readonly assets: string;
  readonly resources: string;
  readonly projects: string;
  readonly templates: string;
  readonly cache: string;
  readonly ttsCache: string;
  readonly jobs: string;
  readonly outputs: string;
}

export function createAppPaths(baseDir: string): AppPaths {
  const base = resolve(baseDir);
  const data = join(base, 'data');
  const cache = join(data, 'cache');
  return {
    base,
    data,
    assets: join(data, 'assets'),
    resources: join(data, 'resources'),
    projects: join(data, 'projects'),
    templates: join(data, 'templates'),
    cache,
    ttsCache: join(cache, 'tts'),
    jobs: join(data, 'jobs'),
    outputs: join(base, 'outputs'),
  };
}

export async function ensureAppDirectories(paths: AppPaths): Promise<void> {
  await Promise.all(
    [paths.assets, paths.resources, paths.projects, paths.templates, paths.ttsCache, paths.jobs, paths.outputs].map(
      (directory) => mkdir(directory, { recursive: true }),
    ),
  );
}

export function resolveDataPath(paths: AppPaths, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) {
    throw invalidInput('Storage paths must be relative to the data directory');
  }

  const resolved = resolve(paths.data, relativePath);
  const fromData = relative(paths.data, resolved);
  if (
    !fromData ||
    fromData === '..' ||
    fromData.startsWith('../') ||
    fromData.startsWith('..\\') ||
    isAbsolute(fromData)
  ) {
    throw invalidInput('Storage paths must remain within the data directory');
  }

  return resolved;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw error;
  }

  try {
    return JSON.parse(source) as T;
  } catch {
    throw invalidInput('Stored JSON is invalid');
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export type AssetIntendedUse =
  | 'background'
  | 'card'
  | 'thumbnail'
  | 'meme-image'
  | 'meme-video'
  | 'meme-sound'
  | 'transition-sound'
  | 'intro-sound'
  | 'background-music';
export type MediaKind = 'image' | 'video' | 'audio';

export interface ImportedAsset {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaKind: MediaKind;
}

interface DetectedMedia {
  readonly kind: MediaKind;
  readonly extension: string;
}

export class AssetStore {
  constructor(private readonly paths: AppPaths) {}

  async importFile(sourcePath: string, intendedUse: AssetIntendedUse): Promise<ImportedAsset> {
    let bytes: Buffer;
    try {
      bytes = await readFile(sourcePath);
    } catch {
      throw invalidInput('Media file could not be read');
    }

    const extension = extname(sourcePath).slice(1).toLowerCase();
    const detected = detectMedia(bytes);
    if (!extension || !detected || !extensionMatches(extension, detected) || !useMatches(intendedUse, detected)) {
      throw invalidInput('Media extension, contents, or intended use is unsupported');
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relativePath = `assets/${sha256}.${canonicalExtension(detected)}`;
    const destination = resolveDataPath(this.paths, relativePath);
    await mkdir(this.paths.assets, { recursive: true });

    try {
      await stat(destination);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      await writeImmutableFile(destination, bytes);
    }

    return { relativePath, sha256, byteSize: bytes.byteLength, mediaKind: detected.kind };
  }
}

export interface CreateProjectInput {
  readonly name: string;
  readonly templateId: string;
  readonly tts: ProjectTtsSettings;
}

export class ProjectStore {
  constructor(
    private readonly paths: AppPaths,
    private readonly assets: AssetStore,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  async list(): Promise<Project[]> {
    const entries = await readdir(this.paths.projects, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.get(entry.name)),
    );
    return projects.sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<Project> {
    const filePath = this.filePath(id);
    try {
      const project = parseStoredProject(await readJsonFile<unknown>(filePath));
      assertProjectAssetPaths(this.paths, project);
      return project;
    } catch (error) {
      if (isMissingFile(error)) {
        throw notFound('Project');
      }
      if (error instanceof ReelForgeError) {
        throw error;
      }
      throw invalidInput('Project manifest is invalid');
    }
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const project = parseStoredProject({
      schemaVersion: 2,
      id: this.nextId(),
      name: input.name,
      templateId: input.templateId,
      tts: input.tts,
      cards: [],
    });
    await this.save(project);
    return project;
  }

  async save(input: Project): Promise<Project> {
    const project = parseStoredProject(input);
    assertProjectAssetPaths(this.paths, project);
    await writeJsonFileAtomic(this.filePath(project.id), project);
    return project;
  }

  async import(input: unknown): Promise<Project> {
    const project = parseStoredProject(input);
    assertProjectAssetPaths(this.paths, project);
    try {
      await writeJsonFileAtomicExclusive(this.filePath(project.id), project);
    } catch (error) {
      if (isAlreadyExists(error)) throw conflict('Project already exists');
      throw error;
    }
    return project;
  }

  async duplicate(id: string, name: string): Promise<Project> {
    const source = await this.get(id);
    const duplicate = parseStoredProject({
      ...structuredClone(source),
      id: this.nextId(),
      name,
    });
    await this.save(duplicate);
    return duplicate;
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await rm(dirname(this.filePath(id)), { recursive: true, force: true });
  }

  async importCardImage(projectId: string, sourcePath: string, script: string): Promise<ProjectCard> {
    const project = await this.get(projectId);
    const asset = await this.assets.importFile(sourcePath, 'card');
    const card: ProjectCard = {
      id: this.nextId(),
      imagePath: asset.relativePath,
      script,
      order: project.cards.length,
      ...(script.trim().length === 0 ? { holdSeconds: 3 } : {}),
    };
    const saved = await this.save({ ...project, cards: [...project.cards, card] });
    return saved.cards.at(-1) as ProjectCard;
  }

  private filePath(id: string): string {
    return resolveDataPath(this.paths, `projects/${safeEntityId(id)}/project.json`);
  }

  private nextId(): string {
    return safeEntityId(this.idFactory());
  }
}

export interface TemplateImportInput {
  readonly name: string;
  readonly backgroundFile: string;
  readonly thumbnailFile?: string;
  readonly layout?: {
    readonly cardSlot?: NormalizedRect;
    readonly memeSlot?: NormalizedRect;
  };
}

export class TemplateStore {
  constructor(
    private readonly paths: AppPaths,
    private readonly assets: AssetStore,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  async list(): Promise<TemplateManifest[]> {
    const entries = await readdir(this.paths.templates, { withFileTypes: true });
    const templates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.get(entry.name)),
    );
    return templates.sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<TemplateManifest> {
    const filePath = this.filePath(id);
    try {
      const template = parseStoredTemplate(await readJsonFile<unknown>(filePath));
      assertTemplateAssetPaths(this.paths, template);
      return template;
    } catch (error) {
      if (isMissingFile(error)) {
        throw notFound('Template');
      }
      if (error instanceof ReelForgeError) {
        throw error;
      }
      throw invalidInput('Template manifest is invalid');
    }
  }

  async import(input: TemplateImportInput): Promise<TemplateManifest> {
    const layout = parseTemplateLayout(input.layout);
    const background = await this.assets.importFile(input.backgroundFile, 'background');
    const thumbnail = input.thumbnailFile
      ? await this.assets.importFile(input.thumbnailFile, 'thumbnail')
      : undefined;
    const template = parseStoredTemplate({
      schemaVersion: 2,
      id: this.nextId(),
      name: input.name,
      backgroundPath: background.relativePath,
      thumbnailPath: thumbnail?.relativePath,
      canvas: {
        width: DEFAULT_OUTPUT.width,
        height: DEFAULT_OUTPUT.height,
        fps: DEFAULT_OUTPUT.fps,
      },
      cardSlot: layout.cardSlot,
      memeSlot: layout.memeSlot,
    });
    assertTemplateAssetPaths(this.paths, template);
    await writeJsonFileAtomic(this.filePath(template.id), template);
    return template;
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await rm(dirname(this.filePath(id)), { recursive: true, force: true });
  }

  private filePath(id: string): string {
    return resolveDataPath(this.paths, `templates/${safeEntityId(id)}/template.json`);
  }

  private nextId(): string {
    return safeEntityId(this.idFactory());
  }
}

function detectMedia(bytes: Buffer): DetectedMedia | undefined {
  if (
    bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  ) {
    return { kind: 'audio', extension: 'mp3' };
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { kind: 'image', extension: 'png' };
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) {
    return { kind: 'image', extension: 'jpeg' };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'image', extension: 'webp' };
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) {
    return { kind: 'video', extension: 'webm' };
  }
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    return {
      kind: 'video',
      extension: bytes.subarray(8, 12).toString('ascii') === 'qt  ' ? 'mov' : 'mp4',
    };
  }
  return undefined;
}

function extensionMatches(extension: string, detected: DetectedMedia): boolean {
  if (detected.extension === 'jpeg') {
    return extension === 'jpg' || extension === 'jpeg';
  }
  return extension === detected.extension;
}

function canonicalExtension(detected: DetectedMedia): string {
  return detected.extension === 'jpeg' ? 'jpg' : detected.extension;
}

function useMatches(intendedUse: AssetIntendedUse, detected: DetectedMedia): boolean {
  if (intendedUse === 'background') {
    return detected.kind === 'video';
  }
  if (intendedUse === 'meme-video') {
    return detected.kind === 'video' && detected.extension === 'mp4';
  }
  if (intendedUse === 'card' || intendedUse === 'thumbnail' || intendedUse === 'meme-image') {
    return detected.kind === 'image';
  }
  return detected.kind === 'audio';
}

async function writeImmutableFile(destination: string, bytes: Buffer): Promise<void> {
  const temporaryPath = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    try {
      await link(temporaryPath, destination);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeJsonFileAtomicExclusive(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function parseTemplateLayout(layout: TemplateImportInput['layout']): {
  cardSlot: NormalizedRect;
  memeSlot: NormalizedRect;
} {
  try {
    return {
      cardSlot: NormalizedRectSchema.parse(layout?.cardSlot ?? DEFAULT_CARD_SLOT),
      memeSlot: NormalizedRectSchema.parse(layout?.memeSlot ?? DEFAULT_MEME_SLOT),
    };
  } catch {
    throw invalidInput('Template layout is invalid');
  }
}

function parseStoredProject(value: unknown): Project {
  try {
    return parseProject(value);
  } catch (error) {
    if (error instanceof ReelForgeError) {
      throw error;
    }
    throw invalidInput('Project manifest is invalid');
  }
}

function parseStoredTemplate(value: unknown): TemplateManifest {
  try {
    return parseTemplateManifest(value);
  } catch (error) {
    if (error instanceof ReelForgeError) {
      throw error;
    }
    throw invalidInput('Template manifest is invalid');
  }
}

function assertProjectAssetPaths(paths: AppPaths, project: Project): void {
  for (const card of project.cards) {
    assertAssetPath(paths, card.imagePath, 'image');
    if (card.postCardMeme) {
      if ('imagePath' in card.postCardMeme) {
        assertAssetPath(paths, card.postCardMeme.imagePath, 'image');
      } else {
        assertAssetPath(paths, card.postCardMeme.videoPath, 'meme-video');
      }
      if (card.postCardMeme.soundPath) {
        assertAssetPath(paths, card.postCardMeme.soundPath, 'audio');
      }
    }
  }
  if (project.transitionSoundPath) {
    assertAssetPath(paths, project.transitionSoundPath, 'audio');
  }
  if (project.backgroundMusicPath) {
    assertAssetPath(paths, project.backgroundMusicPath, 'audio');
  }
  if (project.introSoundPath) {
    assertAssetPath(paths, project.introSoundPath, 'audio');
  }
}

function assertTemplateAssetPaths(paths: AppPaths, template: TemplateManifest): void {
  assertAssetPath(paths, template.backgroundPath, 'video');
  if (template.thumbnailPath) {
    assertAssetPath(paths, template.thumbnailPath, 'image');
  }
}

type ManagedAssetKind = MediaKind | 'meme-video';

export function assertManagedAssetPath(paths: AppPaths, value: string, kind: ManagedAssetKind): void {
  const pattern = kind === 'image'
    ? /^assets\/[a-f0-9]{64}\.(?:png|jpg|webp)$/
    : kind === 'meme-video'
      ? /^assets\/[a-f0-9]{64}\.mp4$/
      : kind === 'video'
      ? /^assets\/[a-f0-9]{64}\.(?:mp4|mov|webm)$/
      : /^assets\/[a-f0-9]{64}\.mp3$/;
  if (!pattern.test(value)) {
    throw invalidInput('Asset paths must be canonical immutable media references');
  }
  resolveDataPath(paths, value);
}

function assertAssetPath(paths: AppPaths, value: string, kind: ManagedAssetKind): void {
  assertManagedAssetPath(paths, value, kind);
}

function safeEntityId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw invalidInput('Entity IDs may contain only letters, numbers, underscores, and hyphens');
  }
  return id;
}

function invalidInput(message: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('INVALID_INPUT', message));
}

function notFound(entity: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('NOT_FOUND', `${entity} was not found`));
}

function conflict(message: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('CONFLICT', message));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

export * from './resources.js';
