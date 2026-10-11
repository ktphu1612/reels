import { MIN_CARD_LAYOUT_SIZE, type NormalizedRect, type PreviewCanvas } from './preview';

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

export type ResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export function fitMediaToSlot(
  slot: NormalizedRect,
  media: MediaDimensions,
  canvas: PreviewCanvas,
): NormalizedRect | undefined {
  if (!hasPositiveFiniteDimensions(media) || !hasPositiveFiniteDimensions(canvas)) return undefined;
  if (![slot.x, slot.y, slot.width, slot.height].every(Number.isFinite) || slot.width <= 0 || slot.height <= 0) return undefined;

  const normalizedAspect =
    (media.width / media.height) * (canvas.height / canvas.width);
  if (!Number.isFinite(normalizedAspect) || normalizedAspect <= 0) return undefined;

  const width = Math.min(slot.width, slot.height * normalizedAspect);
  const height = width / normalizedAspect;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_CARD_LAYOUT_SIZE || height < MIN_CARD_LAYOUT_SIZE) return undefined;

  return {
    x: slot.x + (slot.width - width) / 2,
    y: slot.y + (slot.height - height) / 2,
    width,
    height,
  };
}

export function moveMediaLayout(
  rect: NormalizedRect,
  delta: NormalizedPoint,
): NormalizedRect {
  return {
    x: clampNumber(rect.x + delta.x, 0, Math.max(0, 1 - rect.width)),
    y: clampNumber(rect.y + delta.y, 0, Math.max(0, 1 - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

export function resizeMediaLayout(
  rect: NormalizedRect,
  corner: ResizeCorner,
  pointer: NormalizedPoint,
  media: MediaDimensions,
  canvas: PreviewCanvas,
): NormalizedRect {
  if (!hasPositiveFiniteDimensions(media) || !hasPositiveFiniteDimensions(canvas) || !isFiniteRect(rect) || !isFinitePoint(pointer)) return rect;

  const fixed = getFixedCorner(rect, corner);
  if (!isFinitePoint(fixed) || fixed.x < 0 || fixed.x > 1 || fixed.y < 0 || fixed.y > 1) return rect;

  const pixelAspect = media.width / media.height;
  if (!isPositiveFinite(pixelAspect)) return rect;

  const deltaWidthPx = Math.abs(pointer.x - fixed.x) * canvas.width;
  const deltaHeightPx = Math.abs(pointer.y - fixed.y) * canvas.height;
  if (!Number.isFinite(deltaWidthPx) || deltaWidthPx < 0 || !Number.isFinite(deltaHeightPx) || deltaHeightPx < 0) return rect;

  const projectedHeightPx = (
    deltaWidthPx * pixelAspect + deltaHeightPx
  ) / (pixelAspect * pixelAspect + 1);
  const projectedWidthPx = pixelAspect * projectedHeightPx;
  if (!isPositiveFinite(projectedHeightPx) || !isPositiveFinite(projectedWidthPx)) return rect;

  const normalizedAspect = pixelAspect * (canvas.height / canvas.width);
  if (!isPositiveFinite(normalizedAspect)) return rect;

  const minimumHeight = Math.max(MIN_CARD_LAYOUT_SIZE, MIN_CARD_LAYOUT_SIZE / normalizedAspect);
  const minimumWidth = normalizedAspect * minimumHeight;
  if (!isPositiveFinite(minimumHeight) || !isPositiveFinite(minimumWidth) || minimumWidth > 1 || minimumHeight > 1) return rect;

  const maximumWidth = corner.endsWith('left') ? fixed.x : 1 - fixed.x;
  const maximumHeight = corner.startsWith('top') ? fixed.y : 1 - fixed.y;
  if (!isPositiveFinite(maximumWidth) || !isPositiveFinite(maximumHeight) || maximumWidth < minimumWidth || maximumHeight < minimumHeight) return rect;

  let height = projectedHeightPx / canvas.height;
  let width = projectedWidthPx / canvas.width;
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return rect;

  if (height < minimumHeight) height = minimumHeight;
  width = height * normalizedAspect;
  if (!isPositiveFinite(width)) return rect;

  const maximumScale = Math.min(1, maximumWidth / width, maximumHeight / height);
  if (!isPositiveFinite(maximumScale)) return rect;

  if (maximumScale < 1) {
    width *= maximumScale;
    height *= maximumScale;
  }

  if (!isPositiveFinite(width) || !isPositiveFinite(height) || width < minimumWidth || height < minimumHeight) return rect;

  const x = corner.endsWith('left') ? fixed.x - width : fixed.x;
  const y = corner.startsWith('top') ? fixed.y - height : fixed.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x + width > 1 || y + height > 1) return rect;

  return {
    x,
    y,
    width,
    height,
  };
}

function getFixedCorner(rect: NormalizedRect, corner: ResizeCorner): NormalizedPoint {
  return {
    x: corner.endsWith('left') ? rect.x + rect.width : rect.x,
    y: corner.startsWith('top') ? rect.y + rect.height : rect.y,
  };
}

function hasPositiveFiniteDimensions(value: { width: number; height: number }): boolean {
  return Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0;
}

function isFiniteRect(rect: NormalizedRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
}

function isFinitePoint(point: NormalizedPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
