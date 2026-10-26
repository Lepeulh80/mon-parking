// Exécute les six régressions m1–m6 et résume le résultat.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname,join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((name) => /^[cm]\d+-.*\.test\.mjs$/.test(name)).sort()
if (!files.length) { console.error('Aucun test de régression trouvé.'); process.exit(1) }

let failed = 0
for (const file of files) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit' })
    child.on('error', () => resolve(1))
    child.on('exit', (value) => resolve(value ?? 1))
  })
  if (code) { failed++; console.error(`ÉCHEC ${file} (code ${code})`) }
}
console.log(`\nRÉGRESSIONS c1 + m1–m6 : ${files.length - failed}/${files.length} fichiers réussis`)
process.exitCode = failed ? 1 : 0
