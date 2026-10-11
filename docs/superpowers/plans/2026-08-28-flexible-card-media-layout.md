# Flexible Cards, Intro Sound, and Video Memes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add intro sound timing, blank-duration cards, MP4 meme inserts with original audio, and per-card preview layout while removing the Settings resource gallery.

**Architecture:** Extend the existing V2 contracts additively, classify MP4 files from the existing `stickers` directory, and keep queue snapshots unchanged except for optional fields. Build timing in the pure edit-timeline module, align worker narration paths by card index, then render full-canvas card layers and timed meme-video audio with the existing FFmpeg pipeline.

**Tech Stack:** Node.js 24, TypeScript strict, Zod, React/Vite, Fastify, FFmpeg/ffprobe, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-28-flexible-card-media-layout-design.md`

## Global Constraints

- Continue reading only `stickers`, `meme sounds`, `transition sound`, and `background audio`.
- Meme video format is MP4 only; audio resources remain MP3 only; do not add WAV support.
- Keep `schemaVersion: 2`; do not create a V3 schema or a new legacy-project migration.
- Keep the existing V1-to-V2 migration unchanged.
- Background music has automatic ducking and no user volume control.
- Preserve uncommitted renderer/storage fixes already present in the working tree.
- Use TDD: every production behavior starts with a test that fails for the expected reason.
- Do not refactor unrelated code or add resource management, OCR, transcript generation, or additional folders.

---

### Task 1: Extend project and media-resource contracts

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`

**Interfaces:**
- Produces: `MediaResourceKind` including `'meme-video'`.
- Produces: `ProjectV2.introSoundPath?: string`.
- Produces: `ProjectCardV2.holdSeconds?: number`, `layout?: NormalizedRect`.
- Produces: `PostCardMeme` with exactly one of `imagePath` or `videoPath`; images require `soundPath`.

- [ ] **Step 1: Write failing schema tests**

Add tests with literal objects proving:

```ts
expect(ProjectV2Schema.parse({
  ...validProject,
  introSoundPath: 'assets/intro.mp3',
  cards: [{
    ...validProject.cards[0],
    script: '',
    holdSeconds: 3,
    layout: { x: 0.1, y: 0.2, width: 0.7, height: 0.3 },
    postCardMeme: { videoPath: 'assets/meme.mp4', soundPath: 'assets/extra.mp3' },
  }],
}).cards[0]?.script).toBe('');
expect(MediaResourceKindSchema.parse('meme-video')).toBe('meme-video');
```

Also assert rejection for both/no visual paths, an image without sound, hold values outside 1..5, layout width/height below `0.1`, and layouts extending beyond normalized bounds.

- [ ] **Step 2: Run the core test and verify RED**

Run: `npm.cmd test -w @reelforge/core`

Expected: the new cases fail because V2 currently requires non-empty script and does not recognize the additive fields or `meme-video`.

- [ ] **Step 3: Implement the minimal additive schemas**

Use optional fields on V2 only. Keep the schema version and migration dispatch unchanged. Implement one reusable layout-bound refinement:

```ts
const CardLayoutSchema = NormalizedRectSchema.superRefine((rect, context) => {
  if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    context.addIssue({ code: 'custom', message: 'Card layout must fit inside the canvas' });
  }
});
```

Make `script` accept an empty string, validate `holdSeconds` with `z.number().min(1).max(5).optional()`, and refine `PostCardMemeSchema` exactly as specified.
Enforce `layout.width >= 0.1` and `layout.height >= 0.1` in addition to the canvas-bound refinement.

- [ ] **Step 4: Run core tests and verify GREEN**

Run: `npm.cmd test -w @reelforge/core`

Expected: all core tests pass.

- [ ] **Step 5: Commit only Task 1 files**

```powershell
git add packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat: extend card and meme contracts"
```

---

### Task 2: Discover and serve MP4 meme resources

**Files:**
- Modify: `packages/storage/src/resources.ts`
- Modify: `packages/storage/src/resources.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/index.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/index.test.ts`

**Interfaces:**
- Consumes: `MediaResourceKind = 'meme-video'` from Task 1.
- Produces: mixed image/video classification for the one `stickers` scan and `video/mp4` managed-asset responses with byte ranges.

- [ ] **Step 1: Write failing storage and API tests**

Create a temporary `stickers` directory containing one PNG and one MP4. Assert one `meme-image` and one `meme-video` manifest, with no invalid-file error for either. Add an API test that requests a managed MP4 asset and verifies:

```ts
expect(response.headers['content-type']).toContain('video/mp4');
expect(rangeResponse.statusCode).toBe(206);
expect(rangeResponse.headers['accept-ranges']).toBe('bytes');
```

Extend the existing stale-resource regression test to prove a deleted MP4 disappears from the catalog without deleting its SHA-managed asset.
Add storage round-trip tests for a video meme, optional video meme sound, per-card layout, blank script/hold, and project intro sound. Add a multipart import test proving an empty script creates a card with `holdSeconds: 3`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd test -w @reelforge/storage && npm.cmd test -w @reelforge/server`

Expected: MP4 is rejected or misclassified and its MIME contract is absent.

- [ ] **Step 3: Implement mixed `stickers` classification**

Keep public resource kinds unchanged except for `meme-video`. Use one internal seed source kind for the folder, for example:

```ts
type SeedResourceKind = MediaResourceKind | 'meme';

function classifyResource(kind: SeedResourceKind, name: string): MediaResourceKind {
  if (kind !== 'meme') return kind;
  return extname(name).toLowerCase() === '.mp4' ? 'meme-video' : 'meme-image';
}
```

Accept MP4 only for `meme-video`; keep PNG/JPEG/WebP for images and MP3 for every audio kind. Update resource-id validation and stale-manifest pruning for the new kind. Configure `stickers` once with internal kind `meme`.

- [ ] **Step 4: Serve MP4 with existing safe range behavior**

Extend the managed asset MIME mapping to return `video/mp4`. Reuse the existing range parser/streaming path; do not create a second video endpoint.
Extend storage intended-use/path validation to accept `meme-video` only for MP4 and to validate `introSoundPath` as managed MP3 audio. Change the existing card-import route from trimmed non-empty text to a plain string, and default a newly imported blank card to a three-second hold.

- [ ] **Step 5: Run storage and server tests and verify GREEN**

Run: `npm.cmd test -w @reelforge/storage && npm.cmd test -w @reelforge/server`

Expected: both suites pass.

- [ ] **Step 6: Commit only Task 2 files**

```powershell
git add packages/storage/src/resources.ts packages/storage/src/resources.test.ts packages/storage/src/index.ts packages/storage/src/index.test.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/index.ts apps/server/src/index.test.ts
git commit -m "feat: discover mp4 meme resources"
```

---

### Task 3: Model intro, blank-card, and max-meme timing

**Files:**
- Modify: `packages/renderer/src/edit-timeline.ts`
- Modify: `packages/renderer/src/edit-timeline.test.ts`

**Interfaces:**
- Produces: `createEditTimeline({ introSeconds?, transitionSeconds?, cards })`.
- Produces per card: content range, optional narration range, leading transition, optional meme range, and full visible range.
- Produces: `musicStartSeconds`, equal to intro duration or zero.

- [ ] **Step 1: Write failing pure timeline tests**

Use hand-computed times. Cover this exact sequence:

```ts
const timeline = createEditTimeline({
  introSeconds: 1,
  transitionSeconds: 0.25,
  cards: [
    { cardId: 'a', contentSeconds: 2, hasNarration: true, memeSeconds: 1.5 },
    { cardId: 'b', contentSeconds: 3, hasNarration: false },
  ],
});

expect(timeline.musicStartSeconds).toBe(1);
expect(timeline.cards[0]?.visible).toEqual({ startSeconds: 0, endSeconds: 4.5 });
expect(timeline.cards[0]?.content).toEqual({ startSeconds: 1, endSeconds: 3 });
expect(timeline.cards[1]?.transition).toEqual({ startSeconds: 4.5, endSeconds: 4.75 });
expect(timeline.cards[1]?.content).toEqual({ startSeconds: 4.75, endSeconds: 7.75 });
expect(timeline.cards[1]?.narration).toBeUndefined();
```

Also test no intro, no transition before card one, final meme allowed, and invalid/non-positive durations rejected.

- [ ] **Step 2: Run timeline tests and verify RED**

Run: `npm.cmd test -w @reelforge/renderer -- edit-timeline.test.ts`

Expected: the current narration-only timeline lacks intro, content ranges, optional narration, and music start.

- [ ] **Step 3: Implement the minimal pure timeline**

Keep timeline math independent of FFmpeg. Card one visibility starts at zero; its content begins after intro. Later card visibility starts with its transition. Advance the cursor through transition, content, and meme without adding silence.

- [ ] **Step 4: Run timeline tests and verify GREEN**

Run: `npm.cmd test -w @reelforge/renderer -- edit-timeline.test.ts`

Expected: timeline tests pass.

- [ ] **Step 5: Commit only Task 3 files**

```powershell
git add packages/renderer/src/edit-timeline.ts packages/renderer/src/edit-timeline.test.ts
git commit -m "feat: model intro and blank card timing"
```

---

### Task 4: Align worker narration generation with optional TTS

**Files:**
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`
- Modify: `packages/renderer/src/index.ts`
- Modify: `packages/renderer/src/index.test.ts`

**Interfaces:**
- Consumes: blank scripts and `holdSeconds` from Task 1.
- Produces: `narrationAudioPaths: readonly (string | undefined)[]`, aligned one-to-one with project cards.
- Produces: preflight that requires provider readiness only when any script is non-blank.
- Produces: safe managed path validation for `introSoundPath` and image/video meme variants.

- [ ] **Step 1: Write failing worker and preflight tests**

Add a two-card worker test where card one is blank and card two has text. Assert the provider is called once for card two and render receives `[undefined, '<prepared-card-two.wav>']`. Add an all-blank test with `providerReady: false` that reaches render without synthesis. Add preflight tests for hold bounds through the parsed snapshot and for managed `introSoundPath`/`videoPath` validation.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd test -w @reelforge/worker -- runtime.test.ts && npm.cmd test -w @reelforge/renderer -- index.test.ts`

Expected: narration paths collapse around blank cards and preflight still rejects blank scripts/provider state.

- [ ] **Step 3: Implement aligned optional narration paths**

Build the array with `Promise`-free index preservation:

```ts
const narrationAudioPaths: Array<string | undefined> = [];
for (const [index, card] of cards.entries()) {
  if (!card.script.trim()) {
    narrationAudioPaths[index] = undefined;
    continue;
  }
  narrationAudioPaths[index] = await synthesizeAndPrepare(card, index);
}
```

Remove `SCRIPT_BLANK` from preflight. Check provider readiness only if `cards.some(card => card.script.trim())`. Require narration media only for scripted cards. Progress remains monotonic when cards are blank.

- [ ] **Step 4: Validate every new managed resource path**

Treat intro as `transition-sound`; select meme kind from `videoPath` versus `imagePath`; require optional extra sound only when present. Do not expose absolute paths or add new response fields.

- [ ] **Step 5: Run worker and renderer tests and verify GREEN**

Run: `npm.cmd test -w @reelforge/worker -- runtime.test.ts && npm.cmd test -w @reelforge/renderer -- index.test.ts`

Expected: focused suites pass.

- [ ] **Step 6: Commit only Task 4 files**

```powershell
git add apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts packages/renderer/src/index.ts packages/renderer/src/index.test.ts
git commit -m "feat: render cards without mandatory tts"
```

---

### Task 5: Render per-card layouts and meme videos with audio

**Files:**
- Modify: `packages/renderer/src/index.ts`
- Modify: `packages/renderer/src/index.test.ts`
- Modify: `packages/renderer/src/integration.test.ts`

**Interfaces:**
- Consumes: timeline from Task 3 and aligned narration paths from Task 4.
- Produces: FFmpeg inputs/filters for image or MP4 memes, original meme-video audio, optional extra sound, intro timing, delayed background music, and per-card rectangles.

- [ ] **Step 1: Write failing filter-graph tests**

Build one request containing: intro sound, a card-specific layout, a video meme with original audio plus a longer extra sound, and background music. Assert observable graph behavior rather than private helper text:

- card one full-canvas layer uses its normalized rectangle instead of template `cardSlot`;
- intro audio starts at zero;
- narration and music are delayed to `musicStartSeconds`;
- video meme visual starts at its meme range and includes final-frame padding;
- video audio and extra meme sound use the same start delay;
- total `-t` equals timeline duration.

- [ ] **Step 2: Run renderer unit tests and verify RED**

Run: `npm.cmd test -w @reelforge/renderer -- index.test.ts`

Expected: current command builder only accepts image memes, fixed card slot, narration for every card, and music at zero.

- [ ] **Step 3: Compose each card onto a transparent full canvas**

Resolve `card.layout ?? template.cardSlot` to encoder-safe pixels. Scale/pad the card with `contain`, overlay it on a 720x1280 transparent frame for the card-visible duration, and crossfade those full-canvas layers. Preserve the existing 200 ms visual-only crossfade semantics.

- [ ] **Step 4: Add intro and delayed music audio layers**

Probe intro sound once. Include its duration in the timeline. Delay narration to each scripted card content start. Delay looped music to `timeline.musicStartSeconds`; trim it to the remaining duration. Keep existing normalization, ducking, limiter, and muted gameplay behavior.

- [ ] **Step 5: Add MP4 meme visual and audio layers**

Probe video duration and whether it has audio. Compute:

```ts
const memeSeconds = Math.max(videoSeconds, extraSoundSeconds ?? 0);
const freezeSeconds = Math.max(0, memeSeconds - videoSeconds);
```

Trim the video, apply `tpad=stop_mode=clone:stop_duration=<freezeSeconds>` only when positive, set timestamps to the meme start, and overlay it in `memeSlot`. Delay the video's own audio and optional extra sound to the identical meme start and include both in the foreground mix.

- [ ] **Step 6: Add a real FFmpeg integration fixture**

Generate a short MP4 meme with a distinct sine-wave audio track, a longer extra MP3, intro MP3, narration, and background music. Render two cards and use ffprobe to assert 720x1280, 30 fps, H.264/AAC, expected duration within 100 ms, and an audio stream. Extract frames after the meme video ends but before the extra sound ends to prove the held final frame remains visible.

- [ ] **Step 7: Run renderer tests and verify GREEN**

Run: `npm.cmd test -w @reelforge/renderer`

Expected: all renderer tests, including bundled-FFmpeg integration, pass.

- [ ] **Step 8: Commit only Task 5 files**

```powershell
git add packages/renderer/src/index.ts packages/renderer/src/index.test.ts packages/renderer/src/integration.test.ts
git commit -m "feat: render video memes and card layouts"
```

---

### Task 6: Update editor controls and remove the Settings gallery

**Files:**
- Modify: `apps/web/src/screens/SettingsPage.tsx`
- Modify: `apps/web/src/screens/SettingsPage.module.css`
- Modify: `apps/web/src/app/settings-screen.test.tsx`
- Modify: `apps/web/src/screens/EditorPage.tsx`
- Modify: `apps/web/src/screens/EditorPage.test.tsx`
- Modify: `apps/web/src/components/CardMemeEditor.tsx`
- Modify: `apps/web/src/components/CardMemeEditor.test.tsx`
- Modify: `apps/web/src/components/ResourcePicker.tsx`
- Modify: `apps/web/src/components/ResourcePicker.test.tsx`
- Modify: `apps/web/src/screens/ProjectsPage.tsx`
- Modify: `apps/web/src/app/component-flow.test.tsx`
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Consumes: V2 optional fields and `meme-video` resources from Tasks 1-2.
- Produces: intro picker, optional transcript duration, video-meme selection, and no Settings resource gallery.

- [ ] **Step 1: Write failing Settings and editor tests**

Assert Settings has no `MEDIA RESOURCES`, `Thư viện tài nguyên`, thumbnails, or resource audio players, while Template Library remains. In Editor assert:

- intro picker lists `transition-sound` resources;
- enqueue allows blank script;
- blank script shows a range with min 1, max 5, value 3;
- TTS preview is disabled for blank script;
- meme editor selects either `meme-image` or `meme-video` and only requires sound for images;
- video preview uses a `<video>` managed-asset source.
- Projects marks a project with blank cards as ready when every blank card has a valid hold duration.

- [ ] **Step 2: Run web tests and verify RED**

Run: `npm.cmd test -w @reelforge/web`

Expected: resource gallery is present, blank scripts are blocked, and video/intro controls are absent.

- [ ] **Step 3: Remove only the Settings gallery**

Delete `useResources` from Settings, remove `ResourceLibrary`, its section markup, and styles used only by that component. Renumber Template Library from section 04 to 03. Keep resource hooks and API because editor pickers still use them.

- [ ] **Step 4: Add intro and blank-duration editing**

Use `ResourcePicker kind="transition-sound"` for `introSoundPath`. Allow enqueue when cards exist even if scripts are blank. Show `holdSeconds ?? 3` slider only for a blank card and update the card immutably. Keep the preview-TTS button disabled when script is blank.
Import new card images with an empty script instead of the old warning placeholder. Update the Projects readiness summary to treat a blank card with a valid hold as renderable.

- [ ] **Step 5: Support image/video meme selection**

Offer one visual selector spanning `meme-image` and `meme-video`, or two mutually exclusive pickers if that follows the existing component more cleanly. Save exactly one path. Require a sound before applying an image; allow a video with or without sound. Render selected video with `<video playsInline controls>` in meme preview.
Teach `ResourcePicker` to display MP4 resources with `<video muted playsInline preload="metadata">`; keep image and MP3 behavior unchanged.

- [ ] **Step 6: Run web tests and verify GREEN**

Run: `npm.cmd test -w @reelforge/web`

Expected: all web unit tests pass.

- [ ] **Step 7: Commit only Task 6 files**

```powershell
git add apps/web/src/screens/SettingsPage.tsx apps/web/src/screens/SettingsPage.module.css apps/web/src/app/settings-screen.test.tsx apps/web/src/screens/EditorPage.tsx apps/web/src/screens/EditorPage.test.tsx apps/web/src/screens/ProjectsPage.tsx apps/web/src/components/CardMemeEditor.tsx apps/web/src/components/CardMemeEditor.test.tsx apps/web/src/components/ResourcePicker.tsx apps/web/src/components/ResourcePicker.test.tsx apps/web/src/app/component-flow.test.tsx apps/web/src/lib/api.ts
git commit -m "feat: edit intro blank cards and video memes"
```

---

### Task 7: Add direct resize for each card

**Files:**
- Create: `apps/web/src/components/CardLayoutEditor.tsx`
- Create: `apps/web/src/components/CardLayoutEditor.module.css`
- Create: `apps/web/src/components/CardLayoutEditor.test.tsx`
- Modify: `apps/web/src/screens/EditorPage.tsx`
- Modify: `apps/web/src/screens/EditorPage.module.css`
- Modify: `apps/web/src/lib/preview.ts`
- Modify: `apps/web/src/lib/preview.test.ts`

**Interfaces:**
- Consumes: `ProjectCardV2.layout?: NormalizedRect`.
- Produces: `clampCardLayout(rect): NormalizedRect` with minimum width/height `0.1`.
- Produces: pointer-driven size editor with fixed template position and reset-to-template action.

- [ ] **Step 1: Write failing geometry tests**

Use literal normalized inputs. Verify bottom-right resize clamp to the canvas and minimum size:

```ts
expect(clampCardLayout({ x: 0.95, y: 0.95, width: 0.2, height: 0.2 }))
  .toEqual({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 });
expect(clampCardLayout({ x: 0.2, y: 0.2, width: 0.01, height: 0.02 }))
  .toEqual({ x: 0.2, y: 0.2, width: 0.1, height: 0.1 });
```

- [ ] **Step 2: Write failing interaction tests**

Render the layout editor in a fixed-size container. Assert pointer movement on the card body does not call `onChange`. Simulate pointer down/move/up on the resize handle and assert only `width/height` change while `x/y` remain equal to the template slot. Assert reset calls `onReset` and restores template size.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm.cmd test -w @reelforge/web -- preview.test.ts CardLayoutEditor.test.tsx`

Expected: geometry helper and component do not exist.

- [ ] **Step 4: Implement normalized pointer geometry**

Capture the preview bounding rectangle when resizing starts, convert pixel deltas to normalized deltas, clamp every update, and use pointer capture through pointer up/cancel. The card body must not start an interaction. Persist `x/y` from `templateSlot` and only change `width/height`. Do not add a drag-and-drop dependency. The component receives `value`, `templateSlot`, `onChange`, and `onReset`.

- [ ] **Step 5: Integrate with active-card preview**

Use the template slot position plus `activeCard.layout?.width/height` when present. Persist size changes with template `x/y` through the existing `updateCard`/autosave path. Keep meme preview separate; resize is active only in Card mode. Add a visible reset button labeled `Về bố cục template`.

- [ ] **Step 6: Run web tests and verify GREEN**

Run: `npm.cmd test -w @reelforge/web`

Expected: all web tests pass.

- [ ] **Step 7: Commit only Task 7 files**

```powershell
git add apps/web/src/components/CardLayoutEditor.tsx apps/web/src/components/CardLayoutEditor.module.css apps/web/src/components/CardLayoutEditor.test.tsx apps/web/src/screens/EditorPage.tsx apps/web/src/screens/EditorPage.module.css apps/web/src/lib/preview.ts apps/web/src/lib/preview.test.ts
git commit -m "feat: resize cards in preview"
```

---

### Task 8: Verify the complete workflow

**Files:**
- Modify: `apps/web/tests/e2e/reelforge.spec.ts`
- Modify: `README.md`
- Modify: `docs/RESOURCE_LIBRARY.md`
- Modify only if fixture helpers require it: `apps/web/src/test/fixtures.ts`

**Interfaces:**
- Consumes all prior tasks.
- Produces one end-to-end regression and user documentation limited to the four resource folders and new controls.

- [ ] **Step 1: Write the failing E2E workflow**

Cover: create/open project, add two cards, leave one transcript blank at 3 seconds, choose intro/transition/background, select a video meme plus extra sound, resize one card without changing its template position, save/reopen, enqueue, and observe a succeeded job. Assert the saved size and selections survive reopening.

- [ ] **Step 2: Run the focused E2E and verify RED**

Run: `npm.cmd exec -w @reelforge/web playwright test -- tests/e2e/reelforge.spec.ts`

Expected: the new controls/workflow are not yet represented by the existing test.

- [ ] **Step 3: Complete only required fixture wiring and documentation**

Document MP4 support in `stickers`, MP3-only audio folders, intro ordering, blank-card duration, original meme-video audio, optional extra meme sound, and preview resize with fixed template position. Remove documentation that tells users to browse the deleted Settings resource gallery.

- [ ] **Step 4: Run full verification**

Run in order:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

Expected: every command exits 0 with no test failures, type errors, or build errors.

- [ ] **Step 5: Run security verification**

Run: `npm.cmd run test:security`

Expected: secret scan and persistence-boundary tests pass; no API key or unmanaged absolute resource path appears in frontend output, JSON, SQLite, or logs.

- [ ] **Step 6: Commit Task 8 files**

```powershell
git add apps/web/tests/e2e/reelforge.spec.ts apps/web/src/test/fixtures.ts README.md docs/RESOURCE_LIBRARY.md
git commit -m "test: verify flexible media workflow"
```
