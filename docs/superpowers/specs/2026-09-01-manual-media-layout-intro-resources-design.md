# Manual Media Layout and Intro Resources Design

## Scope

Extend the existing ReelForge editor so card images, post-card meme images, and post-card meme videos share one direct-manipulation layout workflow. Add a dedicated `intro sounds` resource folder and resource kind. Preserve all existing narration, timeline, audio mixing, queue, and output behavior.

This change replaces the current card size/position preset controls. It does not add cropping, freeform rotation, a timeline editor, new audio formats, or legacy-project migration.

## Approved behavior

### Direct layout editing

- Card images, meme images, and meme videos can be dragged in Preview to change position.
- Each visual has four corner resize handles.
- Dragging a resize handle keeps the opposite corner fixed.
- Resizing always preserves the source media aspect ratio.
- Visuals remain fully inside the 9:16 canvas.
- The editable border and handles follow the visible media rectangle, not unused space in a template slot.
- The existing size and vertical-position preset buttons are removed.
- A reset action removes the visual's explicit layout and returns it to its template slot.

Card layout remains per card. Meme layout is stored separately for each card's post-card meme. The same controls apply to meme images and meme videos.

### Default layout

When no explicit layout exists:

- a card uses `template.cardSlot`;
- a meme image or video uses `template.memeSlot`.

For editing, the UI reads the media's intrinsic dimensions and calculates the largest aspect-correct visible rectangle contained in the relevant template slot. The first drag or resize persists that normalized rectangle. Reset removes it again.

If intrinsic dimensions have not loaded, layout manipulation is disabled and the editor shows a short actionable message. The media remains previewable in its template slot.

## Data model

Keep `schemaVersion: 2`. Do not create Project V3 or add a legacy migration.

`ProjectCardV2.layout?: NormalizedRect` remains unchanged for card images.

Add an optional layout to both post-card meme variants:

```ts
type PostCardMeme =
  | {
      imagePath: string;
      soundPath: string;
      layout?: NormalizedRect;
    }
  | {
      videoPath: string;
      soundPath?: string;
      layout?: NormalizedRect;
    };
```

The existing normalized canvas-bound validation and `0.1` minimum width/height apply. UI resize logic enforces both minimum dimensions while preserving aspect ratio. If an extreme intrinsic aspect ratio cannot satisfy those minimums and still fit inside the canvas, manual editing is disabled for that visual and the template slot remains in use. The schema does not attempt to validate source aspect ratio because intrinsic media dimensions are not part of project JSON.

## Layout geometry

All persisted rectangles use normalized canvas coordinates.

The editor converts pointer coordinates through the actual preview bounding rectangle:

- dragging translates `x/y` without changing `width/height`;
- corner resizing derives the new size from the fixed opposite corner;
- the source pixel aspect ratio is converted through the preview canvas aspect ratio;
- every update is clamped so the complete rectangle remains inside the canvas.

The same geometry helper is used for card, meme-image, and meme-video overlays. Pointer capture handles pointer up and cancel outside the visual. Mouse, pen, and touch use the same pointer-event path.

Changing templates preserves explicit manual rectangles as normalized canvas positions. Reset is the explicit way to return a visual to the new template slot.

## Preview and renderer

Preview modes remain:

- **Card** edits the active card image.
- **Meme sau card** edits the active card's selected meme image or meme video.

The FFmpeg renderer resolves:

```ts
card.layout ?? template.cardSlot
card.postCardMeme.layout ?? template.memeSlot
```

Card and meme layers continue using `contain`; no crop or distortion is introduced. Existing card crossfades, meme duration, final-frame video hold, original meme-video audio, optional extra meme sound, transition placement, narration, background music ducking, and output encoding remain unchanged.

## Dedicated intro resources

Add media resource kind `intro-sound`.

The local resource directories become:

| Folder | Resource kind | Accepted files |
| --- | --- | --- |
| `stickers` | `meme-image` / `meme-video` | PNG/JPEG/WebP and MP4 |
| `meme sounds` | `meme-sound` | MP3 |
| `transition sound` | `transition-sound` | MP3 |
| `intro sounds` | `intro-sound` | MP3 |
| `background audio` | `background-music` | MP3 |

The Intro Sound picker lists only `intro-sound`. The Transition Sound picker lists only `transition-sound`. Renderer preflight validates each path against its distinct resource kind. Intro timing does not change: card one and intro start at time zero, then narration and background music start when intro ends.

No WAV support is added.

## Error handling

- Missing or invalid intrinsic media dimensions, or an aspect ratio that cannot satisfy the existing minimum layout bounds, disable manual editing for that visual and show a concise UI error.
- Pointer updates that would leave the canvas are clamped rather than rejected.
- Project validation rejects malformed or out-of-bounds persisted rectangles.
- Resource scanning ignores unsupported intro files consistently with the other MP3-only audio folders.
- Existing render failures remain structured and redacted.

## Testing

### Unit

- Aspect-correct fit inside card and meme template slots.
- Drag clamping on all canvas edges.
- Four-corner resize with fixed opposite corner and source aspect ratio.
- Minimum-size and maximum-fit behavior for portrait, square, and landscape media.
- Pointer capture, pointer cancel, and reset.
- Post-card meme layout schema acceptance and bounds rejection.
- `intro-sound` resource classification and stale-entry removal.

### Integration

- Project storage round-trips independent card and meme layouts.
- Worker preflight accepts `intro-sound` only for intro paths and `transition-sound` only for transitions.
- Renderer filter graph uses per-meme layout for both image and video while preserving existing audio and timing.
- ffprobe-backed render fixture verifies output dimensions, duration, and no gameplay audio regression.

### E2E

- Create a project with two cards.
- Drag and resize one card.
- Select a meme image or video for another card, then drag and resize it.
- Save and reopen; both layouts persist.
- Reset restores template placement.
- Select distinct intro and transition files from their separate folders.
- Enqueue and observe a succeeded render.

## Non-goals

- Crop/cover editing.
- Rotation or opacity controls.
- Keyframed movement.
- Manual timeline editing.
- New resource management UI.
- WAV, MOV, or WebM meme-resource support.
- Legacy-project migration.
