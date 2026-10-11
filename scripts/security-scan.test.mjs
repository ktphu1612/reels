import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scanFilesForSecrets, scanSecuritySurface } from './security-scan.mjs';

test('detects an exact configured key in built frontend bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reelforge-security-'));
  const secret = 'security-sentinel-key-123456789';
  try {
    await mkdir(join(root, 'apps', 'web', 'dist'), { recursive: true });
    const bundle = join(root, 'apps', 'web', 'dist', 'app.js');
    await writeFile(bundle, `window.key=${JSON.stringify(secret)}`);
    const findings = await scanFilesForSecrets([bundle], [secret]);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /app\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts ordinary placeholders and browser-safe managed asset routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reelforge-security-'));
  try {
    const file = join(root, 'safe.js');
    await writeFile(file, 'const key="YOUR_GOOGLE_TTS_API_KEY"; fetch("/api/assets/hash.mp4")');
    assert.deepEqual(await scanFilesForSecrets([file], []), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects every source folder, API key value, and raw path from frontend and API surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reelforge-security-boundary-'));
  const sourceFolders = [
    'D:\\reels\\stickers',
    'D:\\reels\\meme sounds',
    'D:\\reels\\transition sound',
    'D:\\reels\\intro sounds',
    'D:\\reels\\background audio',
  ];
  const secretValues = [
    'eleven-live-secret-value-123456',
    'google-live-secret-value-654321',
  ];
  try {
    for (const sourceFolder of sourceFolders) {
      const report = await scanSecuritySurface({
        rootDirectory: root,
        apiResponses: [{ label: 'project', body: JSON.stringify({ imagePath: sourceFolder }) }],
      });
      assert.equal(report.ok, false, `source folder leaked: ${sourceFolder}`);
      assert.ok(report.violations.some((violation) => /filesystem path/i.test(violation)));
    }

    const frontend = join(root, 'apps', 'web', 'dist', 'index.js');
    await mkdir(join(root, 'apps', 'web', 'dist'), { recursive: true });
    await writeFile(frontend, `${secretValues[0]} ${sourceFolders[0]}`, 'utf8');
    const report = await scanSecuritySurface({
      rootDirectory: root,
      secretValues,
      builtFrontendFiles: [frontend],
      apiResponses: [{ label: 'settings', body: JSON.stringify({ googleKey: secretValues[1], outputPath: sourceFolders[1] }) }],
    });
    assert.equal(report.ok, false);
    assert.ok(report.violations.some((violation) => /secret value appears/i.test(violation)));
    assert.ok(report.violations.some((violation) => /filesystem path/i.test(violation)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts only masked credentials and canonical managed asset paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reelforge-security-managed-'));
  const managedAssets = [
    `assets/${'a'.repeat(64)}.png`,
    `assets/${'b'.repeat(64)}.mp3`,
    `assets/${'c'.repeat(64)}.mp4`,
  ];
  const secretValues = ['eleven-live-secret-value-123456', 'google-live-secret-value-654321'];
  const safePayload = JSON.stringify({
    project: {
      cards: [{ imagePath: managedAssets[0], postCardMeme: { imagePath: managedAssets[0], soundPath: managedAssets[1] } }],
      transitionSoundPath: managedAssets[1],
      backgroundMusicPath: managedAssets[1],
    },
    template: { backgroundPath: managedAssets[2] },
    settings: { elevenlabs: { maskedKey: '••••••••9abc' } },
  });
  try {
    for (const assetPath of managedAssets) assert.match(assetPath, /^assets\/[a-f0-9]{64}\.[a-z0-9]+$/);
    const bundle = join(root, 'apps', 'web', 'dist', 'index.js');
    await mkdir(join(root, 'apps', 'web', 'dist'), { recursive: true });
    await writeFile(bundle, `const payload=${safePayload};`, 'utf8');
    const report = await scanSecuritySurface({
      rootDirectory: root,
      secretValues,
      builtFrontendFiles: [bundle],
      apiResponses: [{ label: 'project', body: safePayload }],
    });
    assert.equal(report.ok, true, report.violations.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
