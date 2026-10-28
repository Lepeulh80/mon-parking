// Accès aux données métier servies par le serveur (PostgreSQL/Neon).
// Stratégie : afficher d'abord le cache IndexedDB (instantané, hors ligne),
// puis remplacer par la vérité du serveur dès qu'elle arrive. Si le serveur est
// injoignable, les lignes locales restent affichées : l'interface ne casse pas.
import { useEffect, useState } from 'react'
import { authRequest } from './authSession.js'

export function useRemoteRows(kind, lotId, local) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    if (!lotId || typeof window === 'undefined') { setRows(null); return }
    if (navigator.onLine === false) { setRows(null); return }
    let alive = true
    authRequest(`/api/data/${kind}`)
      .then((data) => { if (alive) setRows(Array.isArray(data?.[kind]) ? data[kind] : []) })
      .catch(() => { if (alive) setRows(null) })
    return () => { alive = false }
  }, [kind, lotId])
  return rows ?? local ?? []
}

export const pushVehicle = (lotId, data, id) => authRequest(
  id ? `/api/data/vehicles/${encodeURIComponent(id)}` : '/api/data/vehicles',
  { method: id ? 'PATCH' : 'POST', body: data },
)
export const removeVehicle = (id) => authRequest(`/api/data/vehicles/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const pushClient = (data) => authRequest('/api/data/clients', { method: 'POST', body: data })
export const pushSale = (data) => authRequest('/api/data/sales', { method: 'POST', body: data })
export const fetchStats = () => authRequest('/api/data/stats')
