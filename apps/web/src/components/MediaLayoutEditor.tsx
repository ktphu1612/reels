import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react';

import {
  fitMediaToSlot,
  moveMediaLayout,
  resizeMediaLayout,
  type MediaDimensions,
  type NormalizedPoint,
  type ResizeCorner,
} from '../lib/mediaLayout';
import type { NormalizedRect, PreviewCanvas } from '../lib/preview';
import styles from './MediaLayoutEditor.module.css';

const INVALID_METADATA_MESSAGE = 'Không đọc được kích thước media để chỉnh bố cục.';
const INVALID_MEDIA_DIMENSIONS: MediaDimensions = { width: Number.NaN, height: Number.NaN };

export interface MediaLayoutEditorProps {
  readonly kind: 'image' | 'video';
  readonly src: string;
  readonly accessibleName: string;
  readonly value?: NormalizedRect;
  readonly templateSlot: NormalizedRect;
  readonly canvas: PreviewCanvas;
  readonly videoControls?: boolean;
  readonly onChange: (next: NormalizedRect) => void;
  readonly onReset: () => void;
}

type InteractionMode = 'move' | 'resize';

interface CanvasBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface ActiveInteraction {
  readonly pointerId: number;
  readonly mode: InteractionMode;
  readonly corner?: ResizeCorner;
  readonly startPoint: NormalizedPoint;
  readonly startLayout: NormalizedRect;
  readonly canvasBounds: CanvasBounds;
  readonly captureTarget: HTMLElement;
}

export function MediaLayoutEditor({
  kind,
  src,
  accessibleName,
  value,
  templateSlot,
  canvas,
  videoControls = false,
  onChange,
  onReset,
}: MediaLayoutEditorProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const activeInteractionRef = useRef<ActiveInteraction | null>(null);
  const [intrinsicMedia, setIntrinsicMedia] = useState<MediaDimensions | null>(null);
  const [activeInteraction, setActiveInteraction] = useState<ActiveInteraction | null>(null);

  useEffect(() => {
    activeInteractionRef.current = null;
    setActiveInteraction(null);
    setIntrinsicMedia(null);
  }, [kind, src]);

  const fittedLayout = intrinsicMedia ? fitMediaToSlot(templateSlot, intrinsicMedia, canvas) : undefined;
  const layout = value ?? fittedLayout;
  const renderedLayout = layout ?? templateSlot;
  const metadataPending = intrinsicMedia === null;
  const metadataError = intrinsicMedia !== null && fittedLayout === undefined;
  const canMove = !metadataPending && !metadataError && layout !== undefined;
  const canResize = canMove && intrinsicMedia !== null;

  const setIntrinsicDimensions = (dimensions: MediaDimensions) => {
    activeInteractionRef.current = null;
    setActiveInteraction(null);
    setIntrinsicMedia(dimensions);
  };

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    setIntrinsicDimensions({
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight,
    });
  };

  const handleVideoMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    setIntrinsicDimensions({
      width: event.currentTarget.videoWidth,
      height: event.currentTarget.videoHeight,
    });
  };

  const handleMediaError = () => {
    setIntrinsicDimensions(INVALID_MEDIA_DIMENSIONS);
  };

  const beginInteraction = (
    event: ReactPointerEvent<HTMLElement>,
    mode: InteractionMode,
    corner?: ResizeCorner,
  ) => {
    if (!layout || event.button > 0 || (mode === 'move' ? !canMove : !canResize)) return;

    const canvasElement = canvasRef.current;
    if (!canvasElement) return;

    const domRect = canvasElement.getBoundingClientRect();
    const canvasBounds: CanvasBounds = {
      left: domRect.left,
      top: domRect.top,
      width: domRect.width,
      height: domRect.height,
    };
    if (!isUsableCanvasBounds(canvasBounds)) return;

    const interaction: ActiveInteraction = {
      pointerId: event.pointerId,
      mode,
      corner,
      startPoint: toNormalizedPoint(event.clientX, event.clientY, canvasBounds),
      startLayout: layout,
      canvasBounds,
      captureTarget: event.currentTarget,
    };

    activeInteractionRef.current = interaction;
    setActiveInteraction(interaction);
    capturePointer(event.currentTarget, event.pointerId);
    event.preventDefault();
  };

  const handleTargetPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    beginInteraction(event, 'move');
  };

  const handleResizePointerDown = (corner: ResizeCorner) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    beginInteraction(event, 'resize', corner);
  };

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = activeInteractionRef.current;
    if (!interaction || !matchesPointer(interaction, event.pointerId)) return;

    const pointer = toNormalizedPoint(event.clientX, event.clientY, interaction.canvasBounds);
    const next = interaction.mode === 'move'
      ? moveMediaLayout(interaction.startLayout, {
          x: pointer.x - interaction.startPoint.x,
          y: pointer.y - interaction.startPoint.y,
        })
      : intrinsicMedia
        ? resizeMediaLayout(interaction.startLayout, interaction.corner ?? 'bottom-right', pointer, intrinsicMedia, canvas)
        : interaction.startLayout;

    onChange(next);
  };

  const finishInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = activeInteractionRef.current;
    if (!interaction || !matchesPointer(interaction, event.pointerId)) return;

    releasePointer(interaction.captureTarget, interaction.pointerId);
    activeInteractionRef.current = null;
    setActiveInteraction(null);
  };

  return (
    <div className={styles.editor} data-testid="media-layout-editor">
      <div
        ref={canvasRef}
        className={styles.canvas}
        data-testid="media-layout-canvas"
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={finishInteraction}
        onPointerCancel={finishInteraction}
      >
        <div
          className={`${styles.target}${activeInteraction ? ` ${styles.active}` : ''}`}
          data-testid="media-layout-target"
          data-layout={JSON.stringify(renderedLayout)}
          role="group"
          aria-label="Bố cục media"
          style={{ ...toPercentStyle(renderedLayout), touchAction: 'none' }}
        >
          {kind === 'image' ? (
            <img
              className={styles.media}
                src={src}
                alt={accessibleName}
                style={toMediaStyle()}
              onLoad={handleImageLoad}
              onError={handleMediaError}
            />
          ) : (
            <video
              className={styles.media}
              data-testid="media-layout-video"
              src={src}
              aria-label={accessibleName}
              controls={videoControls}
              muted={!videoControls}
              loop
              playsInline
              style={toMediaStyle()}
              onLoadedMetadata={handleVideoMetadata}
              onError={handleMediaError}
            />
          )}
          <div
            className={`${styles.dragSurface}${kind === 'video' && videoControls ? ` ${styles.dragSurfaceWithControls}` : ''}`}
            data-testid="media-layout-drag-surface"
            aria-hidden="true"
            style={{ touchAction: 'none' }}
            onPointerDown={handleTargetPointerDown}
          />
          {!metadataError && intrinsicMedia && (
            <>
              <ResizeHandle corner="top-left" onPointerDown={handleResizePointerDown('top-left')} />
              <ResizeHandle corner="top-right" onPointerDown={handleResizePointerDown('top-right')} />
              <ResizeHandle corner="bottom-left" onPointerDown={handleResizePointerDown('bottom-left')} />
              <ResizeHandle corner="bottom-right" onPointerDown={handleResizePointerDown('bottom-right')} />
            </>
          )}
        </div>
      </div>
      {metadataPending && <div className={styles.pending} role="status">Đang đọc kích thước media để chỉnh bố cục…</div>}
      {metadataError && <div className={styles.error} role="alert">{INVALID_METADATA_MESSAGE}</div>}
      <button type="button" className={styles.resetButton} onClick={onReset}>Về bố cục template</button>
    </div>
  );
}

interface ResizeHandleProps {
  readonly corner: ResizeCorner;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function ResizeHandle({ corner, onPointerDown }: ResizeHandleProps) {
  return (
    <button
      type="button"
      className={`${styles.handle} ${styles[`handle${toClassName(corner)}`]}`}
      aria-label={`Resize ${corner}`}
      data-corner={corner}
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
    />
  );
}

function toPercentStyle(rect: NormalizedRect): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

function toMediaStyle(): CSSProperties {
  return { objectFit: 'contain' };
}

function toNormalizedPoint(clientX: number, clientY: number, bounds: CanvasBounds): NormalizedPoint {
  return {
    x: (clientX - bounds.left) / bounds.width,
    y: (clientY - bounds.top) / bounds.height,
  };
}

function isUsableCanvasBounds(bounds: CanvasBounds): boolean {
  return Number.isFinite(bounds.left)
    && Number.isFinite(bounds.top)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

function capturePointer(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // Pointer capture can fail when a browser has already cancelled the pointer.
  }
}

function matchesPointer(interaction: ActiveInteraction, pointerId: number): boolean {
  return interaction.pointerId === pointerId || pointerId === 0;
}

function releasePointer(element: HTMLElement, pointerId: number): void {
  try {
    element.releasePointerCapture?.(pointerId);
  } catch {
    // The browser can reject release after capture was already lost.
  }
}

function toClassName(corner: ResizeCorner): string {
  return corner
    .split('-')
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
}
