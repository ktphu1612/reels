import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { terminateProcessTree, waitForHealth } from '../scripts/process-supervisor.mjs';

const repositoryRoot = new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:');

test('production supervisor exits and closes both child services on a forwarded shutdown', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'reelforge-task7-shutdown-'));
  const port = 43217;
  const child = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      REELFORGE_HOME: runtimeRoot,
      REELFORGE_PORT: String(port),
      REELFORGE_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 10_000, intervalMs: 50 });
    child.send({ type: 'shutdown' });
    const result = await waitForExit(child, 10_000);
    assert.equal(result.code, 0);
    await assert.rejects(
      waitForHealth(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 250, intervalMs: 25 }),
      /health|timed out/i,
    );
  } finally {
    await terminateProcessTree(child, { graceMs: 100 }).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`Process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}
