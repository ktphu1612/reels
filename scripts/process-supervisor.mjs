import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function waitForHealth(
  url,
  { timeoutMs = 20_000, intervalMs = 100, fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Health checks require the Node fetch API. Use Node 24 or newer.');
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastFailure = 'no response';
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
      });
      if (response.ok) {
        let body;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        if (!body || body.status === 'ok') return body;
        lastFailure = `unexpected health payload ${JSON.stringify(body)}`;
      } else {
        lastFailure = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    const waitMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await delay(waitMs);
  }
  throw new Error(
    `Timed out waiting for health at ${url} after ${Date.now() - startedAt}ms; `
    + `last failure: ${lastFailure}. Check that the API and worker started and that the port is free.`,
  );
}

export async function terminateProcessTree(child, { graceMs = 2_000 } = {}) {
  if (!child) return;
  const pid = child.pid;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (child.connected && typeof child.send === 'function') child.send({ type: 'shutdown' });
      else if (process.platform !== 'win32' && pid) process.kill(-pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }

  const exitedDuringGrace = await waitForProcess(child, graceMs);
  if (process.platform === 'win32' && pid) {
    try {
      await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        timeout: Math.max(1_000, graceMs),
      });
    } catch {
      // taskkill returns a non-zero code when the root already exited.
    }
  } else if (!exitedDuringGrace && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited between checks.
    }
  }
  await waitForProcess(child, Math.max(5_000, graceMs));
}

export function spawnNode(scriptPath, args = [], options = {}) {
  return spawn(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? (options.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']),
    windowsHide: true,
    detached: options.detached ?? false,
  });
}

export function attachPrefixedOutput(child, label, { stdout = process.stdout, stderr = process.stderr } = {}) {
  pipe(child.stdout, stdout, label);
  pipe(child.stderr, stderr, label);
}

export function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function pipe(source, destination, label) {
  if (!source) return;
  let pending = '';
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) destination.write(`[${label}] ${line}\n`);
  });
  source.on('end', () => {
    if (pending) destination.write(`[${label}] ${pending}\n`);
  });
}

function waitForProcess(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('close', onClose);
  });
}
