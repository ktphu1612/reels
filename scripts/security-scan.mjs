import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const excludedDirectories = new Set([
  'node_modules',
  '.git',
  '.git-disabled',
  '.git-partial-recovery',
  '.superpowers',
  'coverage',
  'playwright-report',
  'test-results',
]);
const textExtensions = new Set([
  '.cmd', '.css', '.env', '.html', '.js', '.json', '.jsonl', '.log', '.mjs',
  '.sh', '.sqlite', '.sqlite-shm', '.sqlite-wal', '.ts', '.tsx', '.txt',
]);
const frontendSensitivePathPattern = /(?:[A-Za-z]:[\\/]Users[\\/]|(?:\/Users|\/home|\/private)\/|node:fs|process\.(?:cwd|env)|REELFORGE_HOME)/;
const apiFilesystemPathPattern = /(?:[A-Za-z]:[\\/]|(?:\/Users|\/home|\/private)\/|node:fs|process\.(?:cwd|env)|REELFORGE_HOME)/;

export async function scanSecuritySurface({
  rootDirectory,
  secretValues = [],
  builtFrontendFiles = [],
  apiResponses = [],
} = {}) {
  const root = resolve(rootDirectory);
  const violations = [];
  const files = new Set(await collectCandidateFiles(root));
  for (const file of builtFrontendFiles) files.add(resolve(file));

  for (const file of files) {
    const bytes = await readCandidate(file, violations, root);
    if (!bytes) continue;
    for (const secret of secretValues.filter((value) => typeof value === 'string' && value.length > 0)) {
      if (bytes.includes(Buffer.from(secret, 'utf8'))) {
        const label = relative(root, file) || file;
        violations.push(`secret value appears in ${label}`);
      }
    }
  }

  for (const file of builtFrontendFiles) {
    const absolute = resolve(file);
    const bytes = await readCandidate(absolute, violations, root);
    if (!bytes) continue;
    const source = bytes.toString('utf8');
    const label = relative(root, absolute) || absolute;
    if (frontendSensitivePathPattern.test(source)) {
      violations.push(`frontend filesystem path leakage in ${label}`);
    }
  }

  for (const response of apiResponses) {
    const source = typeof response === 'string' ? response : String(response?.body ?? '');
    for (const secret of secretValues.filter((value) => typeof value === 'string' && value.length > 0)) {
      if (source.includes(secret)) violations.push(`secret value appears in API response ${response?.label ?? 'unnamed'}`);
    }
    if (apiFilesystemPathPattern.test(source)) {
      violations.push(`filesystem path appears in API response ${response?.label ?? 'unnamed'}`);
    }
  }

  return { ok: violations.length === 0, violations, scannedFiles: files.size };
}

export async function scanFilesForSecrets(filePaths, secretValues) {
  const findings = [];
  for (const file of filePaths) {
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      continue;
    }
    for (const secret of secretValues.filter((value) => typeof value === 'string' && value.length > 0)) {
      if (bytes.includes(Buffer.from(secret, 'utf8'))) findings.push(`secret value appears in ${file}`);
    }
  }
  return findings;
}

async function collectCandidateFiles(directory) {
  const candidates = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      candidates.push(...await collectCandidateFiles(fullPath));
    } else if (entry.isFile() && entry.name !== '.env.local' && isCandidateFile(entry.name)) {
      candidates.push(fullPath);
    }
  }
  return candidates;
}

function isCandidateFile(fileName) {
  if (fileName.includes('FDown.vn_Tai_video_Facebook_')) return false;
  const lower = fileName.toLowerCase();
  return [...textExtensions].some((extension) => lower.endsWith(extension));
}

async function readCandidate(file, violations, root) {
  try {
    return await readFile(file);
  } catch (error) {
    violations.push(`security scan could not read ${relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function readEnvSecrets(root) {
  try {
    const source = await readFile(join(root, '.env.local'), 'utf8');
    return source
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*[A-Z0-9_]+\s*=\s*["']?([^"']+?)["']?\s*$/)?.[1]?.trim())
      .filter((value) => value && !/^your_|replace_|<|>/.test(value));
  } catch {
    return [];
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  const rootDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const report = await scanSecuritySurface({
    rootDirectory,
    secretValues: await readEnvSecrets(rootDirectory),
    builtFrontendFiles: await collectCandidateFiles(join(rootDirectory, 'apps', 'web', 'dist')),
  });
  process.stdout.write(`Security scan: ${report.scannedFiles} files, ${report.violations.length} violations\n`);
  if (!report.ok) {
    for (const violation of report.violations) process.stderr.write(`- ${violation}\n`);
    process.exitCode = 1;
  }
}
