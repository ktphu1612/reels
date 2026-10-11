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

export interface ElevenLabsTtsProviderDependencies extends NetworkDependencies {
  readonly secrets: SecretProvider;
}

export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly network;

  constructor(private readonly dependencies: ElevenLabsTtsProviderDependencies) {
    this.network = createNetworkDependencies(dependencies);
  }

  async validateCredentials(request: TtsCredentialValidationRequest): Promise<TtsCredentialValidationResult> {
    try {
      assertElevenLabsRequest(request.provider);
      if (!(await this.dependencies.secrets.read('ELEVENLABS_API_KEY'))) {
        return { ready: false, message: 'TTS provider credentials are not configured' };
      }
      await this.listVoices({ provider: 'elevenlabs' });
      return { ready: true };
    } catch (error) {
      if (error instanceof ReelForgeError && error.payload.code === 'UNAUTHORIZED') {
        return { ready: false, message: error.payload.message };
      }
      return { ready: false, message: 'TTS provider credentials could not be validated' };
    }
  }

  async listVoices(request: TtsListVoicesRequest): Promise<TtsListVoicesResult> {
    assertElevenLabsRequest(request.provider);
    const key = await this.requireKey();
    const voices: TtsListVoicesResult['voices'] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;

    while (true) {
      const parameters = new URLSearchParams({ page_size: '100' });
      if (nextPageToken) {
        parameters.set('next_page_token', nextPageToken);
      }
      const payload = await fetchAndReadWithRetry(
        this.network,
        `https://api.elevenlabs.io/v2/voices?${parameters.toString()}`,
        { method: 'GET', headers: { 'xi-api-key': key } },
        (response) => response.json(),
      );
      if (!isRecord(payload) || !Array.isArray(payload.voices) || typeof payload.has_more !== 'boolean') {
        throw invalidProviderResponse();
      }
      for (const voice of payload.voices) {
        if (!isRecord(voice) || !isNonEmptyString(voice.voice_id) || !isNonEmptyString(voice.name)) {
          throw invalidProviderResponse();
        }
        voices.push({
          id: voice.voice_id,
          name: voice.name,
          languageCode: request.languageCode ?? languageFromMetadata(voice) ?? 'multilingual',
        });
      }
      if (!payload.has_more) {
        return { voices };
      }
      if (!isNonEmptyString(payload.next_page_token) || seenTokens.has(payload.next_page_token)) {
        throw invalidProviderResponse();
      }
      seenTokens.add(payload.next_page_token);
      nextPageToken = payload.next_page_token;
    }
  }

  async synthesize(request: TtsSynthesisRequest, options: TtsSynthesisOptions = {}): Promise<TtsSynthesisResult> {
    assertElevenLabsRequest(request.provider);
    const key = await this.requireKey();
    const outputFormat = request.audioFormat === 'mp3' ? 'mp3_44100_128' : 'wav_44100';
    const body = {
      text: request.text,
      model_id: request.modelId ?? 'eleven_multilingual_v2',
    };
    const responseBody = await fetchAndReadWithRetry(
      this.network,
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(request.voiceId)}?output_format=${outputFormat}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': key },
        body: JSON.stringify(body),
      },
      async (response) => ({
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type'),
      }),
      options.signal,
    );
    const bytes = responseBody.bytes;
    if (bytes.byteLength === 0) {
      throw invalidProviderResponse();
    }
    return {
      audioBase64: bytes.toString('base64'),
      contentType: responseBody.contentType || (request.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav'),
    };
  }

  private async requireKey(): Promise<string> {
    const key = await this.dependencies.secrets.read('ELEVENLABS_API_KEY');
    if (!key) {
      throw new ReelForgeError(createErrorPayload('UNAUTHORIZED', 'TTS provider credentials are not configured'));
    }
    return key;
  }
}

function assertElevenLabsRequest(provider: string): void {
  if (provider !== 'elevenlabs') {
    throw new ReelForgeError(createErrorPayload('INVALID_INPUT', 'ElevenLabs TTS received the wrong provider request'));
  }
}

function languageFromMetadata(voice: Record<string, unknown>): string | undefined {
  if (isNonEmptyString(voice.language)) {
    return voice.language;
  }
  if (isRecord(voice.labels) && isNonEmptyString(voice.labels.language)) {
    return voice.labels.language;
  }
  if (Array.isArray(voice.verified_languages)) {
    for (const language of voice.verified_languages) {
      if (!isRecord(language)) {
        continue;
      }
      if (isNonEmptyString(language.locale)) {
        return language.locale;
      }
      if (isNonEmptyString(language.language)) {
        return language.language;
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
