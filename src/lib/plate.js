/**
 * MON PARKING — Normalisation et validation des immatriculations.
 *
 * Le moteur OCR (Tesseract) confond régulièrement les caractères ambigus :
 *   O/0, I/1, S/5, B/8, Z/2, G/6, D/0, Q/0…
 * On ne se contente pas de « nettoyer » la chaîne : on la projette sur les
 * gabarits d'immatriculation connus (SIV français, Côte d'Ivoire, libre),
 * chaque position imposant son type (lettre ou chiffre), puis on valide.
 */

/* ------------------------------------------------------------------ */
/* Tables de confusion                                                 */
/* ------------------------------------------------------------------ */

const DIGIT_TO_LETTER = {
  0: 'O', 1: 'I', 2: 'Z', 3: 'E', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B', 9: 'G',
}

const LETTER_TO_DIGIT = {
  O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '7', S: '5', B: '8',
  Z: '2', G: '6', A: '4', E: '8', R: '2', Y: '4', P: '9',
}

/** Lettres interdites en position « lettre » pour le SIV français. */
const SIV_FORBIDDEN = new Set(['I', 'O', 'U'])

/**
 * Confusions tolérées sur les caractères LITTÉRAUX d'un gabarit. L'OCR rend
 * fréquemment « CI 4471 AB » sous la forme « Cl 4471 AB » (L minuscule lu au
 * lieu de I) : sans cette table, la plaque ivoirienne n'était jamais reconnue.
 */
const LITERAL_ALTS = {
  I: 'IL1|!lt',
  O: 'O0QD',
  '0': 'O0QD',
  C: 'C(',
  G: 'G6',
  '6': 'G6',
  S: 'S5',
  '5': 'S5',
  B: 'B8',
  '8': 'B8',
  Z: 'Z2',
  '2': 'Z2',
}

/* ------------------------------------------------------------------ */
/* Gabarits                                                            */
/* ------------------------------------------------------------------ */

/**
 * Gabarits : '@' = position lettre, '#' = position chiffre, tout autre
 * caractère est un littéral obligatoire.
 */
const TEMPLATES = [
  {
    id: 'SIV',
    tpl: '@@###@@',
    label: 'SIV France · AA-123-AA',
    priority: 100,
    format: (s) => `${s.slice(0, 2)}-${s.slice(2, 5)}-${s.slice(5, 7)}`,
    validate: (s) => {
      const letters = s.slice(0, 2) + s.slice(5, 7)
      const bad = [...new Set([...letters].filter((c) => SIV_FORBIDDEN.has(c)))]
      return bad.length ? `Lettres interdites en SIV : ${bad.join(', ')}` : null
    },
  },
  {
    id: 'CI',
    tpl: 'CI####@@',
    label: 'Côte d’Ivoire · CI 1234 AB',
    priority: 96,
    format: (s) => `CI ${s.slice(2, 6)} ${s.slice(6, 8)}`,
  },
  {
    id: 'CI-LEGACY',
    tpl: '@@####CI',
    label: 'Côte d’Ivoire (ancien) · AB 1234 CI',
    priority: 92,
    format: (s) => `${s.slice(0, 2)} ${s.slice(2, 6)} CI`,
  },
  {
    id: 'CI-ALPHA',
    tpl: 'CI@@####',
    label: 'Côte d’Ivoire (récent) · CI AB 1234',
    priority: 88,
    format: (s) => `CI ${s.slice(2, 4)} ${s.slice(4, 8)}`,
  },
  {
    id: 'CI-DIGITS',
    tpl: 'CI#####',
    label: 'Côte d’Ivoire (temporaire) · CI 123456',
    priority: 80,
    format: (s) => `CI ${s.slice(2)}`,
  },
  {
    id: 'FREE-L7',
    tpl: '@@###@@',
    label: 'Format libre · 7 caractères',
    priority: 40,
    format: (s) => `${s.slice(0, 2)}-${s.slice(2, 5)}-${s.slice(5, 7)}`,
  },
  {
    id: 'FREE-LLDDDD',
    tpl: '@@####',
    label: 'Format libre · 6 caractères',
    priority: 34,
    format: (s) => `${s.slice(0, 2)} ${s.slice(2)}`,
  },
  {
    id: 'FREE-LLLDDD',
    tpl: '@@@###',
    label: 'Format libre · 6 caractères alphabétiques',
    priority: 30,
    format: (s) => `${s.slice(0, 3)} ${s.slice(3)}`,
  },
  {
    id: 'FREE-LLDDD',
    tpl: '@@###',
    label: 'Format libre · 5 caractères',
    priority: 26,
    format: (s) => `${s.slice(0, 2)} ${s.slice(2)}`,
  },
  {
    id: 'FREE-LLDDDDD',
    tpl: '@@#####',
    label: 'Format libre · 7 caractères',
    priority: 24,
    format: (s) => `${s.slice(0, 2)} ${s.slice(2)}`,
  },
]

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/** Ne garde que A-Z et 0-9, en majuscules. */
export function compact(raw) {
  return String(raw || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '')
}

/** Projette une chaîne sur un gabarit ; renvoie null si impossible. */
function forceTemplate(str, tpl) {
  if (!str || str.length !== tpl.length) return null
  let out = ''
  for (let i = 0; i < tpl.length; i += 1) {
    const c = str[i]
    const t = tpl[i]
    if (t === '@') {
      if (/[A-Z]/.test(c)) out += c
      else if (DIGIT_TO_LETTER[c]) out += DIGIT_TO_LETTER[c]
      else return null
    } else if (t === '#') {
      if (/[0-9]/.test(c)) out += c
      else if (LETTER_TO_DIGIT[c]) out += LETTER_TO_DIGIT[c]
      else return null
    } else if (c === t) {
      out += t
    } else if (LITERAL_ALTS[t] && LITERAL_ALTS[t].includes(c)) {
      out += t
    } else {
      return null
    }
  }
  return out
}

/**
 * Normalise une saisie ou un résultat OCR vers l'immatriculation la plus
 * plausible. Renvoie { value, format, label, ok, warning }.
 */
export function normalizePlate(raw) {
  const c = compact(raw)
  if (!c) return { value: '', format: null, label: '', ok: false, warning: null }
  // Un « cl » minuscule est la lecture la plus fréquente de « CI » par l'OCR.
  const fixed = c.replace(/^CL(?=\d)/, 'CI')

  for (const t of TEMPLATES) {
    const forced = forceTemplate(fixed, t.tpl)
    if (forced) {
      const warning = t.validate ? t.validate(forced) : null
      return {
        value: t.format(forced),
        format: t.id,
        label: t.label,
        ok: !warning,
        warning,
        compact: forced,
      }
    }
  }
  // Repli : on rend la saisie lisible par groupes.
  const groups = c.match(/.{1,4}/g) || [c]
  return {
    value: groups.join(' '),
    format: 'RAW',
    label: 'Format non reconnu',
    ok: false,
    warning: 'Format non reconnu — vérifiez la plaque.',
    compact: c,
  }
}

/** Valide une plaque déjà formatée. */
export function validatePlate(value) {
  const c = compact(value)
  if (!c) return { ok: false, format: null, warning: 'Immatriculation vide.' }
  if (c.length < 5) return { ok: false, format: null, warning: 'Trop court (5 caractères minimum).' }
  const norm = normalizePlate(value)
  return {
    ok: norm.ok && norm.format !== 'RAW',
    format: norm.format,
    label: norm.label,
    warning: norm.warning || (norm.format === 'RAW' ? 'Format inhabituel.' : null),
    value: norm.value,
  }
}

/**
 * Extrait les candidats d'un texte OCR.
 * @param {string} text texte brut renvoyé par Tesseract
 * @param {object} opts { confidence }
 * @returns {Array<{value, compact, format, label, score, confidence, ok, warning}>}
 */
export function extractCandidates(text, opts = {}) {
  const baseConfidence = Number.isFinite(opts.confidence) ? opts.confidence : 0
  const found = new Map()

  const consider = (rawStr, bonus = 0, conf = baseConfidence) => {
    const c = compact(rawStr)
    if (c.length < 5 || c.length > 10) return
    for (const t of TEMPLATES) {
      const forced = forceTemplate(c, t.tpl)
      if (!forced) continue
      const warning = t.validate ? t.validate(forced) : null
      const value = t.format(forced)
      const score =
        t.priority +
        Math.round(conf / 12) +
        bonus -
        (warning ? 45 : 0) -
        Math.abs(c.length - 8) * 0.5
      const key = value.replace(/[^A-Z0-9]/g, '')
      const prev = found.get(key)
      if (!prev || prev.score < score) {
        found.set(key, {
          value,
          compact: forced,
          format: t.id,
          label: t.label,
          score,
          confidence: Math.round(conf),
          ok: !warning,
          warning,
        })
      }
    }
  }

  const lines = String(text || '')
    .toUpperCase()
    .split(/\r?\n/)

  for (const line of lines) {
    const c = compact(line)
    if (!c) continue
    consider(c, 4) // ligne entière : le meilleur indice
    // Preserve OCR word boundaries: "o Cl 4471 AB" contains a complete
    // CI plate plus a noisy prefix. Prefer whole word groups to a truncated
    // substring such as "L4471AB", which could fabricate a French plate.
    const words = line.match(/[A-Z0-9]+/g) || []
    for (let start = 0; start < words.length; start += 1) {
      for (let end = start + 1; end <= words.length; end += 1) {
        const group = words.slice(start, end).join('')
        if (group.length > 10) break
        consider(group, 8)
      }
    }
    // Fenêtres glissantes : l'OCR ajoute souvent du bruit autour de la plaque.
    const maxLen = Math.min(c.length, 9)
    for (let len = 5; len <= maxLen; len += 1) {
      for (let i = 0; i + len <= c.length; i += 1) {
        if (i === 0 && len === c.length) continue
        consider(c.slice(i, i + len), 0)
      }
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 6)
}

/** Vérifie qu'une plaque correspond à un véhicule du parc (comparaison souple). */
export function samePlate(a, b) {
  const x = compact(a)
  const y = compact(b)
  if (!x || !y) return false
  if (x === y) return true
  const nx = compact(normalizePlate(a).value)
  const ny = compact(normalizePlate(b).value)
  return nx && ny && nx === ny
}

export const PLATE_EXAMPLES = ['AB-123-CD', 'CI 4471 AB', 'AB 1234 CI']
export const PLATE_HELP =
  'Cadrez la plaque dans le rectangle. Formats reconnus : AA-123-AA (SIV), CI 1234 AB, AB 1234 CI.'
