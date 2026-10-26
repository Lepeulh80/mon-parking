// Détection de secrets compilés dans le bundle public.
// Extrait de scripts/deploy-check.mjs pour être testable en isolation :
// une clé peut arriver dans dist/ via un .env commité ou un import direct,
// ce qu'un scan des seules variables VITE_* ne verrait jamais.
import { existsSync,readdirSync,readFileSync,statSync } from 'node:fs'
import { join } from 'node:path'

export const SECRET_PATTERNS = [
  ['clé privée PEM', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['clé secrète Supabase', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['clé de service Stripe', /sk_live_[A-Za-z0-9]{16,}/],
  ['rôle service_role', /service_role/],
]

export function scanDist(root) {
  const hits = [], seen = new Set()
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue }
      if (!/\.(?:js|html|json|map|css)$/i.test(entry.name)) continue
      let size = 0
      try { size = statSync(full).size } catch { continue }
      if (size > 8 * 1024 * 1024) continue
      seen.add(full)
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch { continue }
      for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(text)) hits.push(`${label} dans ${full.slice(root.length + 1) || entry.name}`)
      }
    }
  }
  if (existsSync(root)) walk(root)
  return { hits, scanned: seen.size }
}
