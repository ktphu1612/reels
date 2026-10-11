import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertSupportedNode,
  ensureRuntimeLayout,
  installDependencies,
  npmCiInvocation,
  runtimeDirectories,
} from './setup.mjs';

test('requires Node 24 or newer', () => {
  assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
  assert.doesNotThrow(() => assertSupportedNode('26.1.0'));
  assert.throws(() => assertSupportedNode('23.9.0'), /Node\.js 24/i);
  assert.throws(() => assertSupportedNode('invalid'), /Node\.js version/i);
});

test('creates the persistent runtime layout idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reelforge-setup-'));
  try {
    await ensureRuntimeLayout(root);
    await ensureRuntimeLayout(root);
    for (const directory of runtimeDirectories(root)) await access(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invokes npm ci through the Node npm CLI on Windows when npm_execpath is a JS file', () => {
  assert.deepEqual(
    npmCiInvocation({
      platform: 'win32',
      npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'ci'],
      shell: false,
      windowsHide: false,
    },
  );
});

test('falls back to ComSpec for npm.cmd when npm_execpath is unavailable on Windows', () => {
  assert.deepEqual(
    npmCiInvocation({
      platform: 'win32',
      npmExecPath: null,
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      executable: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd ci'],
      shell: false,
      windowsHide: false,
    },
  );
});

test('settles npm ci once and removes child listeners after a successful exit', async () => {
  const child = new EventEmitter();
  const calls = [];
  const promise = installDependencies('D:\\ReelForge Test', {
    platform: 'win32',
    npmExecPath: null,
    comSpec: 'cmd.exe',
    spawnProcess: (executable, args, options) => {
      calls.push({ executable, args, options });
      return child;
    },
  });

  assert.deepEqual(calls, [{
    executable: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd ci'],
    options: {
      cwd: 'D:\\ReelForge Test',
      stdio: 'inherit',
      windowsHide: false,
      shell: false,
    },
  }]);
  child.emit('close', 0);
  await promise;
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
});
