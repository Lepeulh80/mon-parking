// Réplication des tickets de parking vers PostgreSQL (Neon).
// Volontairement sans React : ce module est importé par src/lib/parking.js,
// donc aussi par les tests Node. La lecture reste locale (offline-first) ; ici
// on ne fait que recopier chaque entrée et chaque sortie côté serveur pour que
// les statistiques, la sauvegarde et les autres postes voient les tickets.
import { authRequest } from './authSession.js'

export const pushTicket = (data) => authRequest('/api/data/tickets', { method: 'POST', body: data })
export const closeTicketRemote = (id, data) => authRequest(`/api/data/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: data })
