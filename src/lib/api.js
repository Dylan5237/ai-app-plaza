import { publicPath } from './public-path.js'

let portalStorageKey = null
let portalRequestEpoch = 0
export function advanceIdentityRequests() { portalRequestEpoch++ }
export function configurePortalIdentity(key) { portalStorageKey = key }
export function readPortalToken() {
  if (!portalStorageKey) return null
  try {
    const value = window.localStorage.getItem(portalStorageKey)
    return value && value.length <= 8192 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) ? value : null
  } catch { return null }
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
  const protectedPath = path.startsWith('/api/identity/') || path.startsWith('/api/personal/') || path === '/api/auth/me'
  if (portalToken && protectedPath) headers.set('X-Plaza-Portal-Token', portalToken)

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

  if (!response.ok) {
    if (identityEpoch === portalRequestEpoch && portalToken === readPortalToken() && path !== '/api/auth/me' && protectedPath && ['LOGIN_REQUIRED', 'PORTAL_TOKEN_REQUIRED', 'PORTAL_IDENTITY_INVALID', 'ACCOUNT_SWITCH_REQUIRED', 'IDENTITY_UNAVAILABLE'].includes(payload?.error?.code)) {
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
