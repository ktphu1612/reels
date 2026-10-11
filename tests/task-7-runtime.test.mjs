import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { terminateProcessTree, waitForHealth } from '../scripts/process-supervisor.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:');

test('setup is idempotent, verifies bundled media tools, and preserves runtime data', async () => {
  const setup = await import('../scripts/setup.mjs');
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'reelforge-task7-setup-'));
  try {
    const sentinel = join(runtimeRoot, 'data', 'projects', 'keep.json');
    await mkdir(join(runtimeRoot, 'data', 'projects'), { recursive: true });
    await writeFile(sentinel, '{"keep":true}', 'utf8');

    const first = await setup.runSetup({
      rootDirectory: repositoryRoot,
      runtimeBaseDirectory: runtimeRoot,
      installIfMissing: false,
      log: () => undefined,
    });
    const second = await setup.runSetup({
      rootDirectory: repositoryRoot,
      runtimeBaseDirectory: runtimeRoot,
      installIfMissing: false,
      log: () => undefined,
    });

    assert.deepEqual(second.runtimeDirectories, first.runtimeDirectories);
    await access(join(runtimeRoot, 'data', 'assets'));
    await access(join(runtimeRoot, 'outputs'));
    assert.equal(await readFile(sentinel, 'utf8'), '{"keep":true}');
    assert.match(first.ffmpegVersion, /ffmpeg version/i);
    assert.match(first.ffprobeVersion, /ffprobe version/i);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('health wait has a finite deadline and actionable failure', async () => {
  const { waitForHealth } = await import('../scripts/process-supervisor.mjs');
  const started = Date.now();
  await assert.rejects(
    waitForHealth('http://127.0.0.1:1/api/health', { timeoutMs: 120, intervalMs: 20 }),
    /health|timed out|start/i,
  );
  assert.ok(Date.now() - started < 2_000);
});

test('process-tree termination stops a child and its spawned descendant', async () => {
  const { terminateProcessTree } = await import('../scripts/process-supervisor.mjs');
  const root = await mkdtemp(join(tmpdir(), 'reelforge-task7-tree-'));
  const heartbeatPath = join(root, 'heartbeat.txt');
  const childSource = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const target = process.argv[1];",
    "const descendant = spawn(process.execPath, ['-e', `setInterval(() => fs.appendFileSync(process.argv[1], 'x'), 20)`, target], { stdio: 'ignore' });",
    "setInterval(() => fs.appendFileSync(target, 'p'), 20);",
    "process.on('SIGTERM', () => {});",
    "void descendant;",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', childSource, heartbeatPath], { stdio: 'ignore' });
  try {
    await waitForFile(heartbeatPath, 2_000);
    const before = (await stat(heartbeatPath)).size;
    await terminateProcessTree(child, { graceMs: 150 });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const after = (await stat(heartbeatPath)).size;
    assert.ok(after <= before + 2, `descendant kept writing after cleanup (${before} -> ${after})`);
  } finally {
    await terminateProcessTree(child, { graceMs: 50 }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('production build validation rejects missing compiled UI/API/worker artifacts', async () => {
  const { assertProductionBuild } = await import('../scripts/start.mjs');
  const root = await mkdtemp(join(tmpdir(), 'reelforge-task7-build-'));
  try {
    await assert.rejects(
      Promise.resolve().then(() => assertProductionBuild(root)),
      /build|dist|production/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development supervisor serves the web app from the workspace root', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'reelforge-task7-dev-'));
  const apiPort = 43219;
  const webPort = 5175;
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      REELFORGE_HOME: runtimeRoot,
      REELFORGE_PORT: String(apiPort),
      REELFORGE_WEB_PORT: String(webPort),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await waitForHealth(`http://127.0.0.1:${apiPort}/api/health`, { timeoutMs: 15_000, intervalMs: 50 });
    const response = await fetch(`http://127.0.0.1:${webPort}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ReelForge Studio/);
  } finally {
    await terminateProcessTree(child, { graceMs: 100 }).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('launcher self-check resolves its own directory when the path contains spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ReelForge Studio space-'));
  try {
    const launcher = join(root, 'ReelForge Studio.cmd');
    const source = await readFile(join(repositoryRoot, 'ReelForge Studio.cmd'), 'utf8');
    await writeFile(launcher, source, 'utf8');
    const result = await execFileAsync('cmd.exe', ['/d', '/c', launcher, '--self-test'], { windowsHide: true });
    assert.match(result.stdout, /self-test ok/i);
    assert.match(result.stdout, /ReelForge Studio space/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
