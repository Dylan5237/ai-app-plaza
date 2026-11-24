import { reactive } from 'vue'

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

const pendingEdits = reactive(new Map<string, PendingMetadataEdit>())

export function getPendingMetadataEdit(cacheKey: string): PendingMetadataEdit | undefined {
  return cacheKey ? pendingEdits.get(cacheKey) : undefined
}

export function setPendingMetadataEdit(cacheKey: string, operation: PendingMetadataEdit): void {
  if (!cacheKey) return
  pendingEdits.set(cacheKey, operation)
}

export function deletePendingMetadataEdit(cacheKey: string): void {
  if (!cacheKey) return
  pendingEdits.delete(cacheKey)
}

export function hasPendingMetadataEdit(cacheKey: string): boolean {
  return Boolean(cacheKey && pendingEdits.has(cacheKey))
}

export function clearPendingMetadataEdits(): void {
  pendingEdits.clear()
}
