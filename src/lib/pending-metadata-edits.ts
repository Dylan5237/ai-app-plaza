import { reactive } from 'vue'
import { getCurrentTicketOwnerId, getMountKey } from './publication-tickets.ts'

export interface PendingMetadataEdit {
  key: string
  cacheKey: string
  endpoint: string
  token: string
  publicationMode: boolean
  management: boolean
  body: {
    expectedAppRevision: number
    manifest: Record<string, any>
    documents: Record<string, string>
  }
}

interface StoredPendingMetadataEdit {
  ownerId: string | null
  operation: PendingMetadataEdit
}

const pendingPrefix = () => `ai-app-plaza:pending-edit:${getMountKey()}:`
const pendingEdits = reactive(new Map<string, PendingMetadataEdit>())

function readStoredEntry(cacheKey: string): StoredPendingMetadataEdit | undefined {
  if (!cacheKey || typeof window === 'undefined') return undefined
  try {
    const raw = window.sessionStorage.getItem(`${pendingPrefix()}${cacheKey}`)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as StoredPendingMetadataEdit
    if (!parsed || typeof parsed !== 'object' || !parsed.operation || typeof parsed.operation.key !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function isOwnedStoredEntry(entry: StoredPendingMetadataEdit | undefined, cacheKey: string): entry is StoredPendingMetadataEdit {
  if (!entry) return false
  const currentOwner = getCurrentTicketOwnerId()
  if (entry.ownerId && currentOwner && entry.ownerId !== currentOwner) {
    try {
      window.sessionStorage.removeItem(`${pendingPrefix()}${cacheKey}`)
    } catch {
      // Ignore storage cleanup error.
    }
    return false
  }
  return (entry.ownerId ?? null) === (currentOwner ?? null)
}

export function getPendingMetadataEdit(cacheKey: string): PendingMetadataEdit | undefined {
  if (!cacheKey) return undefined
  const cached = pendingEdits.get(cacheKey)
  if (cached) return cached
  const stored = readStoredEntry(cacheKey)
  if (!isOwnedStoredEntry(stored, cacheKey)) return undefined
  return stored.operation
}

export function setPendingMetadataEdit(cacheKey: string, operation: PendingMetadataEdit): boolean {
  if (!cacheKey) return false
  pendingEdits.set(cacheKey, operation)
  if (typeof window === 'undefined') return false
  try {
    const payload: StoredPendingMetadataEdit = {
      ownerId: getCurrentTicketOwnerId(),
      operation: { ...operation, token: '' },
    }
    window.sessionStorage.setItem(`${pendingPrefix()}${cacheKey}`, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function deletePendingMetadataEdit(cacheKey: string): void {
  if (!cacheKey) return
  pendingEdits.delete(cacheKey)
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(`${pendingPrefix()}${cacheKey}`)
  } catch {
    // Ignore storage removal errors.
  }
}

export function hasPendingMetadataEdit(cacheKey: string): boolean {
  if (!cacheKey) return false
  if (pendingEdits.has(cacheKey)) return true
  return isOwnedStoredEntry(readStoredEntry(cacheKey), cacheKey)
}

export function clearPendingMetadataEdits(): void {
  pendingEdits.clear()
  if (typeof window === 'undefined') return
  try {
    const prefix = pendingPrefix()
    const keysToRemove: string[] = []
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index)
      if (key && key.startsWith(prefix)) keysToRemove.push(key)
    }
    for (const key of keysToRemove) window.sessionStorage.removeItem(key)
  } catch {
    // Ignore storage cleanup error.
  }
}
