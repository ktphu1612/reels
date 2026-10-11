export interface OrderedCard {
  readonly id: string;
  readonly order: number;
  readonly [key: string]: unknown;
}

export function normalizeCardOrder<T extends OrderedCard>(cards: readonly T[]): T[] {
  return [...cards]
    .sort((left, right) => left.order - right.order)
    .map((card, index) => ({ ...card, order: index }));
}

export function moveCard<T extends OrderedCard>(cards: readonly T[], index: number, direction: 'up' | 'down'): T[] {
  const ordered = normalizeCardOrder(cards);
  const nextIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= ordered.length || nextIndex < 0 || nextIndex >= ordered.length) return ordered;
  const next = [...ordered];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next.map((card, cardIndex) => ({ ...card, order: cardIndex }));
}
