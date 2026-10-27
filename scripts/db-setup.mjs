// Une seule commande : applique les migrations sur l'hôte DIRECT puis vérifie
// les deux magasins. Neon exige un hôte direct pour le DDL (le pooler PgBouncer
// refuse CREATE TABLE) : on retire « -pooler » de l'URL si besoin.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

const pooled = process.env.DATABASE_URL || ''
if (!pooled) { console.error('DATABASE_URL manquant.'); process.exit(2) }
const direct = process.env.DATABASE_DIRECT_URL || pooled.replace(/-pooler\./, '.')
const here = dirname(new URL(import.meta.url).pathname)
const show = (u) => u.replace(/(:\/\/[^:]+:)[^@]+@/, '$1***@')

console.log('Direct  : ' + show(direct))
if (process.env.DATABASE_DIRECT_URL === undefined) console.log('Pooler  : ' + show(pooled) + '  (déduit : -pooler retiré)')

const migrate = spawnSync(process.execPath, [join(here, 'db-migrate.mjs')], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: direct },
})
if (migrate.status !== 0) { console.error('Migrations échouées : rien n\'a été modifié côté service.'); process.exit(migrate.status || 1) }

const test = spawnSync(process.execPath, [join(here, 'test-pg-stores.mjs')], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: direct },
})
process.exit(test.status || 0)
