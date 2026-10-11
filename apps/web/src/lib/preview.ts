export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PreviewCanvas {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export const defaultManifest = {
  canvas: { width: 720, height: 1280, fps: 30 },
  cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
  memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
} as const;

export const MIN_CARD_LAYOUT_SIZE = 0.1;

export function clampCardLayout(rect: NormalizedRect): NormalizedRect {
  const width = clampNumber(rect.width, MIN_CARD_LAYOUT_SIZE, 1);
  const height = clampNumber(rect.height, MIN_CARD_LAYOUT_SIZE, 1);

  return {
    x: clampNumber(rect.x, 0, 1 - width),
    y: clampNumber(rect.y, 0, 1 - height),
    width,
    height,
  };
}

export function getSlotStyle(slot: NormalizedRect, canvas: PreviewCanvas): Record<'left' | 'top' | 'width' | 'height', string> {
  return {
    left: toPixels(slot.x * canvas.width),
    top: toPixels(slot.y * canvas.height),
    width: toPixels(slot.width * canvas.width),
    height: toPixels(slot.height * canvas.height),
  };
}

export function previewMediaProps(kind: 'image' | 'video', src: string): {
  src: string;
  objectFit: 'contain' | 'cover';
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
} {
  return kind === 'video'
    ? { src, objectFit: 'cover', muted: true, loop: true, playsInline: true }
    : { src, objectFit: 'contain' };
}

function toPixels(value: number): string {
  return `${Number(value.toFixed(4))}px`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
