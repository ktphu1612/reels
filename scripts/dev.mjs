import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  attachPrefixedOutput,
  spawnNode,
  terminateProcessTree,
  waitForHealth,
} from './process-supervisor.mjs';

export async function runDevelopmentSupervisor({
  rootDirectory = fileURLToPath(new URL('..', import.meta.url)),
  runtimeBaseDirectory = process.env.REELFORGE_HOME || rootDirectory,
  apiPort = Number(process.env.REELFORGE_PORT ?? 3000),
  webPort = Number(process.env.REELFORGE_WEB_PORT ?? 5173),
} = {}) {
  const root = resolve(rootDirectory);
  const webRoot = join(root, 'apps', 'web');
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const viteCli = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  await Promise.all([access(tsxCli), access(viteCli)]);
  const environment = {
    ...process.env,
    REELFORGE_HOME: resolve(runtimeBaseDirectory),
    REELFORGE_PORT: String(apiPort),
    REELFORGE_HOST: '127.0.0.1',
  };
  const children = [
    { label: 'vite', child: spawnNode(viteCli, ['--host', '127.0.0.1', '--port', String(webPort)], { cwd: webRoot, env: environment }) },
    { label: 'server', child: spawnNode(tsxCli, ['watch', join('apps', 'server', 'src', 'index.ts')], { cwd: root, env: environment }) },
    { label: 'worker', child: spawnNode(tsxCli, ['watch', join('apps', 'worker', 'src', 'index.ts')], { cwd: root, env: environment }) },
  ];
  for (const entry of children) attachPrefixedOutput(entry.child, entry.label);

  let stopping = false;
  let stopPromise;
  const stop = () => {
    if (!stopPromise) {
      stopping = true;
      stopPromise = Promise.all(children.map(({ child }) => terminateProcessTree(child, { graceMs: 1_000 })));
    }
    return stopPromise;
  };
  const signalHandler = () => { void stop(); };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);
  try {
    await Promise.race([
      waitForHealth(`http://127.0.0.1:${apiPort}/api/health`, { timeoutMs: 20_000 }),
      firstChildExit(children).then(({ label }) => { throw new Error(`${label} stopped before the API became healthy`); }),
    ]);
    process.stdout.write(`Development app ready: UI http://127.0.0.1:${webPort} API http://127.0.0.1:${apiPort}\n`);
    const exit = await Promise.race([
      firstChildExit(children),
      new Promise((resolveSignal) => {
        const onSignal = () => resolveSignal({ signal: 'shutdown' });
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
      }),
    ]);
    if (!stopping && exit.signal !== 'shutdown') throw new Error(`${exit.label} stopped unexpectedly`);
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    await stop();
  }
}

function firstChildExit(children) {
  return Promise.race(children.map(({ label, child }) => new Promise((resolveExit) => {
    child.once('close', (code, signal) => resolveExit({ label, code, signal }));
    child.once('error', (error) => resolveExit({ label, code: 1, signal: error.message }));
  })));
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  runDevelopmentSupervisor().catch((error) => {
    process.stderr.write(`Development start failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
