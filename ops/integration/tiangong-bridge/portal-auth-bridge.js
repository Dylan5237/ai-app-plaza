const NONCE = /^[a-f0-9]{64}$/
const REQUEST = /^[a-zA-Z0-9_-]{1,128}$/
const nonceValue = value => typeof value === 'string' && NONCE.test(value)
const freshNonce = host => Array.from(host.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
const origin = value => {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return url.origin === value && !url.username && !url.password &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) }
  catch { return false }
}
const sameProfile = (left, right) => right?.enabled === true &&
  ['portalOrigin', 'plazaOrigin', 'fuxiOrigin', 'appId', 'entryId'].every(key => left[key] === right[key])

// This module owns authentication only: it contains no visible controls, labels, styles or sizing.
export function startPortalAuthBridge(host, profile, options = {}) {
  const unavailable = { dispose() {} }
  if (profile?.enabled !== true || !['portalOrigin', 'plazaOrigin', 'fuxiOrigin'].every(key => origin(profile[key])) ||
    host.location.origin !== profile.portalOrigin || typeof profile.appId !== 'string' || typeof profile.entryId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.appId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.entryId)) return unavailable
  try { if (host.top.location.origin !== profile.portalOrigin) return unavailable } catch { return unavailable }
  const frameWindow = options.frameWindow || (() => host.document.querySelector('iframe')?.contentWindow || null)
  const policyUrl = new URL('./fuxi-widget-test-policy.json', host.location.href)
  const readPolicy = options.readPolicy || (async () => {
    try {
      const response = await host.fetch(policyUrl.href, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) })
      return response.ok ? await response.json() : null
    } catch { return null }
  })
  const timeoutMs = options.timeoutMs || 120000
  const policyTimeoutMs = options.policyTimeoutMs || 5000
  const seen = new Map()
  let grant, disposed = false
  const send = (data, target = frameWindow()) => {
    try { target?.postMessage({ version: 1, appId: profile.appId, entryId: profile.entryId, ...data }, profile.plazaOrigin) } catch {}
  }
  const clear = (close = false) => {
    const active = grant
    grant = undefined
    if (!active) return
    host.clearTimeout(active.expiry)
    if (active.policyExpiry !== undefined) host.clearTimeout(active.policyExpiry)
    host.clearInterval(active.closedPoll)
    if (close) { try { active.child.close() } catch {} }
  }
  const fail = code => {
    const requestId = grant?.requestId
    clear(true)
    if (requestId) send({ type: 'fuxi:portal:status', requestId, code })
  }
  const receive = async event => {
    if (disposed || !event.isTrusted || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return
    const data = event.data
    if (event.origin === profile.fuxiOrigin && grant && event.source === grant.child &&
      data.type === 'fuxi:tiangong:ready' && grant.stage === 'waiting-fuxi' && typeof data.requestId === 'string' && REQUEST.test(data.requestId)) {
      grant.fuxiRequestId = data.requestId
      grant.policyRequestId = freshNonce(host)
      grant.stage = 'waiting-policy'
      grant.policyExpiry = host.setTimeout(() => fail('POLICY_UNAVAILABLE'), policyTimeoutMs)
      send({ type: 'fuxi:portal:policy-check', requestId: grant.requestId, policyRequestId: grant.policyRequestId })
      return
    }
    const frame = frameWindow()
    if (!frame || event.source !== frame || event.origin !== profile.plazaOrigin ||
      data.version !== 1 || data.appId !== profile.appId || data.entryId !== profile.entryId) return
    if (data.type === 'fuxi:portal:hello' && nonceValue(data.requestId)) {
      send({ type: 'fuxi:portal:ready', requestId: data.requestId })
      return
    }
    if (data.type === 'fuxi:portal:launch') {
      if (!nonceValue(data.requestId) || !host.navigator.userActivation?.isActive) return
      const now = Date.now()
      for (const [nonce, at] of seen) if (now - at > 120000) seen.delete(nonce)
      if (seen.has(data.requestId) || seen.size >= 64) return
      seen.set(data.requestId, now)
      clear(true)
      let child
      try { child = host.open(profile.fuxiOrigin + '/auth/tiangong', '_blank') } catch {}
      if (!child) { send({ type: 'fuxi:portal:status', requestId: data.requestId, code: 'POPUP_BLOCKED' }); return }
      grant = { requestId: data.requestId, child, frame, stage: 'waiting-fuxi', expiresAt: now + timeoutMs,
        expiry: host.setTimeout(() => fail('REQUEST_EXPIRED'), timeoutMs),
        closedPoll: host.setInterval(() => { try { if (grant?.child === child && child.closed) clear() } catch { clear() } }, 250) }
      return
    }
    if (data.type === 'fuxi:portal:cancel' && grant?.requestId === data.requestId) { clear(true); return }
    const current = grant
    if (data.type !== 'fuxi:portal:policy-result' || !current || current.stage !== 'waiting-policy' ||
      current.frame !== frame || data.requestId !== current.requestId || data.policyRequestId !== current.policyRequestId) return
    host.clearTimeout(current.policyExpiry)
    if (data.enabled !== true) { fail('POLICY_DISABLED'); return }
    current.stage = 'checking-portal'
    const latest = await readPolicy()
    if (disposed || grant !== current) return
    if (Date.now() >= current.expiresAt) { fail('REQUEST_EXPIRED'); return }
    if (!sameProfile(profile, latest)) { fail('POLICY_DISABLED'); return }
    try { if (current.child.closed) { clear(); return } } catch { clear(); return }
    clear()
    let token = null
    try { token = host.localStorage.getItem('sky-token') } catch {}
    const valid = typeof token === 'string' && token.length > 0 && token.length <= 8192 && token.trim() === token && !/[\u0000-\u001f\u007f]/.test(token)
    if (!valid) {
      token = null
      try { current.child.close() } catch {}
      send({ type: 'fuxi:portal:status', requestId: current.requestId, code: 'CREDENTIAL_MISSING' })
      return
    }
    try { current.child.postMessage({ type: 'fuxi:tiangong:login', requestId: current.fuxiRequestId, token }, profile.fuxiOrigin) }
    catch { send({ type: 'fuxi:portal:status', requestId: current.requestId, code: 'HANDOFF_FAILED' }) }
    finally { token = null }
  }
  const dispose = () => { disposed = true; clear(true); seen.clear(); host.removeEventListener('message', receive); host.removeEventListener('pagehide', dispose) }
  host.addEventListener('message', receive)
  host.addEventListener('pagehide', dispose)
  return { dispose }
}

export async function startConfiguredPortalAuthBridge(host) {
  let profile
  try {
    const url = new URL('./fuxi-widget-test-policy.json', host.location.href)
    const response = await host.fetch(url.href, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) return
    profile = await response.json()
  } catch { return }
  return startPortalAuthBridge(host, profile)
}
if (typeof window !== 'undefined' && document.documentElement.hasAttribute('data-fuxi-portal-bridge')) startConfiguredPortalAuthBridge(window)
