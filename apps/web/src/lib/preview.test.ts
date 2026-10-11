import { describe, expect, it } from 'vitest';

import { clampCardLayout, defaultManifest, getSlotStyle, previewMediaProps } from './preview';

describe('9:16 preview geometry', () => {
  it('clamps a normalized card layout to the canvas and minimum size', () => {
    expect(clampCardLayout({ x: 0.95, y: 0.95, width: 0.2, height: 0.2 }))
      .toEqual({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 });
    expect(clampCardLayout({ x: 0.2, y: 0.2, width: 0.01, height: 0.02 }))
      .toEqual({ x: 0.2, y: 0.2, width: 0.1, height: 0.1 });
  });

  it('derives default card slot pixels from the manifest canvas', () => {
    expect(getSlotStyle(defaultManifest.cardSlot, defaultManifest.canvas)).toEqual({
      left: '36px',
      top: '486.4px',
      width: '648px',
      height: '320px',
    });
  });

  it('uses overridden normalized slots without duplicated pixel constants', () => {
    expect(getSlotStyle({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, { width: 1000, height: 2000, fps: 30 })).toEqual({
      left: '100px',
      top: '400px',
      width: '500px',
      height: '800px',
    });
  });

  it('configures gameplay as muted looping cover and cards as contained media', () => {
    expect(previewMediaProps('video', '/api/assets/gameplay.mp4')).toMatchObject({
      src: '/api/assets/gameplay.mp4',
      muted: true,
      loop: true,
      objectFit: 'cover',
    });
    expect(previewMediaProps('image', '/api/assets/card.webp')).toMatchObject({
      src: '/api/assets/card.webp',
      objectFit: 'contain',
    });
  });
});
