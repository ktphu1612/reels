export interface SettingsDraft {
  readonly outputDirectory: string;
  readonly concurrency: number;
  readonly googleKey: string;
  readonly elevenlabsKey: string;
  readonly clearGoogle: boolean;
  readonly clearElevenlabs: boolean;
}

export function buildSettingsUpdate(draft: SettingsDraft): Record<string, unknown> {
  const update: Record<string, unknown> = {
    outputDirectory: draft.outputDirectory,
    concurrency: draft.concurrency,
  };
  if (draft.clearGoogle) update.googleApiKey = null;
  else if (draft.googleKey.trim()) update.googleApiKey = draft.googleKey;
  if (draft.clearElevenlabs) update.elevenlabsApiKey = null;
  else if (draft.elevenlabsKey.trim()) update.elevenlabsApiKey = draft.elevenlabsKey;
  return update;
}
