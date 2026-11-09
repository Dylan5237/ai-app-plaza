import { reactive, watch } from 'vue'
import { apiRequest } from './api.js'
import { identity, signIn } from './identity.js'
import { publicBasePath } from './public-path.js'

export const favorites = reactive({ ids: [], busy: [], error: '', loaded: false })
const intentKey = `plaza-favorite-intent:${publicBasePath()}`
let pending = null
let completing = false
let revision = 0
let previousUserId = null
try {
  const value = JSON.parse(sessionStorage.getItem(intentKey) || 'null')
  if (value && /^[0-9a-f-]{36}$/i.test(value.appId)) pending = value
} catch { /* The expressed intent also works without browser storage. */ }
function remember(value) {
  pending = value
  try { value ? sessionStorage.setItem(intentKey, JSON.stringify(value)) : sessionStorage.removeItem(intentKey) } catch { /* Optional storage. */ }
}
export async function refreshFavoriteIds() {
  if (!identity.user) return
  const epoch = identity.epoch
  const current = revision
  try {
    const result = await apiRequest('/api/personal/favorite-ids')
    if (epoch !== identity.epoch || current !== revision) return
    favorites.ids = result.ids; favorites.loaded = true; favorites.error = ''
  } catch (error) { if (epoch === identity.epoch) favorites.error = error.message }
}
export async function saveFavorite(appId, saved) {
  if (!identity.user || favorites.busy.includes(appId)) return
  const epoch = identity.epoch
  revision++
  favorites.busy.push(appId); favorites.error = ''
  try {
    await apiRequest(`/api/personal/favorites/${appId}`, { method: 'PUT', body: { saved } })
    if (epoch !== identity.epoch) return
    revision++
    favorites.ids = saved ? [...new Set([...favorites.ids, appId])] : favorites.ids.filter(id => id !== appId)
    window.dispatchEvent(new CustomEvent('plaza-favorites-changed'))
    return true
  } catch (error) { if (epoch === identity.epoch) favorites.error = error.message; throw error }
  finally { if (epoch === identity.epoch) favorites.busy = favorites.busy.filter(id => id !== appId) }
}
async function completeIntent() {
  if (!pending || !identity.user || completing) return
  completing = true
  const intent = pending
  try {
    if (await saveFavorite(intent.appId, true)) remember(null)
  } catch { remember(null) }
  finally { completing = false }
}
export async function toggleFavorite(appId) {
  if (!identity.user) {
    remember({ appId })
    await signIn()
    await completeIntent()
    return
  }
  return saveFavorite(appId, !favorites.ids.includes(appId))
}
watch(() => identity.epoch, async () => {
  const userId = identity.user?.id || null
  if (previousUserId && previousUserId !== userId) remember(null)
  previousUserId = userId
  favorites.ids = []; favorites.busy = []; favorites.error = ''; favorites.loaded = false
  if (identity.user) { await refreshFavoriteIds(); await completeIntent() }
}, { flush: 'sync' })
