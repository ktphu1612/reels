import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import test from 'node:test';

import { applyChildResult, createPlaywrightInvocation, runWithVite } from './run-e2e.mjs';

test('builds a direct Node Playwright invocation and forwards every CLI argument', () => {
  const invocation = createPlaywrightInvocation(['--workers=1', '--grep', 'cancel']);

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.options.shell, false);
  assert.equal(isAbsolute(invocation.options.cwd), true);
  assert.equal(isAbsolute(invocation.args[0]), true);
  assert.match(invocation.args[0], /@playwright[\\/]test[\\/]cli\.js$/);
  assert.deepEqual(invocation.args.slice(1, 3), ['test', '--config']);
  assert.equal(isAbsolute(invocation.args[3]), true);
  assert.match(invocation.args[3], /playwright\.config\.ts$/);
  assert.deepEqual(invocation.args.slice(4), ['--workers=1', '--grep', 'cancel']);
});

test('returns the Playwright exit result only after awaiting Vite close', async () => {
  const events = [];
  const expected = { code: 7, signal: null };

  const result = await runWithVite(['--workers=1'], {
    startVite: async () => {
      events.push('vite:start');
      return { close: async () => { events.push('vite:close'); } };
    },
    runPlaywright: async (args) => {
      events.push(`playwright:${args.join(' ')}`);
      return expected;
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(events, ['vite:start', 'playwright:--workers=1', 'vite:close']);
});

test('awaits Vite close when Playwright rejects and preserves the original error', async () => {
  const events = [];
  const failure = new Error('playwright spawn failed');

  await assert.rejects(
    runWithVite([], {
      startVite: async () => ({ close: async () => { events.push('vite:close'); } }),
      runPlaywright: async () => { throw failure; },
    }),
    (error) => error === failure,
  );

  assert.deepEqual(events, ['vite:close']);
});

test('preserves a Playwright child signal result through Vite teardown', async () => {
  const expected = { code: null, signal: 'SIGTERM' };
  let closed = false;

  const result = await runWithVite([], {
    startVite: async () => ({ close: async () => { closed = true; } }),
    runPlaywright: async () => expected,
  });

  assert.equal(closed, true);
  assert.equal(result, expected);
});

test('forwards child exit codes and signals to the runner process boundary', () => {
  const observed = [];
  const target = {
    setExitCode: (code) => observed.push(['exit', code]),
    raiseSignal: (signal) => observed.push(['signal', signal]),
  };

  applyChildResult({ code: 9, signal: null }, target);
  applyChildResult({ code: null, signal: 'SIGINT' }, target);

  assert.deepEqual(observed, [['exit', 9], ['signal', 'SIGINT']]);
});
