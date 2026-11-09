// First-party anonymous measurement. Never sends URLs, search text, clipboard text or credentials.
let enabled = false
let visitor = null
let session = null
const view = uuid()
let memorySession = uuid()
let memoryLastAt = 0
const visitorKey = 'plaza-analytics-visitor-v1'
const sessionKey = 'plaza-analytics-session-v1'
const sessionWindow = 30 * 60 * 1000
const visitorWindow = 180 * 24 * 60 * 60 * 1000

export function uuid() {
  try {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch { return null }
}
function validId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) }
function currentIdentity() {
  const now = Date.now()
  try {
    let saved = JSON.parse(localStorage.getItem(visitorKey) || 'null')
    if (!saved || !validId(saved.id) || !Number.isFinite(saved.createdAt) || saved.createdAt > now || now - saved.createdAt >= visitorWindow) {
      saved = { id: uuid(), createdAt: now }
      if (!saved.id) throw new Error('random unavailable')
      localStorage.setItem(visitorKey, JSON.stringify(saved))
    }
    let current = JSON.parse(localStorage.getItem(sessionKey) || 'null')
    if (!current || !validId(current.id) || current.visitorId !== saved.id || !Number.isFinite(current.lastAt) || current.lastAt > now || now - current.lastAt >= sessionWindow) {
      current = { id: uuid(), visitorId: saved.id, lastAt: now }
    }
    if (!current.id) throw new Error('random unavailable')
    current.lastAt = now
    localStorage.setItem(sessionKey, JSON.stringify(current))
    visitor = saved.id; session = current.id
    return { identityScope: 'persistent', visitorId: visitor, sessionId: session }
  } catch {
    if (!memorySession || !memoryLastAt || now < memoryLastAt || now - memoryLastAt >= sessionWindow) memorySession = uuid()
    memoryLastAt = now
    return { identityScope: 'session_only', visitorId: null, sessionId: memorySession }
  }
}
export function enableAnalytics(value) { enabled = value === true }
export function track(eventName, attributes, context = {}) {
  if (!enabled || !view) return
  const identity = currentIdentity()
  const eventId = uuid()
  if (!identity.sessionId || !eventId) return
  const payload = JSON.stringify({ eventId, eventName, occurredAt: new Date().toISOString(), ...identity, viewId: view, ...context, attributes })
  const attempt = (remaining) => {
    void fetch('/api/analytics/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true, credentials: 'same-origin', cache: 'no-store' })
      .then(response => { if (!response.ok && response.status >= 500 && remaining) setTimeout(() => attempt(remaining - 1), 2000) })
      .catch(() => { if (remaining) setTimeout(() => attempt(remaining - 1), 2000) })
  }
  attempt(2)
}
