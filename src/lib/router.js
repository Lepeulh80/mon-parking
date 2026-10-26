import { useEffect, useState } from 'react'

function normalize(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').split('?')[0]
  const parts = raw.split('/').filter(Boolean)
  return { path: '/' + parts.join('/'), parts, segment: parts[0] || 'dashboard' }
}

export function useRoute() {
  const [route, setRoute] = useState(() => normalize(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(normalize(window.location.hash))
    window.addEventListener('hashchange', onChange)
    if (!window.location.hash) window.location.hash = '#/dashboard'
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function navigate(to) {
  const target = to.startsWith('#') ? to : '#' + to
  if (window.location.hash === target) return
  window.location.hash = target
  window.scrollTo({ top: 0, behavior: 'instant' })
}
