// MON PARKING — migration des données d'authentification SQLite -> PostgreSQL.
//
// Usage :
//   DATABASE_URL=postgresql://… node scripts/sqlite-to-postgres.mjs \
//     --sqlite .server-data/auth.sqlite [--force]
//
// Sans --force, la migration refuse d'écrire si la table accounts du serveur
// PostgreSQL contient déjà des lignes : un import partiel produirait deux
// sources d'identité divergentes, exactement ce que importTrusted() interdit.
//
// Les colonnes sont nommées une par une : les bases antérieures à la v19 n'ont
// pas totp_*, et un INSERT positionnel les décalerait silencieusement.

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { openSql } from '../server/sql.mjs'

const TABLES = [
  ['lots', ['id', 'profile']],
  ['accounts', ['id', 'principal', 'username', 'name', 'role', 'lot_id', 'active',
    'pin_hash', 'pin_salt', 'generation', 'failures', 'locked_until', 'phone', 'email',
    'totp_secret', 'totp_active', 'totp_last_step', 'totp_backup', 'totp_failures', 'totp_locked_until']],
  ['sessions', ['token_hash', 'account_id', 'generation', 'created', 'expires']],
  ['auth_audit', ['id', 'actor', 'action', 'target', 'at']],
  ['login_attempts', ['key', 'count', 'reset']],
  ['login_challenges', ['token_hash', 'account_id', 'principal', 'expires', 'attempts', 'created']],
]

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const source = value('--sqlite') || process.env.AUTH_DB || '.server-data/auth.sqlite'
if (!existsSync(source)) {
  console.error(`Base SQLite introuvable : ${source}`)
  process.exit(1)
}

const { sql, close } = await openSql({ connectionString: process.env.DATABASE_URL })

try {
  const existing = await sql.one('SELECT count(*)::int AS n FROM accounts')
  if (existing.n > 0 && !flag('--force')) {
    console.error(`Refus : ${existing.n} compte(s) déjà présents dans PostgreSQL. Utilisez --force pour fusionner sciemment.`)
    process.exitCode = 1
  } else {
    const db = new DatabaseSync(source, { readOnly: true })
    const report = []
    await sql.transaction(async tx => {
      for (const [table, wanted] of TABLES) {
        let rows = []
        try { rows = db.prepare(`SELECT * FROM ${table}`).all() } catch { report.push([table, 0, 'table absente']); continue }
        // Les colonnes viennent de PRAGMA table_info, jamais de la première
        // ligne : une table vide (login_attempts au premier démarrage) n'a pas
        // de ligne, et l'ancienne version annonçait alors « colonnes absentes ».
        let columns = new Set()
        try { columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)) } catch { /* table virtuelle */ }
        const usable = wanted.filter(name => columns.has(name))
        let written = 0
        for (const row of rows) {
          const values = usable.map(name => row[name] ?? null)
          const placeholders = usable.map((_, index) => `$${index + 1}`).join(',')
          await tx.run(
            `INSERT INTO ${table} (${usable.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
            values,
          )
          written++
        }
        report.push([table, written, usable.length < wanted.length ? `colonnes absentes : ${wanted.filter(n => !columns.has(n)).join(', ')}` : 'ok'])
      }
    })
    db.close()
    console.log('TABLE                  LIGNES  REMARQUE')
    for (const [table, count, note] of report) console.log(`${table.padEnd(22)} ${String(count).padStart(6)}  ${note}`)
    const after = await sql.one('SELECT count(*)::int AS n FROM accounts')
    const admins = await sql.one("SELECT count(*)::int AS n FROM accounts WHERE role='admin' AND active=1")
    console.log(`\nCONTRÔLE : ${after.n} compte(s), ${admins.n} administrateur(s) actif(s).`)
    console.log(admins.n > 0 ? '/readyz répondra 200 sur ce serveur.' : '/readyz restera en 503 ADMIN_REQUIRED.')
  }
} catch (error) {
  console.error('Migration interrompue :', error.message)
  process.exitCode = 1
} finally {
  await close()
}
