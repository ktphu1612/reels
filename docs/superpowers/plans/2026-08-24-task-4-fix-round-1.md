# Task 4 Fix Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct renderer crossfades, cancellation ownership, strict decoding, publication cleanup, narration duration selection, fixture audio proof, progress completion, and zero-card preflight.

**Architecture:** Keep the renderer's public entry point while introducing a unified xfade-based card layer, a render-scoped process registry, injectable process/filesystem boundaries, and explicit duration/publication helpers. Every finding receives a failing behavioral test before production changes.

**Tech Stack:** Node.js 24, strict TypeScript, Vitest, bundled FFmpeg/ffprobe.

**Spec:** `D:/reels/.superpowers/sdd/2026-08-24-batch-video-tts-tool/task-4-brief.md` plus the independent review findings supplied in the fix-round request.

## Global Constraints

- Do not use git or modify the user-owned reference MP4.
- Use `apply_patch` for source edits.
- Preserve safe structured errors without paths or secrets.
- Run focused renderer tests, full tests, lint, and build before completion.

---

### Task 1: Unified card crossfade

**Files:** Modify `packages/renderer/src/index.ts`; test `packages/renderer/src/index.test.ts` and `packages/renderer/src/integration.test.ts`.

**Interfaces:** Keep `buildFfmpegCommand`; produce one `[cards]` layer using chained `xfade` transitions and overlay that layer once.

- [ ] Add graph and real midpoint pixel assertions, including a 50 ms clamped transition.
- [ ] Run `npm.cmd test --workspace @reelforge/renderer` and record the expected RED compositor failure.
- [ ] Replace sequential alpha overlays with a unified xfade card layer while leaving audio duration unchanged.
- [ ] Rerun focused tests for GREEN.

### Task 2: Render-scoped process registry and reliable tree cancellation

**Files:** Modify `packages/renderer/src/index.ts`; test `packages/renderer/src/index.test.ts`.

**Interfaces:** Add an internal registry shared by probe, decode, render, and final probe subprocesses; add injectable spawn/tree-termination boundaries to renderer options.

- [ ] Add tests proving probe/decode ownership, cancellation rejection, closure waiting, progress completion, and child/grandchild cleanup through the injectable tree boundary.
- [ ] Run focused tests for RED.
- [ ] Implement registry cancellation and closure-safe termination. Keep `taskkill /T /F` for normal Windows; use deterministic direct-child fallback when denied.
- [ ] Rerun focused tests for GREEN.

### Task 3: Strict decode and narration duration selection

**Files:** Modify `packages/renderer/src/index.ts`; test both renderer test files.

**Interfaces:** Add exported `selectAudioDurationSeconds(probe)` supporting stream duration, `duration_ts * time_base`, and validated format fallback.

- [ ] Add duration-selection and probetable-midstream-corruption tests.
- [ ] Run focused tests for RED.
- [ ] Parse `duration_ts`/`time_base`, use the helper in rendering, and add `-xerror -loglevel error` to full decode.
- [ ] Rerun focused tests for GREEN.

### Task 4: Publication and preflight cleanup guarantees

**Files:** Modify `packages/renderer/src/index.ts`; test `packages/renderer/src/index.test.ts`.

**Interfaces:** Inject filesystem publication operations; preflight verifies create and delete; publication success remains success after final link creation even if partial cleanup needs retry.

- [ ] Add tests for delete-denied preflight and post-publication cleanup failure.
- [ ] Run focused tests for RED.
- [ ] Implement cleanup issue reporting, retry/explicit deferred cleanup semantics, and non-false failure after publication.
- [ ] Rerun focused tests for GREEN.

### Task 5: Remaining audit gaps and verification

**Files:** Modify renderer tests, implementation, and `task-4-report.md`.

- [ ] Add zero-card structured preflight test and two-interval tone/near-zero-template assertions.
- [ ] Run focused RED then implement minimum GREEN.
- [ ] Run final focused renderer tests, `npm.cmd test`, `npm run lint`, and `npm.cmd run build`.
- [ ] Append exact evidence and reasoned Job Object pushback to the report.
