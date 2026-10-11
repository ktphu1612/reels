import {
  ReelForgeError,
  createErrorPayload,
  type TtsCredentialValidationRequest,
  type TtsCredentialValidationResult,
  type TtsListVoicesRequest,
  type TtsListVoicesResult,
  type TtsProvider,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
  type TtsSynthesisOptions,
} from '@reelforge/core';

import { createNetworkDependencies, fetchAndReadWithRetry, invalidProviderResponse, type NetworkDependencies } from './network.js';
import type { SecretProvider } from './secrets.js';

export interface GoogleTtsProviderDependencies extends NetworkDependencies {
  readonly secrets: SecretProvider;
}

export class GoogleTtsProvider implements TtsProvider {
  private readonly network;

  constructor(private readonly dependencies: GoogleTtsProviderDependencies) {
    this.network = createNetworkDependencies(dependencies);
  }

  async validateCredentials(request: TtsCredentialValidationRequest): Promise<TtsCredentialValidationResult> {
    try {
      assertGoogleRequest(request.provider);
      if (!(await this.dependencies.secrets.read('GOOGLE_TTS_API_KEY'))) {
        return { ready: false, message: 'TTS provider credentials are not configured' };
      }
      await this.listVoices({ provider: 'google', languageCode: 'vi-VN' });
      return { ready: true };
    } catch (error) {
      if (error instanceof ReelForgeError && error.payload.code === 'UNAUTHORIZED') {
        return { ready: false, message: error.payload.message };
      }
      return { ready: false, message: 'TTS provider credentials could not be validated' };
    }
  }

  async listVoices(request: TtsListVoicesRequest): Promise<TtsListVoicesResult> {
    assertGoogleRequest(request.provider);
    const key = await this.requireKey();
    const parameters = new URLSearchParams({ key });
    if (request.languageCode) {
      parameters.set('languageCode', request.languageCode);
    }
    const payload = await fetchAndReadWithRetry(
      this.network,
      `https://texttospeech.googleapis.com/v1/voices?${parameters.toString()}`,
      { method: 'GET' },
      (response) => response.json(),
    );
    if (!isRecord(payload) || !Array.isArray(payload.voices)) {
      throw invalidProviderResponse();
    }
    return {
      voices: payload.voices.map((voice) => {
        if (!isRecord(voice) || !isNonEmptyString(voice.name) || !isNonEmptyStringArray(voice.languageCodes)) {
          throw invalidProviderResponse();
        }
        return { id: voice.name, name: voice.name, languageCode: voice.languageCodes[0] as string };
      }),
    };
  }

  async synthesize(request: TtsSynthesisRequest, options: TtsSynthesisOptions = {}): Promise<TtsSynthesisResult> {
    assertGoogleRequest(request.provider);
    const key = await this.requireKey();
    const encoding = request.audioFormat === 'mp3' ? 'MP3' : 'LINEAR16';
    const payload = await fetchAndReadWithRetry(
      this.network,
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { text: request.text },
          voice: { name: request.voiceId, languageCode: languageFromVoiceId(request.voiceId) },
          audioConfig: { audioEncoding: encoding, speakingRate: request.speakingRate },
        }),
      },
      (response) => response.json(),
      options.signal,
    );
    if (!isRecord(payload) || !isValidBase64(payload.audioContent)) {
      throw invalidProviderResponse();
    }
    return {
      audioBase64: payload.audioContent,
      contentType: request.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    };
  }

  private async requireKey(): Promise<string> {
    const key = await this.dependencies.secrets.read('GOOGLE_TTS_API_KEY');
    if (!key) {
      throw new ReelForgeError(createErrorPayload('UNAUTHORIZED', 'TTS provider credentials are not configured'));
    }
    return key;
  }
}

function assertGoogleRequest(provider: string): void {
  if (provider !== 'google') {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'Google TTS received the wrong provider request'));
  }
}

function languageFromVoiceId(voiceId: string): string {
  const match = voiceId.match(/^([a-z]{2,3}-[A-Z]{2,3})-/);
  return match?.[1] ?? 'vi-VN';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isValidBase64(value: unknown): value is string {
  if (!isNonEmptyString(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64').byteLength > 0;
  } catch {
    return false;
  }
}
