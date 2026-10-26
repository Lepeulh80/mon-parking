/**
 * Hook de traduction (isolé de `i18n.js` pour éviter un cycle
 * i18n -> display -> i18n au moment de l'évaluation des modules).
 */
import { useEffect, useState } from 'react'
import { t as translate, dirFor, isRTL } from './i18n.js'
import { getDisplaySettings } from './display.js'

export function useTranslation() {
  const [lang, setLang] = useState(() => getDisplaySettings().lang)
  useEffect(() => {
    // Changer la langue dans les réglages retraduit l'interface déjà montée.
    const sync = () => setLang(getDisplaySettings().lang)
    window.addEventListener('mp-appearance', sync)
    return () => window.removeEventListener('mp-appearance', sync)
  }, [])
  return { lang, dir: dirFor(lang), rtl: isRTL(lang), t: (key, vars) => translate(lang, key, vars) }
}

export default useTranslation
