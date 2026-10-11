import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { MediaResourceV1, Project, TemplateManifest, TtsVoice } from '@reelforge/core';
import { ApiProvider } from '../app/api-context';
import type { NormalizedRect } from '../lib/preview';
import { baseProject, createMockApi, resources, template, voices } from '../test/fixtures';
import { EditorPage } from './EditorPage';

const videoResource: MediaResourceV1 = {
  schemaVersion: 1,
  id: 'meme-video-1',
  name: 'Reaction.mp4',
  kind: 'meme-video',
  assetPath: 'assets/reaction.mp4',
};

const introResource: MediaResourceV1 = {
  schemaVersion: 1,
  id: 'intro-sound-1',
  name: 'Intro.mp3',
  kind: 'intro-sound',
  assetPath: 'assets/intro.mp3',
};

const manualCardLayout: NormalizedRect = { x: 0.18, y: 0.23, width: 0.52, height: 0.34 };
const movedCardLayout: NormalizedRect = { x: 0.28, y: 0.23, width: 0.52, height: 0.34 };
const manualMemeLayout: NormalizedRect = { x: 0.14, y: 0.58, width: 0.5, height: 0.26 };
const movedMemeLayout: NormalizedRect = { x: 0.24, y: 0.58, width: 0.5, height: 0.26 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setImageDimensions(image: HTMLImageElement): void {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 600 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1000 });
  fireEvent.load(image);
}

function mockLayoutCanvas(): void {
  const canvas = screen.getByTestId('media-layout-canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    bottom: 640,
    height: 640,
    left: 0,
    right: 360,
    top: 0,
    width: 360,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function dispatchPointerEvent(
  element: HTMLElement,
  type: 'pointerdown' | 'pointermove',
  init: { pointerId: number; clientX?: number; clientY?: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { configurable: true, value: 0 },
    clientX: { configurable: true, value: init.clientX ?? 0 },
    clientY: { configurable: true, value: init.clientY ?? 0 },
    pointerId: { configurable: true, value: init.pointerId },
  });
  element.dispatchEvent(event);
}

function renderEditor(api = createMockApi()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <StrictMode>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/projects/${baseProject.id}`]}>
            <Routes>
              <Route path="/projects/:id" element={<EditorPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ApiProvider>
    </StrictMode>,
  );
}

describe('EditorPage regressions', () => {
  it('renders an explicit card layout through the shared media editor', async () => {
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Script thật', order: 0, layout: manualCardLayout }],
    });

    renderEditor(api);

    const target = await screen.findByTestId('media-layout-target');
    expect(target).toHaveAttribute('data-layout', JSON.stringify(manualCardLayout));
    expect(screen.getByRole('img', { name: 'Preview card 1' })).toHaveAttribute('src', `/api/${'assets/' + 'd'.repeat(64)}.webp`);
  });

  it('renders a meme image or video with its independent layout and native video controls', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.listResources = vi.fn().mockResolvedValue([...resources, videoResource]);
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{
        id: 'card-1',
        imagePath: `assets/${'d'.repeat(64)}.webp`,
        script: 'Script thật',
        order: 0,
        postCardMeme: { videoPath: 'assets/reaction.mp4', soundPath: 'assets/bonk.mp3', layout: manualMemeLayout },
      }],
    });

    renderEditor(api);

    await user.click(await screen.findByRole('button', { name: 'Meme sau card' }));

    expect(await screen.findByTestId('media-layout-target')).toHaveAttribute('data-layout', JSON.stringify(manualMemeLayout));
    expect(screen.getByTestId('media-layout-video')).toHaveAttribute('src', '/api/assets/reaction.mp4');
    expect(screen.getByTestId('media-layout-video')).toHaveAttribute('controls');
  });

  it('updates only the active card layout when card media is dragged', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const secondCardLayout: NormalizedRect = { x: 0.12, y: 0.48, width: 0.42, height: 0.22 };
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [
        { id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Card một', order: 0, layout: manualCardLayout },
        { id: 'card-2', imagePath: `assets/${'e'.repeat(64)}.webp`, script: 'Card hai', order: 1, layout: secondCardLayout },
      ],
    });

    renderEditor(api);
    await screen.findByTestId('media-layout-target');
    setImageDimensions(await screen.findByRole('img', { name: 'Preview card 1' }));
    mockLayoutCanvas();
    await act(async () => {
      dispatchPointerEvent(screen.getByTestId('media-layout-drag-surface'), 'pointerdown', { pointerId: 31, clientX: 180, clientY: 320 });
      dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointermove', { pointerId: 31, clientX: 216, clientY: 320 });
    });
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      cards: [
        expect.objectContaining({ id: 'card-1', layout: expect.objectContaining({ ...movedCardLayout, x: expect.closeTo(movedCardLayout.x, 5) }) }),
        expect.objectContaining({ id: 'card-2', layout: secondCardLayout }),
      ],
    })));
  });

  it('updates only the active card meme layout when meme media is dragged', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const secondMemeLayout: NormalizedRect = { x: 0.3, y: 0.66, width: 0.32, height: 0.2 };
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [
        {
          id: 'card-1',
          imagePath: `assets/${'d'.repeat(64)}.webp`,
          script: 'Card một',
          order: 0,
          layout: manualCardLayout,
          postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: manualMemeLayout },
        },
        {
          id: 'card-2',
          imagePath: `assets/${'e'.repeat(64)}.webp`,
          script: 'Card hai',
          order: 1,
          postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: secondMemeLayout },
        },
      ],
    });

    renderEditor(api);
    await user.click(await screen.findByRole('button', { name: 'Meme sau card' }));
    await screen.findByTestId('media-layout-target');
    setImageDimensions(await screen.findByRole('img', { name: 'Meme image sau card 1' }));
    mockLayoutCanvas();
    await act(async () => {
      dispatchPointerEvent(screen.getByTestId('media-layout-drag-surface'), 'pointerdown', { pointerId: 32, clientX: 180, clientY: 320 });
      dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointermove', { pointerId: 32, clientX: 216, clientY: 320 });
    });
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      cards: [
        expect.objectContaining({
          id: 'card-1',
          layout: manualCardLayout,
          postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: movedMemeLayout },
        }),
        expect.objectContaining({ id: 'card-2', postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: secondMemeLayout } }),
      ],
    })));
  });

  it('does not list voices for blank-only cards until the first script is entered', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      tts: { provider: 'google', voiceId: 'not-required-for-blank-cards', speakingRate: 1 },
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: '', order: 0, holdSeconds: 3 }],
    });

    renderEditor(api);

    const script = await screen.findByLabelText('Script card 1');
    expect(api.listVoices).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Voice')).toBeDisabled();
    expect(screen.getByLabelText('Voice')).toHaveTextContent('Không cần voice');

    await user.type(script, 'Bắt đầu narration');

    await waitFor(() => expect(api.listVoices).toHaveBeenCalledWith('google', 'vi-VN'));
    await waitFor(() => expect(screen.getByLabelText('Voice')).toHaveValue('vi-HoaiMy'));
  });

  it('disables TTS actions until the sentinel voice is replaced after voices resolve', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const voicesDeferred = deferred<TtsVoice[]>();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      tts: { provider: 'google', voiceId: 'not-required-for-blank-cards', speakingRate: 1 },
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Bắt đầu narration', order: 0 }],
    });
    api.listVoices = vi.fn().mockReturnValue(voicesDeferred.promise);

    renderEditor(api);

    const enqueue = await screen.findByRole('button', { name: 'Đưa vào hàng đợi' });
    const preview = await screen.findByRole('button', { name: 'Nghe thử script card 1' });
    expect(enqueue).toBeDisabled();
    expect(preview).toBeDisabled();
    await user.click(enqueue);
    await user.click(preview);
    expect(api.enqueueProjects).not.toHaveBeenCalled();
    expect(api.previewTts).not.toHaveBeenCalled();

    await act(async () => voicesDeferred.resolve([voices[0]]));

    await waitFor(() => expect(screen.getByLabelText('Voice')).toHaveValue(voices[0].id));
    expect(enqueue).toBeEnabled();
    expect(preview).toBeEnabled();
    await user.click(preview);
    await waitFor(() => expect(api.previewTts).toHaveBeenCalledWith(expect.objectContaining({ voiceId: voices[0].id })));
    await user.click(enqueue);
    await waitFor(() => expect(api.enqueueProjects).toHaveBeenCalledWith(['project-1']));
  });

  it('keeps TTS actions disabled and guarded when the voice query errors', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      tts: { provider: 'google', voiceId: 'not-required-for-blank-cards', speakingRate: 1 },
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Bắt đầu narration', order: 0 }],
    });
    api.listVoices = vi.fn().mockRejectedValue(new Error('TTS credentials unavailable'));

    renderEditor(api);

    const enqueue = await screen.findByRole('button', { name: 'Đưa vào hàng đợi' });
    const preview = await screen.findByRole('button', { name: 'Nghe thử script card 1' });
    await waitFor(() => {
      expect(enqueue).toBeDisabled();
      expect(preview).toBeDisabled();
    });
    await user.click(enqueue);
    await user.click(preview);
    expect(api.enqueueProjects).not.toHaveBeenCalled();
    expect(api.previewTts).not.toHaveBeenCalled();
  });

  it('resets only the active card layout', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{
        id: 'card-1',
        imagePath: `assets/${'d'.repeat(64)}.webp`,
        script: 'Script thật',
        order: 0,
        layout: manualCardLayout,
        postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: manualMemeLayout },
      }],
    });

    renderEditor(api);
    await user.click(await screen.findByRole('button', { name: 'Về bố cục template' }));
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalled());
    const savedProject = vi.mocked(api.saveProject).mock.calls.at(-1)?.[0];
    expect(savedProject?.cards[0]).not.toHaveProperty('layout');
    expect(savedProject?.cards[0]?.postCardMeme).toEqual({ imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: manualMemeLayout });
  });

  it('resets only the meme layout while preserving meme media, sound, and card layout', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{
        id: 'card-1',
        imagePath: `assets/${'d'.repeat(64)}.webp`,
        script: 'Script thật',
        order: 0,
        layout: manualCardLayout,
        postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: manualMemeLayout },
      }],
    });

    renderEditor(api);

    await user.click(await screen.findByRole('button', { name: 'Meme sau card' }));
    await user.click(screen.getByRole('button', { name: 'Về bố cục template' }));
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalled());
    const savedProject = vi.mocked(api.saveProject).mock.calls.at(-1)?.[0];
    expect(savedProject?.cards[0]?.layout).toEqual(manualCardLayout);
    expect(savedProject?.cards[0]?.postCardMeme).toEqual({ imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3' });
  });

  it('saves and restores both independent layouts when the editor reopens', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    let persistedProject: Project = {
      ...baseProject,
      cards: [{
        id: 'card-1',
        imagePath: `assets/${'d'.repeat(64)}.webp`,
        script: 'Script thật',
        order: 0,
        layout: manualCardLayout,
        postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: manualMemeLayout },
      }],
    };
    api.getProject = vi.fn(async () => persistedProject);
    api.saveProject = vi.fn(async (nextProject) => {
      persistedProject = nextProject;
      return nextProject;
    });

    const firstRender = renderEditor(api);
    await screen.findByTestId('media-layout-target');
    await user.clear(screen.getByLabelText('Tên project'));
    await user.type(screen.getByLabelText('Tên project'), 'Mẹo xây nhà mới');
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));
    await waitFor(() => expect(api.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      cards: [expect.objectContaining({ layout: manualCardLayout, postCardMeme: expect.objectContaining({ layout: manualMemeLayout }) })],
    })));

    firstRender.unmount();
    renderEditor(api);
    expect(await screen.findByTestId('media-layout-target')).toHaveAttribute('data-layout', JSON.stringify(manualCardLayout));
    await user.click(await screen.findByRole('button', { name: 'Meme sau card' }));
    expect(await screen.findByTestId('media-layout-target')).toHaveAttribute('data-layout', JSON.stringify(manualMemeLayout));
  });

  it('preserves explicit normalized layouts and applies new template slots only to cards without overrides', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const alternateTemplate: TemplateManifest = {
      ...template,
      id: 'template-2',
      name: 'Minecraft đỏ',
      cardSlot: { x: 0.12, y: 0.16, width: 0.62, height: 0.28 },
      memeSlot: { x: 0.2, y: 0.7, width: 0.55, height: 0.2 },
    };
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [
        {
          id: 'card-explicit',
          imagePath: `assets/${'d'.repeat(64)}.webp`,
          script: 'Có override',
          order: 0,
          layout: manualCardLayout,
          postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3', layout: manualMemeLayout },
        },
        {
          id: 'card-default',
          imagePath: `assets/${'e'.repeat(64)}.webp`,
          script: 'Theo template',
          order: 1,
          postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3' },
        },
      ],
    });
    api.listTemplates = vi.fn().mockResolvedValue([template, alternateTemplate]);
    api.getTemplate = vi.fn((id) => Promise.resolve(id === alternateTemplate.id ? alternateTemplate : template));

    renderEditor(api);

    await user.selectOptions(await screen.findByLabelText('Template'), alternateTemplate.id);
    await user.click(await screen.findByRole('button', { name: 'Preview card 2' }));
    await waitFor(() => expect(screen.getByTestId('media-layout-target')).toHaveAttribute('data-layout', JSON.stringify(alternateTemplate.cardSlot)));
    await user.click(screen.getByRole('button', { name: 'Meme sau card' }));
    await waitFor(() => expect(screen.getByTestId('media-layout-target')).toHaveAttribute('data-layout', JSON.stringify(alternateTemplate.memeSlot)));
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      templateId: alternateTemplate.id,
      cards: [
        expect.objectContaining({ layout: manualCardLayout, postCardMeme: expect.objectContaining({ layout: manualMemeLayout }) }),
        expect.objectContaining({ postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3' } }),
      ],
    })));
  });

  it('shows an error notice when the project query fails', async () => {
    const api = createMockApi();
    api.getProject = vi.fn().mockRejectedValue(new Error('project query failed'));

    renderEditor(api);

    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể mở project này.');
    expect(screen.queryByText('Đang mở project…')).not.toBeInTheDocument();
  });

  it('clears Google voice and model before reconciling the first ElevenLabs voice', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const elevenLabsVoices = deferred<TtsVoice[]>();
    const googleVoice: TtsVoice = { id: 'google-voice', name: 'Google Voice', languageCode: 'vi-VN' };
    const elevenLabsVoice: TtsVoice = { id: 'eleven-voice', name: 'Eleven Voice', languageCode: 'vi-VN' };
    let persistedProject: Project = {
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Script thật', order: 0 }],
      tts: { provider: 'google', voiceId: googleVoice.id, modelId: 'google-model', speakingRate: 1 },
    };
    api.getProject = vi.fn(async () => persistedProject);
    api.listVoices = vi.fn((provider) => provider === 'google' ? Promise.resolve([googleVoice]) : elevenLabsVoices.promise);
    api.saveProject = vi.fn(async (project) => {
      persistedProject = project;
      return project;
    });

    renderEditor(api);
    expect(await screen.findByLabelText('Voice')).toHaveValue(googleVoice.id);

    await user.selectOptions(screen.getByLabelText('Provider'), 'elevenlabs');
    expect(screen.getByLabelText('Model (tuỳ chọn)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalled());
    const savedWhileLoading = vi.mocked(api.saveProject).mock.calls.at(-1)?.[0];
    expect(savedWhileLoading?.tts.provider).toBe('elevenlabs');
    expect(savedWhileLoading?.tts.voiceId).toBe('');
    expect(savedWhileLoading?.tts.modelId).toBeUndefined();

    await act(async () => elevenLabsVoices.resolve([elevenLabsVoice]));

    await waitFor(() => expect(screen.getByLabelText('Voice')).toHaveValue(elevenLabsVoice.id));
  });

  it('stores one project transition sound and one background music selection', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const project: Project = {
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Script thật', order: 0 }],
    };
    api.getProject = vi.fn().mockResolvedValue(project);

    renderEditor(api);

    await user.selectOptions(await screen.findByLabelText('Transition sound toàn project'), 'assets/transition.mp3');
    await user.selectOptions(screen.getByLabelText('Nhạc nền'), 'assets/music.mp3');
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      transitionSoundPath: 'assets/transition.mp3',
      backgroundMusicPath: 'assets/music.mp3',
    })));
  });

  it('filters intro sound resources independently from transition sound resources', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.listResources = vi.fn().mockResolvedValue([...resources, introResource]);
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Script thật', order: 0 }],
    });

    renderEditor(api);

    const introPicker = await screen.findByLabelText('Intro sound');
    const transitionPicker = screen.getByLabelText('Transition sound toàn project');
    expect(introPicker.querySelector('option[value="assets/intro.mp3"]')).toBeInTheDocument();
    expect(introPicker.querySelector('option[value="assets/transition.mp3"]')).not.toBeInTheDocument();
    expect(transitionPicker.querySelector('option[value="assets/transition.mp3"]')).toBeInTheDocument();
    expect(transitionPicker.querySelector('option[value="assets/intro.mp3"]')).not.toBeInTheDocument();

    await user.selectOptions(introPicker, 'assets/intro.mp3');
    await user.selectOptions(transitionPicker, 'assets/transition.mp3');
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      introSoundPath: 'assets/intro.mp3',
      transitionSoundPath: 'assets/transition.mp3',
    })));
  });

  it('shows a default hold slider and disables TTS preview for a blank card', async () => {
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: '', order: 0, holdSeconds: 3 }],
    });

    renderEditor(api);

    const hold = await screen.findByRole('slider', { name: 'Thời gian giữ card 1' });
    expect(hold).toHaveAttribute('min', '1');
    expect(hold).toHaveAttribute('max', '5');
    expect(hold).toHaveValue('3');
    expect(screen.getByRole('button', { name: 'Nghe thử script card 1' })).toBeDisabled();
  });

  it('persists a changed blank-card hold duration immutably', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: '', order: 0, holdSeconds: 3 }],
    });

    renderEditor(api);

    const hold = await screen.findByRole('slider', { name: 'Thời gian giữ card 1' });
    fireEvent.change(hold, { target: { value: '4' } });
    await user.click(screen.getByRole('button', { name: 'Lưu project' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      cards: [expect.objectContaining({ id: 'card-1', script: '', holdSeconds: 4 })],
    })));
  });

  it('enqueues a project when its card script is blank but its hold is valid', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: '', order: 0, holdSeconds: 3 }],
    });

    renderEditor(api);

    await user.click(await screen.findByRole('button', { name: 'Đưa vào hàng đợi' }));

    await waitFor(() => expect(api.enqueueProjects).toHaveBeenCalledWith(['project-1']));
  });

  it('imports new cards with an empty script and a three-second hold', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const importedCard = { id: 'card-imported', imagePath: `assets/${'e'.repeat(64)}.webp`, script: '', order: 0, holdSeconds: 3 };
    api.importCard = vi.fn().mockResolvedValue(importedCard);

    renderEditor(api);

    const file = new File(['one'], 'one.webp', { type: 'image/webp' });
    await user.upload(await screen.findByLabelText('Thêm ảnh card'), file);

    await waitFor(() => expect(api.importCard).toHaveBeenCalledWith('project-1', file, ''));
    expect(await screen.findByRole('slider', { name: 'Thời gian giữ card 1' })).toHaveValue('3');
  });

  it('shows the selected ending meme only in the meme preview mode', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const project: Project = {
      ...baseProject,
      cards: [{
        id: 'card-1',
        imagePath: `assets/${'d'.repeat(64)}.webp`,
        script: 'Script thật',
        order: 0,
        postCardMeme: { imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3' },
      }],
    };
    api.getProject = vi.fn().mockResolvedValue(project);

    renderEditor(api);

    expect(screen.queryByTestId('preview-meme')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Meme sau card' }));
    await screen.findByTestId('media-layout-target');
    expect(screen.getByRole('img', { name: 'Meme image sau card 1' })).toHaveAttribute('src', '/api/assets/confused.png');
    expect(screen.queryByTestId('persistent-sticker')).not.toBeInTheDocument();
  });

  it('previews a selected meme video through the managed asset URL', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.listResources = vi.fn().mockResolvedValue([...resources, videoResource]);
    api.getProject = vi.fn().mockResolvedValue({
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: 'Script thật', order: 0 }],
    });

    renderEditor(api);

    await user.selectOptions(await screen.findByLabelText('Meme video'), 'assets/reaction.mp4');
    await user.click(screen.getByRole('button', { name: 'Áp dụng meme' }));
    await user.click(screen.getByRole('button', { name: 'Meme sau card' }));

    const video = await screen.findByTestId('media-layout-video');
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', '/api/assets/reaction.mp4');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('playsinline');
  });
});
