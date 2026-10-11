import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './routes';
import { ApiProvider } from './api-context';
import { baseProject, createMockApi } from '../test/fixtures';

function renderApp(api = createMockApi(), initialEntries = ['/projects']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(
    <StrictMode>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={initialEntries}>
            <AppRoutes />
          </MemoryRouter>
        </QueryClientProvider>
      </ApiProvider>
    </StrictMode>,
  );
  return {
    api,
    ...rendered,
  };
}

describe('ReelForge Studio project flow', () => {
  it('marks blank cards ready when every card has a valid hold duration', async () => {
    const api = createMockApi();
    api.listProjects = vi.fn().mockResolvedValue([{
      ...baseProject,
      cards: [{ id: 'card-1', imagePath: `assets/${'d'.repeat(64)}.webp`, script: '', order: 0, holdSeconds: 3 }],
    }]);

    renderApp(api);

    expect(await screen.findByText('Đã hoàn tất')).toBeInTheDocument();
  });

  it('creates a blank-only project without listing voices and uses the internal sentinel', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.listVoices = vi.fn().mockRejectedValue(new Error('TTS credentials are unavailable'));

    renderApp(api);

    await user.click(await screen.findByRole('button', { name: 'Tạo project' }));
    await user.type(screen.getByLabelText('Tên project'), 'Video card trống');
    expect(screen.getByLabelText('Project chỉ dùng card trống (không TTS)')).toBeChecked();
    await user.click(screen.getByRole('button', { name: /^Tạo project$/ }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: 'Video card trống',
      templateId: 'template-1',
      tts: { provider: 'google', voiceId: 'not-required-for-blank-cards', speakingRate: 1 },
    }));
    expect(api.listVoices).not.toHaveBeenCalled();
  });

  it('creates a project, adds two cards, previews a voice, saves, and enqueues it', async () => {
    const user = userEvent.setup();
    const { api } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Tạo project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tạo project mới' });
    await user.type(screen.getByLabelText('Tên project'), 'Video mẹo mới');
    await user.selectOptions(screen.getByLabelText('Template'), 'template-1');
    await user.click(screen.getByLabelText('Project chỉ dùng card trống (không TTS)'));
    await user.selectOptions(screen.getByLabelText('Provider'), 'google');
    const voice = await screen.findByLabelText('Voice');
    expect(voice).toBeEnabled();
    await user.selectOptions(voice, 'vi-HoaiMy');
    await user.click(screen.getByRole('button', { name: /^Tạo project$/ }));

    expect(await screen.findByRole('heading', { name: 'Biên tập project' })).toBeInTheDocument();
    expect(dialog).not.toBeInTheDocument();

    const imageInput = screen.getByLabelText('Thêm ảnh card');
    await user.upload(imageInput, [
      new File(['one'], 'one.webp', { type: 'image/webp' }),
      new File(['two'], 'two.webp', { type: 'image/webp' }),
    ]);
    expect(api.importCard).toHaveBeenCalledTimes(2);

    const scripts = await screen.findAllByRole('textbox', { name: /Script card/ });
    await user.clear(scripts[0]);
    await user.type(scripts[0], 'Mẹo đầu tiên cho căn nhà đẹp.');
    await user.clear(scripts[1]);
    await user.type(scripts[1], 'Mẹo thứ hai là dùng ánh sáng.');
    await user.click(screen.getByRole('button', { name: 'Nghe thử script card 1' }));
    expect(api.previewTts).toHaveBeenCalledWith(expect.objectContaining({ text: 'Mẹo đầu tiên cho căn nhà đẹp.' }));

    await user.click(screen.getByRole('button', { name: 'Lưu project' }));
    await waitFor(() => expect(api.saveProject).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Đưa vào hàng đợi' }));
    expect(api.enqueueProjects).toHaveBeenCalledWith([expect.any(String)]);
    expect(await screen.findByRole('heading', { name: 'Hàng đợi render' })).toBeInTheDocument();
    expect(screen.getByText('Đã hoàn tất')).toBeInTheDocument();
  }, 15_000);
});
