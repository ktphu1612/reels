import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MediaResourceV1 } from '@reelforge/core';
import { ResourcePicker } from './ResourcePicker';

const resources: MediaResourceV1[] = [
  {
    schemaVersion: 1,
    id: 'meme-image-1',
    name: 'Confused.png',
    kind: 'meme-image',
    assetPath: 'assets/confused.png',
  },
  {
    schemaVersion: 1,
    id: 'meme-sound-1',
    name: 'Bonk.mp3',
    kind: 'meme-sound',
    assetPath: 'assets/bonk.mp3',
  },
  {
    schemaVersion: 1,
    id: 'meme-video-1',
    name: 'Reaction.mp4',
    kind: 'meme-video',
    assetPath: 'assets/reaction.mp4',
  },
];

describe('ResourcePicker', () => {
  it('shows an image thumbnail for a selected meme image', () => {
    render(
      <ResourcePicker
        label="Meme image"
        kind="meme-image"
        value="assets/confused.png"
        resources={resources}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('img', { name: 'Confused.png' })).toHaveAttribute('src', '/api/assets/confused.png');
  });

  it('shows an audio control for a selected MP3 resource', () => {
    render(
      <ResourcePicker
        label="Meme sound"
        kind="meme-sound"
        value="assets/bonk.mp3"
        resources={resources}
        onChange={vi.fn()}
      />,
    );

    const audio = document.querySelector('audio');
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', '/api/assets/bonk.mp3');
  });

  it('shows a muted metadata video preview for a selected MP4 resource', () => {
    render(
      <ResourcePicker
        label="Meme video"
        kind="meme-video"
        value="assets/reaction.mp4"
        resources={resources}
        onChange={vi.fn()}
      />,
    );

    const video = document.querySelector('video');
    expect(video).toHaveAttribute('src', '/api/assets/reaction.mp4');
    expect(video).toHaveProperty('muted', true);
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('preload', 'metadata');
  });
});
