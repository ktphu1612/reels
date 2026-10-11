import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const runnerPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(runnerPath), '..');
const playwrightConfig = join(webRoot, 'playwright.config.ts');
const resolveFromRunner = createRequire(import.meta.url);
const playwrightCli = resolveFromRunner.resolve('@playwright/test/cli');
const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function createPlaywrightInvocation(userArgs) {
  return {
    command: process.execPath,
    args: [playwrightCli, 'test', '--config', playwrightConfig, ...userArgs],
    options: {
      cwd: webRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    },
  };
}

async function startViteServer() {
  const server = await createServer({
    root: webRoot,
    configFile: join(webRoot, 'vite.config.ts'),
    logLevel: 'warn',
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
    },
  });

  try {
    await server.listen();
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function runPlaywrightChild(userArgs) {
  const invocation = createPlaywrightInvocation(userArgs);
  const child = spawn(invocation.command, invocation.args, invocation.options);
  const signalHandlers = new Map();

  for (const signal of forwardedSignals) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    return await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveResult({ code, signal }));
    });
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

export async function runWithVite(userArgs, dependencies = {}) {
  const startVite = dependencies.startVite ?? startViteServer;
  const runPlaywright = dependencies.runPlaywright ?? runPlaywrightChild;
  const server = await startVite();

  try {
    return await runPlaywright(userArgs);
  } finally {
    await server.close();
  }
}

const processTarget = {
  setExitCode(code) {
    process.exitCode = code;
  },
  raiseSignal(signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exitCode = 128 + (osConstants.signals[signal] ?? 1);
    }
  },
};

export function applyChildResult(result, target = processTarget) {
  if (result.signal) {
    target.raiseSignal(result.signal);
    return;
  }
  target.setExitCode(result.code ?? 1);
}

async function main() {
  try {
    const result = await runWithVite(process.argv.slice(2));
    applyChildResult(result);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === runnerPath) await main();
