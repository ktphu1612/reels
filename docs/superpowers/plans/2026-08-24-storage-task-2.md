# Storage Task 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide durable, safe local storage for ReelForge projects, templates, and content-addressed media assets.

**Architecture:** `@reelforge/storage` owns app-directory layout and filesystem persistence only. `AssetStore` validates and imports source media into immutable SHA-256 paths; `ProjectStore` and `TemplateStore` parse the Task 1 core schemas and persist only data-root-relative references.

**Tech Stack:** Node.js 24 filesystem/crypto APIs, TypeScript strict mode, Vitest, Zod contracts from `@reelforge/core`.

**Spec:** `.superpowers/sdd/2026-08-24-batch-video-tts-tool/task-2-brief.md`

## Global Constraints

- Work directly in `D:\reels`; `.git` is disabled, so do not commit or invoke git.
- Use real temporary directories and hand-authored fixture bytes; do not mock the filesystem.
- Asset JSON values must be relative to the data root and resolution must reject absolute and traversal input.
- Atomically write JSON through a same-directory temporary file and rename.
- Do not add HTTP, queue, TTS, renderer, or UI behavior.

---

### Task 1: Define observable storage behavior in real-filesystem tests

**Files:**
- Create: `packages/storage/src/index.test.ts`
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`

**Interfaces:**
- Produces expected contracts for `createAppPaths`, `resolveDataPath`, `readJsonFile`, `writeJsonFileAtomic`, `AssetStore`, `ProjectStore`, and `TemplateStore`.

- [ ] **Step 1: Write a failing path and JSON test.**

```ts
// Production break caught: removing traversal/absolute validation lets JSON reference outside storage.
expect(() => resolveDataPath(paths, '../secrets.json')).toThrow(ReelForgeError);
```

- [ ] **Step 2: Run the focused test and confirm it fails because the package is absent.**

Run: `npm test --workspace=@reelforge/storage -- --run src/index.test.ts`
Expected: failing test command caused by missing workspace/package.

- [ ] **Step 3: Add successive failing real-file tests.**

```ts
// Production break caught: accepting renamed arbitrary bytes as PNG.
await expect(store.importFile(fakePng, 'card')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
```

Cover MIME/magic validation, SHA reuse/no overwrite, project CRUD/duplicate/delete, card import, and template import/delete with hand-written image/video bytes.

- [ ] **Step 4: Run focused RED tests after each behavioral group.**

Run: `npm test --workspace=@reelforge/storage -- --run src/index.test.ts`
Expected: failure explains the missing API or behavior under test.

### Task 2: Implement the minimal storage package

**Files:**
- Create: `packages/storage/src/index.ts`
- Create: `packages/storage/src/index.test.ts`
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ProjectV1`, `TemplateManifestV1`, defaults, parsers, `ReelForgeError`, `createErrorPayload` from `@reelforge/core`.
- Produces: safe paths and atomic JSON helpers plus independent asset/project/template stores.

- [ ] **Step 1: Implement only enough safe directory, resolver, and JSON behavior for the first RED tests.**

```ts
export function resolveDataPath(paths: AppPaths, relativePath: string): string {
  // reject absolute paths and any resolved path outside paths.data
}
```

- [ ] **Step 2: Run the focused test and verify green.**

Run: `npm test --workspace=@reelforge/storage -- --run src/index.test.ts`
Expected: all currently written tests pass.

- [ ] **Step 3: Implement media detection and immutable asset imports for the next RED tests.**

```ts
const relativePath = `assets/${sha256}.${extension}`;
// write only when target does not already exist; use exclusive creation.
```

- [ ] **Step 4: Implement schema-backed project and template persistence for the next RED tests.**

```ts
const project = parseProject(input);
await writeJsonFileAtomic(projectPath, project);
```

- [ ] **Step 5: Re-run focused tests after each GREEN implementation.**

Run: `npm test --workspace=@reelforge/storage -- --run src/index.test.ts`
Expected: all tests pass with no temporary JSON files left after successful writes.

### Task 3: Verify and report

**Files:**
- Create: `.superpowers/sdd/2026-08-24-batch-video-tts-tool/task-2-report.md`

- [ ] **Step 1: Run the full test suite.**

Run: `npm test`
Expected: all workspace tests pass.

- [ ] **Step 2: Run type-check lint.**

Run: `npm run lint`
Expected: exit code 0.

- [ ] **Step 3: Run all package builds.**

Run: `npm run build`
Expected: exit code 0.

- [ ] **Step 4: Record RED/GREEN command evidence, changed files, requirement coverage, review, and concerns in the Task 2 report.**
