# Flexible Cards, Intro Sound, and Video Memes Design

## Scope

Extend the existing local ReelForge workflow without adding folders, resource uploads, schema migrations, or new services. The app continues to read only the four launch-directory folders `stickers`, `meme sounds`, `transition sound`, and `background audio`.

## Accepted behavior

1. Remove the entire read-only resource-library section from Settings. Resource pickers in the editor remain.
2. `stickers` accepts PNG, JPEG, WebP, and MP4. MP4 files are meme videos; no other video format is supported.
3. A post-card meme contains exactly one visual:
   - Image meme: `imagePath` plus a required MP3 `soundPath`; its duration is the sound duration.
   - Video meme: `videoPath` plus an optional MP3 `soundPath`; the video keeps its original audio.
4. Video audio and the optional extra meme sound start together and may overlap. Meme duration is `max(video duration, extra sound duration)`. If the video ends first, its last frame remains visible until the extra sound ends.
5. One project-level transition sound is reused after every meme and starts when the next card appears. It is not used before card one.
6. A separate optional intro sound is selected from `transition sound`.
7. At video time zero, card one and the intro sound start together. Card one remains visible. When the intro sound ends, card-one TTS and background music start together. Without intro sound, card-one TTS and music start at zero.
8. A card script may be blank. A blank card has no TTS and uses a user-selected hold duration from 1 through 5 seconds, defaulting to 3 seconds.
9. Provider credentials are required only when at least one card has non-blank TTS text.
10. Each card may override the template card size with normalized `width` and `height`. The editor supports bottom-right resizing in the preview but does not allow changing card position. Saved `x` and `y` always come from the template slot. Rendering uses the same rectangle. Values remain inside the 9:16 canvas and use a minimum normalized width and height of `0.1`.
11. Background music remains automatically reduced under narration and foreground effects. There is no volume control.
12. No WAV resources, OCR, transcript generation, additional resource directories, resource management UI, or legacy-project migration are added.

## Data model

Keep `schemaVersion: 2`. Do not create Project V3 and do not add a new migration. The existing V1-to-V2 migration remains untouched.

Additive project fields:

```ts
interface PostCardMeme {
  imagePath?: string;
  videoPath?: string;
  soundPath?: string;
}

interface ProjectCardV2 {
  id: string;
  imagePath: string;
  script: string;
  order: number;
  holdSeconds?: number;
  layout?: NormalizedRect;
  postCardMeme?: PostCardMeme;
}

interface ProjectV2 {
  // existing fields remain
  introSoundPath?: string;
}
```

Validation enforces exactly one of `imagePath` and `videoPath`. An image meme requires `soundPath`; a video meme does not. `holdSeconds`, when present, is within 1..5. A per-card layout must fit fully inside normalized canvas bounds.

Add public resource kind `meme-video`. `MediaResourceV1` remains schema version 1. The storage scanner classifies MP4 files in `stickers` as `meme-video` and image files as `meme-image`. All audio resources remain MP3-only.

## Timeline

The renderer probes real media durations. For each card it creates a content range, optional leading transition range, optional narration audio layer, and optional post-card meme range.

```text
t=0: card 1 visible + optional intro sound
intro end: card 1 content starts + optional narration + background music
card 1 content end: optional meme visual/audio
meme end: card 2 visible + project transition sound
transition end: card 2 content starts
```

For a scripted card, content duration is the probed prepared narration duration. For a blank card, content duration is `holdSeconds ?? 3` and there is no narration input or audio layer. Card visibility includes its leading intro/transition, content, and post-card meme.

Background music is delayed to the end of the intro and then loops through the remaining timeline. Existing ducking and limiting remain.

## Rendering

Card images are composed onto transparent full-canvas frames using `layout ?? template.cardSlot`, then the existing visual crossfade is applied between full-canvas frames. Editor-created layouts keep the template position and override only card size.

Image memes retain the existing contained overlay behavior. Video memes are trimmed to their natural duration and extended with FFmpeg `tpad=stop_mode=clone` only when the optional extra sound is longer. Their original audio, when present, is delayed to the meme start and mixed with the optional extra meme sound. Gameplay audio stays muted.

The final output remains H.264/AAC, 720x1280, 30 fps, CRF 20, `yuv420p`, and `faststart`.

## UI

- Settings jumps directly from providers to Template Library after removing the resource library.
- Editor adds an intro-sound picker next to transition sound and background music.
- The meme editor allows either an image or MP4 video and an optional extra sound; it explains that image memes require a sound.
- Blank transcript shows the 1..5 second slider and disables TTS preview.
- The active card in the preview can only be resized from the bottom-right handle. The card body is not draggable, and saved `x/y` remain equal to the template slot. Size changes autosave through the existing project update path. A reset action removes the override and returns to the template size.

## Tests

- Core schema tests cover optional fields, exact-one visual validation, image-sound requirement, hold bounds, and layout bounds.
- Storage/server tests cover mixed image/MP4 discovery from `stickers`, MP4 MIME/range serving, and removal of stale video entries.
- Timeline/worker tests cover intro ordering, music start, blank-card rendering without TTS credentials, aligned optional narration paths, and transition placement.
- Renderer unit/integration tests cover original video audio, extra meme sound overlap, max duration, final-frame hold, per-card layout, and no gameplay audio.
- UI tests cover Settings removal, intro picker, blank duration slider, meme-video selection, resize clamping without position changes, reset, autosave, and enqueue acceptance.
