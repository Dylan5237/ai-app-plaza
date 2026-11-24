const memoryTickets = new Map<string, string>()
const storageFallbackIds = new Set<string>()

export function setPublicationTicket(id: string, ticket: string, persistedInStorage: boolean): void {
  if (!id || !ticket) return
  memoryTickets.set(id, ticket)
  if (persistedInStorage) storageFallbackIds.delete(id)
  else storageFallbackIds.add(id)
}

export function getPublicationTicket(id: string): string {
  return id ? memoryTickets.get(id) || '' : ''
}

export function hasTicketStorageFallback(id: string): boolean {
  return Boolean(id && storageFallbackIds.has(id))
}

export function clearMemoryPublicationTickets(): void {
  memoryTickets.clear()
  storageFallbackIds.clear()
}
