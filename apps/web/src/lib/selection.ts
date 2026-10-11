export function reconcileSelection<T extends { id: string }>(selected: ReadonlySet<string>, items: readonly T[]): Set<string> {
  const available = new Set(items.map((item) => item.id));
  return new Set([...selected].filter((id) => available.has(id)));
}

export function batchEnqueuePayload(selected: ReadonlySet<string>): { projectIds: string[] } {
  return { projectIds: [...new Set(selected)].sort() };
}
