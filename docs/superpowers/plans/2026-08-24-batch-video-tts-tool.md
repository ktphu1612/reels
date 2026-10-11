# Batch Video TTS Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. All behavioral production code follows test-first development.

**Goal:** Build a Windows-first local web application that turns complete card images plus Vietnamese scripts into queued vertical gameplay videos using Google Cloud TTS or ElevenLabs.

**Architecture:** An npm workspace contains a React/Vite web UI, a Fastify local API, a durable SQLite queue, a separate render worker, shared Zod contracts, TTS adapters, and an FFmpeg renderer. App-managed content-addressed assets and immutable job snapshots make batch jobs repeatable across restarts.

**Tech Stack:** Node.js 24, TypeScript strict, npm workspaces, React, Vite, Fastify, Zod, node:sqlite WAL, bundled FFmpeg/ffprobe, Vitest, Playwright.

## Global Constraints

- Bind network services only to `127.0.0.1`; v1 is local single-user and has no authentication or cloud hosting.
- Output defaults to MP4 H.264/AAC, 720x1280, 30 fps, CRF 20, yuv420p, faststart.
- Template audio is always muted. Background video covers the canvas and loops from its beginning.
- Cards use contain in normalized slot x=0.05, y=0.38, width=0.90, height=0.25 and crossfade for 200 ms without changing narration duration.
- Optional sticker uses normalized slot x=0.30, y=0.63, width=0.40, height=0.31 and remains visible for the whole video.
- There is no intro, subtitle, OCR, AI image description, manual timeline, template layout editor, social publishing, or cloud worker in v1.
- Inputs are complete PNG/JPEG/WebP cards with a required non-empty script. The user supplies clean gameplay and transparent sticker assets.
- Implement both Google Cloud REST API-key and ElevenLabs adapters. API keys live only in gitignored `.env.local` and must never appear in projects, SQLite, frontend responses, cache keys, or logs.
- TTS retries timeout, HTTP 429, and HTTP 5xx up to three retries with delays 2/5/15 seconds; authentication and validation errors do not retry.
- Queue concurrency is configurable from 1 to 4 and defaults to 1. Jobs survive restart and use immutable project/template snapshots.

---

### Task 1: Workspace and core contracts

Create the npm workspace and scripts for build, lint, tests, dev, setup, and start. Add shared versioned Zod schemas for ProjectV1, TemplateManifestV1, SettingsPublic, TtsProvider contracts, RenderJob, structured errors, default layouts, filename helpers, and migration entry points. Add unit tests that fail before each behavioral contract is implemented.

Deliverable: all workspace packages compile, core tests pass, and no runtime app behavior is added yet.

### Task 2: Project, template, and asset storage

Implement app data paths, SHA-256 content-addressed imports, safe filenames, atomic JSON writes, project CRUD/duplicate/delete, template import/list/read, and immutable relative asset references. Template import accepts clean gameplay, optional sticker, and optional thumbnail and creates a default manifest. Validate MIME/extensions and prevent paths escaping app storage.

Deliverable: storage API is fully covered by filesystem tests and preserves queued asset identities when source files change.

### Task 3: Settings, TTS providers, and cache

Implement backend-only `.env.local` secret persistence with allowlisted variables and masked public status. Add Google Cloud and ElevenLabs adapters implementing validateCredentials, listVoices, and synthesize; add retry classification and timeouts. Add a cache keyed by provider, voice, model, settings, and script, excluding secrets, with atomic successful writes.

Deliverable: mocked provider contract tests cover success, 401, 429, 5xx, timeout, retry count, masking, and stable cache keys.

### Task 4: Timeline and FFmpeg renderer

Implement preflight validation, ffprobe duration probing, exact narration timeline construction, 200 ms visual crossfades, FFmpeg filter graph generation, background cover/loop/mute, contained cards, optional static sticker, concatenated and normalized narration, progress parsing, partial output handling, output validation, and atomic final rename.

Deliverable: fixture render integration test verifies codec, dimensions, fps, duration tolerance, generated narration audio, muted template audio, and non-overwrite behavior.

### Task 5: Durable queue, worker, and local API

Implement SQLite WAL schema and migrations for jobs/events/settings metadata, immutable enqueue snapshots, transitions, configurable concurrency, restart recovery, retry attempts, cancellation, redacted capped logs, and cleanup. Build the worker process and Fastify endpoints for projects, templates, settings, TTS preview/voices, enqueue/batch, status, cancel, retry, and SSE progress.

Deliverable: state-machine, restart, concurrency, API, SSE, cancel, retry, and 50-job stress tests pass.

### Task 6: React local web UI

Build Projects, Editor, Queue, and Settings surfaces. Support project create/open/duplicate/delete, multi-select batch enqueue, template/provider/voice selection, multi-image upload, required scripts, drag reorder, autosave, live video/card/sticker preview, voice preview, realtime queue progress, cancel/retry, masked credentials, output directory, and concurrency. Use accessible labels, keyboard behavior, responsive desktop layout, and useful empty/error states.

Deliverable: component tests and Playwright user-flow tests cover a two-card project through enqueue and completed output using mocked TTS/render fixtures.

### Task 7: Windows packaging, documentation, and final verification

Bundle Windows FFmpeg and ffprobe discovery, add setup/dev/build/start scripts plus a one-click Windows launcher, production static serving, license notices, example environment file, clean-template guide, troubleshooting, and README. Run all unit, integration, API, component, E2E, security, build, and 50-job stress checks. Verify no secret or sample video enters git.

Deliverable: a fresh Windows checkout can install, build, launch locally, create a project, enqueue it, and produce a valid MP4 without a system FFmpeg installation.
