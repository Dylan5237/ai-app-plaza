// Deterministic-shuffle helper for the empty-state suggestion chips: takes the full
// pool and returns a random subset, so every conversation offers a different set.
export function rotateSuggestions(pool: readonly string[], count = 3, random: () => number = Math.random): string[] {
  const items = [...pool]
  for (let index = items.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[items[index], items[swap]] = [items[swap], items[index]]
  }
  return items.slice(0, count)
}
