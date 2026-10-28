// Sauvegarde logique de la base PostgreSQL (Neon) : un dump SQL compressé
// horodaté dans backups/. Lecture seule côté base, donc sans risque.
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL (ou DATABASE_DIRECT_URL) absent : rien à sauvegarder.'); process.exit(1) }
const dir = process.env.BACKUP_DIR || 'backups'
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const file = join(dir, `mon-parking-${stamp}.sql.gz`)
execFileSync('bash', ['-c', `pg_dump "$DB_URL" --no-owner --no-privileges | gzip -9 > "${file}"`], {
  stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, DB_URL: url },
})
const size = statSync(file).size
console.log(`Sauvegarde écrite : ${file} (${size} octets)`)
if (size < 1024) { console.error('Sauvegarde suspecte : moins de 1 Kio.'); process.exit(1) }
