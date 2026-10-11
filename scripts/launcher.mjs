import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { attachPrefixedOutput, spawnNode, terminateProcessTree, waitForHealth } from './process-supervisor.mjs';
import { assertProductionBuild } from './start.mjs';

export async function runLauncher({
  rootDirectory = fileURLToPath(new URL('..', import.meta.url)),
  openBrowser = true,
  healthTimeoutMs = 20_000,
} = {}) {
  const root = resolve(rootDirectory);
  if (!(await dependenciesPresent(root))) {
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'setup'], root);
  }
  try {
    await assertProductionBuild(root);
  } catch {
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], root);
  }

  const runtimeBaseDirectory = process.env.REELFORGE_HOME || root;
  const environment = {
    ...process.env,
    REELFORGE_HOME: runtimeBaseDirectory,
    REELFORGE_HOST: process.env.REELFORGE_HOST || '127.0.0.1',
    REELFORGE_PORT: process.env.REELFORGE_PORT || '3000',
  };
  const child = spawnNode(join(root, 'scripts', 'start.mjs'), [], {
    cwd: root,
    env: environment,
    ipc: true,
  });
  attachPrefixedOutput(child, 'app');
  const healthUrl = `http://127.0.0.1:${environment.REELFORGE_PORT}/api/health`;
  const applicationUrl = `http://127.0.0.1:${environment.REELFORGE_PORT}/`;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void terminateProcessTree(child, { graceMs: 1_500 });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await Promise.race([
      waitForHealth(healthUrl, { timeoutMs: healthTimeoutMs }),
      waitForExit(child).then(({ code, signal }) => {
        throw new Error(`The application exited before health was ready (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
      }),
    ]);
    process.stdout.write(`ReelForge Studio is ready at ${applicationUrl}\n`);
    if (openBrowser) {
      try {
        await launchBrowser(applicationUrl);
      } catch (error) {
        process.stderr.write(
          `Browser could not be opened automatically: ${error instanceof Error ? error.message : String(error)}. `
          + `Open ${applicationUrl} manually.\n`,
        );
      }
    }
    const result = await waitForExit(child);
    if (!stopped && result.code !== 0) {
      throw new Error(`The application stopped with exit code ${result.code ?? 'unknown'}.`);
    }
    return result.code ?? 0;
  } catch (error) {
    stop();
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function dependenciesPresent(root) {
  const paths = [
    join(root, 'node_modules', 'ffmpeg-static'),
    join(root, 'node_modules', 'ffprobe-static'),
    join(root, 'node_modules', 'tsx'),
    join(root, 'node_modules', 'vite'),
  ];
  try {
    await Promise.all(paths.map((path) => access(path)));
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: false });
    child.once('error', rejectCommand);
    child.once('close', (code) => {
      if (code === 0) resolveCommand();
      else rejectCommand(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown'}`));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit) => {
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
}

function launchBrowser(url) {
  const command = process.platform === 'win32'
    ? { executable: 'explorer.exe', args: [url] }
    : process.platform === 'darwin'
      ? { executable: 'open', args: [url] }
      : { executable: 'xdg-open', args: [url] };
  return new Promise((resolveBrowser, rejectBrowser) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectBrowser(new Error('browser launcher timed out'));
      }
    }, 2_000);
    timer.unref?.();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectBrowser(error);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolveBrowser();
    });
  });
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  const noBrowser = process.argv.includes('--no-browser');
  runLauncher({ openBrowser: !noBrowser }).catch((error) => {
    process.stderr.write(`Launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
