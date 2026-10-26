/**
 * API de notifications, isolée du composant pour être testable sans JSX.
 *
 * Défaut corrigé en v19.3 : le contexte par défaut de `ToastCtx` ne portait
 * que `push`. Un composant monté hors de `<ToastProvider>` (écran isolé,
 * test, rendu partiel) appelait `toast.ok(...)` → `TypeError: toast.ok is
 * not a function` au lieu d'un no-op silencieux.
 */

export const TOAST_KINDS = Object.freeze(['info', 'ok', 'err'])

/**
 * Construit l'API de toasts autour d'une fonction d'émission.
 * @param {(message: string, kind?: 'info'|'ok'|'err') => void} push
 */
export function createToastApi(push) {
  if (typeof push !== 'function') throw new TypeError('createToastApi attend une fonction push.')
  const emit = (kind) => (message) => push(String(message ?? ''), kind)
  return {
    push,
    info: emit('info'),
    ok: emit('ok'),
    err: emit('err'),
  }
}

/** API inerte : utilisée comme valeur par défaut du contexte React. */
export const NOOP_TOAST = createToastApi(() => {})

export function isToastApi(value) {
  return Boolean(value)
    && typeof value.push === 'function'
    && typeof value.ok === 'function'
    && typeof value.err === 'function'
    && typeof value.info === 'function'
}
