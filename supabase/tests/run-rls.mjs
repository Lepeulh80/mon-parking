// Lance la suite RLS contre un PostgreSQL RÉEL.
// Usage : node supabase/tests/run-rls.mjs [--keep]
// Variables : PGHOST/PGPORT/PGUSER (défaut : socket local, utilisateur postgres
// via sudo), ou DATABASE_URL pour un serveur distinct (ex. un projet Supabase
// de test). Sans psql, le script s'arrête avec un message explicite (code 2)
// au lieu de prétendre avoir testé.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const DB = process.env.RLS_DB || 'mon_parking_rls_test'

const has = (cmd) => spawnSync('which', [cmd]).status === 0
if (!has('psql')) {
  console.error('SKIP : psql absent. Installez PostgreSQL (apt install postgresql) ou définissez DATABASE_URL.')
  process.exit(2)
}

const useSudo = !process.env.DATABASE_URL && process.getuid?.() !== 0
const base = process.env.DATABASE_URL ? [] : ['-U', process.env.PGUSER || 'postgres', '-h', process.env.PGHOST || '/var/run/postgresql']
// Le SQL est TOUJOURS passé par stdin : le compte `postgres` n'a pas forcément
// le droit de lire les fichiers du répertoire de travail (échec « Permission
// denied » observé avec `psql -f`), et stdin évite toute copie temporaire.
const run = (sql, { db = 'postgres', file = null, quiet = false } = {}) => {
  const args = [...base, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-d', db, '-f', '-']
  const input = file ? readFileSync(file, 'utf8') : sql
  const cmd = useSudo ? 'sudo' : null
  const res = cmd
    ? spawnSync(cmd, ['-u', 'postgres', 'psql', ...args], { encoding: 'utf8', input })
    : spawnSync('psql', args, { encoding: 'utf8', input })
  if (!quiet && res.status !== 0) {
    console.error(res.stderr || res.stdout)
  }
  return res
}

// 1. Base de test neuve : on ne teste jamais sur des données existantes.
run(`drop database if exists ${DB}`, { quiet: true })
const created = run(`create database ${DB}`, { quiet: true })
if (created.status !== 0) { console.error(created.stderr); process.exit(1) }

// 2. Schéma + harnais + suite, dans l'ordre.
const migrations = readdirSync(join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
const files = [join(here, '00_auth_stub.sql'), join(here, '00b_storage_stub.sql'), ...migrations.map((f) => join(root, 'supabase', 'migrations', f)), join(here, '99_rls_suite.sql')]

for (const file of files) {
  const res = run(null, { db: DB, file })
  if (res.status !== 0) {
    console.error(`ÉCHEC pendant ${file.split('/').slice(-2).join('/')}`)
    process.exit(1)
  }
}

// 3. Lecture des résultats.
const res = run(`select ok::text || '|' || name || '|' || coalesce(detail,'') from rls_results order by id`, { db: DB })
const rows = (res.stdout || '').trim().split('\n').filter(Boolean).map((line) => {
  const [ok, name, detail] = line.split('|')
  return { ok: ok === 't' || ok === 'true', name, detail }
})

let passed = 0, failed = 0
for (const row of rows) {
  if (row.ok) { passed++; console.log('OK  ', row.name) }
  else { failed++; console.log('FAIL', row.name, '→', row.detail) }
}
console.log(`\nRLS (PostgreSQL réel) : ${passed} passed / ${failed} failed`)

if (!process.argv.includes('--keep')) run(`drop database if exists ${DB}`, { quiet: true })
console.log(`Base de test : ${DB} (${process.argv.includes('--keep') ? 'conservée' : 'supprimée'})`)
process.exitCode = failed ? 1 : 0
