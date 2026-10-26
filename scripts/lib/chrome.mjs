// Résolution du navigateur pour les tests navigateur (m5).
// Aucun chemin absolu propre à une machine ne doit être codé en dur : la suite
// doit tourner en CI et sur n'importe quel poste, sinon la validation
// navigateur n'est pas reproductible.
import { existsSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SYSTEM_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

// Chrome téléchargé par Puppeteer : ~/.cache/puppeteer/chrome/<version>/chrome-linux64/chrome
function puppeteerCacheCandidates() {
  const roots = [
    join(homedir(), '.cache', 'puppeteer', 'chrome'),
    join(homedir(), 'Library', 'Caches', 'puppeteer', 'chrome'),
    join(homedir(), 'AppData', 'Local', 'puppeteer', 'chrome'),
  ]
  const found = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let versions = []
    try { versions = readdirSync(root) } catch { continue }
    for (const version of versions.sort().reverse()) {
      for (const suffix of ['chrome-linux64/chrome', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-win64/chrome.exe']) {
        found.push(join(root, version, suffix))
      }
    }
  }
  return found
}

export function chromePath() {
  const explicit = process.env.CHROME
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`CHROME pointe vers un fichier absent : ${explicit}`)
    }
    return explicit
  }
  for (const candidate of [...SYSTEM_CANDIDATES, ...puppeteerCacheCandidates()]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'Navigateur introuvable pour les tests navigateur. Installez Chrome/Chromium, ' +
    'exécutez « npx puppeteer browsers install chrome », ou définissez CHROME=/chemin/vers/chrome.',
  )
}
