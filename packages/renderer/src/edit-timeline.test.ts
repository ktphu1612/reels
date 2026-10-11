import { describe, expect, it } from 'vitest';

import { createEditTimeline } from './edit-timeline.js';

describe('createEditTimeline', () => {
  it('keeps card one visible during intro and starts later cards after transition', () => {
    const timeline = createEditTimeline({
      introSeconds: 1,
      transitionSeconds: 0.25,
      cards: [
        { cardId: 'a', contentSeconds: 2, hasNarration: true, memeSeconds: 1.5 },
        { cardId: 'b', contentSeconds: 3, hasNarration: false },
      ],
    });

    expect(timeline.musicStartSeconds).toBe(1);
    expect(timeline.cards[0]).toEqual({
      cardId: 'a',
      visible: { startSeconds: 0, endSeconds: 4.5 },
      content: { startSeconds: 1, endSeconds: 3 },
      narration: { startSeconds: 1, endSeconds: 3 },
      meme: { startSeconds: 3, endSeconds: 4.5 },
    });
    expect(timeline.cards[0]?.visible).toEqual({ startSeconds: 0, endSeconds: 4.5 });
    expect(timeline.cards[0]?.content).toEqual({ startSeconds: 1, endSeconds: 3 });
    expect(timeline.cards[1]).toEqual({
      cardId: 'b',
      visible: { startSeconds: 4.5, endSeconds: 7.75 },
      transition: { startSeconds: 4.5, endSeconds: 4.75 },
      content: { startSeconds: 4.75, endSeconds: 7.75 },
    });
    expect(timeline.cards[1]?.transition).toEqual({ startSeconds: 4.5, endSeconds: 4.75 });
    expect(timeline.cards[1]?.content).toEqual({ startSeconds: 4.75, endSeconds: 7.75 });
    expect(timeline.cards[1]?.narration).toBeUndefined();
    expect(timeline.durationSeconds).toBe(7.75);
  });

  it('defaults to no intro or transition and still allocates blank card content', () => {
    const timeline = createEditTimeline({
      cards: [
        { cardId: 'first', contentSeconds: 1, hasNarration: false },
        { cardId: 'second', contentSeconds: 0.5, hasNarration: true },
      ],
    });

    expect(timeline.musicStartSeconds).toBe(0);
    expect(timeline.cards).toEqual([
      {
        cardId: 'first',
        visible: { startSeconds: 0, endSeconds: 1 },
        content: { startSeconds: 0, endSeconds: 1 },
      },
      {
        cardId: 'second',
        visible: { startSeconds: 1, endSeconds: 1.5 },
        content: { startSeconds: 1, endSeconds: 1.5 },
        narration: { startSeconds: 1, endSeconds: 1.5 },
      },
    ]);
    expect(timeline.cards[0]).not.toHaveProperty('transition');
    expect(timeline.cards[1]).not.toHaveProperty('transition');
  });

  it('allows a final meme without adding a trailing transition', () => {
    const timeline = createEditTimeline({
      transitionSeconds: 0.5,
      cards: [{ cardId: 'last', contentSeconds: 2, hasNarration: true, memeSeconds: 4.62 }],
    });

    expect(timeline.cards[0]).toEqual({
      cardId: 'last',
      visible: { startSeconds: 0, endSeconds: 6.62 },
      content: { startSeconds: 0, endSeconds: 2 },
      narration: { startSeconds: 0, endSeconds: 2 },
      meme: { startSeconds: 2, endSeconds: 6.62 },
    });
    expect(timeline.cards[0]).not.toHaveProperty('transition');
    expect(timeline.durationSeconds).toBeCloseTo(6.62);
  });

  it.each([
    ['intro', { introSeconds: 0, cards: [{ cardId: 'bad', contentSeconds: 1, hasNarration: false }] }],
    ['intro', { introSeconds: -1, cards: [{ cardId: 'bad', contentSeconds: 1, hasNarration: false }] }],
    ['intro', { introSeconds: Number.NaN, cards: [{ cardId: 'bad', contentSeconds: 1, hasNarration: false }] }],
    ['intro', { introSeconds: Number.POSITIVE_INFINITY, cards: [{ cardId: 'bad', contentSeconds: 1, hasNarration: false }] }],
    ['transition', {
      cards: [
        { cardId: 'first', contentSeconds: 1, hasNarration: false },
        { cardId: 'second', contentSeconds: 1, hasNarration: false },
      ],
      transitionSeconds: 0,
    }],
    ['content', { cards: [{ cardId: 'bad', contentSeconds: 0, hasNarration: false }] }],
    ['content', { cards: [{ cardId: 'bad', contentSeconds: -1, hasNarration: false }] }],
    ['meme', { cards: [{ cardId: 'bad', contentSeconds: 1, hasNarration: true, memeSeconds: -1 }] }],
  ])('rejects invalid %s durations', (_kind, input) => {
    expect(() => createEditTimeline(input)).toThrow();
  });
});
