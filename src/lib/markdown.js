import MarkdownIt from 'markdown-it'

function absoluteSafeUrl(value) {
  if (/[\u0000-\u0020\u007f]/.test(value)) return ''
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return ''
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
    if (['mailto:', 'tel:'].includes(url.protocol)) return value
  } catch {
    return ''
  }
  return ''
}

export function safeMarkdownHref(href, baseUrl = '') {
  if (typeof href !== 'string' || !href.trim()) return ''
  const value = href.trim()
  const absolute = absoluteSafeUrl(value)
  if (absolute) return absolute
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('\\\\')) return ''
  if (/[\u0000-\u001f\u007f]/.test(value)) return ''

  if (baseUrl) {
    try {
      const resolved = new URL(value, baseUrl)
      if (['http:', 'https:'].includes(resolved.protocol) && !resolved.username && !resolved.password) return resolved.href
      return ''
    } catch {
      return ''
    }
  }
  return value
}

export function repositoryDocumentBase(projectUrl, commitSha, documentPath) {
  if (typeof projectUrl !== 'string' || typeof commitSha !== 'string' || typeof documentPath !== 'string') return ''
  if (!projectUrl || !commitSha || !documentPath) return ''
  try {
    const repository = new URL(projectUrl)
    if (!['http:', 'https:'].includes(repository.protocol) || repository.username || repository.password) return ''
    repository.search = ''
    repository.hash = ''
    repository.pathname = repository.pathname.replace(/\.git$/i, '').replace(/\/+$/, '')
    const path = documentPath.replaceAll('\\', '/').replace(/^\/+/, '')
    const encodedPath = path.split('/').map(encodeURIComponent).join('/')
    const documentUrl = `${repository.origin}${repository.pathname}/-/blob/${encodeURIComponent(commitSha)}/${encodedPath}`
    return new URL('.', documentUrl).href
  } catch {
    return ''
  }
}

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false })
markdown.validateLink = (href) => Boolean(safeMarkdownHref(href))

const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  const safeHref = safeMarkdownHref(token.attrGet('href') || '', env?.baseUrl || '')
  token.attrSet('href', safeHref || '#')
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  if (!safeHref) token.attrSet('aria-disabled', 'true')
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, renderer)
    : renderer.renderToken(tokens, index, options)
}

markdown.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index].attrGet('alt') || '图片'
  return markdown.utils.escapeHtml(alt)
}

export function renderMarkdown(source, context = {}) {
  return markdown.render(typeof source === 'string' ? source : '', { baseUrl: context.baseUrl || '' })
}
