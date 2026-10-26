import { displayMoney, DEFAULT_CURRENCY } from './money.js'
import { getDisplaySettings, dateLocale } from './display.js'

export const CURRENCIES = { XOF: 'F CFA', EUR: '€', USD: '$' }

/**
 * `fmtMoney(montant, deviseStockee)` : le second argument reste la devise dans
 * laquelle le montant est PERSISTÉ (celle du parking). La conversion vers la
 * devise d'affichage choisie dans les réglages se fait ici, à la lecture.
 * Aucun montant en base n'est modifié par un changement de devise.
 */
export function fmtMoney(n, cur = DEFAULT_CURRENCY) {
  const settings = getDisplaySettings()
  return displayMoney(n, {
    stored: cur || DEFAULT_CURRENCY,
    show: settings.currency,
    rates: settings.rates,
  })
}

export const fmtNum = (n) => (Number(n) || 0).toLocaleString(dateLocale())
export const fmtPct = (n) => `${(Number(n) || 0).toFixed(1)} %`

export const fmtDate = (d) => {
  if (!d) return '—'
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date)) return '—'
  return date.toLocaleDateString(dateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
}
export const fmtDateLong = (d) => {
  if (!d) return '—'
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleDateString(dateLocale(), { day: '2-digit', month: 'long', year: 'numeric' })
}
export const fmtDateTime = (d) => {
  if (!d) return '—'
  const date = d instanceof Date ? d : new Date(d)
  return `${date.toLocaleDateString(dateLocale())} · ${date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}`
}
export const isoDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10)
export const monthKey = (d) => new Date(d).toISOString().slice(0, 7)
export const monthLabel = (key) => {
  const [y, m] = key.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(dateLocale(), { month: 'short', year: '2-digit' })
}
export const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000))
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export const initials = (s = '') =>
  s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export function toCSV(rows, headers) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const head = headers.map((h) => esc(h.label)).join(';')
  const body = rows.map((r) => headers.map((h) => esc(typeof h.value === 'function' ? h.value(r) : r[h.key])).join(';')).join('\n')
  return '\uFEFF' + head + '\n' + body
}

export const classNames = (...a) => a.filter(Boolean).join(' ')

export function monthBuckets(n = 6) {
  const out = []
  const d = new Date()
  d.setDate(1)
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1)
    const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`
    out.push({ key, label: x.toLocaleDateString(dateLocale(), { month: 'short' }) })
  }
  return out
}
