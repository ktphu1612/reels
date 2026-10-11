export interface TimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface EditCardInput {
  readonly cardId: string;
  readonly contentSeconds: number;
  readonly hasNarration: boolean;
  readonly memeSeconds?: number;
}

export interface EditTimelineInput {
  readonly cards: readonly EditCardInput[];
  readonly introSeconds?: number;
  readonly transitionSeconds?: number;
}

export interface EditCardSegment {
  readonly cardId: string;
  readonly visible: TimeRange;
  readonly content: TimeRange;
  readonly narration?: TimeRange;
  readonly transition?: TimeRange;
  readonly meme?: TimeRange;
}

export interface EditTimeline {
  readonly cards: readonly EditCardSegment[];
  readonly durationSeconds: number;
  readonly musicStartSeconds: number;
}

export function createEditTimeline(input: EditTimelineInput): EditTimeline {
  if (input.introSeconds !== undefined) {
    validateDuration('Intro', input.introSeconds);
  }
  if (input.transitionSeconds !== undefined) {
    validateDuration('Transition', input.transitionSeconds);
  }

  const introSeconds = input.introSeconds ?? 0;
  let cursor = 0;
  const cards = input.cards.map((card, index): EditCardSegment => {
    validateDuration('Content', card.contentSeconds);
    if (card.memeSeconds !== undefined) validateDuration('Meme', card.memeSeconds);

    const visibleStartSeconds = cursor;
    if (index === 0) cursor += introSeconds;

    const transition = index > 0 && input.transitionSeconds !== undefined
      ? createRange(cursor, input.transitionSeconds)
      : undefined;
    if (transition !== undefined) cursor = transition.endSeconds;

    const content = createRange(cursor, card.contentSeconds);
    cursor = content.endSeconds;

    const meme = card.memeSeconds === undefined
      ? undefined
      : createRange(cursor, card.memeSeconds);
    if (meme !== undefined) cursor = meme.endSeconds;

    const narration = card.hasNarration ? content : undefined;
    return {
      cardId: card.cardId,
      visible: createRange(visibleStartSeconds, cursor - visibleStartSeconds),
      ...(transition === undefined ? {} : { transition }),
      content,
      ...(narration === undefined ? {} : { narration }),
      ...(meme === undefined ? {} : { meme }),
    };
  });

  return { cards, durationSeconds: cursor, musicStartSeconds: introSeconds };
}

function createRange(startSeconds: number, durationSeconds: number): TimeRange {
  const endSeconds = startSeconds + durationSeconds;
  if (!Number.isFinite(endSeconds)) {
    throw new Error('Timeline duration must be finite');
  }
  return { startSeconds, endSeconds };
}

function validateDuration(label: string, durationSeconds: number): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`${label} duration must be a positive finite number`);
  }
}
