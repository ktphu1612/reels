# Rich Transitions, Background Audio, and Reliable TTS Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-card paired meme inserts, one project-wide transition sound, continuous selectable background music, remove the fixed template sticker, and make 0.5x–2.0x TTS speed reliable for every provider/model.

**Architecture:** Migrate projects and templates to canonical v2 contracts, add an app-managed media-resource catalog, and construct a probed event timeline before rendering. Provider TTS is cached at 1.0x, local FFmpeg creates speed-adjusted narration, and the renderer mixes timed narration, meme sounds, transition sounds, and ducked looping music.

**Tech Stack:** Node.js 24, TypeScript strict, npm workspaces, React/Vite, Fastify, Zod, `node:sqlite` WAL, bundled FFmpeg/ffprobe, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-rich-transitions-audio-speed-design.md`

## Global Constraints

- Read the spec completely before implementation and preserve every accepted timeline rule.
- Follow strict red-green-refactor TDD for each behavioral change; observe the named test fail before production edits.
- Preserve the existing uncommitted queue-response fix in `apps/server/src/app.ts` and `apps/server/src/app.test.ts`; do not overwrite or revert it.
- Fixed template stickers are removed from import, preview, contracts, and rendering. Legacy sticker assets stay on disk and are never deleted by migration.
- A post-card meme is always an image/sound pair, and its visual duration equals the probed meme-sound duration within one 30 fps frame.
- One optional transition sound belongs to the project and is reused before narration for cards 2..N. Card 1 has none; no transition follows the last card.
- A card becomes visible when its leading transition starts. Narration begins only after that transition ends.
- Optional background music starts at zero, loops through the complete timeline at one fixed internal mix level, and is ducked under foreground audio.
- TTS speed is 0.5x–2.0x and is applied locally with FFmpeg to cached 1.0x provider audio for every provider/model, including `eleven_v3`.
- Gameplay audio remains muted. Output remains H.264/AAC, 720x1280, 30 fps, CRF 20, yuv420p, faststart.
- Resource source paths and API keys must never enter projects, SQLite, frontend responses, cache keys, or logs.
- Resource source folders are scanned non-recursively and idempotently; source files are never modified or deleted.
- Bind only to `127.0.0.1`; retain Windows/local single-user behavior and bundled FFmpeg/ffprobe.

---

### Task 0: Preserve and commit the approved queue-response fix

**Files:**
- Existing modified: `apps/server/src/app.ts`
- Existing modified: `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: Current working-tree fix that strips `outputPath`, `cancelRequested`, and `cleanupPendingPaths` before validating a public job with `RenderJobSchema`.
- Produces: A clean baseline commit before feature work starts.

- [ ] **Step 1: Inspect only the two approved changes and the complete working tree**

Run:

```powershell
git status --short
git diff -- apps/server/src/app.ts apps/server/src/app.test.ts
```

Expected: only the diagnosed public-job response fix appears in those two tracked files; the user-provided media folders/video remain untracked and untouched.

- [ ] **Step 2: Re-run the focused regression test**

Run:

```powershell
npm.cmd test --workspace @reelforge/server -- --run apps/server/src/app.test.ts
```

Expected: the server suite passes and the enqueue response parses with strict `RenderJobSchema`.

- [ ] **Step 3: Commit only the queue-response fix**

```powershell
git add apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "fix: publish contract-compatible queue jobs"
```

Do not add `FDown.vn_Tai_video_Facebook_720p (HD)_2d74.mp4` or any resource folder.

---

### Task 1: Add v2 project/template contracts and backward migrations

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/sse.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/screens/EditorPage.tsx`
- Modify: `apps/web/src/screens/EditorPage.test.tsx`
- Modify: `apps/web/src/screens/ProjectsPage.tsx`
- Modify: `apps/web/src/screens/SettingsPage.tsx`
- Modify: `apps/web/src/test/fixtures.ts`
- Modify: `apps/web/tests/e2e/reelforge.spec.ts`
- Modify: `apps/worker/src/runtime.test.ts`
- Modify: `apps/worker/src/worker.stress.test.ts`
- Modify: `packages/queue/src/index.ts`
- Modify: `packages/queue/src/index.test.ts`
- Modify: `packages/renderer/src/index.ts`
- Modify: `packages/renderer/src/index.test.ts`
- Modify: `packages/renderer/src/integration.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/index.test.ts`

**Interfaces:**
- Consumes: Existing `ProjectV1Schema`, `TemplateManifestV1Schema`, normalized layout rectangles, and render-job snapshots.
- Produces: `PostCardMemeSchema`, `BackgroundMusicSettingsSchema`, `ProjectV2Schema`, `TemplateManifestV2Schema`, `MediaResourceV1Schema`, canonical `Project`, `ProjectCard`, `TemplateManifest`, and migration functions returning v2 objects.

- [ ] **Step 1: Write failing contract tests**

Add literal fixtures and assertions covering these breaks:

```ts
it('migrates project v1 to v2 without inventing audio or meme selections', () => {
  const migrated = migrateProject(projectV1Fixture());
  expect(migrated).toMatchObject({
    schemaVersion: 2,
    transitionSoundPath: undefined,
    backgroundMusicPath: undefined,
  });
  expect(migrated.cards.every((card) => card.postCardMeme === undefined)).toBe(true);
});

it('requires a complete post-card meme pair and bounds project speed', () => {
  expect(() => ProjectV2Schema.parse(projectV2Fixture({
    cards: [{ ...cardV2Fixture(), postCardMeme: { imagePath: 'assets/meme.png' } }],
  }))).toThrow();
  expect(() => ProjectV2Schema.parse(projectV2Fixture({
    tts: { ...projectV2Fixture().tts, speakingRate: 0.49 },
  }))).toThrow();
  expect(() => ProjectV2Schema.parse(projectV2Fixture({
    tts: { ...projectV2Fixture().tts, speakingRate: 2.01 },
  }))).toThrow();
});

it('drops a legacy fixed sticker while preserving its slot as the meme slot', () => {
  const migrated = migrateTemplateManifest(templateV1Fixture({
    stickerPath: 'assets/legacy.png',
    stickerSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
  }));
  expect(migrated).toMatchObject({
    schemaVersion: 2,
    memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
  });
  expect(migrated).not.toHaveProperty('stickerPath');
});

it('normalizes legacy render-job snapshots to canonical v2 contracts', () => {
  const job = RenderJobSchema.parse(renderJobWithV1SnapshotFixture());
  expect(job.snapshot.project.schemaVersion).toBe(2);
  expect(job.snapshot.template.schemaVersion).toBe(2);
});
```

- [ ] **Step 2: Run core tests and confirm the intended RED failures**

Run:

```powershell
npm.cmd test --workspace @reelforge/core
```

Expected: failures name missing v2 schemas/migration behavior, not fixture syntax errors.

- [ ] **Step 3: Implement canonical schemas and migrations**

Use these exact public shapes:

```ts
export const PostCardMemeSchema = z.object({
  imagePath: z.string().min(1),
  soundPath: z.string().min(1),
}).strict();

export const ProjectCardV2Schema = z.object({
  id: z.string().min(1),
  imagePath: z.string().min(1),
  script: z.string().min(1),
  order: z.number().int().nonnegative(),
  postCardMeme: PostCardMemeSchema.optional(),
}).strict();

export const ProjectV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  name: z.string().min(1),
  templateId: z.string().min(1),
  tts: ProjectTtsSettingsSchema.extend({
    speakingRate: z.number().min(0.5).max(2),
  }).strict(),
  output: OutputSettingsSchema.default(DEFAULT_OUTPUT),
  transitionSoundPath: z.string().min(1).optional(),
  backgroundMusicPath: z.string().min(1).optional(),
  cards: z.array(ProjectCardV2Schema),
}).strict();

export const TemplateManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  name: z.string().min(1),
  backgroundPath: z.string().min(1),
  thumbnailPath: z.string().min(1).optional(),
  canvas: TemplateCanvasSchema,
  cardSlot: NormalizedRectSchema.default(DEFAULT_CARD_SLOT),
  memeSlot: NormalizedRectSchema.default(DEFAULT_MEME_SLOT),
}).strict();

export const MediaResourceKindSchema = z.enum([
  'meme-image',
  'meme-sound',
  'transition-sound',
  'background-music',
]);

export const MediaResourceV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  kind: MediaResourceKindSchema,
  assetPath: z.string().min(1),
}).strict();
```

Keep legacy v1 schemas for parsing only. `migrateProject`, `migrateTemplateManifest`, and render-snapshot parsing must always return canonical v2 values. Export canonical aliases named `Project`, `ProjectCard`, `TemplateManifest`, and `RenderJobSnapshot`; update downstream imports without changing behavior yet.

Add `DEFAULT_MEME_SLOT` with the old normalized coordinates. Keep `DEFAULT_STICKER_SLOT` only as a deprecated migration alias while v1 template fixtures are parsed; no canonical v2 renderer/UI code may reference it.

Update every typed fixture listed in this task to canonical `schemaVersion: 2`, `memeSlot`, and no fixed sticker. Keep dedicated literal v1 fixtures only in migration tests. This task is a contract migration only: project transition/background values remain absent and card meme values remain absent in all existing behavior fixtures.

- [ ] **Step 4: Run core tests and workspace type checks**

```powershell
npm.cmd test --workspace @reelforge/core
npm run lint
npm.cmd test
```

Expected: all contract tests, strict TypeScript checks, and unchanged workspace behavior pass against canonical v2 fixtures.

- [ ] **Step 5: Commit the contract migration**

```powershell
git add packages/core/src/index.ts packages/core/src/index.test.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/sse.test.ts apps/web/src/lib/api.ts apps/web/src/screens/EditorPage.tsx apps/web/src/screens/EditorPage.test.tsx apps/web/src/screens/ProjectsPage.tsx apps/web/src/screens/SettingsPage.tsx apps/web/src/test/fixtures.ts apps/web/tests/e2e/reelforge.spec.ts apps/worker/src/runtime.test.ts apps/worker/src/worker.stress.test.ts packages/queue/src/index.ts packages/queue/src/index.test.ts packages/renderer/src/index.ts packages/renderer/src/index.test.ts packages/renderer/src/integration.test.ts packages/storage/src/index.ts packages/storage/src/index.test.ts
git commit -m "feat: add v2 media timeline contracts"
```

Review staged files first so generated media and user resources are not included.

---

### Task 2: Add managed audio assets and the resource catalog

**Files:**
- Create: `packages/storage/src/resources.ts`
- Create: `packages/storage/src/resources.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/index.test.ts`

**Interfaces:**
- Consumes: `MediaResourceKind`, `MediaResourceV1Schema`, `AssetStore`, `AppPaths`, atomic JSON writes, and managed-path validation.
- Produces: MP3-aware `AssetStore`, read-only `ResourceStore`, `SeedResourceDirectory`, and `AppPaths.resources`.

- [ ] **Step 1: Write failing storage tests**

Cover actual behavior with PNG/JPEG/MP3 fixtures:

```ts
it('imports audio by content hash and rejects audio used as a meme image', async () => {
  const mp3 = await writeMp3Fixture(root, 'effect.mp3');
  const imported = await assets.importFile(mp3, 'meme-sound');
  expect(imported).toMatchObject({
    relativePath: expect.stringMatching(/^assets\/[a-f0-9]{64}\.mp3$/),
    mediaKind: 'audio',
  });
  await expect(assets.importFile(mp3, 'meme-image')).rejects.toMatchObject({
    payload: { code: 'INVALID_INPUT' },
  });
});

it('seeds a directory idempotently without recursing or storing source paths', async () => {
  const first = await resources.seedDirectories([
    { directory: memeSoundDirectory, kind: 'meme-sound' },
  ]);
  const second = await resources.seedDirectories([
    { directory: memeSoundDirectory, kind: 'meme-sound' },
  ]);
  expect(first.resources).toHaveLength(2);
  expect(second.resources).toEqual(first.resources);
  expect(first.errors).toEqual([]);
  expect(second.errors).toEqual([]);
  expect(JSON.stringify(await resources.list())).not.toContain(memeSoundDirectory);
});

it('keeps valid seeded resources when a sibling file is invalid', async () => {
  const result = await resources.seedDirectories([
    { directory: seedDirectory, kind: 'meme-image' },
  ]);
  expect(result.resources).toHaveLength(1);
  expect(result.errors).toEqual([{ name: 'broken.png', code: 'INVALID_INPUT' }]);
});
```

- [ ] **Step 2: Run storage tests and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/storage
```

Expected: failures identify missing audio detection, resource path, and catalog methods.

- [ ] **Step 3: Extend asset detection and app paths**

Use these unions:

```ts
export type AssetIntendedUse =
  | 'background'
  | 'card'
  | 'thumbnail'
  | 'meme-image'
  | 'meme-sound'
  | 'transition-sound'
  | 'background-music';

export type MediaKind = 'image' | 'video' | 'audio';
```

Recognize MP3 (`ID3` or MPEG frame sync) by bytes, require the matching `.mp3` extension, and map only audio intended uses to `audio`. Add `resources` to `createAppPaths()` and `ensureAppDirectories()`.

- [ ] **Step 4: Implement `ResourceStore`**

```ts
export interface SeedResourceDirectory {
  readonly directory: string;
  readonly kind: MediaResourceKind;
}

export interface SeedResourceResult {
  readonly resources: readonly MediaResourceV1[];
  readonly errors: readonly { readonly name: string; readonly code: 'INVALID_INPUT' }[];
}

export class ResourceStore {
  constructor(private readonly paths: AppPaths, private readonly assets: AssetStore) {}
  list(kind?: MediaResourceKind): Promise<MediaResourceV1[]>;
  get(id: string): Promise<MediaResourceV1>;
  seedDirectories(inputs: readonly SeedResourceDirectory[]): Promise<SeedResourceResult>;
}
```

Derive a deterministic ID as `${kind}-${sha256}`. Write one atomic manifest at `resources/<id>/resource.json`. Sort list results by `kind`, then `name`, then `id`. Scan only direct files and return sanitized per-file errors while continuing valid imports.

- [ ] **Step 5: Run storage tests**

```powershell
npm.cmd test --workspace @reelforge/storage
```

Expected: all storage tests pass without writing outside temporary test roots.

- [ ] **Step 6: Commit storage/catalog support**

```powershell
git add packages/storage
git commit -m "feat: add managed media resource catalog"
```

---

### Task 3: Expose and seed the resource library through the local API

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/index.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `ResourceStore`, `MediaResourceKindSchema`, asset multipart collection, and `assetUrl()`.
- Produces: read-only `GET /api/resources`, startup seeding, and typed web API method `listResources()`.

- [ ] **Step 1: Write failing API tests**

```ts
it('lists public managed resources without source paths', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/resources?kind=meme-sound' })).json())
    .toMatchObject({ resources: [{ kind: 'meme-sound', name: 'Klonk' }] });
});

it('serves mp3 assets with byte ranges and the correct content type', async () => {
  const mp3 = await requestImportedAsset('meme-sound', 'bytes=0-2');
  expect(mp3.statusCode).toBe(206);
  expect(mp3.headers['content-type']).toBe('audio/mpeg');
  expect(mp3.headers['content-range']).toMatch(/^bytes 0-2\//);
});
```

Add an index test with a temporary seed root containing one file per category. Assert two startup calls produce one catalog record per file, not duplicates.

- [ ] **Step 2: Run server and web API tests and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/server
npm.cmd test --workspace @reelforge/web -- --run src/lib/api.test.ts
```

Expected: missing dependency/routes/MIME/API client methods cause the failures.

- [ ] **Step 3: Add resource dependencies and routes**

Extend `ServerDependencies` with `resources: ResourceStore`. Implement:

```ts
app.get('/api/resources', async (request) => {
  const { kind } = parse(ResourceListQuerySchema, request.query);
  return { resources: await dependencies.resources.list(kind) };
});

```

Add `.mp3 -> audio/mpeg` to `assetContentType()`.

- [ ] **Step 4: Seed the four launch-directory folders**

Add an optional `resourceSourceDirectory` argument to `createDefaultServer()` and call:

```ts
await resources.seedDirectories([
  { directory: resolve(resourceSourceDirectory, 'stickers'), kind: 'meme-image' },
  { directory: resolve(resourceSourceDirectory, 'meme sounds'), kind: 'meme-sound' },
  { directory: resolve(resourceSourceDirectory, 'transition sound'), kind: 'transition-sound' },
  { directory: resolve(resourceSourceDirectory, 'background audio'), kind: 'background-music' },
]);
```

Missing directories are skipped. Log only resource names and structured codes for invalid files; never log source absolute paths.

- [ ] **Step 5: Add typed web API methods**

```ts
listResources(kind?: MediaResourceKind): Promise<MediaResourceV1[]>;
```

Validate all responses with `MediaResourceV1Schema` before returning them to React.

- [ ] **Step 6: Run focused tests and security scan**

```powershell
npm.cmd test --workspace @reelforge/server
npm.cmd test --workspace @reelforge/web -- --run src/lib/api.test.ts
npm run test:security
```

Expected: API, range serving, idempotent seed, typed client, and secret/path checks pass.

- [ ] **Step 7: Commit API and bootstrap support**

```powershell
git add apps/server apps/web/src/lib
git commit -m "feat: expose local media resource library"
```

---

### Task 4: Make speaking speed model-independent with local FFmpeg

**Files:**
- Create: `packages/renderer/src/audio-speed.ts`
- Create: `packages/renderer/src/audio-speed.test.ts`
- Modify: `packages/renderer/src/index.ts`
- Modify: `packages/renderer/src/integration.test.ts`
- Create: `packages/tts/src/speed.ts`
- Create: `packages/tts/src/speed.test.ts`
- Modify: `packages/tts/src/elevenlabs.ts`
- Modify: `packages/tts/src/index.test.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: bundled FFmpeg resolver/process ownership, cached TTS entries, preview endpoint, worker job workspace, cancellation signal.
- Produces: `createBaseSynthesisRequest()` from `@reelforge/tts` and `prepareAudioAtSpeed()` from `@reelforge/renderer`, used by both preview and worker render paths.

- [ ] **Step 1: Write failing speed and adapter tests**

```ts
it.each([
  [0.5, 4],
  [1, 2],
  [2, 1],
])('changes a two-second input at %sx to %s seconds', async (rate, expected) => {
  const output = await prepareAudioAtSpeed(inputWav, outputWav, rate, testProcessOptions());
  const probe = await probeMedia(output, testProbeOptions());
  expect(selectAudioDurationSeconds(probe)).toBeCloseTo(expected, 1);
});

it('normalizes paid synthesis to 1x and preserves requested local rate', () => {
  expect(createBaseSynthesisRequest(requestFixture({ speakingRate: 1.8 })))
    .toMatchObject({ speakingRate: 1 });
});

it('omits unsupported native speed for eleven_v3', async () => {
  await provider.synthesize(requestFixture({ modelId: 'eleven_v3', speakingRate: 1 }));
  expect(JSON.parse(fetchBody())).toEqual({ text: 'Xin chào', model_id: 'eleven_v3' });
});
```

Add worker and server tests proving both pass `speakingRate: 1` to cache/provider, then invoke `prepareAudioAtSpeed()` with the project/preview requested rate.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/renderer -- --run src/audio-speed.test.ts
npm.cmd test --workspace @reelforge/tts
npm.cmd test --workspace @reelforge/worker -- --run src/runtime.test.ts
npm.cmd test --workspace @reelforge/server -- --run src/app.test.ts
```

Expected: missing speed utility and old provider-speed expectations fail.

- [ ] **Step 3: Implement the shared speed operation**

```ts
export function createBaseSynthesisRequest(request: TtsSynthesisRequest): TtsSynthesisRequest {
  return { ...request, speakingRate: 1 };
}

export async function prepareAudioAtSpeed(
  inputPath: string,
  outputPath: string,
  speakingRate: number,
  options: OwnedMediaProcessOptions,
): Promise<string> {
  if (speakingRate === 1) return inputPath;
  await runOwnedFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-i', inputPath,
    '-vn', '-filter:a', `atempo=${decimal(speakingRate)}`,
    '-c:a', 'pcm_s16le', outputPath,
  ], options);
  await assertValidAudio(outputPath, options);
  return outputPath;
}
```

Use job-scoped `.wav` destinations, register the process for Windows cancellation, and remove partial speed outputs on failure/cancel.

Export `createBaseSynthesisRequest()` from `packages/tts/src/speed.ts` and `prepareAudioAtSpeed()` from the renderer package entry point. Add `@reelforge/renderer` as an explicit server workspace dependency and refresh the lockfile with `npm install --package-lock-only --ignore-scripts`.

- [ ] **Step 4: Use 1.0x cache requests and speed-adjusted work files**

In worker synthesis, call cache/provider with `createBaseSynthesisRequest(request)`, then call `prepareAudioAtSpeed()` into the current job workspace. Pass adjusted paths to duration probing and rendering.

In `/api/tts/preview`, use the same base cache request and speed operation in a unique preview workspace. Return raw cached MP3 at 1x or `audio/wav` for transformed previews; always clean the preview workspace after response bytes are read.

In ElevenLabs, omit `voice_settings.speed` for `eleven_v3`. Since orchestration sends 1x, omit the speed-only `voice_settings` object for other models as well unless another supported voice setting is added later.

- [ ] **Step 5: Verify RED-to-GREEN duration behavior**

```powershell
npm.cmd test --workspace @reelforge/renderer
npm.cmd test --workspace @reelforge/tts
npm.cmd test --workspace @reelforge/worker
npm.cmd test --workspace @reelforge/server
```

Expected: duration ratios, v3 payload, cache request, preview, worker cancellation, and cleanup tests pass.

- [ ] **Step 6: Commit reliable speed handling**

```powershell
git add packages/renderer packages/tts apps/worker apps/server
git commit -m "fix: apply TTS speed locally across models"
```

---

### Task 5: Build the probed card/meme/transition timeline

**Files:**
- Create: `packages/renderer/src/edit-timeline.ts`
- Create: `packages/renderer/src/edit-timeline.test.ts`
- Modify: `packages/renderer/src/index.ts`

**Interfaces:**
- Consumes: ordered canonical project cards plus probed narration, meme-sound, and transition-sound durations.
- Produces: `createEditTimeline(input): EditTimeline` with exact event ranges for the FFmpeg builder and progress calculations.

- [ ] **Step 1: Write failing pure timeline tests**

```ts
it('orders transition, narration, and meme events without overlap', () => {
  const timeline = createEditTimeline({
    cards: [
      { cardId: 'a', narrationSeconds: 2, memeSeconds: 1.5 },
      { cardId: 'b', narrationSeconds: 3 },
    ],
    transitionSeconds: 0.5,
  });
  expect(timeline.cards).toEqual([
    {
      cardId: 'a',
      cardVisible: range(0, 3.5),
      narration: range(0, 2),
      meme: range(2, 3.5),
    },
    {
      cardId: 'b',
      cardVisible: range(3.5, 7),
      transition: range(3.5, 4),
      narration: range(4, 7),
    },
  ]);
  expect(timeline.durationSeconds).toBe(7);
});

it('allows a final meme and never adds a trailing transition', () => {
  const timeline = createEditTimeline({
    cards: [{ cardId: 'last', narrationSeconds: 2, memeSeconds: 4.62 }],
    transitionSeconds: 0.5,
  });
  expect(timeline.cards[0]).not.toHaveProperty('transition');
  expect(timeline.durationSeconds).toBeCloseTo(6.62);
});
```

Also test no selected transition sound (`transitionSeconds` absent), zero/NaN/negative rejection, one-frame rounding tolerance, and card ordering.

- [ ] **Step 2: Run timeline tests and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/renderer -- --run src/edit-timeline.test.ts
```

Expected: missing module/API failure.

- [ ] **Step 3: Implement immutable range types and timeline construction**

```ts
export interface TimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
}

export interface EditCardSegment {
  readonly cardId: string;
  readonly cardVisible: TimeRange;
  readonly transition?: TimeRange;
  readonly narration: TimeRange;
  readonly meme?: TimeRange;
}

export interface EditTimeline {
  readonly cards: readonly EditCardSegment[];
  readonly durationSeconds: number;
}
```

Advance one cursor in this exact order for each card: leading transition only when index > 0 and a transition duration exists; narration; post-card meme when selected. Set `cardVisible.startSeconds` before the leading transition and `cardVisible.endSeconds` after the optional meme.

- [ ] **Step 4: Run renderer unit tests**

```powershell
npm.cmd test --workspace @reelforge/renderer -- --run src/edit-timeline.test.ts
```

Expected: all event-order and duration tests pass.

- [ ] **Step 5: Commit the pure timeline**

```powershell
git add packages/renderer/src/edit-timeline.ts packages/renderer/src/edit-timeline.test.ts packages/renderer/src/index.ts
git commit -m "feat: add card meme transition timeline"
```

---

### Task 6: Render timed memes, effects, transitions, and background music

**Files:**
- Modify: `packages/renderer/src/index.ts`
- Modify: `packages/renderer/src/index.test.ts`
- Modify: `packages/renderer/src/integration.test.ts`

**Interfaces:**
- Consumes: `EditTimeline`, canonical snapshot resource paths, adjusted narration paths, probed audio durations, and existing output publication flow.
- Produces: expanded `FfmpegCommandRequest`/filter graph and final mixed video with no fixed sticker.

- [ ] **Step 1: Write failing filter-graph tests**

Use literal two-card input indices and assert these behaviors:

```ts
expect(command.args).not.toContain('legacy-sticker.png');
expect(command.filterGraph).toContain(
  "overlay=x=216:y=806:eof_action=pass:shortest=0:enable='between(t,2,3.5)'",
);
expect(command.filterGraph).toContain('adelay=2000|2000[memeAudio0]');
expect(command.filterGraph).toContain('adelay=3500|3500[transitionAudio1]');
expect(command.filterGraph).toContain('adelay=4000|4000[narration1]');
expect(command.filterGraph).toContain('sidechaincompress=');
expect(command.filterGraph).toContain('alimiter=limit=0.95[aout]');
```

Add cases for no meme, no transition sound, no background music, final meme, music loop/trim, one project transition input reused with `asplit`, and total `-t` equal to `EditTimeline.durationSeconds`.

- [ ] **Step 2: Run renderer tests and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/renderer -- --run src/index.test.ts
```

Expected: old continuous-narration/static-sticker graph does not satisfy timed-layer assertions.

- [ ] **Step 3: Extend renderer request types**

```ts
export interface RenderMemeInput {
  readonly imagePath: string;
  readonly soundPath: string;
  readonly range: TimeRange;
}

export interface RenderCardInput {
  readonly imagePath: string;
  readonly audioPath: string;
  readonly segment: EditCardSegment;
  readonly meme?: RenderMemeInput;
}

export interface FfmpegCommandRequest {
  readonly backgroundPath: string;
  readonly cards: readonly RenderCardInput[];
  readonly transitionSoundPath?: string;
  readonly backgroundMusicPath?: string;
  readonly cardSlot?: NormalizedRect;
  readonly memeSlot?: NormalizedRect;
  readonly outputPath: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly crf?: number;
}
```

- [ ] **Step 4: Replace static sticker and continuous concat with timed layers**

Build input indexes deterministically in this order: gameplay, card images, meme images, narration audio, meme audio, optional transition audio, optional background music. Scale each meme with contain/pad into `memeSlot`, shift it to its range start, and enable its overlay only for the exact range.

Delay every foreground audio event to its timeline start:

```ts
`[${input}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,adelay=${ms}|${ms}[${label}]`
```

For a selected project transition sound, use `asplit=N-1` and delay one branch for each later card. Do not create a branch for card one or after the final card.

Loop music with `-stream_loop -1`, trim it to total duration, apply one fixed internal mix level, and duck it with the foreground mix as sidechain. Mix ducked music and foreground with `amix=normalize=0`, then `alimiter=limit=0.95`. When no music is selected, route foreground directly through the limiter.

- [ ] **Step 5: Add real FFmpeg integration coverage**

Generate fixture tones with distinct durations:

- Narration A: 1.00 s.
- Meme A: 0.70 s.
- Transition: 0.50 s.
- Narration B: 1.20 s.
- Final meme B: 0.40 s.
- Music: 0.60 s, requiring loop.

Expected total duration is `1.00 + 0.70 + 0.50 + 1.20 + 0.40 = 3.80` seconds. Probe the result and assert H.264/AAC, 720x1280, 30 fps, duration within 100 ms, and an audio stream spanning the full output. Extract frames at 1.35 s and 3.60 s and assert fixture meme colors occupy `memeSlot`; extract a narration frame and assert no legacy sticker color appears.

- [ ] **Step 6: Run renderer unit and integration tests**

```powershell
npm.cmd test --workspace @reelforge/renderer
```

Expected: all legacy render protections plus new timeline/mix/frame tests pass.

- [ ] **Step 7: Commit the renderer composition**

```powershell
git add packages/renderer
git commit -m "feat: render meme transitions and background audio"
```

---

### Task 7: Wire immutable resources through worker preflight and queue snapshots

**Files:**
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`
- Modify: `apps/worker/src/worker.stress.test.ts`
- Modify: `packages/queue/src/index.ts` only if legacy snapshot normalization needs a queue-boundary hook
- Modify: `packages/queue/src/index.test.ts`

**Interfaces:**
- Consumes: canonical `ProjectV2` snapshots, managed resource paths, `prepareAudioAtSpeed()`, renderer preflight, and expanded renderer request.
- Produces: worker flow that validates every selected asset before paid TTS and passes exact probed durations/resources into rendering.

- [ ] **Step 1: Write failing worker/preflight tests**

```ts
it('preflights all selected resources before requesting paid TTS', async () => {
  const job = enqueue(projectWithMissingMemeSound());
  await worker.tick();
  expect(providerSynthesizeCalls()).toBe(0);
  expect(queue.getJob(job.id)).toMatchObject({
    status: 'failed',
    error: { code: 'MEDIA_INVALID' },
  });
});

it('passes speed-adjusted narration and canonical resource selections to renderer', async () => {
  await worker.tick();
  expect(lastRenderRequest()).toMatchObject({
    snapshot: {
      project: {
        schemaVersion: 2,
        transitionSoundPath: 'assets/transition.mp3',
        backgroundMusicPath: 'assets/music.mp3',
      },
    },
    narrationAudioPaths: expect.arrayContaining([expect.stringMatching(/\.wav$/)]),
  });
});
```

Add cancellation tests during local speed conversion and restart tests proving a v1 queued snapshot resumes after normalization without losing its asset identity.

- [ ] **Step 2: Run worker and queue tests and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/worker
npm.cmd test --workspace @reelforge/queue
```

Expected: missing resource resolution/probing and legacy normalization failures.

- [ ] **Step 3: Extend managed snapshot path resolution and preflight**

Resolve and validate:

```ts
project.transitionSoundPath
project.backgroundMusicPath
card.postCardMeme?.imagePath
card.postCardMeme?.soundPath
```

Require image kind for meme images and audio kind for all sounds/music. Resolve everything before TTS synthesis. The renderer's existing preflight call must inspect these resources before the worker requests provider audio and reject missing, zero, wrong-kind, or unprobeable assets with redacted structured details containing only card ID and resource kind.

- [ ] **Step 4: Build adjusted narration and render input**

For each card:

1. Create/cache provider audio from `createBaseSynthesisRequest()`.
2. Convert to job-local speed-adjusted WAV with `prepareAudioAtSpeed()`.
3. Pass adjusted narration paths and the canonical snapshot to renderer `start()`.
4. Let the renderer probe adjusted narration/effect durations and build `EditTimeline` inside the owned render operation.

Register all temporary WAVs for existing success/cancel cleanup; preserve failed-job manifests/logs under current rules.

- [ ] **Step 5: Verify queue snapshot compatibility and stress behavior**

```powershell
npm.cmd test --workspace @reelforge/worker
npm.cmd test --workspace @reelforge/queue
```

Expected: cancellation, restart, retry, concurrency, immutable snapshots, v1 history, and stress fixtures pass.

- [ ] **Step 6: Commit worker integration**

```powershell
git add apps/worker packages/queue
git commit -m "feat: process immutable timeline resources in worker"
```

---

### Task 8: Update template import and build resource/transition editor UI

**Files:**
- Create: `apps/web/src/components/ResourcePicker.tsx`
- Create: `apps/web/src/components/ResourcePicker.module.css`
- Create: `apps/web/src/components/CardMemeEditor.tsx`
- Create: `apps/web/src/components/CardMemeEditor.module.css`
- Create: `apps/web/src/components/ResourcePicker.test.tsx`
- Create: `apps/web/src/components/CardMemeEditor.test.tsx`
- Modify: `apps/web/src/app/query-hooks.ts`
- Modify: `apps/web/src/screens/EditorPage.tsx`
- Modify: `apps/web/src/screens/EditorPage.module.css`
- Modify: `apps/web/src/screens/EditorPage.test.tsx`
- Modify: `apps/web/src/screens/SettingsPage.tsx`
- Modify: `apps/web/src/screens/settings-screen.test.tsx`
- Modify: `apps/web/src/lib/preview.ts`
- Modify: `apps/web/src/lib/preview.test.ts`

**Interfaces:**
- Consumes: resource API methods, canonical project/template contracts, autosave controller, and managed asset URLs.
- Produces: read-only grouped resource library, project-level audio selectors, atomic meme-pair editor, and preview with no fixed sticker.

- [ ] **Step 1: Write failing component tests**

```tsx
it('applies a meme only after both image and sound are selected', async () => {
  render(<CardMemeEditor value={undefined} resources={resourceFixtures} onApply={onApply} />);
  await user.selectOptions(screen.getByLabelText('Meme image'), 'image-1');
  expect(screen.getByRole('button', { name: 'Áp dụng meme' })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Meme sound'), 'sound-1');
  await user.click(screen.getByRole('button', { name: 'Áp dụng meme' }));
  expect(onApply).toHaveBeenCalledWith({
    imagePath: 'assets/image.png',
    soundPath: 'assets/sound.mp3',
  });
});

it('stores one project transition sound and one background music selection', async () => {
  renderEditor(projectV2Fixture());
  await user.selectOptions(screen.getByLabelText('Transition sound toàn project'), 'transition-1');
  await user.selectOptions(screen.getByLabelText('Nhạc nền'), 'music-1');
  await flushAutosave();
  expect(api.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
    transitionSoundPath: 'assets/transition.mp3',
    backgroundMusicPath: 'assets/music.mp3',
  }));
});

it('never renders a persistent template sticker in editor preview', () => {
  renderEditorWithLegacyTemplate();
  expect(screen.queryByTestId('persistent-sticker')).not.toBeInTheDocument();
});
```

Add Settings tests for grouped counts, image thumbnails, audio controls, and template import containing only gameplay/thumbnail/layout.

- [ ] **Step 2: Run web tests and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/web
```

Expected: missing components/labels and old fixed-sticker/template form cause failures.

- [ ] **Step 3: Add resource queries and focused components**

Add query key `['resources']` and `useResources(kind?)`.

`ResourcePicker` accepts:

```ts
interface ResourcePickerProps {
  readonly label: string;
  readonly kind: MediaResourceKind;
  readonly value?: string;
  readonly resources: readonly MediaResourceV1[];
  readonly allowNone?: boolean;
  readonly onChange: (assetPath: string | undefined) => void;
}
```

Show thumbnails for `meme-image`; show an `<audio controls preload="metadata">` preview for audio kinds. `CardMemeEditor` owns partial local selection and calls `onApply` only when both selected; `Clear` removes both atomically.

- [ ] **Step 4: Update Editor project and per-card controls**

At project level add transition sound and background music selectors. Do not show transition sound as a per-card field. If background music is cleared, remove `backgroundMusicPath`.

For every card, render `Sau card này` with selected meme names and an edit/apply control. The final card label explains it becomes an ending meme. Autosave only canonical complete pairs.

Keep speed slider at 0.5–2.0 and update helper text to state speed is applied locally and works with every model.

- [ ] **Step 5: Remove fixed sticker UI and update template import**

Remove the sticker file input, `previewStickerStyle`, and persistent sticker `<img>`. Replace template layout text with `Meme slot · x 30% · y 63% · 40% × 31%`. Preview provides a `Card`/`Meme sau card` toggle; meme mode overlays only the active card's selected meme in `memeSlot`.

- [ ] **Step 6: Run web component tests**

```powershell
npm.cmd test --workspace @reelforge/web
```

Expected: project audio, atomic pair, preview, autosave, accessibility, and existing project/queue screens pass.

- [ ] **Step 7: Commit UI support**

```powershell
git add apps/web
git commit -m "feat: add meme and project audio controls"
```

---

### Task 9: Add E2E, security, documentation, and real-resource acceptance

**Files:**
- Modify: `apps/web/tests/e2e/reelforge.spec.ts`
- Modify: `scripts/security-scan.test.mjs`
- Modify: `tests/task-7-security.test.mjs`
- Create: `docs/RESOURCE_LIBRARY.md`
- Modify: `docs/CLEAN_TEMPLATE_GUIDE.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed API/worker/renderer/UI behavior and the four existing user resource directories.
- Produces: full user-flow coverage, security regression coverage, operator guidance, and acceptance evidence.

- [ ] **Step 1: Write a failing E2E project flow**

Extend the Playwright fixture APIs with canonical v2 resources. Cover this exact flow:

1. Open Settings and confirm grouped resource lists.
2. Confirm the four scanned folders expose a meme image, meme sound, transition sound, and music track.
3. Create a two-card `eleven_v3` project at 1.5x.
4. Select the one project transition sound and background music.
5. Apply a meme pair after card one and a different ending meme pair after card two.
6. Save/reopen and assert every selection persisted.
7. Preview TTS and the selected effects.
8. Enqueue and follow the job to a succeeded output.

- [ ] **Step 2: Run E2E and confirm RED**

```powershell
npm.cmd test --workspace @reelforge/web
```

Expected: mocked flow fails until resource and v2 project mocks match the completed UI.

- [ ] **Step 3: Complete E2E fixtures and security tests**

Assert serialized project/job/log/frontend output does not contain:

```text
D:\reels\stickers
D:\reels\meme sounds
D:\reels\transition sound
D:\reels\background audio
ELEVENLABS_API_KEY
GOOGLE_TTS_API_KEY
```

Assert managed paths match `assets/<sha256>.<extension>`. Retain existing public-job internal-field and output-path protections.

- [ ] **Step 4: Write operator documentation**

`docs/RESOURCE_LIBRARY.md` must explain:

- The four auto-seeded folder names and supported formats.
- How to add resources by copying supported files into the four folders and restarting the app.
- The exact card → meme → next-card transition → narration sequence.
- Meme duration derives from sound and cannot be set independently.
- One transition sound applies to the project.
- Background music loop and automatic ducking.
- Local FFmpeg speed behavior and the 0.5x–2.0x range.

Update the clean-template guide to remove fixed sticker instructions and describe `memeSlot`. Update troubleshooting with invalid audio, missing paired resource, unprobeable duration, and stale app restart guidance.

- [ ] **Step 5: Run the complete automated verification**

Run fresh and read every exit code:

```powershell
npm run lint
npm.cmd test
npm.cmd run build
npm run test:security
git diff --check
```

Expected: zero lint/type errors, zero test failures, successful production build/security scan, and no whitespace errors.

- [ ] **Step 6: Run real-resource acceptance without committing media**

Start the rebuilt app and verify every valid direct child file currently present in the four resource folders appears once in the seeded catalog. Add one temporary supported fixture to a folder, restart, confirm it appears, then remove only that temporary fixture; never modify or delete the user's existing resources.

Create a three-card project using `eleven_v3` at 1.5x, both an intermediate meme and final meme, the project transition sound, and background music. Render it, then use bundled ffprobe to verify 720x1280, 30 fps, H.264/AAC, and the timeline duration formula from probed sources. Inspect frames during each meme window and listen through every boundary to confirm effect order, music ducking, and no fixed sticker.

Render the same short script at 0.5x, 1.0x, 1.2x, and 2.0x. Record durations and confirm each is within 100 ms of `baseDuration / speakingRate` and strictly decreases as speed increases.

- [ ] **Step 7: Confirm repository hygiene**

```powershell
git status --short
git diff --cached --name-only
```

Expected: source/docs/tests only. The reference MP4, `stickers`, `meme sounds`, `transition sound`, `background audio`, `data`, `outputs`, API keys, and generated inspection files are not staged.

- [ ] **Step 8: Commit final verification/docs**

```powershell
git add apps/web/tests scripts tests docs README.md
git commit -m "test: verify rich transition production flow"
```

---

## Execution checkpoints

After each task:

1. Review the focused diff for scope and secret/path leakage.
2. Run the task's focused tests.
3. Commit only that task's files.
4. Keep the user-provided media folders untracked.
5. Do not proceed on a red test, TypeScript error, or unexplained warning.

After Task 9, compare every acceptance criterion in the spec to fresh test/manual evidence before claiming completion.
