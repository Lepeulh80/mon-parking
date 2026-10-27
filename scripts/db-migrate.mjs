// Applique les migrations PostgreSQL sur l'hôte DIRECT (sans -pooler).
// PgBouncer en mode transaction refuse le DDL : c'est pour cela que ce script
// existe séparément du démarrage du serveur (PG_AUTO_MIGRATE=0 en production).
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { openSql } from '../server/sql.mjs'

const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL
if (!url) { console.error('DATABASE_DIRECT_URL (ou DATABASE_URL) manquant.'); process.exit(2) }
if (/-pooler\./.test(url)) {
  console.error('URL de pooler détectée : utilisez l\'hôte direct pour les migrations (retirez « -pooler »).')
  process.exit(2)
}
const here = dirname(new URL(import.meta.url).pathname)
const dir = join(here, '..', 'supabase', 'migrations')
const files = ['20261026100000_auth_store.sql', '20261027120000_server_business.sql']
const { sql, close } = await openSql({ connectionString: url })
try {
  for (const name of files) {
    const file = join(dir, name)
    if (!existsSync(file)) { console.error(`Absent : ${name}`); process.exit(2) }
    await sql.exec(readFileSync(file, 'utf8'))
    console.log(`Migration appliquée : ${name}`)
  }
  const tables = await sql.all("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
  console.log('Tables : ' + tables.map((t) => t.table_name).join(', '))
} catch (error) {
  console.error('Migration échouée : ' + error.message)
  process.exit(1)
} finally { await close() }
