import { apiRequest } from './api.js'

export const DEFAULT_SHARE_TEMPLATES = {
  agent: '[AI应用分享]【{{name}}】\n{{summary}}\n在应用广场查看并一键安装：{{url}}',
  platform: '[AI应用分享]【{{name}}】\n{{summary}}\n在应用广场查看并立即使用：{{url}}',
}

let cached = { ...DEFAULT_SHARE_TEMPLATES }
let loadedOnce = false
let inFlight: Promise<{ templates: typeof DEFAULT_SHARE_TEMPLATES; ok: boolean }> | null = null
let requestSequence = 0
let latestCompletedSequence = 0

export function currentShareTemplates() {
  return cached
}

export function hasLoadedShareTemplates() {
  return loadedOnce
}

export function resetShareTemplatesCache() {
  cached = { ...DEFAULT_SHARE_TEMPLATES }
  loadedOnce = false
  inFlight = null
  requestSequence = 0
  latestCompletedSequence = 0
}

export async function loadShareTemplates(
  force = false,
  options: { bypassInFlight?: boolean } = {},
): Promise<{ templates: typeof DEFAULT_SHARE_TEMPLATES; ok: boolean }> {
  if (loadedOnce && !force) return { templates: cached, ok: true }
  if (inFlight && !options.bypassInFlight) return inFlight
  const seq = ++requestSequence
  const request = apiRequest('/api/share-templates')
    .then((result) => {
      if (result && typeof result.agent === 'string' && typeof result.platform === 'string') {
        const fetched = { agent: result.agent, platform: result.platform }
        if (seq > latestCompletedSequence) {
          latestCompletedSequence = seq
          cached = fetched
          loadedOnce = true
        }
        return { templates: cached, ok: true }
      }
      return { templates: cached, ok: false }
    })
    .catch(() => ({ templates: cached, ok: false }))
    .finally(() => {
      if (inFlight === request) inFlight = null
    })
  inFlight = request
  return request
}

/** Single-pass substitution; blank summary removes its standalone line. */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return String(template || '').replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match,
  )
}

export function renderShareTemplate(
  template: string,
  values: { name: string; summary?: string | null; url: string },
): string {
  const summary = (values.summary ?? '').trim()
  const normalizedTemplate = summary
    ? String(template || '')
    : String(template || '').split(/\r?\n/).filter(line => line.trim() !== '{{summary}}').join('\n')
  const rendered = renderTemplate(normalizedTemplate, {
    name: values.name || '未命名应用',
    summary,
    url: values.url,
  })
  const url = String(values.url || '').trim()
  if (url && !rendered.includes(url)) {
    return rendered ? `${rendered}\n${url}` : url
  }
  return rendered
}
