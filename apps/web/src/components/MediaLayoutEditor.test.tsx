import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { NormalizedRect, PreviewCanvas } from '../lib/preview';
import { MediaLayoutEditor } from './MediaLayoutEditor';

const canvas: PreviewCanvas = { width: 360, height: 640, fps: 30 };
const templateSlot: NormalizedRect = { x: 0.05, y: 0.38, width: 0.9, height: 0.25 };
const suppliedValue: NormalizedRect = { x: 0.2, y: 0.2, width: 0.32, height: 0.3 };

function setMediaDimension(element: HTMLElement, property: string, value: number): void {
  Object.defineProperty(element, property, { configurable: true, value });
}

function dispatchPointerEvent(
  element: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
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

function mockCanvasRect(): void {
  const canvasElement = screen.getByTestId('media-layout-canvas');
  vi.spyOn(canvasElement, 'getBoundingClientRect').mockReturnValue({
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

function renderReadyImage(onChange: (next: NormalizedRect) => void = vi.fn()) {
  render(
    <MediaLayoutEditor
      kind="image"
      src="/api/assets/card.webp"
      accessibleName="Ảnh card"
      value={suppliedValue}
      templateSlot={templateSlot}
      canvas={canvas}
      onChange={onChange}
      onReset={vi.fn()}
    />,
  );

  const image = screen.getByRole('img', { name: 'Ảnh card' });
  setMediaDimension(image, 'naturalWidth', 600);
  setMediaDimension(image, 'naturalHeight', 1000);
  fireEvent.load(image);
  mockCanvasRect();

  return { image, onChange };
}

describe('MediaLayoutEditor', () => {
  it('uses a supplied image layout and keeps image rendering contained', () => {
    const onChange = vi.fn();
    render(
      <MediaLayoutEditor
        kind="image"
        src="/api/assets/card.webp"
        accessibleName="Ảnh card"
        value={suppliedValue}
        templateSlot={templateSlot}
        canvas={canvas}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByTestId('media-layout-target')).toHaveAttribute('data-layout', JSON.stringify(suppliedValue));
    expect(screen.getByRole('img', { name: 'Ảnh card' })).toHaveStyle({ objectFit: 'contain' });
    expect(screen.getByRole('status')).toHaveTextContent('Đang đọc kích thước media để chỉnh bố cục…');
    expect(screen.queryByRole('button', { name: 'Resize top-left' })).not.toBeInTheDocument();

    mockCanvasRect();
    dispatchPointerEvent(screen.getByTestId('media-layout-drag-surface'), 'pointerdown', { pointerId: 10, clientX: 180, clientY: 320 });
    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointermove', { pointerId: 10, clientX: 216, clientY: 320 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fits an image with missing value inside the template slot after load', () => {
    render(
      <MediaLayoutEditor
        kind="image"
        src="/api/assets/card.webp"
        accessibleName="Ảnh card"
        templateSlot={templateSlot}
        canvas={canvas}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    const image = screen.getByRole('img', { name: 'Ảnh card' });
    setMediaDimension(image, 'naturalWidth', 600);
    setMediaDimension(image, 'naturalHeight', 1000);
    fireEvent.load(image);

    expect(JSON.parse(screen.getByTestId('media-layout-target').getAttribute('data-layout') ?? '{}')).toEqual({
      x: expect.closeTo(0.366666, 5),
      y: expect.closeTo(0.38, 5),
      width: expect.closeTo(0.266666, 5),
      height: expect.closeTo(0.25, 5),
    });
  });

  it('reads video metadata, fits the video, and preserves requested controls', () => {
    render(
      <MediaLayoutEditor
        kind="video"
        src="/api/assets/gameplay.mp4"
        accessibleName="Video gameplay"
        templateSlot={templateSlot}
        canvas={canvas}
        videoControls
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    const video = screen.getByTestId('media-layout-video');
    setMediaDimension(video, 'videoWidth', 1600);
    setMediaDimension(video, 'videoHeight', 900);
    fireEvent.loadedMetadata(video);

    expect(video).toHaveAttribute('controls');
    expect(video).toHaveStyle({ objectFit: 'contain' });
    expect(screen.getByTestId('media-layout-target')).toHaveAttribute('data-layout', expect.any(String));
    expect(screen.getByTestId('media-layout-target')).toHaveAttribute('data-layout', expect.stringContaining('0.790123'));
  });

  it('keeps video audio available with native controls while defaulting to muted without them', () => {
    const { rerender } = render(
      <MediaLayoutEditor
        kind="video"
        src="/api/assets/reaction.mp4"
        accessibleName="Video meme"
        templateSlot={templateSlot}
        canvas={canvas}
        videoControls
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    const video = screen.getByTestId('media-layout-video');
    expect(video).toHaveProperty('muted', false);

    rerender(
      <MediaLayoutEditor
        kind="video"
        src="/api/assets/reaction.mp4"
        accessibleName="Video meme"
        templateSlot={templateSlot}
        canvas={canvas}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(video).toHaveProperty('muted', true);
  });

  it('uses a video body drag surface while native video pointerdown stays inert', () => {
    const onChange = vi.fn<(next: NormalizedRect) => void>();
    render(
      <MediaLayoutEditor
        kind="video"
        src="/api/assets/gameplay.mp4"
        accessibleName="Video gameplay"
        templateSlot={templateSlot}
        canvas={canvas}
        videoControls
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );

    const video = screen.getByTestId('media-layout-video');
    setMediaDimension(video, 'videoWidth', 1600);
    setMediaDimension(video, 'videoHeight', 900);
    fireEvent.loadedMetadata(video);
    mockCanvasRect();

    const dragSurface = screen.getByTestId('media-layout-drag-surface');
    expect(getComputedStyle(dragSurface).bottom).toBe('3rem');
    expect(dragSurface.style.touchAction).toBe('none');

    dispatchPointerEvent(dragSurface, 'pointerdown', { pointerId: 21, clientX: 180, clientY: 320 });
    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointermove', { pointerId: 21, clientX: 216, clientY: 320 });
    expect(onChange).toHaveBeenCalledTimes(1);

    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointerup', { pointerId: 21 });
    const callsAfterSurfaceDrag = onChange.mock.calls.length;
    dispatchPointerEvent(video, 'pointerdown', { pointerId: 22, clientX: 180, clientY: 320 });
    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointermove', { pointerId: 22, clientX: 216, clientY: 320 });

    expect(onChange).toHaveBeenCalledTimes(callsAfterSurfaceDrag);
  });

  it('shows the exact metadata error and no resize handles for invalid dimensions', () => {
    render(
      <MediaLayoutEditor
        kind="image"
        src="/api/assets/broken.webp"
        accessibleName="Ảnh lỗi"
        templateSlot={templateSlot}
        canvas={canvas}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    const image = screen.getByRole('img', { name: 'Ảnh lỗi' });
    setMediaDimension(image, 'naturalWidth', 0);
    setMediaDimension(image, 'naturalHeight', 0);
    fireEvent.load(image);

    expect(screen.getByRole('alert')).toHaveTextContent('Không đọc được kích thước media để chỉnh bố cục.');
    expect(screen.queryByRole('button', { name: 'Resize top-left' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resize top-right' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resize bottom-left' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resize bottom-right' })).not.toBeInTheDocument();
  });

  it('renders all four corner handles without the legacy preset groups', () => {
    renderReadyImage();

    expect(screen.getByTestId('media-layout-drag-surface').style.touchAction).toBe('none');
    expect(screen.getByRole('button', { name: 'Resize top-left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resize top-right' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resize bottom-left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resize bottom-right' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Kích thước card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Vị trí card' })).not.toBeInTheDocument();
  });

  it('moves the body with normalized pointer deltas and releases capture on pointer up', () => {
    const onChange = vi.fn<(next: NormalizedRect) => void>();
    renderReadyImage(onChange);

    const target = screen.getByTestId('media-layout-drag-surface');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(target, 'setPointerCapture', { configurable: true, value: setPointerCapture });
    Object.defineProperty(target, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });

    dispatchPointerEvent(target, 'pointerdown', { pointerId: 11, clientX: 180, clientY: 320 });
    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointermove', { pointerId: 11, clientX: 216, clientY: 320 });

    expect(onChange).toHaveBeenLastCalledWith({ x: 0.3, y: 0.2, width: 0.32, height: 0.3 });

    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointerup', { pointerId: 11 });
    expect(setPointerCapture).toHaveBeenCalledWith(11);
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
  });

  it('resizes from a corner with aspect-preserving Task 3 geometry and releases on cancel', () => {
    const onChange = vi.fn<(next: NormalizedRect) => void>();
    renderReadyImage(onChange);

    const handle = screen.getByRole('button', { name: 'Resize bottom-right' });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(handle, 'setPointerCapture', { configurable: true, value: setPointerCapture });
    Object.defineProperty(handle, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });

    dispatchPointerEvent(handle, 'pointerdown', { pointerId: 12, clientX: 187.2, clientY: 320 });
    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointermove', { pointerId: 12, clientX: 216, clientY: 368 });

    expect(onChange).toHaveBeenLastCalledWith({
      x: expect.closeTo(0.2, 5),
      y: expect.closeTo(0.2, 5),
      width: expect.closeTo(0.4, 5),
      height: expect.closeTo(0.375, 5),
    });

    dispatchPointerEvent(screen.getByTestId('media-layout-canvas'), 'pointercancel', { pointerId: 12 });
    expect(setPointerCapture).toHaveBeenCalledWith(12);
    expect(releasePointerCapture).toHaveBeenCalledWith(12);
  });

  it('resets through the button without starting a drag', () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <MediaLayoutEditor
        kind="image"
        src="/api/assets/card.webp"
        accessibleName="Ảnh card"
        value={suppliedValue}
        templateSlot={templateSlot}
        canvas={canvas}
        onChange={onChange}
        onReset={onReset}
      />,
    );

    const reset = screen.getByRole('button', { name: 'Về bố cục template' });
    dispatchPointerEvent(reset, 'pointerdown', { pointerId: 13, clientX: 24, clientY: 24 });
    fireEvent.click(reset);

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
