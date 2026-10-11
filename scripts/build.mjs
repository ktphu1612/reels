import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertProductionBuild } from './start.mjs';

const workspaces = [
  '@reelforge/core',
  '@reelforge/storage',
  '@reelforge/queue',
  '@reelforge/tts',
  '@reelforge/renderer',
  '@reelforge/server',
  '@reelforge/worker',
  '@reelforge/web',
];

export async function runBuild(rootDirectory = fileURLToPath(new URL('..', import.meta.url))) {
  const npmCommand = process.env.npm_execpath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  for (const workspace of workspaces) {
    const args = process.env.npm_execpath
      ? [process.env.npm_execpath, 'run', 'build', '--workspace', workspace]
      : ['run', 'build', '--workspace', workspace];
    await runCommand(npmCommand, args, {
      cwd: rootDirectory,
      env: process.env,
    });
  }
  await assertProductionBuild(rootDirectory);
  return workspaces;
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      windowsHide: false,
      shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
    });
    child.once('error', rejectCommand);
    child.once('close', (code, signal) => {
      if (code === 0) resolveCommand();
      else rejectCommand(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code ?? 'unknown'}`));
    });
  });
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  runBuild().catch((error) => {
    process.stderr.write(`Build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
