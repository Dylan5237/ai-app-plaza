type DateInput = string | Date | null | undefined

function parseDate(value: DateInput): Date | null {
  if (value == null || value === '') return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatDate(value: DateInput): string {
  if (!value) return '未登记'
  const parsed = parseDate(value)
  if (!parsed) return String(value)
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed).replaceAll('/', '-')
}

export function formatDateTime(value: DateInput, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const parsed = parseDate(value)
  if (!parsed) return String(value)
  const parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(parsed)
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}`
}
