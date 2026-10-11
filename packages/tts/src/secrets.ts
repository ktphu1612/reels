import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ReelForgeError, SettingsPublicSchema, createErrorPayload, type SettingsPublic } from '@reelforge/core';

export const SECRET_NAMES = ['GOOGLE_TTS_API_KEY', 'ELEVENLABS_API_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type SecretUpdate = Partial<Record<SecretName, string>>;

export interface SecretProvider {
  read(name: SecretName): Promise<string | undefined>;
}

export class EnvSecretStore implements SecretProvider {
  constructor(private readonly filePath: string) {}

  async read(name: SecretName): Promise<string | undefined> {
    assertSecretName(name);
    const source = await this.readSource();
    const match = source.match(new RegExp(`^[\\t ]*${name}[\\t ]*=[\\t ]*(.*?)[\\t ]*(?:\\r?$)`, 'm'));
    const value = match?.[1]?.trim();
    return value || undefined;
  }

  async update(values: SecretUpdate): Promise<void> {
    const entries = Object.entries(values) as Array<[string, string | undefined]>;
    for (const [name, value] of entries) {
      assertSecretName(name);
      if (value === undefined || !value) {
        throw invalidInput('A TTS API key must be a non-empty single-line value');
      }
      if (/[\u0000-\u001F\u007F]/.test(value)) {
        throw invalidInput('A TTS API key must not contain control characters');
      }
    }

    let source = await this.readSource();
    for (const [name, value] of entries) {
      if (value === undefined) {
        continue;
      }
      const line = new RegExp(`^([\\t ]*${name}[\\t ]*=[\\t ]*).*?(\\r?\\n|$)`, 'm');
      if (line.test(source)) {
        source = source.replace(line, (_match, assignmentPrefix: string, lineEnding: string) => (
          `${assignmentPrefix}${value}${lineEnding}`
        ));
      } else {
        source += `${source && !/\n$/.test(source) ? '\n' : ''}${name}=${value}\n`;
      }
    }
    await this.writeSourceAtomic(source);
  }

  async clear(names: readonly SecretName[] | SecretName = SECRET_NAMES): Promise<void> {
    const requested = typeof names === 'string' ? [names] : names;
    for (const name of requested) {
      assertSecretName(name);
    }

    let source = await this.readSource();
    for (const name of requested) {
      source = source.replace(new RegExp(`^[\\t ]*${name}[\\t ]*=.*(?:\\r?\\n|$)`, 'gm'), '');
    }
    await this.writeSourceAtomic(source);
  }

  async publicStatus(outputDirectory: string, concurrency: number): Promise<SettingsPublic> {
    const [google, elevenlabs] = await Promise.all([
      this.read('GOOGLE_TTS_API_KEY'),
      this.read('ELEVENLABS_API_KEY'),
    ]);
    return SettingsPublicSchema.parse({
      outputDirectory,
      concurrency,
      providers: {
        google: publicProviderStatus(google),
        elevenlabs: publicProviderStatus(elevenlabs),
      },
    });
  }

  private async readSource(): Promise<string> {
    try {
      return await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return '';
      }
      throw new ReelForgeError(createErrorPayload('INTERNAL', 'TTS settings could not be read'));
    }
  }

  private async writeSourceAtomic(source: string): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = join(directory, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, source, 'utf8');
      await rename(temporaryPath, this.filePath);
    } catch {
      throw new ReelForgeError(createErrorPayload('INTERNAL', 'TTS settings could not be saved'));
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function publicProviderStatus(value: string | undefined): { ready: boolean; maskedKey?: string } {
  return value ? { ready: true, maskedKey: `••••${value.slice(-4)}` } : { ready: false };
}

function assertSecretName(name: string): asserts name is SecretName {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) {
    throw invalidInput('Only supported TTS credentials may be stored');
  }
}

function invalidInput(message: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('INVALID_INPUT', message));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
