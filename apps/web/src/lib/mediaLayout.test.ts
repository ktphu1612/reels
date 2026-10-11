import { describe, expect, it } from 'vitest';

import { fitMediaToSlot, moveMediaLayout, resizeMediaLayout, type NormalizedPoint, type ResizeCorner } from './mediaLayout';
import type { NormalizedRect, PreviewCanvas } from './preview';

const canvas: PreviewCanvas = { width: 360, height: 640, fps: 30 };
const slot: NormalizedRect = { x: 0.05, y: 0.38, width: 0.9, height: 0.25 };

describe('aspect-preserving media geometry', () => {
  it('fits portrait media centered in the slot', () => {
    expect(fitMediaToSlot(slot, { width: 600, height: 1000 }, canvas)).toEqual({
      x: expect.closeTo(0.366666, 5),
      y: expect.closeTo(0.38, 5),
      width: expect.closeTo(0.266666, 5),
      height: expect.closeTo(0.25, 5),
    });
  });

  it('fits square media centered in the slot', () => {
    expect(fitMediaToSlot(slot, { width: 1000, height: 1000 }, canvas)).toEqual({
      x: expect.closeTo(0.277778, 5),
      y: expect.closeTo(0.38, 5),
      width: expect.closeTo(0.444444, 5),
      height: expect.closeTo(0.25, 5),
    });
  });

  it('fits landscape media centered in the slot', () => {
    expect(fitMediaToSlot(slot, { width: 1600, height: 900 }, canvas)).toEqual({
      x: expect.closeTo(0.104938, 5),
      y: expect.closeTo(0.38, 5),
      width: expect.closeTo(0.790123, 5),
      height: expect.closeTo(0.25, 5),
    });
  });

  it.each([
    ['zero width', { width: 0, height: 1000 }],
    ['negative width', { width: -1, height: 1000 }],
    ['NaN height', { width: 600, height: Number.NaN }],
    ['extreme portrait ratio', { width: 1, height: 10000 }],
    ['extreme landscape ratio', { width: 10000, height: 1 }],
  ] as const)('returns undefined for %s media that cannot meet the minimum size', (_label, media) => {
    expect(fitMediaToSlot(slot, media, canvas)).toBeUndefined();
  });

  it.each([
    ['extreme portrait ratio', { width: 1, height: 10000 }],
    ['extreme landscape ratio', { width: 10000, height: 1 }],
  ] as const)('leaves the rect unchanged when %s cannot meet both resize minimums', (_label, media) => {
    const rect = { x: 0.2, y: 0.2, width: 0.32, height: 0.3 };

    expect(resizeMediaLayout(rect, 'bottom-right', { x: 0.8, y: 0.8 }, media, canvas)).toEqual(rect);
  });

  it('leaves the rect unchanged when a finite huge pointer overflows pixel projection', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.32, height: 0.3 };

    expect(resizeMediaLayout(rect, 'bottom-right', { x: Number.MAX_VALUE, y: Number.MAX_VALUE }, { width: 600, height: 1000 }, canvas))
      .toEqual(rect);
  });

  it('leaves the rect unchanged when the projected resize is non-positive', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.32, height: 0.3 };

    expect(resizeMediaLayout(rect, 'bottom-right', { x: 0.2, y: 0.2 }, { width: 600, height: 1000 }, canvas))
      .toEqual(rect);
  });

  it.each([
    ['top edge', { x: 0.1, y: -0.5 }, { x: 0.3, y: 0, width: 0.4, height: 0.5 }],
    ['left edge', { x: -0.5, y: 0.1 }, { x: 0, y: 0.4, width: 0.4, height: 0.5 }],
    ['right edge', { x: 0.8, y: 0.1 }, { x: 0.6, y: 0.4, width: 0.4, height: 0.5 }],
    ['bottom edge', { x: 0.1, y: 0.8 }, { x: 0.3, y: 0.5, width: 0.4, height: 0.5 }],
  ] as const)('clamps a move at the %s without changing size', (_label, delta, expected) => {
    expect(moveMediaLayout({ x: 0.2, y: 0.3, width: 0.4, height: 0.5 }, delta)).toEqual({
      x: expect.closeTo(expected.x, 5),
      y: expect.closeTo(expected.y, 5),
      width: expected.width,
      height: expected.height,
    });
  });

  const resizeRect: NormalizedRect = { x: 0.2, y: 0.2, width: 0.32, height: 0.3 };
  const portraitMedia = { width: 600, height: 1000 };
  const resizeCases: ReadonlyArray<{
    corner: ResizeCorner;
    pointer: NormalizedPoint;
    fixed: NormalizedPoint;
    expected: NormalizedRect;
  }> = [
    {
      corner: 'top-left',
      pointer: { x: -1, y: -1 },
      fixed: { x: 0.52, y: 0.5 },
      expected: { x: 0, y: 0.0125, width: 0.52, height: 0.4875 },
    },
    {
      corner: 'top-right',
      pointer: { x: 0.19, y: 0.49 },
      fixed: { x: 0.2, y: 0.5 },
      expected: { x: 0.2, y: 0.4, width: 0.1066666667, height: 0.1 },
    },
    {
      corner: 'bottom-left',
      pointer: { x: 0.12, y: 0.575 },
      fixed: { x: 0.52, y: 0.2 },
      expected: { x: 0.12, y: 0.2, width: 0.4, height: 0.375 },
    },
    {
      corner: 'bottom-right',
      pointer: { x: 0.6, y: 0.575 },
      fixed: { x: 0.2, y: 0.2 },
      expected: { x: 0.2, y: 0.2, width: 0.4, height: 0.375 },
    },
  ];

  it.each(resizeCases)('resizes from $corner while keeping the opposite corner fixed', ({ corner, pointer, fixed, expected }) => {
    const result = resizeMediaLayout(resizeRect, corner, pointer, portraitMedia, canvas);

    expect(result).toEqual({
      x: expect.closeTo(expected.x, 5),
      y: expect.closeTo(expected.y, 5),
      width: expect.closeTo(expected.width, 5),
      height: expect.closeTo(expected.height, 5),
    });
    expect(result.width).toBeGreaterThanOrEqual(0.1);
    expect(result.height).toBeGreaterThanOrEqual(0.1);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + result.width).toBeLessThanOrEqual(1);
    expect(result.y + result.height).toBeLessThanOrEqual(1);
    expect((result.width * canvas.width) / (result.height * canvas.height)).toBeCloseTo(portraitMedia.width / portraitMedia.height, 5);

    if (corner === 'top-left') {
      expect(result.x + result.width).toBeCloseTo(fixed.x, 5);
      expect(result.y + result.height).toBeCloseTo(fixed.y, 5);
    } else if (corner === 'top-right') {
      expect(result.x).toBeCloseTo(fixed.x, 5);
      expect(result.y + result.height).toBeCloseTo(fixed.y, 5);
    } else if (corner === 'bottom-left') {
      expect(result.x + result.width).toBeCloseTo(fixed.x, 5);
      expect(result.y).toBeCloseTo(fixed.y, 5);
    } else {
      expect(result.x).toBeCloseTo(fixed.x, 5);
      expect(result.y).toBeCloseTo(fixed.y, 5);
    }
  });

  it.each([
    ['square', { width: 1000, height: 1000 }],
    ['landscape', { width: 1600, height: 900 }],
  ] as const)('keeps %s resize aspect and bounds valid', (_label, media) => {
    const result = resizeMediaLayout(resizeRect, 'bottom-right', { x: 0.8, y: 0.8 }, media, canvas);

    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + result.width).toBeLessThanOrEqual(1);
    expect(result.y + result.height).toBeLessThanOrEqual(1);
    expect(result.width).toBeGreaterThanOrEqual(0.1);
    expect(result.height).toBeGreaterThanOrEqual(0.1);
    expect((result.width * canvas.width) / (result.height * canvas.height)).toBeCloseTo(media.width / media.height, 5);
  });
});
