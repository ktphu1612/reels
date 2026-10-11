import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('security scan detects fixture secrets in source and runtime artifacts', async () => {
  const { scanSecuritySurface } = await import('../scripts/security-scan.mjs');
  const root = await mkdtemp(join(tmpdir(), 'reelforge-task7-security-'));
  const fixtureKey = 'fixture-api-key-DO-NOT-PERSIST-9876';
  try {
    await writeFile(join(root, 'app.ts'), `export const value = '${fixtureKey}';`, 'utf8');
    await writeFile(join(root, 'data.json'), JSON.stringify({ key: fixtureKey }), 'utf8');
    const report = await scanSecuritySurface({ rootDirectory: root, secretValues: [fixtureKey] });
    assert.equal(report.ok, false);
    assert.ok(report.violations.some((violation) => violation.includes('app.ts')));
    assert.ok(report.violations.some((violation) => violation.includes('data.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('security scan accepts clean source and rejects frontend filesystem/key leakage', async () => {
  const { scanSecuritySurface } = await import('../scripts/security-scan.mjs');
  const root = await mkdtemp(join(tmpdir(), 'reelforge-task7-security-clean-'));
  try {
    await writeFile(join(root, 'source.ts'), 'export const answer = 42;\n', 'utf8');
    await writeFile(join(root, 'apps-web-dist.js'), 'const ok = true;\n', 'utf8');
    const clean = await scanSecuritySurface({ rootDirectory: root, secretValues: ['live-secret-value-1234'] });
    assert.equal(clean.ok, true, clean.violations.join('\n'));

    await writeFile(join(root, 'built.js'), 'const key = "live-secret-value-1234"; const path = "C:/Users/owner/private";', 'utf8');
    const dirty = await scanSecuritySurface({ rootDirectory: root, secretValues: ['live-secret-value-1234'], builtFrontendFiles: [join(root, 'built.js')] });
    assert.equal(dirty.ok, false);
    assert.ok(dirty.violations.some((violation) => /frontend|filesystem|secret/i.test(violation)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps project, job, log, SQLite, and frontend surfaces on canonical managed paths', async () => {
  const { scanSecuritySurface } = await import('../scripts/security-scan.mjs');
  const root = await mkdtemp(join(tmpdir(), 'reelforge-task9-security-'));
  const sourceFolders = [
    String.raw`D:\reels\stickers`,
    String.raw`D:\reels\meme sounds`,
    String.raw`D:\reels\transition sound`,
    String.raw`D:\reels\background audio`,
    String.raw`D:\reels\intro sounds`,
  ];
  const apiKeys = ['eleven-live-secret-value-123456', 'google-live-secret-value-654321'];
  const managed = {
    card: `assets/${'1'.repeat(64)}.webp`,
    memeImage: `assets/${'2'.repeat(64)}.png`,
    memeSound: `assets/${'3'.repeat(64)}.mp3`,
    transition: `assets/${'4'.repeat(64)}.mp3`,
    music: `assets/${'5'.repeat(64)}.mp3`,
    gameplay: `assets/${'6'.repeat(64)}.mp4`,
  };
  const safeProject = {
    schemaVersion: 2,
    tts: { provider: 'elevenlabs', voiceId: 'voice-en-demo', modelId: 'eleven_v3', speakingRate: 1.5 },
    cards: [{ imagePath: managed.card, postCardMeme: { imagePath: managed.memeImage, soundPath: managed.memeSound } }],
    transitionSoundPath: managed.transition,
    backgroundMusicPath: managed.music,
  };
  const safeJob = { snapshot: { project: safeProject, template: { backgroundPath: managed.gameplay } } };
  const safeSurfaces = [
    JSON.stringify(safeProject),
    JSON.stringify(safeJob),
    JSON.stringify({ event: 'render.succeeded', assets: Object.values(managed) }),
    JSON.stringify({ apiKey: '••••••••9abc', assetUrl: `/api/assets/${'2'.repeat(64)}.png` }),
  ];
  try {
    for (const surface of safeSurfaces) {
      for (const sourceFolder of sourceFolders) assert.equal(surface.includes(sourceFolder), false, `source folder leaked: ${sourceFolder}`);
      for (const apiKey of apiKeys) assert.equal(surface.includes(apiKey), false, `API key leaked: ${apiKey}`);
      for (const assetPath of Object.values(managed)) assert.match(assetPath, /^assets\/[a-f0-9]{64}\.[a-z0-9]+$/);
    }

    const clean = await scanSecuritySurface({
      rootDirectory: root,
      secretValues: apiKeys,
      apiResponses: safeSurfaces.map((body, index) => ({ label: `surface-${index}`, body })),
    });
    assert.equal(clean.ok, true, clean.violations.join('\n'));

    const exposed = JSON.stringify({
      projectPath: sourceFolders[0],
      sqlitePath: sourceFolders[1],
      logPath: sourceFolders[2],
      outputPath: sourceFolders[3],
      elevenlabsKey: apiKeys[0],
      googleKey: apiKeys[1],
    });
    const dirty = await scanSecuritySurface({
      rootDirectory: root,
      secretValues: apiKeys,
      apiResponses: [{ label: 'leaky-surface', body: exposed }],
    });
    assert.equal(dirty.ok, false);
    assert.ok(dirty.violations.some((violation) => /secret value appears/i.test(violation)));
    assert.ok(dirty.violations.some((violation) => /filesystem path/i.test(violation)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
