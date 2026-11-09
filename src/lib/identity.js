import { reactive } from 'vue'
import { apiRequest, advanceIdentityRequests, configurePortalIdentity, configureWebIdentity, readPortalToken } from './api.js'
import { publicBasePath } from './public-path.js'

export const identity = reactive({ enabled: false, user: null, busy: false, error: '', switchRequired: false, epoch: 0 })
const suppressionKey = `plaza-explicit-logout:${publicBasePath()}`
let generation = 0
let suppressed = false
let storageKey = null
try { suppressed = sessionStorage.getItem(suppressionKey) === '1' } catch { /* In-memory suppression still works. */ }
function suppress(value) {
  suppressed = value
  try { value ? sessionStorage.setItem(suppressionKey, '1') : sessionStorage.removeItem(suppressionKey) } catch { /* Optional storage. */ }
}
function clearUser() { generation++; advanceIdentityRequests(); configureWebIdentity(false); identity.user = null; identity.busy = false; identity.epoch++ }
function failed(error) {
  clearUser()
  identity.error = error.message
  identity.switchRequired = error.code === 'ACCOUNT_SWITCH_REQUIRED'
}

export async function signIn(switchAccount = false) {
  if (identity.busy) return
  const current = ++generation
  identity.busy = true; identity.error = ''
  try {
    const token = readPortalToken()
    if (!token) throw new Error('未检测到天宫登录状态，请先登录天宫，再从同源广场入口进入。')
    const { requestId } = await apiRequest('/api/auth/tiangong/requests', { method: 'POST', body: {} })
    const result = await apiRequest('/api/auth/tiangong/exchange', { method: 'POST', body: { requestId, token, switchAccount } })
    if (current !== generation || token !== readPortalToken()) return
    advanceIdentityRequests(); configureWebIdentity(true); identity.user = result.user; identity.epoch++; identity.switchRequired = false; suppress(false)
  } catch (error) { if (current === generation) failed(error) }
  finally { if (current === generation) identity.busy = false }
}

export async function signOut() {
  if (identity.busy) return
  identity.busy = true; identity.error = ''
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', body: {} })
    suppress(true); clearUser(); identity.switchRequired = false
  } catch (error) { identity.error = error.message }
  finally { identity.busy = false }
}

export async function initializeIdentity() {
  const current = ++generation
  try {
    const status = await apiRequest('/api/auth/tiangong/status')
    if (current !== generation) return
    identity.enabled = status.enabled === true
    if (!identity.enabled) return
    storageKey = status.tokenStorage?.key
    configurePortalIdentity(status.tokenStorage?.key)
    if (suppressed || !readPortalToken()) return
    const token = readPortalToken()
    try {
      const result = await apiRequest('/api/auth/me')
      if (current !== generation || token !== readPortalToken()) return
      advanceIdentityRequests(); configureWebIdentity(true); identity.user = result.user; identity.epoch++
    }
    catch (error) {
      if (current !== generation) return
      if (error.code === 'LOGIN_REQUIRED') await signIn()
      else failed(error)
    }
  } catch (error) { if (current === generation) identity.error = error.message }
}

window.addEventListener('plaza-identity-invalid', event => failed(event.detail))
window.addEventListener('storage', event => {
  if (storageKey && (event.key === storageKey || event.key === null)) {
    clearUser()
    initializeIdentity()
  }
})
async function refreshIdentity() {
  if (!identity.user || identity.busy) return
  const current = generation, token = readPortalToken()
  try {
    const result = await apiRequest('/api/auth/me')
    if (current === generation && token === readPortalToken()) {
      if (['administrator','superAdministrator','identityAdmin'].some(key => identity.user[key] !== result.user[key])) { advanceIdentityRequests(); identity.epoch++ }
      identity.user = result.user
    }
  } catch (error) { if (current === generation) failed(error) }
}
window.addEventListener('focus', refreshIdentity)
window.addEventListener('plaza-capabilities-changed', refreshIdentity)
