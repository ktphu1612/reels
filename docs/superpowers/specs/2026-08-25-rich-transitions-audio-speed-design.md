# Rich Transitions, Background Audio, and Reliable TTS Speed Design

## Context

The reference video `FDown.vn_Tai_video_Facebook_720p (HD)_2d74.mp4` uses short meme inserts and sound effects between narrated cards while background music remains continuous. The current ReelForge renderer crossfades narrated cards continuously, renders one template sticker for the whole video, and outputs narration only.

The local resource folders currently contain:

- `stickers`: 36 PNG/JPEG meme images.
- `meme sounds`: 12 MP3 meme sounds.
- `transition sound`: 2 MP3 transition sounds.
- `background audio`: 1 MP3 background track.

The existing output job `09acdca1-12b6-4d07-9cc5-8f6a03e4ddec` saved `speakingRate=1.2` correctly but used `modelId=eleven_v3`. ElevenLabs does not apply its native speed setting to Eleven v3, while ReelForge currently has no local speed-processing fallback.

## Accepted behavior

For cards A and B, the sequence is:

```text
TTS card A
→ optional meme image + its paired meme sound
→ card B becomes visible + the project's transition sound
→ TTS card B
```

The following rules are fixed:

1. A meme image and meme sound are a pair. Both are configured or neither is configured.
2. The meme image starts with its sound and remains visible for exactly the probed duration of that sound.
3. The outgoing card remains visible behind its meme until the meme finishes.
4. One transition sound is selected at project level and reused for every card after the first.
5. A later card becomes visible when its transition sound starts. Its narration starts only after that transition sound finishes.
6. The first card has no leading transition sound.
7. The last card may have an ending meme, but no transition sound follows it.
8. Background music, when selected, starts at video time zero, loops as needed, and ends with the video.
9. Background music is automatically lowered under narration and foreground effects. There is no manual music-volume control.
10. The fixed template sticker is removed completely from template import, preview, and rendering.
11. Existing template sticker files are not deleted automatically. Legacy manifests simply stop referencing them after migration.
12. Speaking speed remains a project setting from 0.5x through 2.0x and must work identically for Google, ElevenLabs Multilingual, and Eleven v3.

## Data model

The canonical project becomes `ProjectV2`.

```ts
interface PostCardMeme {
  imagePath: string;
  soundPath: string;
}

interface ProjectCardV2 {
  id: string;
  imagePath: string;
  script: string;
  order: number;
  postCardMeme?: PostCardMeme;
}

interface ProjectV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  templateId: string;
  tts: ProjectTtsSettings; // speakingRate constrained to 0.5..2
  output: OutputSettings;
  transitionSoundPath?: string;
  backgroundMusicPath?: string;
  cards: ProjectCardV2[];
}
```

The canonical template becomes `TemplateManifestV2`.

```ts
interface TemplateManifestV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  backgroundPath: string;
  thumbnailPath?: string;
  canvas: TemplateCanvas;
  cardSlot: NormalizedRect;
  memeSlot: NormalizedRect;
}
```

`TemplateManifestV2` has no fixed `stickerPath`. Migration from v1 copies `stickerSlot` to `memeSlot` and discards `stickerPath`. Migration from `ProjectV1` adds empty transition/background settings and cards without memes. Existing SQLite job snapshots are normalized through the same migrations when read so queue history survives the upgrade.

Managed resources use a small catalog:

```ts
type MediaResourceKind =
  | 'meme-image'
  | 'meme-sound'
  | 'transition-sound'
  | 'background-music';

interface MediaResourceV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: MediaResourceKind;
  assetPath: string;
}
```

Resource files are copied into the existing SHA-256 asset store. Resource manifests contain only managed relative paths, never original filesystem paths.

## Resource library

On startup, ReelForge idempotently scans these direct child folders relative to the launch directory:

| Folder | Resource kind |
| --- | --- |
| `stickers` | `meme-image` |
| `meme sounds` | `meme-sound` |
| `transition sound` | `transition-sound` |
| `background audio` | `background-music` |

Missing folders are ignored. Invalid files are reported without preventing valid resources or app startup. Scanning is non-recursive and never modifies or deletes source files. To add resources later, the user copies files into these four folders and restarts the app; there is no upload/import UI.

V1 supports PNG, JPEG, and WebP meme images plus MP3 audio resources only. The asset endpoint serves the matching image/audio MIME type and continues to support byte ranges so browser audio preview works.

## Timeline and rendering

The renderer probes narration, meme sounds, and the selected transition sound before constructing the timeline. Durations are never trusted from browser metadata or project JSON.

For every card, the timeline records:

- The optional leading transition range.
- The narration range.
- The optional post-card meme range.
- The complete card-visible range.

Card visibility begins when its leading transition starts, or when narration starts for the first card. It ends after its optional meme. Existing 200 ms card crossfades remain visual-only and do not change audio event times or total duration.

Each selected meme image is scaled with `contain` into `memeSlot` and enabled only over its meme range. There is no always-on sticker layer.

Audio is assembled from independent timed layers:

- Narration clips begin at their timeline narration starts.
- Meme sounds begin at their meme starts.
- The one transition sound is reused at every later-card transition start.
- Background music loops from zero through total duration.

Narration remains normalized near -16 LUFS. Music uses one fixed internal mix level and side-chain ducking under narration/foreground effects. The final mix uses a limiter before AAC encoding. Gameplay audio remains muted.

## Speaking-speed behavior

Provider-generated TTS is cached at 1.0x. A local FFmpeg `atempo` pass creates job-local narration audio at the requested 0.5x–2.0x before duration probing and timeline creation. The TTS preview endpoint uses the same operation, so preview and final render have matching pacing.

This design intentionally does not depend on provider-native speed controls:

- It works for Eleven v3.
- It makes the UI range truthful for every provider/model.
- Changing speed reuses the paid 1.0x TTS cache.
- FFmpeg preserves pitch while changing duration.

The ElevenLabs adapter omits unsupported `voice_settings.speed` for Eleven v3. Provider adapters receive a normalized 1.0x synthesis request from the orchestration layer.

## User interface

Settings gains a grouped resource library with image thumbnails and audio playback. Template import no longer accepts a sticker.

Editor project controls gain:

- One background-music picker.
- One transition-sound picker used by the complete project.
- Playback controls for selected audio.

Each card gains a `Sau card này` section. A small apply dialog selects both meme image and meme sound before writing `postCardMeme`, preventing autosave from persisting half a pair. Clearing the section removes both paths together. The final card uses the same control for an ending meme.

Preview removes the persistent sticker and can switch between the active card and its post-card meme. Preview labels state that the meme duration comes from its selected sound.

## Errors and safety

Preflight fails before TTS/render when a selected resource is missing, outside managed storage, the wrong media kind, empty, or unprobeable. The error identifies the project/card and resource category without exposing raw paths.

Queued snapshots hold immutable managed paths. Resource source directories and API keys never enter project JSON, SQLite snapshots, frontend responses, cache keys, or logs. Cancellation covers speed-processing and final FFmpeg processes.

## Compatibility and non-goals

- Existing projects and templates open through v1-to-v2 migration.
- Existing completed and failed queue history remains readable.
- Existing static sticker assets remain on disk but are no longer used.
- This change does not add animated GIF/video memes, multiple effects per boundary, a free-form timeline editor, per-transition transition sounds, music trimming, waveform editing, or automatic meme selection.

## Acceptance criteria

1. Every valid direct child file in the four resource folders appears in the resource library after startup seeding; adding a supported file and restarting adds it without requiring code changes.
2. A project can select one transition sound, one background track, and optional meme pairs after individual cards.
3. Render order exactly matches the accepted sequence, including no transition before card one and no transition after the final meme.
4. Every meme visual duration differs from its probed sound duration by no more than one output frame.
5. Background music is present for the complete output and gameplay audio is absent.
6. A project using `eleven_v3` at 0.5x, 1.0x, 1.2x, and 2.0x produces monotonically decreasing narration durations as speed rises, within 100 ms of `baseDuration / speakingRate` per card.
7. TTS preview and rendered narration created from the same cached source differ in duration by no more than 100 ms.
8. No fixed template sticker appears in preview or output.
9. All schema, storage, API, worker, renderer, UI, E2E, security, lint, test, and production-build checks pass.
