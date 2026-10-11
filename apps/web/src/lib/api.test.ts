import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, assetUrl, createApiClient } from './api';

describe('typed API client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a structured server error to a Vietnamese user-facing message', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Project was not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createApiClient(fetcher);

    await expect(client.getProject('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Không tìm thấy project.',
    });
    expect(fetcher).toHaveBeenCalledWith('/api/projects/missing', expect.objectContaining({ method: 'GET' }));
  });

  it('encodes only the managed asset filename and never emits a filesystem URL', () => {
    expect(assetUrl('assets/abc123.webp')).toBe('/api/assets/abc123.webp');
    expect(assetUrl('assets/card preview.webp')).toBe('/api/assets/card%20preview.webp');
    expect(assetUrl('C:\\Users\\secret\\card.webp')).toBe('/api/assets/card.webp');
  });

  it('returns TTS preview audio as a Blob instead of parsing it as JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new TextEncoder().encode('ID3-fixture'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const preview = await createApiClient(fetcher).previewTts({
      provider: 'google',
      voiceId: 'vi-HoaiMy',
      text: 'Một câu preview.',
      speakingRate: 1,
    });

    expect(preview).toBeInstanceOf(Blob);
    expect(preview.type).toBe('audio/mpeg');
    expect(preview.size).toBe(new TextEncoder().encode('ID3-fixture').byteLength);
  });

  it('parses a blank V2 card returned by importCard', async () => {
    const importedCard = {
      id: 'card-blank',
      imagePath: 'assets/card.webp',
      script: '',
      order: 0,
      holdSeconds: 3,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(importedCard), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const image = new File(['image'], 'card.webp', { type: 'image/webp' });

    await expect(createApiClient(fetcher).importCard('project-1', image, '')).resolves.toEqual(importedCard);
    expect(fetcher).toHaveBeenCalledWith('/api/projects/project-1/cards', expect.objectContaining({
      method: 'POST',
      body: expect.any(FormData),
    }));
  });

  it('lists typed media resources with an optional kind filter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        resources: [{
          schemaVersion: 1,
          id: 'meme-sound-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          name: 'Klonk.mp3',
          kind: 'meme-sound',
          assetPath: 'assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const resources = await createApiClient(fetcher).listResources('meme-sound');

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ name: 'Klonk.mp3', kind: 'meme-sound' });
    expect(fetcher).toHaveBeenCalledWith('/api/resources?kind=meme-sound', expect.objectContaining({ method: 'GET' }));
  });

  it('exposes structured details through ApiError without leaking unknown raw errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 'INVALID_INPUT', message: 'bad', details: { field: 'name' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(createApiClient(fetcher).getProject('one')).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ApiError)) return false;
      return error.code === 'INVALID_INPUT' && error.details?.field === 'name';
    });
  });
});
