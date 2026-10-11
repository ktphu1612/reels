# Manual Media Layout and Intro Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag and aspect-resize cards, meme images, and meme videos while separating Intro Sound into its own MP3 resource folder.

**Architecture:** Extend Project V2 meme variants with an optional normalized layout and add one `intro-sound` resource kind. A shared React `MediaLayoutEditor` consumes pure geometry helpers and persists the same normalized rectangles used by FFmpeg. Existing timing and audio graphs remain unchanged; only meme rectangle selection and intro resource validation change.

**Tech Stack:** Node.js 24, TypeScript strict, React, CSS Modules, Zod, Fastify, node:sqlite, FFmpeg/ffprobe, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-manual-media-layout-intro-resources-design.md`

## Global Constraints

- Keep `schemaVersion: 2`; do not add Project V3 or a legacy migration.
- Remove the current card size/position presets; do not keep two layout-editing systems.
- Use pointer events directly; do not add a drag-and-drop or resize dependency.
- Card images, meme images, and meme videos use the same drag and four-corner resize behavior.
- Resizing preserves intrinsic media aspect ratio, keeps the opposite corner fixed, and keeps the full media rectangle inside the canvas.
- Continue using `contain`; do not add crop, cover, distortion, rotation, opacity, or keyframes.
- Add exactly one source folder, `intro sounds`, containing MP3 only.
- Keep narration, intro/transition timing, meme duration/audio, music ducking, queue behavior, and H.264/AAC output unchanged.
- Do not touch or stage user resource media, Chrome profiles, or `social-post-automation`.
- Every task follows RED → GREEN → refactor and ends with a focused commit.

---

### Task 1: Extend Project V2 and resource contracts

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`

**Interfaces:**
- Produces: `PostCardMeme.layout?: NormalizedRect` on both image and video variants.
- Produces: `MediaResourceKind = ... | 'intro-sound'`.
- Preserves: Project V2, image-meme sound requirement, and video-meme optional sound.

- [ ] **Step 1: Write failing contract tests**

Add literal tests proving image/video meme layouts round-trip and invalid bounds fail:

```ts
const layout = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 };

expect(ProjectV2Schema.parse({
  ...projectFixture,
  cards: [{
    ...projectFixture.cards[0],
    postCardMeme: { imagePath, soundPath, layout },
  }],
}).cards[0]?.postCardMeme).toMatchObject({ layout });

expect(ProjectV2Schema.parse({
  ...projectFixture,
  cards: [{
    ...projectFixture.cards[0],
    postCardMeme: { videoPath, layout },
  }],
}).cards[0]?.postCardMeme).toMatchObject({ layout });

expect(() => ProjectV2Schema.parse({
  ...projectFixture,
  cards: [{
    ...projectFixture.cards[0],
    postCardMeme: {
      videoPath,
      layout: { x: 0.8, y: 0.2, width: 0.3, height: 0.3 },
    },
  }],
})).toThrow();

expect(MediaResourceKindSchema.parse('intro-sound')).toBe('intro-sound');
```

- [ ] **Step 2: Run core tests and verify RED**

Run: `npm.cmd exec -w @reelforge/core -- vitest run src/index.test.ts`

Expected: layout is rejected as an unrecognized meme key and `intro-sound` is not in the enum.

- [ ] **Step 3: Add the minimal schema fields**

Use the existing `CardLayoutSchema` for both variants:

```ts
export const PostCardMemeSchema = z.union([
  z.object({
    imagePath: z.string().min(1),
    soundPath: z.string().min(1),
    layout: CardLayoutSchema.optional(),
  }).strict(),
  z.object({
    videoPath: z.string().min(1),
    soundPath: z.string().min(1).optional(),
    layout: CardLayoutSchema.optional(),
  }).strict(),
]);

export const MediaResourceKindSchema = z.enum([
  'meme-image',
  'meme-video',
  'meme-sound',
  'transition-sound',
  'intro-sound',
  'background-music',
]);
```

- [ ] **Step 4: Run core tests and lint**

Run:

```powershell
npm.cmd test -w @reelforge/core
npm.cmd run lint -w @reelforge/core
```

Expected: all core tests and TypeScript checks pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat: extend meme layout and intro contracts"
```

---

### Task 2: Scan and serve the dedicated intro folder

**Files:**
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/resources.ts`
- Modify: `packages/storage/src/resources.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/index.test.ts`
- Modify: `scripts/security-scan.test.mjs`

**Interfaces:**
- Consumes: `intro-sound` from Task 1.
- Produces: `intro sounds → intro-sound` and managed IDs beginning `intro-sound-`.

- [ ] **Step 1: Write failing resource tests**

Create isolated transition and intro sources:

```ts
const introDirectory = join(directory, 'intro sounds');
const transitionDirectory = join(directory, 'transition sound');
await writeFixture(introDirectory, 'opening.mp3', mp3Bytes(1));
await writeFixture(transitionDirectory, 'whoosh.mp3', mp3Bytes(2));

const inputs = [
  { directory: introDirectory, kind: 'intro-sound' as const },
  { directory: transitionDirectory, kind: 'transition-sound' as const },
];
await resources.seedDirectories(inputs);

expect((await resources.list('intro-sound')).map((item) => item.name))
  .toEqual(['opening.mp3']);
expect((await resources.list('transition-sound')).map((item) => item.name))
  .toEqual(['whoosh.mp3']);
```

Delete `opening.mp3`, rescan, and assert only its intro manifest disappears. Add an intro WAV fixture and assert it appears in `errors`, not resources.

- [ ] **Step 2: Write the failing server startup test**

Extend the server fixture:

```ts
await mkdir(join(sourceRoot, 'intro sounds'), { recursive: true });
await writeFile(join(sourceRoot, 'intro sounds', 'opening.mp3'), mp3Bytes());
```

Assert six seeded resources and both distinct kinds, `intro-sound` and `transition-sound`.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm.cmd exec -w @reelforge/storage -- vitest run src/resources.test.ts
npm.cmd exec -w @reelforge/server -- vitest run src/index.test.ts
```

Expected: intended-use/resource-ID parsing rejects `intro-sound` and startup does not scan the fifth folder.

- [ ] **Step 4: Implement the pipeline**

Add `'intro-sound'` to `AssetIntendedUse` and extend the resource ID parser:

```ts
const match = /^(meme-image|meme-video|meme-sound|transition-sound|intro-sound|background-music)-[a-f0-9]{64}$/.exec(value);
```

Add startup mapping:

```ts
{ directory: resolve(resourceSourceDirectory, 'intro sounds'), kind: 'intro-sound' },
```

Audio matching remains MP3-only. Add the intro source directory to security-scan fixture coverage so raw source paths remain forbidden.

- [ ] **Step 5: Run storage/server/packaging checks**

```powershell
npm.cmd test -w @reelforge/storage
npm.cmd test -w @reelforge/server
npm.cmd run test:packaging
npm.cmd run lint -w @reelforge/storage
npm.cmd run lint -w @reelforge/server
```

Expected: all commands exit 0 and stale intro cleanup leaves transitions intact.

- [ ] **Step 6: Commit Task 2**

```powershell
git add packages/storage/src/index.ts packages/storage/src/resources.ts packages/storage/src/resources.test.ts apps/server/src/index.ts apps/server/src/index.test.ts scripts/security-scan.test.mjs
git commit -m "feat: add dedicated intro sound resources"
```

---

### Task 3: Build pure aspect-preserving geometry

**Files:**
- Create: `apps/web/src/lib/mediaLayout.ts`
- Create: `apps/web/src/lib/mediaLayout.test.ts`
- Modify: `apps/web/src/lib/preview.ts`
- Modify: `apps/web/src/lib/preview.test.ts`

**Interfaces:**
- Consumes: `NormalizedRect` and `PreviewCanvas` from `preview.ts`.
- Produces:

```ts
export interface MediaDimensions { width: number; height: number }
export type ResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface NormalizedPoint { x: number; y: number }

export function fitMediaToSlot(
  slot: NormalizedRect,
  media: MediaDimensions,
  canvas: PreviewCanvas,
): NormalizedRect | undefined;

export function moveMediaLayout(
  rect: NormalizedRect,
  delta: NormalizedPoint,
): NormalizedRect;

export function resizeMediaLayout(
  rect: NormalizedRect,
  corner: ResizeCorner,
  pointer: NormalizedPoint,
  media: MediaDimensions,
  canvas: PreviewCanvas,
): NormalizedRect;
```

- [ ] **Step 1: Write failing fit and move tests**

Use canvas `360×640`, slot `{x:.05,y:.38,width:.9,height:.25}`, and portrait media `600×1000`:

```ts
expect(fitMediaToSlot(slot, { width: 600, height: 1000 }, canvas)).toEqual({
  x: expect.closeTo(0.366666, 5),
  y: expect.closeTo(0.38, 5),
  width: expect.closeTo(0.266666, 5),
  height: expect.closeTo(0.25, 5),
});
```

Assert move clamping on all edges without size change. Assert `undefined` for zero, negative, NaN, and extreme ratios that cannot fit both normalized dimensions at `0.1`.

- [ ] **Step 2: Write failing four-corner resize tests**

For every corner assert the opposite corner is fixed, physical aspect equals `media.width/media.height`, bounds stay within `0..1`, and both dimensions remain at least `0.1`. Include one pointer beyond the canvas and one near the fixed corner.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm.cmd exec -w @reelforge/web -- vitest run src/lib/mediaLayout.test.ts src/lib/preview.test.ts`

Expected: the module is missing and preset exports remain.

- [ ] **Step 4: Implement geometry while preserving current consumers**

Keep `CARD_SIZE_PRESETS`, `CARD_POSITION_PRESETS`, `getCardLayoutForPreset`, and inference helpers in `preview.ts` until Task 5 migrates EditorPage and deletes the old component. Task 3 must remain independently lintable.

Use:

```ts
const normalizedAspect =
  (media.width / media.height) * (canvas.height / canvas.width);
```

Fit and center the largest aspect-correct rectangle in the slot. Return `undefined` unless finite dimensions fit both `0.1` minimums.

For resize, project the pointer vector from the fixed opposite corner:

```ts
const pixelAspect = media.width / media.height;
const deltaWidthPx = Math.abs(pointer.x - fixed.x) * canvas.width;
const deltaHeightPx = Math.abs(pointer.y - fixed.y) * canvas.height;
const projectedHeightPx = (
  deltaWidthPx * pixelAspect + deltaHeightPx
) / (pixelAspect * pixelAspect + 1);
const projectedWidthPx = pixelAspect * projectedHeightPx;
```

Convert back to normalized dimensions, clamp to minimum/canvas maximum, then reconstruct `x/y` from the fixed corner.

- [ ] **Step 5: Run focused tests and lint**

```powershell
npm.cmd exec -w @reelforge/web -- vitest run src/lib/mediaLayout.test.ts src/lib/preview.test.ts
npm.cmd run lint -w @reelforge/web
```

- [ ] **Step 6: Commit Task 3**

```powershell
git add apps/web/src/lib/mediaLayout.ts apps/web/src/lib/mediaLayout.test.ts apps/web/src/lib/preview.ts apps/web/src/lib/preview.test.ts
git commit -m "feat: add aspect-preserving media geometry"
```

---

### Task 4: Replace preset UI with a shared media layout editor

**Files:**
- Create: `apps/web/src/components/MediaLayoutEditor.tsx`
- Create: `apps/web/src/components/MediaLayoutEditor.module.css`
- Create: `apps/web/src/components/MediaLayoutEditor.test.tsx`

**Interfaces:**
- Consumes Task 3 geometry.
- Produces:

```ts
export interface MediaLayoutEditorProps {
  kind: 'image' | 'video';
  src: string;
  accessibleName: string;
  value?: NormalizedRect;
  templateSlot: NormalizedRect;
  canvas: PreviewCanvas;
  videoControls?: boolean;
  onChange(next: NormalizedRect): void;
  onReset(): void;
}
```

- [ ] **Step 1: Write failing media-load tests**

Render image and video variants. Fire image `load` with mocked `naturalWidth/naturalHeight` and video `loadedMetadata` with mocked `videoWidth/videoHeight`.

Assert supplied `value` is used, missing `value` fits intrinsic media inside the template slot, invalid metadata shows `Không đọc được kích thước media để chỉnh bố cục.` and no handles, image remains `contain`, and video keeps controls when requested.

- [ ] **Step 2: Write failing pointer tests**

Mock the canvas rect as `360×640`. Assert body drag calls `moveMediaLayout`; four handles have labels `Resize top-left`, `Resize top-right`, `Resize bottom-left`, `Resize bottom-right`; pointer move calls `resizeMediaLayout`; pointer up/cancel releases capture; reset calls `onReset`; and no preset groups remain.

- [ ] **Step 3: Run component tests and verify RED**

Run: `npm.cmd exec -w @reelforge/web -- vitest run src/components/MediaLayoutEditor.test.tsx`

Expected: `MediaLayoutEditor` does not exist.

- [ ] **Step 4: Implement the component**

Render a full-canvas editor, one aspect-correct target, four corner buttons, and reset. Store only intrinsic dimensions and active interaction. On pointer down capture canvas bounds/start layout; on move convert client coordinates to normalized points and call Task 3 helpers.

Use `touch-action: none` on target/handles. Do not attach drag behavior to reset or native video controls.

- [ ] **Step 5: Keep the old component until consumer migration**

Do not delete `CardLayoutEditor` yet because EditorPage still imports it. Task 5 replaces that consumer, then removes the old component and preset API in one buildable commit.

```powershell
npm.cmd exec -w @reelforge/web -- vitest run src/components/MediaLayoutEditor.test.tsx
npm.cmd run lint -w @reelforge/web
```

Expected: new component tests and full web lint pass while the old component remains temporarily available.

- [ ] **Step 6: Commit Task 4**

```powershell
git add apps/web/src/components/MediaLayoutEditor.tsx apps/web/src/components/MediaLayoutEditor.module.css apps/web/src/components/MediaLayoutEditor.test.tsx
git commit -m "feat: add shared manual media layout editor"
```

---

### Task 5: Persist independent card and meme layouts in Editor

**Files:**
- Modify: `apps/web/src/screens/EditorPage.tsx`
- Modify: `apps/web/src/screens/EditorPage.module.css`
- Modify: `apps/web/src/screens/EditorPage.test.tsx`
- Modify: `apps/web/src/components/CardMemeEditor.tsx`
- Modify: `apps/web/src/components/CardMemeEditor.test.tsx`
- Modify: `apps/web/src/lib/preview.ts`
- Modify: `apps/web/src/lib/preview.test.ts`
- Delete: `apps/web/src/components/CardLayoutEditor.tsx`
- Delete: `apps/web/src/components/CardLayoutEditor.module.css`
- Delete: `apps/web/src/components/CardLayoutEditor.test.tsx`

**Interfaces:**
- Consumes optional meme layout from Task 1 and `MediaLayoutEditor` from Task 4.
- Produces card `layout` and `postCardMeme.layout` through existing autosave.
- Preserves blank-card/TTS guards and media/audio selection.

- [ ] **Step 1: Write failing CardMemeEditor tests**

Applying sound changes to the same visual path preserves `value.layout`:

```ts
expect(onApply).toHaveBeenCalledWith({
  videoPath,
  soundPath,
  layout: existingLayout,
});
```

Changing the image/video path omits the old layout because its aspect no longer applies.

- [ ] **Step 2: Write failing Editor tests**

Assert:

- Card mode passes card media, `card.layout`, and `template.cardSlot` to `MediaLayoutEditor`.
- Meme mode passes image/video media, `postCardMeme.layout`, and `template.memeSlot`.
- Card drag updates only active-card `layout`.
- Meme drag updates only active-card `postCardMeme.layout`.
- Card reset removes `card.layout`.
- Meme reset removes only meme `layout`, preserving visual and sound.
- Save/reopen restores both layouts.
- Template changes preserve explicit normalized layouts; visuals without overrides use new template slots.
- Intro Sound picker filters `intro-sound` while Transition Sound continues filtering `transition-sound`.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm.cmd exec -w @reelforge/web -- vitest run src/components/CardMemeEditor.test.tsx src/screens/EditorPage.test.tsx
```

Expected: meme layout wiring and shared editor integration are absent.

- [ ] **Step 4: Integrate both preview modes**

Replace `CardLayoutEditor` with `MediaLayoutEditor`. Add:

```ts
const updateMemeLayout = (layout: NormalizedRect) => {
  if (!activeCard?.postCardMeme) return;
  updateCard(activeCard.id, (card) => ({
    ...card,
    postCardMeme: { ...card.postCardMeme!, layout },
  }));
};

const resetMemeLayout = () => {
  if (!activeCard?.postCardMeme) return;
  updateCard(activeCard.id, (card) => {
    const meme = card.postCardMeme!;
    const { layout: _layout, ...withoutLayout } = meme;
    return { ...card, postCardMeme: withoutLayout };
  });
};
```

Pass `videoControls` for meme videos and keep preview audio available through native controls. Preserve a meme layout in `CardMemeEditor.apply` only when the chosen visual path is unchanged.

Replace the current template-change preset inference/recomputation. Explicit manual card and meme rectangles remain unchanged normalized coordinates; only visuals without explicit layouts read the new template slots.

After EditorPage no longer imports the old component, delete all three `CardLayoutEditor` files. Remove `CARD_SIZE_PRESETS`, `CARD_POSITION_PRESETS`, `getCardLayoutForPreset`, and both inference helpers from `preview.ts`, and remove their obsolete tests from `preview.test.ts`.

Change only the Intro picker to `kind="intro-sound"`. Leave the project transition picker on `kind="transition-sound"`.

- [ ] **Step 5: Run full web unit tests and lint**

```powershell
npm.cmd test -w @reelforge/web
npm.cmd run lint -w @reelforge/web
```

Expected: all web tests pass and pending-voice guards remain green.

- [ ] **Step 6: Commit Task 5**

```powershell
git add apps/web/src/screens/EditorPage.tsx apps/web/src/screens/EditorPage.module.css apps/web/src/screens/EditorPage.test.tsx apps/web/src/components/CardMemeEditor.tsx apps/web/src/components/CardMemeEditor.test.tsx apps/web/src/lib/preview.ts apps/web/src/lib/preview.test.ts apps/web/src/components/CardLayoutEditor.tsx apps/web/src/components/CardLayoutEditor.module.css apps/web/src/components/CardLayoutEditor.test.tsx
git commit -m "feat: edit card and meme layouts manually"
```

---

### Task 6: Render per-meme layouts and validate intro resources

**Files:**
- Modify: `packages/renderer/src/index.ts`
- Modify: `packages/renderer/src/index.test.ts`
- Modify: `packages/renderer/src/integration.test.ts`

**Interfaces:**
- Consumes `postCardMeme.layout` and `intro-sound` from Task 1.
- Produces `layout?: NormalizedRect` on both render meme inputs.
- Resolves `meme.layout ?? request.memeSlot ?? DEFAULT_MEME_SLOT` per card.

- [ ] **Step 1: Write failing graph tests**

Build image/video meme inputs with layouts `{x:.05,y:.1,width:.4,height:.3}` and `{x:.5,y:.55,width:.45,height:.4}` at `720×1280`:

```ts
expect(command.filterGraph).toContain('scale=288:384:force_original_aspect_ratio=decrease');
expect(command.filterGraph).toContain('overlay=x=36:y=128');
expect(command.filterGraph).toContain('scale=324:512:force_original_aspect_ratio=decrease');
expect(command.filterGraph).toContain('overlay=x=360:y=704');
```

Add a no-layout meme and assert fallback to `request.memeSlot`.

- [ ] **Step 2: Write failing preparation/preflight tests**

Assert project meme layouts are copied into both render variants. Assert collected assets classify:

```ts
expect(introAsset.resourceKind).toBe('intro-sound');
expect(transitionAsset.resourceKind).toBe('transition-sound');
```

Prove a transition resource manifest cannot satisfy an intro path.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm.cmd exec -w @reelforge/renderer -- vitest run src/index.test.ts src/integration.test.ts`

Expected: meme layouts are dropped/global and intro expects `transition-sound`.

- [ ] **Step 4: Implement per-meme rectangles**

Add `layout?: NormalizedRect` to image/video render meme interfaces and copy project layout during preparation.

Inside the meme loop:

```ts
const memeRect = pixelRect(
  meme.layout ?? request.memeSlot ?? DEFAULT_MEME_SLOT,
  width,
  height,
);
```

Use `memeRect` for that meme's scale, pad, and overlay; remove the global pre-pixelized meme rectangle. Add `intro-sound` to `SelectedResourceKind` and classify `project.introSoundPath` accordingly.

- [ ] **Step 5: Run renderer tests and lint**

```powershell
npm.cmd test -w @reelforge/renderer
npm.cmd run lint -w @reelforge/renderer
```

Expected: original video audio, optional extra sound, freeze hold, timing, and gameplay mute remain green.

- [ ] **Step 6: Commit Task 6**

```powershell
git add packages/renderer/src/index.ts packages/renderer/src/index.test.ts packages/renderer/src/integration.test.ts
git commit -m "feat: render independent meme layouts"
```

---

### Task 7: Verify workflow and update documentation

**Files:**
- Modify: `apps/web/tests/e2e/reelforge.spec.ts`
- Modify: `README.md`
- Modify: `docs/RESOURCE_LIBRARY.md`
- Modify only if required: `apps/web/src/test/fixtures.ts`

**Interfaces:**
- Consumes all earlier tasks.
- Produces one E2E regression for manual card/meme layouts and separate intro/transition resources.

- [ ] **Step 1: Run the existing E2E and verify RED**

Run: `npm.cmd run test:e2e -w @reelforge/web -- --workers=1`

Expected: the existing E2E fails because it still queries removed preset controls. This proves the old workflow no longer represents the product.

- [ ] **Step 2: Update E2E resource fixtures**

Use:

```ts
{ schemaVersion: 1, id: 'intro-one', name: 'Intro.mp3', kind: 'intro-sound', assetPath: managed.intro }
```

Keep transition as `transition-sound`.

- [ ] **Step 3: Replace the stale flow with direct manipulation**

Replace preset clicks with card drag and corner resize; switch to Meme mode; apply a meme video; drag and resize it; save/reopen; assert both layouts persist; reset both to fitted template placement; select distinct Intro/Transition resources; enqueue and observe `Đã hoàn tất`. Assert preset groups `Kích thước card` and `Vị trí card` do not exist.

- [ ] **Step 4: Run focused E2E and verify GREEN**

Run: `npm.cmd run test:e2e -w @reelforge/web -- --workers=1`

Expected: the rewritten workflow passes with card and meme layouts persisted.

- [ ] **Step 5: Update documentation**

Document exactly five resource folders, MP3-only `intro sounds`, separate pickers, four-corner aspect-preserving resize, drag positioning, reset, and card/image-meme/video-meme parity. Remove all preset instructions.

- [ ] **Step 6: Run full verification**

```powershell
npm.cmd run test:e2e -w @reelforge/web -- --workers=1
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run test:security
```

Expected: E2E passes; all workspace/packaging tests pass; strict TypeScript and production build pass; security reports zero violations.

- [ ] **Step 7: Commit Task 7**

```powershell
git add apps/web/tests/e2e/reelforge.spec.ts apps/web/src/test/fixtures.ts README.md docs/RESOURCE_LIBRARY.md
git commit -m "test: verify manual media layout workflow"
```

---

## Dependency and review order

1. Task 1 is the contract gate.
2. Tasks 2 and 3 are independent after Task 1.
3. Task 4 depends on Task 3.
4. Task 5 depends on Tasks 1 and 4.
5. Task 6 depends on Task 1 and is independent of Tasks 3–5.
6. Task 7 begins only after Tasks 2, 5, and 6 pass task reviews.

Each task receives an independent spec/code-quality review before dependents begin. Review fixes receive scoped re-review. After Task 7, run one whole-branch review against this plan and its linked spec.
