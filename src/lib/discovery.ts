export type DiscoveryTab = 'catalog' | 'random' | 'search'

// Single source of truth for mapping the ?discover= URL parameter to a tab.
// An absent or unrecognized parameter means the plaza default homepage (smart search).
export function discoverTabFromParam(value: string | null): DiscoveryTab {
  return value === 'random' ? 'random' : value === 'catalog' ? 'catalog' : 'search'
}
