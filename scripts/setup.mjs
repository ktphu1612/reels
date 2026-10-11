import { createRequire } from 'node:module';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRequire = createRequire(import.meta.url);

export async function runSetup({
  rootDirectory = resolve(fileURLToPath(new URL('..', import.meta.url))),
  runtimeBaseDirectory = process.env.REELFORGE_HOME || rootDirectory,
  installIfMissing = true,
  log = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  const root = resolve(rootDirectory);
  const runtimeBase = resolve(runtimeBaseDirectory);
  assertSupportedNode(process.versions.node);

  if (!dependenciesAvailable()) {
    if (!installIfMissing) {
      throw new Error('Dependencies are missing. Run npm ci from the repository root, then rerun setup.');
    }
    log('Dependencies are missing; installing the lockfile dependencies with npm ci...');
    await installDependencies(root);
  }

  const binaries = resolveBundledBinaries();
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([
    verifyBinary('ffmpeg', binaries.ffmpegPath),
    verifyBinary('ffprobe', binaries.ffprobePath),
  ]);

  const directories = runtimeDirectories(runtimeBase);
  await ensureRuntimeLayout(runtimeBase);

  log(`Runtime data: ${runtimeBase}`);
  log(`Bundled ffmpeg: ${ffmpegVersion.split(/\r?\n/)[0]}`);
  log(`Bundled ffprobe: ${ffprobeVersion.split(/\r?\n/)[0]}`);
  log('Next commands: npm run dev | npm run build && npm start');

  return { runtimeDirectories: directories, ffmpegVersion, ffprobeVersion };
}

export function assertSupportedNode(version) {
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Could not parse Node.js version: ${version}`);
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`Node.js 24 or newer is required; found ${version}.`);
  }
}

export function runtimeDirectories(root) {
  const runtimeBase = resolve(root);
  return [
    join(runtimeBase, 'data'),
    join(runtimeBase, 'data', 'assets'),
    join(runtimeBase, 'data', 'projects'),
    join(runtimeBase, 'data', 'templates'),
    join(runtimeBase, 'data', 'cache'),
    join(runtimeBase, 'data', 'cache', 'tts'),
    join(runtimeBase, 'data', 'jobs'),
    join(runtimeBase, 'data', 'uploads'),
    join(runtimeBase, 'outputs'),
  ];
}

export async function ensureRuntimeLayout(root) {
  const directories = runtimeDirectories(root);
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
  await assertWritable(join(resolve(root), 'outputs'));
}

function dependenciesAvailable() {
  for (const packageName of ['ffmpeg-static', 'ffprobe-static', 'fastify', 'tsx', 'vite']) {
    try {
      repositoryRequire.resolve(packageName);
    } catch {
      return false;
    }
  }
  return true;
}

function resolveBundledBinaries() {
  let ffmpegPath;
  let ffprobePath;
  try {
    ffmpegPath = repositoryRequire('ffmpeg-static');
    ffprobePath = repositoryRequire('ffprobe-static')?.path;
  } catch (error) {
    throw new Error(`Bundled media tools are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof ffmpegPath !== 'string' || typeof ffprobePath !== 'string') {
    throw new Error('Bundled ffmpeg-static/ffprobe-static files are unavailable. Run npm ci again.');
  }
  return { ffmpegPath, ffprobePath };
}

async function verifyBinary(name, binaryPath) {
  try {
    const information = await stat(binaryPath);
    if (!information.isFile() || information.size === 0) throw new Error('not a non-empty file');
    const result = await execFileAsync(binaryPath, ['-version'], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (!new RegExp(`^${name} version`, 'im').test(output)) {
      throw new Error('version output was not recognized');
    }
    return output;
  } catch (error) {
    throw new Error(
      `Bundled ${name} failed validation at ${binaryPath}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function assertWritable(directory) {
  const probe = join(directory, `.reelforge-setup-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(probe, 'setup write check\n', { encoding: 'utf8', flag: 'wx' });
  } finally {
    await rm(probe, { force: true });
  }
}

export function npmCiInvocation({
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
  nodeExecutable = process.execPath,
  comSpec = process.env.ComSpec || 'cmd.exe',
} = {}) {
  if (typeof npmExecPath === 'string' && npmExecPath.length > 0 && !/\.(?:cmd|bat)$/i.test(npmExecPath)) {
    return {
      executable: nodeExecutable,
      args: [npmExecPath, 'ci'],
      shell: false,
      windowsHide: false,
    };
  }

  if (platform === 'win32') {
    return {
      executable: comSpec,
      args: ['/d', '/s', '/c', 'npm.cmd ci'],
      shell: false,
      windowsHide: false,
    };
  }

  return {
    executable: 'npm',
    args: ['ci'],
    shell: false,
    windowsHide: false,
  };
}

export function installDependencies(root, {
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
  nodeExecutable = process.execPath,
  comSpec = process.env.ComSpec || 'cmd.exe',
  spawnProcess = spawn,
} = {}) {
  const invocation = npmCiInvocation({ platform, npmExecPath, nodeExecutable, comSpec });
  return new Promise((resolveInstall, rejectInstall) => {
    let settled = false;
    let child;
    const cleanup = () => {
      child?.removeListener('error', onError);
      child?.removeListener('close', onClose);
    };
    const settle = (settler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settler(value);
    };
    const onError = (error) => {
      settle(
        rejectInstall,
        new Error(`Could not start npm ci: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
      );
    };
    const onClose = (code, signal) => {
      if (code === 0) settle(resolveInstall);
      else settle(rejectInstall, new Error(`npm ci exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`));
    };

    try {
      child = spawnProcess(invocation.executable, invocation.args, {
        cwd: root,
        stdio: 'inherit',
        windowsHide: invocation.windowsHide,
        shell: invocation.shell,
      });
      child.once('error', onError);
      child.once('close', onClose);
    } catch (error) {
      onError(error);
    }
  });
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  runSetup().catch((error) => {
    process.stderr.write(`Setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
