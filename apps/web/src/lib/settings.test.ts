import { describe, expect, it } from 'vitest';

import { buildSettingsUpdate } from './settings';

describe('write-only credential settings', () => {
  it('keeps blank secret fields out of an update and sends explicit clear separately', () => {
    expect(buildSettingsUpdate({ outputDirectory: 'D:/renders', concurrency: 2, googleKey: '', elevenlabsKey: 'new-secret', clearGoogle: false, clearElevenlabs: false })).toEqual({
      outputDirectory: 'D:/renders',
      concurrency: 2,
      elevenlabsApiKey: 'new-secret',
    });
    expect(buildSettingsUpdate({ outputDirectory: 'D:/renders', concurrency: 2, googleKey: '', elevenlabsKey: '', clearGoogle: true, clearElevenlabs: false })).toEqual({
      outputDirectory: 'D:/renders',
      concurrency: 2,
      googleApiKey: null,
    });
  });
});
