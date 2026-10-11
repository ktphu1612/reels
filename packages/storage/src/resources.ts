import { readdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import {
  MediaResourceV1Schema,
  ReelForgeError,
  createErrorPayload,
  type MediaResourceKind,
  type MediaResourceV1,
} from '@reelforge/core';

import {
  assertManagedAssetPath,
  readJsonFile,
  resolveDataPath,
  writeJsonFileAtomic,
  type AppPaths,
  type AssetStore,
} from './index.js';

type SeedResourceKind = MediaResourceKind | 'meme';

export interface SeedResourceDirectory {
  readonly directory: string;
  readonly kind: SeedResourceKind;
}

export interface SeedResourceError {
  readonly name: string;
  readonly code: 'INVALID_INPUT';
}

export interface SeedResourceResult {
  readonly resources: readonly MediaResourceV1[];
  readonly errors: readonly SeedResourceError[];
}

export class ResourceStore {
  constructor(
    private readonly paths: AppPaths,
    private readonly assets: AssetStore,
  ) {}

  async list(kind?: MediaResourceKind): Promise<MediaResourceV1[]> {
    let entries;
    try {
      entries = await readdir(this.paths.resources, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw invalidInput('Resource catalog could not be read');
    }

    const resources: MediaResourceV1[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        const resource = await this.get(entry.name);
        if (!kind || resource.kind === kind) {
          resources.push(resource);
        }
      } catch (error) {
        if (error instanceof ReelForgeError) {
          throw error;
        }
        throw invalidInput('Resource manifest is invalid');
      }
    }

    return sortResources(resources);
  }

  async get(id: string): Promise<MediaResourceV1> {
    if (!isResourceId(id)) {
      throw invalidInput('Resource ID is invalid');
    }

    try {
      const resource = parseResource(this.paths, await readJsonFile<unknown>(this.manifestPath(id)));
      if (resource.id !== id) {
        throw invalidInput('Resource manifest ID does not match its directory');
      }
      return resource;
    } catch (error) {
      if (isMissingFile(error)) {
        throw notFound('Resource');
      }
      if (error instanceof ReelForgeError) {
        throw error;
      }
      throw invalidInput('Resource manifest is invalid');
    }
  }

  async seedDirectories(inputs: readonly SeedResourceDirectory[]): Promise<SeedResourceResult> {
    const resources = new Map<string, MediaResourceV1>();
    const errors: SeedResourceError[] = [];
    const activeIdsByKind = new Map<MediaResourceKind, Set<string>>();

    for (const input of inputs) {
      let entries;
      try {
        entries = await readdir(input.directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        errors.push({ name: basename(input.directory), code: 'INVALID_INPUT' });
        continue;
      }
      for (const resourceKind of resourceKindsForSeed(input.kind)) {
        if (!activeIdsByKind.has(resourceKind)) {
          activeIdsByKind.set(resourceKind, new Set<string>());
        }
      }

      for (const entry of entries.filter((candidate) => candidate.isFile()).sort(compareDirectoryEntries)) {
        try {
          const resourceKind = classifyResource(input.kind, entry.name);
          const imported = await this.assets.importFile(join(input.directory, entry.name), resourceKind);
          const resource = parseResource(this.paths, {
            schemaVersion: 1,
            id: `${resourceKind}-${imported.sha256}`,
            name: entry.name,
            kind: resourceKind,
            assetPath: imported.relativePath,
          });
          await writeJsonFileAtomic(this.manifestPath(resource.id), resource);
          resources.set(resource.id, resource);
          activeIdsByKind.get(resourceKind)?.add(resource.id);
        } catch {
          errors.push({ name: entry.name, code: 'INVALID_INPUT' });
        }
      }
    }

    await this.removeStaleManifests(activeIdsByKind);

    return {
      resources: sortResources([...resources.values()]),
      errors: errors.sort(compareErrors),
    };
  }

  private manifestPath(id: string): string {
    return resolveDataPath(this.paths, `resources/${id}/resource.json`);
  }

  private async removeStaleManifests(activeIdsByKind: ReadonlyMap<MediaResourceKind, ReadonlySet<string>>): Promise<void> {
    const entries = await readdir(this.paths.resources, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const kind = resourceKindFromId(entry.name);
      if (!kind || !activeIdsByKind.has(kind) || activeIdsByKind.get(kind)?.has(entry.name)) {
        continue;
      }
      await rm(resolveDataPath(this.paths, `resources/${entry.name}`), { recursive: true, force: true });
    }
  }
}

function parseResource(paths: AppPaths, value: unknown): MediaResourceV1 {
  try {
    const resource = MediaResourceV1Schema.parse(value);
    if (!isResourceId(resource.id) || resource.id !== `${resource.kind}-${assetHash(resource.assetPath)}`) {
      throw invalidInput('Resource manifest identity is invalid');
    }
    assertManagedAssetPath(paths, resource.assetPath, resourceAssetKind(resource.kind));
    return resource;
  } catch (error) {
    if (error instanceof ReelForgeError) {
      throw error;
    }
    throw invalidInput('Resource manifest is invalid');
  }
}

function assetHash(assetPath: string): string {
  const match = /^assets\/([a-f0-9]{64})\.(?:png|jpg|webp|mp3|mp4)$/.exec(assetPath);
  if (!match) {
    throw invalidInput('Resource asset path is invalid');
  }
  return match[1];
}

function isResourceId(value: string): boolean {
  return resourceKindFromId(value) !== undefined;
}

function resourceKindFromId(value: string): MediaResourceKind | undefined {
  const match = /^(meme-image|meme-video|meme-sound|transition-sound|intro-sound|background-music)-[a-f0-9]{64}$/.exec(value);
  return match?.[1] as MediaResourceKind | undefined;
}

function classifyResource(kind: SeedResourceKind, name: string): MediaResourceKind {
  if (kind !== 'meme') return kind;
  return extname(name).toLowerCase() === '.mp4' ? 'meme-video' : 'meme-image';
}

function resourceKindsForSeed(kind: SeedResourceKind): readonly MediaResourceKind[] {
  return kind === 'meme' ? ['meme-image', 'meme-video'] : [kind];
}

function resourceAssetKind(kind: MediaResourceKind): 'image' | 'meme-video' | 'audio' {
  if (kind === 'meme-image') return 'image';
  if (kind === 'meme-video') return 'meme-video';
  return 'audio';
}

function sortResources(resources: MediaResourceV1[]): MediaResourceV1[] {
  return resources.sort((left, right) => (
    compareText(left.kind, right.kind)
    || compareText(left.name, right.name)
    || compareText(left.id, right.id)
  ));
}

function compareDirectoryEntries(left: { name: string }, right: { name: string }): number {
  return compareText(left.name, right.name);
}

function compareErrors(left: SeedResourceError, right: SeedResourceError): number {
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidInput(message: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('INVALID_INPUT', message));
}

function notFound(entity: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('NOT_FOUND', `${entity} was not found`));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
