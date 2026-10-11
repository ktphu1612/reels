# Task 3 TTS Settings and Cache Implementation Plan

> **For agentic workers:** Execute inline with focused test-first cycles. The user explicitly prohibits git and subagent use for this task.

**Goal:** Add safe local TTS credential persistence, Google and ElevenLabs implementations of the shared provider contract, resilient safe networking, and a deterministic atomic narration cache.

**Architecture:** `@reelforge/tts` owns four isolated concerns: an allowlisted `.env.local` store, an injected retry/timeout boundary, provider adapters, and a filesystem cache rooted at storage's `AppPaths.ttsCache`. The public types remain the contracts from `@reelforge/core`; storage supplies only path ownership.

**Tech Stack:** Node.js 24, TypeScript strict, Vitest, native `fetch`, Node filesystem and crypto APIs.

**Spec:** `D:\reels\.superpowers\sdd\2026-08-24-batch-video-tts-tool\task-3-brief.md`

## Global Constraints

- Only `GOOGLE_TTS_API_KEY` and `ELEVENLABS_API_KEY` may be written to `.env.local`; unrelated lines and comments are retained.
- Public values and structured errors never include keys, URLs, query strings, or response bodies.
- Retry only network/timeout failures, HTTP 429, and HTTP 5xx: one attempt plus at most three retries after 2000, 5000, and 15000 ms.
- Tests use real temporary filesystems for secrets/cache and mock only fetch, sleep, and timeout boundaries.
- Do not add HTTP routes, renderer, queue, or UI behavior.

---

### Task 1: Add package testing setup and secret store

**Files:**
- Modify: `packages/tts/package.json`
- Create: `packages/tts/src/index.test.ts`
- Create: `packages/tts/src/secrets.ts`
- Modify: `packages/tts/src/index.ts`

- [ ] Write a failing filesystem test proving allowlisted update/clear preserves comments and unrelated variables, masks the final four key characters, and rejects control-character injection.
- [ ] Run `npx vitest run packages/tts/src/index.test.ts` and confirm the missing export failure.
- [ ] Implement `EnvSecretStore` with atomic writes and an internal `SecretProvider` read boundary.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Add retry boundary and Google adapter

**Files:**
- Create: `packages/tts/src/network.ts`
- Create: `packages/tts/src/google.ts`
- Modify: `packages/tts/src/index.test.ts`
- Modify: `packages/tts/src/index.ts`

- [ ] Write failing contract tests for a complete Google voices response, 429 retry delays/count, 401 no-retry safe validation, timeout behavior, and synthesis request/response parsing.
- [ ] Run the focused tests and confirm the Google adapter export is missing.
- [ ] Implement injected fetch/sleep/timeout/clock dependencies, safe classification, and Google request/response handling.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: Add ElevenLabs adapter

**Files:**
- Create: `packages/tts/src/elevenlabs.ts`
- Modify: `packages/tts/src/index.test.ts`
- Modify: `packages/tts/src/index.ts`

- [ ] Write a failing contract test for a complete ElevenLabs voice result and binary synthesis response, including URL encoding, default model, requested/metadata language, and MP3/WAV format choices.
- [ ] Run focused tests and confirm the ElevenLabs adapter export is missing.
- [ ] Implement the adapter using the shared safe networking boundary.
- [ ] Re-run focused tests and confirm they pass.

### Task 4: Add TTS cache

**Files:**
- Create: `packages/tts/src/cache.ts`
- Modify: `packages/tts/src/index.test.ts`
- Modify: `packages/tts/src/index.ts`

- [ ] Write failing filesystem tests proving canonical secret-free keys, cached reuse, concurrent de-duplication, atomic success writes, and no entries after synthesis failure.
- [ ] Run focused tests and confirm the cache export is missing.
- [ ] Implement cache read validation, in-flight coalescing, and temporary-file-plus-rename persistence under `AppPaths.ttsCache`.
- [ ] Re-run focused tests and confirm they pass.

### Task 5: Verify and report

**Files:**
- Create: `D:\reels\.superpowers\sdd\2026-08-24-batch-video-tts-tool\task-3-report.md`

- [ ] Run `npm test`, `npm run lint`, and `npm run build`.
- [ ] Inspect the changed files for secret leaks, retry/error classification, and cache partial-file handling.
- [ ] Record exact RED/GREEN commands and output, verification results, self-review, and concerns in the required report.
