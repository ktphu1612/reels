import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ApiProvider } from './api-context';
import { SettingsPage } from '../screens/SettingsPage';
import { createMockApi } from '../test/fixtures';

describe('Settings secrets', () => {
  it('never renders a masked key into a secret input and keeps clear separate from update', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </QueryClientProvider>
      </ApiProvider>,
    );

    const googleKey = await screen.findByLabelText('Google Cloud API key');
    expect(googleKey).toHaveValue('');
    expect(screen.getByText('••••••••9abc')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('D:/reelforge/outputs\\raw-secret');

    await user.click(screen.getByRole('button', { name: 'Xoá key Google Cloud' }));
    await user.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ googleApiKey: null })));
    expect(api.updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ googleApiKey: '••••••••9abc' }));
  });

  it('removes the Settings resource gallery while keeping the Template Library', async () => {
    const api = createMockApi();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </QueryClientProvider>
      </ApiProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Import clean template' })).toBeInTheDocument();
    expect(screen.getByText('03 / TEMPLATE LIBRARY')).toBeInTheDocument();
    expect(screen.queryByText('MEDIA RESOURCES')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Thư viện tài nguyên' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelectorAll('audio[controls]').length).toBe(0);
    expect(api.listResources).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /upload|import tài nguyên/i })).not.toBeInTheDocument();
  });
});
