// The delivered page reads a fixed same-origin policy file; URL parameters,
// parent messages and Manifest fields never choose a credential recipient.
// Profile injection exists solely for isolated fixtures of this module.
export function startPortalWidget(host, profile) {
  const button = host.document.getElementById('open-fuxi')
  const status = host.document.getElementById('status')
  let validated = false
  const codes = {
    '浏览器未允许读取天宫登录状态，请在天宫入口重试。': 'STORAGE_DENIED',
    '入口请求已过期，请重新点击进入。': 'REQUEST_EXPIRED',
    '本次入口请求已过期，请重新进入。': 'REQUEST_EXPIRED',
    '浏览器阻止了新窗口，请允许此入口打开窗口后重试。': 'POPUP_BLOCKED',
    '广场入口确认超时，请重新进入。': 'POLICY_UNAVAILABLE',
    '无法确认广场入口，请重新进入。': 'POLICY_UNAVAILABLE',
    '广场伏羲入口已停用或配置不符。': 'POLICY_DISABLED',
    '伏羲入口已停用或配置不可用，请稍后重试。': 'POLICY_DISABLED',
    '未取得天宫登录凭证，请在天宫登录后重试。': 'CREDENTIAL_MISSING',
    '本次身份交接未完成，请重新进入。': 'HANDOFF_FAILED',
  }
  const show = message => {
    if (status) status.textContent = message
    const code = codes[message]
    if (validated && code) {
      try { host.parent.postMessage({ type: 'fuxi:widget:status', code }, profile.plazaOrigin) } catch { /* status only */ }
    }
  }
  const exactOrigin = value => {
    try {
      const url = new URL(value)
      return url.origin === value && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    } catch { return false }
  }
  const validPolicyUrl = value => {
    try { const url = new URL(value); return url.origin === profile.portalOrigin && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/fuxi-widget-test-policy.json') } catch { return false }
  }
  const loopback = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const secureSite = value => { const url = new URL(value); return url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url)) }
  const safeFuxi = value => {
    const url = new URL(value)
    if (url.protocol === 'https:' || loopback(url)) return true
    const parts = url.hostname.split('.').map(Number)
    return url.protocol === 'http:' && parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
      (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))
  }
  if (!profile || !button || host.parent === host || host.location.origin !== profile.portalOrigin || !exactOrigin(profile.portalOrigin) || !exactOrigin(profile.plazaOrigin) || !exactOrigin(profile.fuxiOrigin) ||
    !secureSite(profile.portalOrigin) || !secureSite(profile.plazaOrigin) || !safeFuxi(profile.fuxiOrigin) || !validPolicyUrl(profile.policyUrl) ||
    typeof profile.appId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.appId) || typeof profile.entryId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.entryId) ||
    typeof profile.credentialKey !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(profile.credentialKey) ||
    !Number.isInteger(profile.ttlMs) || profile.ttlMs < 1 || profile.ttlMs > 120000) {
    if (button) button.disabled = true
    if (button) button.textContent = '入口暂不可用'
    show('入口来源或配置无效，请联系维护者。')
    return { dispose() {} }
  }
  validated = true
  let grant
  let expiry
  let parentExpiry
  let generation = 0
  const clearGrant = () => {
    grant = undefined
    if (expiry !== undefined) host.clearTimeout(expiry)
    if (parentExpiry !== undefined) host.clearTimeout(parentExpiry)
    expiry = undefined
    parentExpiry = undefined
  }
  const open = async event => {
    if (!event.isTrusted) return
    if (!host.navigator.userActivation?.isActive) { show('入口请求已过期，请重新点击进入。'); return }
    const current = ++generation
    if (grant) { try { grant.child.close() } catch { /* preserve safe fallback */ } }
    clearGrant()
    let storage
    try {
      // In a cross-site frame normal localStorage may be partitioned. Ask the
      // browser for first-party storage only from this trusted click; the
      // browser may prompt or deny, in which case no popup or token is issued.
      if (!host.isSecureContext || typeof host.document.requestStorageAccess !== 'function') throw new Error()
      const handle = await host.document.requestStorageAccess({ localStorage: true })
      storage = handle?.localStorage
      if (!storage || typeof storage.getItem !== 'function') throw new Error()
    } catch {
      if (current === generation) show('浏览器未允许读取天宫登录状态，请在天宫入口重试。')
      return
    }
    if (current !== generation) return
    if (!host.navigator.userActivation?.isActive) { show('入口请求已过期，请重新点击进入。'); return }
    let child
    try { child = host.open(`${profile.fuxiOrigin}/auth/tiangong`, '_blank') } catch { /* fixed diagnostic below */ }
    if (!child) { show('浏览器阻止了新窗口，请允许此入口打开窗口后重试。'); return }
    grant = { child, storage, expiresAt: Date.now() + profile.ttlMs, stage: 'waiting-fuxi' }
    expiry = host.setTimeout(() => { clearGrant(); try { child.close() } catch {} show('本次入口请求已过期，请重新进入。') }, profile.ttlMs)
    show('正在进入伏羲，请保持窗口打开。')
  }
  const receive = async event => {
    if (!grant || !event.isTrusted || Date.now() >= grant.expiresAt) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    const currentGrant = grant
    if (currentGrant.stage === 'waiting-fuxi' && event.origin === profile.fuxiOrigin && event.source === currentGrant.child &&
      data.type === 'fuxi:tiangong:ready' && typeof data.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(data.requestId)) {
      currentGrant.fuxiRequestId = data.requestId
      if (host.parent !== host) {
        let policyRequestId
        try { policyRequestId = Array.from(host.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('') }
        catch { clearGrant(); try { currentGrant.child.close() } catch {} show('无法确认广场入口，请重新进入。'); return }
        currentGrant.stage = 'waiting-plaza'
        currentGrant.policyRequestId = policyRequestId
        parentExpiry = host.setTimeout(() => {
          if (grant !== currentGrant || currentGrant.stage !== 'waiting-plaza') return
          clearGrant(); try { currentGrant.child.close() } catch {} show('广场入口确认超时，请重新进入。')
        }, 5000)
        try {
          host.parent.postMessage({ type: 'fuxi:widget:policy-request', requestId: policyRequestId, appId: profile.appId, entryId: profile.entryId }, profile.plazaOrigin)
        } catch { clearGrant(); try { currentGrant.child.close() } catch {} show('无法确认广场入口，请重新进入。') }
        return
      }
      return
    } else if (currentGrant.stage === 'waiting-plaza' && event.origin === profile.plazaOrigin && event.source === host.parent &&
      data.type === 'fuxi:widget:policy-result' && data.requestId === currentGrant.policyRequestId) {
      if (parentExpiry !== undefined) host.clearTimeout(parentExpiry)
      parentExpiry = undefined
      if (data.enabled !== true || data.appId !== profile.appId || data.entryId !== profile.entryId ||
        data.portalOrigin !== profile.portalOrigin || data.fuxiOrigin !== profile.fuxiOrigin) {
        clearGrant(); try { currentGrant.child.close() } catch {} show('广场伏羲入口已停用或配置不符。'); return
      }
      currentGrant.stage = 'checking-portal'
    } else return
    let enabled = false
    try {
      const response = await host.fetch(profile.policyUrl, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        const policy = await response.json()
        enabled = policy?.enabled === true && policy.portalOrigin === profile.portalOrigin && policy.plazaOrigin === profile.plazaOrigin && policy.fuxiOrigin === profile.fuxiOrigin &&
          policy.appId === profile.appId && policy.entryId === profile.entryId
      }
    } catch { /* fixed diagnostic below */ }
    if (grant !== currentGrant || Date.now() >= currentGrant.expiresAt) return
    const child = grant.child
    const storage = grant.storage
    try { if (child.closed) { clearGrant(); return } } catch { clearGrant(); return }
    if (!enabled) {
      clearGrant()
      try { child.close() } catch { /* fixed diagnostic below */ }
      show('伏羲入口已停用或配置不可用，请稍后重试。')
      return
    }
    // Consume the click-bound grant before reading; replay cannot read again.
    clearGrant()
    let token = null
    try { token = storage.getItem(profile.credentialKey) } catch { /* fixed diagnostic below */ }
    const valid = typeof token === 'string' && token.length > 0 && token.length <= 8192 && token.trim() === token && !/[\u0000-\u001f\u007f]/.test(token)
    if (!valid) {
      token = null
      try { child.close() } catch { /* fixed diagnostic below */ }
      show('未取得天宫登录凭证，请在天宫登录后重试。')
      return
    }
    try {
      child.postMessage({ type: 'fuxi:tiangong:login', requestId: currentGrant.fuxiRequestId, token }, profile.fuxiOrigin)
      show('已发起身份验证，请在伏羲窗口查看结果。')
    } catch { show('本次身份交接未完成，请重新进入。') }
    finally { token = null }
  }
  const dispose = () => {
    generation++
    if (grant) { try { grant.child.close() } catch {} }
    clearGrant()
    button.removeEventListener('click', open)
    host.removeEventListener('message', receive)
    host.removeEventListener('pagehide', dispose)
  }
  button.disabled = false
  button.addEventListener('click', open)
  host.addEventListener('message', receive)
  host.addEventListener('pagehide', dispose)
  show('点击进入伏羲测试环境。')
  return { dispose }
}

export async function startConfiguredPortalWidget(host) {
  const button = host.document.getElementById('open-fuxi')
  const status = host.document.getElementById('status')
  const show = message => { if (status) status.textContent = message }
  if (!button || host.parent === host) { show('请从天宫中的广场入口进入。'); return }
  const policyUrl = new URL('./fuxi-widget-test-policy.json', import.meta.url)
  if (policyUrl.origin !== host.location.origin) { show('入口配置不可用。'); return }
  let policy
  try {
    const response = await host.fetch(policyUrl.href, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (response.ok) policy = await response.json()
  } catch { /* fixed diagnostic below */ }
  if (policy?.enabled !== true) { button.textContent = '入口暂不可用'; show('伏羲入口暂未启用。'); return }
  return startPortalWidget(host, { portalOrigin: policy.portalOrigin, plazaOrigin: policy.plazaOrigin,
    fuxiOrigin: policy.fuxiOrigin, appId: policy.appId, entryId: policy.entryId,
    policyUrl: policyUrl.href, credentialKey: 'sky-token', ttlMs: 120000 })
}

if (typeof window !== 'undefined' && window.document.getElementById('fuxi-portal-widget')) startConfiguredPortalWidget(window)
