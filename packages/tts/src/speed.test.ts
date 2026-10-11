import { describe, expect, it } from 'vitest';

import { createBaseSynthesisRequest } from './speed.js';

describe('createBaseSynthesisRequest', () => {
  it('normalizes provider synthesis to 1x while retaining the requested request shape', () => {
    expect(createBaseSynthesisRequest({
      provider: 'elevenlabs',
      voiceId: 'voice-id',
      modelId: 'eleven_v3',
      text: 'Xin chào',
      speakingRate: 1.8,
      audioFormat: 'mp3',
    })).toEqual({
      provider: 'elevenlabs',
      voiceId: 'voice-id',
      modelId: 'eleven_v3',
      text: 'Xin chào',
      speakingRate: 1,
      audioFormat: 'mp3',
    });
  });
});
