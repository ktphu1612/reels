import { describe, expect, it } from 'vitest';

import { moveCard, normalizeCardOrder } from './reorder';

describe('card ordering', () => {
  it('normalizes persisted order to contiguous zero-based values', () => {
    const cards = [
      { id: 'b', imagePath: 'assets/b.webp', script: 'B', order: 7 },
      { id: 'a', imagePath: 'assets/a.webp', script: 'A', order: 2 },
    ];

    expect(normalizeCardOrder(cards)).toEqual([
      { ...cards[1], order: 0 },
      { ...cards[0], order: 1 },
    ]);
  });

  it('moves a card with the same result for pointer and keyboard controls', () => {
    const cards = [
      { id: 'a', imagePath: 'assets/a.webp', script: 'A', order: 0 },
      { id: 'b', imagePath: 'assets/b.webp', script: 'B', order: 1 },
      { id: 'c', imagePath: 'assets/c.webp', script: 'C', order: 2 },
    ];

    expect(moveCard(cards, 1, 'up').map((card: { id: string }) => card.id)).toEqual(['b', 'a', 'c']);
    expect(moveCard(cards, 1, 'down').map((card: { id: string }) => card.id)).toEqual(['a', 'c', 'b']);
    expect(moveCard(cards, 0, 'up').map((card: { id: string }) => card.id)).toEqual(['a', 'b', 'c']);
  });
});
