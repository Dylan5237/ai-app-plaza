import { publicPath } from './public-path.js'

let portalStorageKey = null
let portalRequestEpoch = 0
let authenticatedWebIdentity = false
export function advanceIdentityRequests() { portalRequestEpoch++ }
export function configureWebIdentity(active) { authenticatedWebIdentity = active === true }
export function configurePortalIdentity(key) { portalStorageKey = key }
export function readPortalToken() {
  if (!portalStorageKey) return null
  try {
    const value = window.localStorage.getItem(portalStorageKey)
    return value && value.length <= 8192 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) ? value : null
  } catch { return null }
}
export function readAuthenticatedPortalToken() {
  return authenticatedWebIdentity ? readPortalToken() : null
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function apiRequest(path, { method = 'GET', body, token, idempotencyKey } = {}) {
  const identityEpoch = portalRequestEpoch
  const headers = new Headers({ Accept: 'application/json' })
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
  const portalToken = readPortalToken()
  const protectedPath = /^\/api\/(identity|personal|access|management|operations|publications)(\/|\?|$)/.test(path) || path === '/api/auth/me'
  const authenticatedRead = authenticatedWebIdentity && /^\/api\/(apps|tags)(\/|\?|$)/.test(path)
  if (portalToken && (protectedPath || authenticatedRead)) headers.set('X-Plaza-Portal-Token', portalToken)

  let response
  try {
    response = await fetch(publicPath(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    })
  } catch {
    throw new ApiError('暂时无法连接应用广场服务，请稍后重试。')
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (identityEpoch !== portalRequestEpoch) throw new ApiError('身份状态已变化，请重新读取。', 409, 'STALE_IDENTITY')

  if (!response.ok) {
    if (payload?.error?.code === 'ADMINISTRATOR_REQUIRED') window.dispatchEvent(new Event('plaza-capabilities-changed'))
    if (identityEpoch === portalRequestEpoch && portalToken === readPortalToken() && path !== '/api/auth/me' && protectedPath && response.status < 500 && ['LOGIN_REQUIRED', 'PORTAL_TOKEN_REQUIRED', 'PORTAL_IDENTITY_INVALID', 'ACCOUNT_SWITCH_REQUIRED'].includes(payload?.error?.code)) {
      window.dispatchEvent(new CustomEvent('plaza-identity-invalid', { detail: { message: payload?.error?.message || '身份核验未完成，请重试。', code: payload?.error?.code } }))
    }
    throw new ApiError(
      payload?.error?.message || `请求未完成（HTTP ${response.status}）`,
      response.status,
      payload?.error?.code,
    )
  }

  if (payload === null) throw new ApiError('服务返回了无法读取的数据。', response.status)
  return payload
}

export async function downloadPackage(url) {
  const target = new URL(url, location.href)
  if (target.origin !== location.origin || !target.pathname.startsWith(publicPath('/api/apps/'))) throw new ApiError('请使用当前广场的分发包地址。')
  const epoch = portalRequestEpoch, headers = new Headers({ Accept: 'application/zip' }), token = readPortalToken()
  if (authenticatedWebIdentity && token) headers.set('X-Plaza-Portal-Token', token)
  let response
  try { response = await fetch(target, { headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store' }) }
  catch { throw new ApiError('下载未完成，请重试。') }
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    if (epoch === portalRequestEpoch && token === readPortalToken() && response.status < 500 && ['LOGIN_REQUIRED', 'PORTAL_TOKEN_REQUIRED', 'PORTAL_IDENTITY_INVALID', 'ACCOUNT_SWITCH_REQUIRED'].includes(result?.error?.code)) {
      window.dispatchEvent(new CustomEvent('plaza-identity-invalid', { detail: result.error }))
    }
    throw new ApiError(result?.error?.message || '分发包当前不可访问。', response.status, result?.error?.code)
  }
  const blob = await response.blob()
  if (epoch !== portalRequestEpoch || token !== readPortalToken()) throw new ApiError('身份状态已变化，已停止下载。', 409, 'STALE_IDENTITY')
  const objectUrl = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = objectUrl; anchor.download = 'plaza-application.zip'; anchor.click()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
