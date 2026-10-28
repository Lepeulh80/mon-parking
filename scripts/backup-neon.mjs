// Sauvegarde logique de la base PostgreSQL (Neon) sans dépendre de pg_dump :
// le client local (16.x) refuse de dumper un serveur 18.x et produisait un
// fichier de 20 octets. On écrit donc un dump SQL autonome avec le même
// pilote `pg` que l'application, table par table, dans une transaction
// READ ONLY : aucune écriture, aucune donnée modifiée.
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL (ou DATABASE_DIRECT_URL) absent : rien à sauvegarder.'); process.exit(1) }
const dir = process.env.BACKUP_DIR || 'backups'
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const file = join(dir, `mon-parking-${stamp}.sql`)

const quote = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (typeof v === 'object') v = JSON.stringify(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

const client = new Client({ connectionString: url, ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: false } : undefined })
await client.connect()
await client.query('BEGIN READ ONLY')
const tables = await client.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)
const out = [`-- MON PARKING — sauvegarde logique ${new Date().toISOString()}`, 'BEGIN;']
let rowsTotal = 0
for (const { table_name: t } of tables.rows) {
  const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t])
  const names = cols.rows.map((c) => c.column_name)
  const data = await client.query(`SELECT * FROM "${t}"`)
  rowsTotal += data.rowCount
  if (!data.rowCount) continue
  const values = data.rows.map((r) => `(${names.map((n) => quote(r[n])).join(',')})`).join(',\n')
  out.push(`-- ${t} : ${data.rowCount} ligne(s)`)
  out.push(`INSERT INTO "${t}" (${names.map((n) => `"${n}"`).join(',')}) VALUES\n${values}\nON CONFLICT DO NOTHING;`)
}
out.push('COMMIT;')
await client.query('ROLLBACK') // lecture seule : rien à valider
await client.end()
writeFileSync(file, out.join('\n'))
const size = statSync(file).size
console.log(`Sauvegarde : ${file} — ${size} octets, ${tables.rowCount} tables, ${rowsTotal} lignes`)
if (size < 1024) { console.error('Sauvegarde suspecte : moins de 1 Kio.'); process.exit(1) }
