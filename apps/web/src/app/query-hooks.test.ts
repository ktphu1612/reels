import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiProvider } from './api-context';
import { queryKeys, useVoices } from './query-hooks';
import { createMockApi } from '../test/fixtures';

function VoiceQueryProbe({ enabled }: { readonly enabled: boolean }) {
  useVoices('google', enabled);
  return null;
}

describe('resource query keys', () => {
  it('keeps filtered resource lists in separate cache entries', () => {
    expect(queryKeys.resources()).toEqual(['resources', 'all']);
    expect(queryKeys.resources('meme-image')).toEqual(['resources', 'meme-image']);
    expect(queryKeys.resources('meme-sound')).not.toEqual(queryKeys.resources('meme-image'));
  });
});

describe('voice queries', () => {
  it('does not call listVoices when disabled', async () => {
    const api = createMockApi();
    api.listVoices = vi.fn().mockResolvedValue([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const probe = createElement(VoiceQueryProbe, { enabled: false });
    const queryProvider = createElement(QueryClientProvider, { client: queryClient, children: probe });
    render(createElement(ApiProvider, { client: api, children: queryProvider }));

    await Promise.resolve();
    expect(api.listVoices).not.toHaveBeenCalled();
  });
});
