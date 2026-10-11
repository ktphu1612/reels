import { expect, test, type Page, type Route } from '@playwright/test';
import type { MediaResourceV1, Project, RenderJob, TemplateManifest } from '@reelforge/core';

const managed = {
  cardOne: `assets/${'1'.repeat(64)}.webp`,
  cardTwo: `assets/${'2'.repeat(64)}.webp`,
  memeImageOne: `assets/${'3'.repeat(64)}.png`,
  memeVideo: `assets/${'4'.repeat(64)}.mp4`,
  memeSound: `assets/${'5'.repeat(64)}.mp3`,
  intro: `assets/${'6'.repeat(64)}.mp3`,
  transition: `assets/${'7'.repeat(64)}.mp3`,
  music: `assets/${'8'.repeat(64)}.mp3`,
  gameplay: `assets/${'9'.repeat(64)}.mp4`,
} as const;

const imageFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const videoFixture = Buffer.from('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', 'base64');

const template: TemplateManifest = {
  schemaVersion: 2,
  id: 'template-1',
  name: 'Minecraft xanh',
  backgroundPath: managed.gameplay,
  canvas: { width: 720, height: 1280, fps: 30 },
  cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
  memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
};

const voices = {
  google: { id: 'vi-HoaiMy', name: 'Hoài My', languageCode: 'vi-VN' },
  elevenlabs: { id: 'voice-en-demo', name: 'English Demo', languageCode: 'en-US' },
} as const;

const resources: readonly MediaResourceV1[] = [
  { schemaVersion: 1, id: 'meme-image-one', name: 'Confused.png', kind: 'meme-image', assetPath: managed.memeImageOne },
  { schemaVersion: 1, id: 'meme-video-one', name: 'Reaction.mp4', kind: 'meme-video', assetPath: managed.memeVideo },
  { schemaVersion: 1, id: 'meme-sound-one', name: 'Bonk.mp3', kind: 'meme-sound', assetPath: managed.memeSound },
  { schemaVersion: 1, id: 'intro-one', name: 'Intro.mp3', kind: 'intro-sound', assetPath: managed.intro },
  { schemaVersion: 1, id: 'transition-one', name: 'Whoosh.mp3', kind: 'transition-sound', assetPath: managed.transition },
  { schemaVersion: 1, id: 'music-one', name: 'Background.mp3', kind: 'background-music', assetPath: managed.music },
];

type MockState = {
  projects: Project[];
  jobs: RenderJob[];
  nextCard: number;
  statusReads: number;
  previewRequests: unknown[];
  enqueuePayload?: unknown;
  savedProjects: Project[];
  requests: { method: string; path: string; body: string }[];
  pageErrors: string[];
};

function emptyProject(name = 'Mẹo xây nhà'): Project {
  return {
    schemaVersion: 2,
    id: 'project-1',
    name,
    templateId: template.id,
    tts: { provider: 'google', voiceId: voices.google.id, speakingRate: 1 },
    output: { width: 720, height: 1280, fps: 30, crf: 20 },
    cards: [],
  };
}

function makeJob(project: Project, status: RenderJob['status']): RenderJob {
  const now = '2026-08-25T12:00:00.000Z';
  return {
    id: 'job-1',
    status,
    snapshot: { project: structuredClone(project), template },
    progress: status === 'succeeded' ? 100 : status === 'running' ? 42 : 0,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    ...(status === 'succeeded' ? { completedAt: now } : {}),
  };
}

async function mockApi(page: Page): Promise<MockState> {
  const state: MockState = {
    projects: [],
    jobs: [],
    nextCard: 0,
    statusReads: 0,
    previewRequests: [],
    savedProjects: [],
    requests: [],
    pageErrors: [],
  };
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.route('**/api/**', (route) => respond(route, state));
  return state;
}

async function respond(route: Route, state: MockState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  state.requests.push({ method: request.method(), path, body: request.postData() ?? '' });
  const json = (body: unknown, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  if (path === '/api/health') return json({ status: 'ok' });
  if (path === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': heartbeat\n\n' });
  if (path === '/api/templates' && request.method() === 'GET') return json({ templates: [template] });
  if (path === '/api/templates/template-1' && request.method() === 'GET') return json(template);
  if (path === '/api/resources' && request.method() === 'GET') {
    const kind = url.searchParams.get('kind');
    return json({ resources: kind ? resources.filter((resource) => resource.kind === kind) : resources });
  }
  if (path === '/api/projects' && request.method() === 'GET') return json({ projects: state.projects });
  if (path === '/api/projects' && request.method() === 'POST') {
    const body = request.postDataJSON() as { name: string; templateId: string; tts: Project['tts'] };
    const created: Project = {
      ...emptyProject(body.name),
      templateId: body.templateId,
      tts: body.tts,
    };
    state.projects = [created];
    return json(created, 201);
  }
  if (path === '/api/projects/project-1' && request.method() === 'GET') {
    return state.projects[0] ? json(structuredClone(state.projects[0])) : json({ code: 'NOT_FOUND', message: 'Không tìm thấy project.' }, 404);
  }
  if (path === '/api/projects/project-1' && request.method() === 'PUT') {
    const saved = request.postDataJSON() as Project;
    state.projects = [structuredClone(saved)];
    state.savedProjects.push(structuredClone(saved));
    return json(saved);
  }
  if (path === '/api/projects/project-1/cards' && request.method() === 'POST') {
    state.nextCard += 1;
    const imagePath = state.nextCard === 1 ? managed.cardOne : managed.cardTwo;
    const card = {
      id: `card-${state.nextCard}`,
      imagePath,
      script: '',
      order: state.nextCard - 1,
      holdSeconds: 3,
    };
    if (state.projects[0]) state.projects[0] = { ...state.projects[0], cards: [...state.projects[0].cards, card] };
    return json(card, 201);
  }
  if (path === '/api/tts/voices' && request.method() === 'GET') {
    const provider = url.searchParams.get('provider');
    return json({ voices: [provider === 'elevenlabs' ? voices.elevenlabs : voices.google] });
  }
  if (path === '/api/tts/preview' && request.method() === 'POST') {
    state.previewRequests.push(request.postDataJSON());
    return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from('ID3-fixture') });
  }
  if (path === '/api/jobs' && request.method() === 'GET') {
    if (state.jobs[0]?.status === 'running') {
      state.statusReads += 1;
      if (state.statusReads > 1 && state.projects[0]) state.jobs = [makeJob(state.projects[0], 'succeeded')];
    }
    return json({ jobs: state.jobs });
  }
  if (path === '/api/jobs/enqueue' && request.method() === 'POST') {
    state.enqueuePayload = request.postDataJSON();
    if (state.projects[0]) state.jobs = [makeJob(state.projects[0], 'running')];
    state.statusReads = 0;
    return json({ jobs: state.jobs }, 202);
  }
  if (path === '/api/settings' && request.method() === 'GET') {
    return json({
      outputDirectory: 'D:/reelforge/outputs',
      concurrency: 1,
      providers: {
        google: { ready: false },
        elevenlabs: { ready: true, maskedKey: '••••••••9abc' },
      },
    });
  }
  if (path === '/api/settings' && request.method() === 'PUT') return json({ outputDirectory: 'D:/reelforge/outputs', concurrency: 1, providers: { google: { ready: false }, elevenlabs: { ready: true, maskedKey: '••••••••9abc' } } });
  if (path === '/api/tts/credentials/validate') return json({ ready: true, message: 'Đã xác thực' });
  if (path === '/api/system/open-output-directory') return route.fulfill({ status: 204 });
  if (path.startsWith('/api/assets/')) {
    if (path.endsWith('.mp4')) return route.fulfill({ status: 200, contentType: 'video/mp4', body: videoFixture });
    if (path.endsWith('.png') || path.endsWith('.webp')) return route.fulfill({ status: 200, contentType: 'image/png', body: imageFixture });
    return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from('managed-fixture') });
  }
  return json({ code: 'NOT_FOUND', message: 'Fixture route not configured' }, 404);
}

test('persists manual card and meme layouts through render completion', async ({ page }) => {
  const state = await mockApi(page);

  await page.goto('/projects');
  await page.getByRole('button', { name: 'Tạo project' }).first().click();
  const createDialog = page.getByRole('dialog', { name: 'Tạo project mới' });
  await createDialog.getByLabel('Tên project').fill('E2E two-card rich flow');
  await createDialog.getByLabel('Project chỉ dùng card trống (không TTS)').uncheck();
  await createDialog.getByLabel('Provider').selectOption('elevenlabs');
  await expect(createDialog.getByLabel('Voice')).toHaveValue(voices.elevenlabs.id);
  await createDialog.getByLabel('Tốc độ đọc').fill('1.5');
  await createDialog.getByRole('button', { name: 'Tạo project', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Biên tập project' })).toBeVisible();
  await page.getByLabel('Model (tuỳ chọn)').fill('eleven_v3');
  await page.getByLabel('Tốc độ đọc').fill('1.5');
  await page.getByLabel('Thêm ảnh card').setInputFiles([
    { name: 'card-one.webp', mimeType: 'image/webp', buffer: Buffer.from('card-one') },
    { name: 'card-two.webp', mimeType: 'image/webp', buffer: Buffer.from('card-two') },
  ]);
  await expect(page.getByLabel('Script card 1')).toBeVisible();
  await expect(page.getByLabel('Script card 2')).toBeVisible();
  await page.getByLabel('Script card 1').fill('First narration for the test card.');
  await expect(page.getByLabel('Script card 2')).toHaveValue('');
  const blankHold = page.getByRole('slider', { name: 'Thời gian giữ card 2' });
  await expect(blankHold).toHaveValue('3');

  const introPicker = page.getByLabel('Intro sound');
  const transitionPicker = page.getByLabel('Transition sound toàn project');
  await expect(introPicker.locator('option')).toHaveText(['Không chọn', 'Intro.mp3']);
  await expect(transitionPicker.locator('option')).toHaveText(['Không chọn', 'Whoosh.mp3']);
  await introPicker.selectOption(managed.intro);
  await transitionPicker.selectOption(managed.transition);
  await page.getByLabel('Nhạc nền').selectOption(managed.music);

  const memeEditors = page.locator('section[aria-label="Sau card này"]');
  await memeEditors.nth(1).getByLabel('Meme video').selectOption(managed.memeVideo);
  await memeEditors.nth(1).getByLabel('Meme sound').selectOption(managed.memeSound);
  await memeEditors.nth(1).getByRole('button', { name: 'Áp dụng meme' }).click();

  const cardEditor = page.getByTestId('media-layout-editor');
  await expect(cardEditor.getByRole('button', { name: 'Resize top-left' })).toBeVisible();
  await expect(cardEditor.getByRole('button', { name: 'Resize top-right' })).toBeVisible();
  await expect(cardEditor.getByRole('button', { name: 'Resize bottom-left' })).toBeVisible();
  await expect(cardEditor.getByRole('button', { name: 'Resize bottom-right' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Kích thước card' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Vị trí card' })).toHaveCount(0);

  const cardDragSurface = cardEditor.getByTestId('media-layout-drag-surface');
  const cardBeforeDrag = JSON.parse(await cardEditor.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  const cardDragBox = await cardDragSurface.boundingBox();
  expect(cardDragBox).not.toBeNull();
  await page.mouse.move(cardDragBox!.x + cardDragBox!.width / 2, cardDragBox!.y + cardDragBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardDragBox!.x + cardDragBox!.width / 2 + 24, cardDragBox!.y + cardDragBox!.height / 2 + 18);
  await page.mouse.up();
  const cardAfterDrag = JSON.parse(await cardEditor.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  expect(cardAfterDrag.x).toBeGreaterThan(cardBeforeDrag.x);
  expect(cardAfterDrag.y).toBeGreaterThan(cardBeforeDrag.y);
  const cardResizeHandle = cardEditor.getByRole('button', { name: 'Resize bottom-right' });
  const cardResizeBox = await cardResizeHandle.boundingBox();
  expect(cardResizeBox).not.toBeNull();
  await page.mouse.move(cardResizeBox!.x + cardResizeBox!.width / 2, cardResizeBox!.y + cardResizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardResizeBox!.x + cardResizeBox!.width / 2 + 24, cardResizeBox!.y + cardResizeBox!.height / 2 + 24);
  await page.mouse.up();
  const cardLayout = JSON.parse(await cardEditor.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  expect(cardLayout.x).toBeCloseTo(cardAfterDrag.x);
  expect(cardLayout.y).toBeCloseTo(cardAfterDrag.y);
  expect(cardLayout.width).toBeGreaterThan(cardAfterDrag.width);
  expect(cardLayout.height).toBeGreaterThan(cardAfterDrag.height);

  await page.getByRole('button', { name: 'Lưu project', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu phiên bản project hiện tại.' })).toBeVisible();
  expect(state.savedProjects.at(-1)).toMatchObject({
    tts: { provider: 'elevenlabs', modelId: 'eleven_v3', speakingRate: 1.5 },
    introSoundPath: managed.intro,
    transitionSoundPath: managed.transition,
    backgroundMusicPath: managed.music,
    cards: [
      expect.objectContaining({
        script: 'First narration for the test card.',
        layout: cardLayout,
      }),
      expect.objectContaining({
        script: '',
        holdSeconds: 3,
        postCardMeme: expect.objectContaining({ videoPath: managed.memeVideo, soundPath: managed.memeSound }),
      }),
    ],
  });

  await page.goto('/projects/project-1');
  await expect(page.getByLabel('Tốc độ đọc')).toHaveValue('1.5');
  await expect(page.getByLabel('Model (tuỳ chọn)')).toHaveValue('eleven_v3');
  await expect(page.getByLabel('Intro sound', { exact: true })).toHaveValue(managed.intro);
  await expect(page.getByLabel('Transition sound toàn project', { exact: true })).toHaveValue(managed.transition);
  await expect(page.getByLabel('Nhạc nền', { exact: true })).toHaveValue(managed.music);
  await expect(page.getByLabel('Script card 1')).toHaveValue('First narration for the test card.');
  await expect(page.getByLabel('Script card 2')).toHaveValue('');
  await expect(page.getByRole('slider', { name: 'Thời gian giữ card 2' })).toHaveValue('3');
  const reopenedCardEditor = page.getByTestId('media-layout-editor');
  await expect(reopenedCardEditor.getByTestId('media-layout-target')).toHaveAttribute('data-layout', JSON.stringify(cardLayout));

  await page.getByRole('button', { name: 'Preview card 2' }).click();
  await page.getByRole('button', { name: 'Meme sau card' }).click();
  const memeEditor = page.getByTestId('media-layout-editor');
  const memeVideo = memeEditor.getByTestId('media-layout-video');
  await expect(memeVideo).toHaveAttribute('src', /\/api\/assets\/4{64}\.mp4$/);
  await expect(memeVideo).not.toHaveAttribute('muted', '');
  await memeVideo.evaluate((video) => {
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1600 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 900 });
    video.addEventListener('error', (event) => event.stopImmediatePropagation(), true);
    video.dispatchEvent(new Event('loadedmetadata'));
  });
  await expect(memeEditor.getByRole('button', { name: 'Resize top-left' })).toBeVisible();

  const memeDragSurface = memeEditor.getByTestId('media-layout-drag-surface');
  const memeBeforeDrag = JSON.parse(await memeEditor.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  const memeDragBox = await memeDragSurface.boundingBox();
  expect(memeDragBox).not.toBeNull();
  await page.mouse.move(memeDragBox!.x + memeDragBox!.width / 2, memeDragBox!.y + memeDragBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(memeDragBox!.x + memeDragBox!.width / 2 - 20, memeDragBox!.y + memeDragBox!.height / 2 - 16);
  await page.mouse.up();
  const memeAfterDrag = JSON.parse(await memeEditor.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  expect(memeAfterDrag.x).toBeLessThan(memeBeforeDrag.x);
  expect(memeAfterDrag.y).toBeLessThan(memeBeforeDrag.y);
  const memeResizeHandle = memeEditor.getByRole('button', { name: 'Resize bottom-right' });
  const memeResizeBox = await memeResizeHandle.boundingBox();
  expect(memeResizeBox).not.toBeNull();
  await page.mouse.move(memeResizeBox!.x + memeResizeBox!.width / 2, memeResizeBox!.y + memeResizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(memeResizeBox!.x + memeResizeBox!.width / 2 + 18, memeResizeBox!.y + memeResizeBox!.height / 2 + 18);
  await page.mouse.up();
  const memeLayout = JSON.parse(await memeEditor.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  expect(memeLayout.x).toBeCloseTo(memeAfterDrag.x);
  expect(memeLayout.y).toBeCloseTo(memeAfterDrag.y);
  expect(memeLayout.width).toBeGreaterThan(memeAfterDrag.width);
  expect(memeLayout.height).toBeGreaterThan(memeAfterDrag.height);
  await expect(memeEditors.nth(1).getByLabel('Meme video', { exact: true })).toHaveValue(managed.memeVideo);
  await expect(memeEditors.nth(1).getByLabel('Meme sound', { exact: true })).toHaveValue(managed.memeSound);

  await page.getByRole('button', { name: 'Lưu project', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu phiên bản project hiện tại.' })).toBeVisible();
  expect(state.savedProjects.at(-1)).toMatchObject({ cards: [expect.anything(), expect.objectContaining({ postCardMeme: expect.objectContaining({ layout: memeLayout }) })] });

  await page.getByRole('button', { name: 'Card', exact: true }).click();
  await page.getByRole('button', { name: 'Preview card 1' }).click();
  await page.getByRole('button', { name: 'Về bố cục template' }).click();
  const resetCardLayout = JSON.parse(await page.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  expect(resetCardLayout.x).toBeCloseTo(0.2777778);
  expect(resetCardLayout.y).toBeCloseTo(0.38);
  expect(resetCardLayout.width).toBeCloseTo(0.4444444);
  expect(resetCardLayout.height).toBeCloseTo(0.25);

  await page.getByRole('button', { name: 'Preview card 2' }).click();
  await page.getByRole('button', { name: 'Meme sau card' }).click();
  await page.getByTestId('media-layout-video').evaluate((video) => {
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1600 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 900 });
    video.dispatchEvent(new Event('loadedmetadata'));
  });
  await page.getByRole('button', { name: 'Về bố cục template' }).click();
  const resetMemeLayout = JSON.parse(await page.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}');
  expect(resetMemeLayout.x).toBeCloseTo(0.3);
  expect(resetMemeLayout.y).toBeCloseTo(0.72171875);
  expect(resetMemeLayout.width).toBeCloseTo(0.4);
  expect(resetMemeLayout.height).toBeCloseTo(0.1265625);

  await page.getByRole('button', { name: 'Đưa vào hàng đợi' }).click();
  await expect(page.getByRole('heading', { name: 'Hàng đợi render' })).toBeVisible();
  await expect(page.getByText('Đang render', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Đã hoàn tất', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mở thư mục output' })).toBeVisible();

  expect(state.enqueuePayload).toEqual({ projectIds: ['project-1'] });
  expect(state.requests.filter((request) => request.path === '/api/resources' && request.method !== 'GET')).toEqual([]);
  expect(state.requests.some((request) => request.path === '/api/tts/credentials/validate')).toBe(false);
  expect(state.previewRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
