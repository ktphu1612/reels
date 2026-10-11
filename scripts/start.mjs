import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  attachPrefixedOutput,
  delay,
  spawnNode,
  terminateProcessTree,
  waitForHealth,
} from './process-supervisor.mjs';

const productionArtifacts = [
  ['built web UI', join('apps', 'web', 'dist', 'index.html')],
  ['compiled API', join('apps', 'server', 'dist', 'index.js')],
  ['compiled worker', join('apps', 'worker', 'dist', 'index.js')],
];

export async function assertProductionBuild(rootDirectory) {
  const root = resolve(rootDirectory);
  const missing = [];
  for (const [label, relativePath] of productionArtifacts) {
    try {
      await access(join(root, relativePath));
    } catch {
      missing.push(`${label}: ${relativePath}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Production build is incomplete. Run npm run build first; missing ${missing.join(', ')}`);
  }
  return true;
}

export async function runProductionSupervisor({
  rootDirectory = fileURLToPath(new URL('..', import.meta.url)),
  runtimeBaseDirectory = process.env.REELFORGE_HOME || rootDirectory,
  port = Number(process.env.REELFORGE_PORT ?? 3000),
  host = process.env.REELFORGE_HOST || '127.0.0.1',
  healthTimeoutMs = 20_000,
  log = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  const root = resolve(rootDirectory);
  await assertProductionBuild(root);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Production port must be an integer from 1 to 65535; received ${port}.`);
  }

  const environment = {
    ...process.env,
    REELFORGE_HOME: resolve(runtimeBaseDirectory),
    REELFORGE_WEB_DIST: join(root, 'apps', 'web', 'dist'),
    REELFORGE_PORT: String(port),
    REELFORGE_HOST: host,
  };
  const children = [
    {
      label: 'server',
      child: spawnNode(join(root, 'apps', 'server', 'dist', 'index.js'), [], { cwd: root, env: environment, ipc: true }),
    },
    {
      label: 'worker',
      child: spawnNode(join(root, 'apps', 'worker', 'dist', 'index.js'), [], { cwd: root, env: environment, ipc: true }),
    },
  ];
  for (const entry of children) attachPrefixedOutput(entry.child, entry.label);

  let stopping = false;
  let stopPromise;
  const stop = () => {
    if (!stopPromise) {
      stopping = true;
      stopPromise = Promise.all(children.map(({ child }) => terminateProcessTree(child, { graceMs: 1_500 })));
    }
    return stopPromise;
  };
  const signalHandler = () => { requestShutdown(); };
  let resolveShutdown;
  const shutdownRequested = new Promise((resolveSignal) => { resolveShutdown = resolveSignal; });
  const requestShutdown = () => {
    void stop();
    resolveShutdown?.({ signal: 'shutdown' });
  };
  const messageHandler = (message) => {
    if (isShutdownMessage(message)) requestShutdown();
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);
  process.on('message', messageHandler);

  try {
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    const healthResult = await Promise.race([
      waitForHealth(healthUrl, { timeoutMs: healthTimeoutMs }),
      shutdownRequested,
      firstChildExit(children).then(({ label, code, signal }) => {
        throw new Error(`${label} process exited before health was ready (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
      }),
    ]);
    if (healthResult?.signal === 'shutdown') return;
    void healthResult;
    log(`Production app ready at ${healthUrl}`);

    const exit = await Promise.race([
      firstChildExit(children),
      shutdownRequested,
    ]);
    if (!stopping && exit.signal !== 'shutdown') {
      throw new Error(`${exit.label} process stopped unexpectedly (code=${exit.code ?? 'none'}, signal=${exit.signal ?? 'none'}).`);
    }
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    process.removeListener('message', messageHandler);
    await stop();
    if (process.connected) process.disconnect();
  }
}

function isShutdownMessage(message) {
  return typeof message === 'object' && message !== null && message.type === 'shutdown';
}

function firstChildExit(children) {
  return Promise.race(children.map(({ label, child }) => new Promise((resolveExit) => {
    child.once('close', (code, signal) => resolveExit({ label, code, signal }));
    child.once('error', (error) => resolveExit({ label, code: 1, signal: error.message }));
  })));
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  runProductionSupervisor().catch(async (error) => {
    process.stderr.write(`Production start failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await delay(0);
    process.exitCode = 1;
  });
}
