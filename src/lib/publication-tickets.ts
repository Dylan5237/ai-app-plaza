import { publicBasePath } from './public-path.js'

export const getMountKey = (): string => (typeof document !== 'undefined' ? publicBasePath() || '/' : '/')
const mountKey = getMountKey
const ticketPrefix = () => `ai-app-plaza:publication:${mountKey()}:`
const ownerStorageKey = () => `ai-app-plaza:publication-owner:${mountKey()}`
const LEGACY_TICKET_PREFIX = 'ai-app-plaza:publication:'
const isLegacyTicketKey = (key: string) => /^ai-app-plaza:publication:[^/:]+$/.test(key)
const memoryTickets = new Map<string, string>()
const storageFallbackIds = new Set<string>()
const currentRouteTicketIds = new Set<string>()
let currentTicketOwnerId: string | null = null
let ticketsSuspended = false

export function getCurrentTicketOwnerId(): string | null {
  return currentTicketOwnerId
}

function removeStorageTickets(preserveIds?: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    const prefix = ticketPrefix()
    const ownerKey = ownerStorageKey()
    const keysToRemove: string[] = []
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index)
      if (!key) continue
      if (key === ownerKey) {
        keysToRemove.push(key)
        continue
      }
      if (key.startsWith(prefix)) {
        const id = key.slice(prefix.length)
        if (!preserveIds?.has(id)) keysToRemove.push(key)
        continue
      }
      if (!preserveIds && isLegacyTicketKey(key)) {
        keysToRemove.push(key)
      }
    }
    for (const key of keysToRemove) window.sessionStorage.removeItem(key)
  } catch {
    // Ignore storage access errors in restricted frames or memory-only environments.
  }
}

export function setPublicationTicket(id: string, ticket: string, persistedInStorage: boolean, fromUrl = false): void {
  if (!id || !ticket) return
  memoryTickets.set(id, ticket)
  if (fromUrl && !currentTicketOwnerId) currentRouteTicketIds.add(id)
  if (persistedInStorage) storageFallbackIds.delete(id)
  else storageFallbackIds.add(id)
}

export function savePublicationTicket(id: string, ticket: string, fromUrl = false): boolean {
  if (!id || !ticket) return false
  let persisted = false
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(`${ticketPrefix()}${id}`, ticket)
      if (currentTicketOwnerId) window.sessionStorage.setItem(ownerStorageKey(), currentTicketOwnerId)
      persisted = true
    } catch {
      persisted = false
    }
  }
  setPublicationTicket(id, ticket, persisted, fromUrl)
  return persisted
}

export function setPublicationTicketsSuspended(suspended: boolean): void {
  ticketsSuspended = Boolean(suspended)
}

export function getPublicationTicket(id: string): string {
  if (ticketsSuspended) return ''
  return id ? memoryTickets.get(id) || '' : ''
}

export function readPublicationTicket(id: string): string {
  if (!id || ticketsSuspended) return ''
  if (typeof window !== 'undefined') {
    try {
      const stored = window.sessionStorage.getItem(`${ticketPrefix()}${id}`)
      if (stored) return stored
    } catch {
      // Fallback to in-memory ticket when sessionStorage is unavailable.
    }
  }
  return getPublicationTicket(id)
}

export function readLegacyPublicationTicket(id: string): string {
  if (!id || ticketsSuspended || id.includes('/') || id.includes(':') || typeof window === 'undefined') return ''
  try {
    return window.sessionStorage.getItem(`${LEGACY_TICKET_PREFIX}${id}`) || ''
  } catch {
    return ''
  }
}

export function removeLegacyPublicationTicket(id: string): void {
  if (!id || id.includes('/') || id.includes(':') || typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(`${LEGACY_TICKET_PREFIX}${id}`)
  } catch {
    // Ignore storage access errors in restricted frames or memory-only environments.
  }
}

export function promoteLegacyPublicationTicket(id: string, ticket: string): void {
  if (!id || !ticket) return
  savePublicationTicket(id, ticket, false)
  removeLegacyPublicationTicket(id)
}

export function hasTicketStorageFallback(id: string): boolean {
  return Boolean(id && storageFallbackIds.has(id))
}

export function clearMemoryPublicationTickets(preserveCurrentRouteTickets = false): void {
  ticketsSuspended = false
  const preserveIds = preserveCurrentRouteTickets && currentRouteTicketIds.size
    ? new Set(currentRouteTicketIds)
    : undefined
  if (preserveIds) {
    for (const id of [...memoryTickets.keys()]) {
      if (!preserveIds.has(id)) memoryTickets.delete(id)
    }
    for (const id of [...storageFallbackIds]) {
      if (!preserveIds.has(id)) storageFallbackIds.delete(id)
    }
  } else {
    memoryTickets.clear()
    storageFallbackIds.clear()
    currentRouteTicketIds.clear()
  }
  removeStorageTickets(preserveIds)
}

export function syncPublicationTicketIdentity(userId: string | null): void {
  if (!userId) {
    currentTicketOwnerId = null
    return
  }
  currentTicketOwnerId = userId
  ticketsSuspended = false
  if (typeof window !== 'undefined') {
    try {
      const ownerKey = ownerStorageKey()
      const previousOwner = window.sessionStorage.getItem(ownerKey)
      if (previousOwner && previousOwner !== userId) {
        clearMemoryPublicationTickets(true)
      }
      window.sessionStorage.setItem(ownerKey, userId)
    } catch {
      // Ignore storage access errors in memory-only environments.
    }
  }
  currentRouteTicketIds.clear()
}
