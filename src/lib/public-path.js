export function publicBasePath() {
  const value = document.querySelector('meta[name="plaza-base-path"]')?.getAttribute('content') || ''
  return /^\/[a-zA-Z0-9_-]+$/.test(value) ? value : ''
}

export function publicPath(path) {
  return `${publicBasePath()}${path}`
}
