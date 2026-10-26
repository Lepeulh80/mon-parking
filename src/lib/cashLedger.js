/** Must be called INSIDE the same Dexie transaction as the receipt. */
export const CASH_METHODS = ['espèces', 'mobile money', 'carte bancaire', 'virement']
export function money(value, { zero = true } = {}) {
  if (value === '' || value === null || value === undefined) throw new Error('Montant requis.')
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || (!zero && n <= 0)) throw new Error('Montant invalide.')
  return Math.round(n * 100) / 100
}
export async function bookReceipt(database, { lotId, user, source, amount, method, at }) {
  const value = money(amount)
  if (!value) return null
  if (!CASH_METHODS.includes(method)) throw new Error('Mode de paiement invalide.')
  const lot = await database.lots.get(lotId)
  const session = await database.cashSessions.where('[lotId+userId]').equals([lotId, user.id]).filter((s) => s.status === 'ouverte').first()
  if (!session) {
    if (lot?.requireCashSession) throw new Error('Ouvrez votre session de caisse dans Équipe & exploitation avant d’encaisser.')
    return null // Historical compatibility. KPI flags unlinked receipts.
  }
  if(session.cloudMode && !source.startsWith('ticket:')) throw new Error('La caisse cloud parking est réservée aux tickets. Utilisez une caisse locale distincte pour les ventes.')
  const key = `${lotId}:${source}`
  const existing = await database.cashMovements.where('source').equals(key).first()
  if (existing) return session.id
  await database.cashMovements.add({ id: crypto.randomUUID(), lotId, sessionId: session.id, userId: user.id,
    pendingCloud: !!session.cloudMode, source: key, kind: 'recette', amount: value, method, at, reason: source })
  return session.id
}
export function cashSummary(session, movements) {
  const own = movements.filter((m) => m.sessionId === session.id)
  const byMethod = {}
  for (const m of own.filter((x) => x.kind === 'recette')) byMethod[m.method] = (byMethod[m.method] || 0) + m.amount
  const cashDelta = own.filter((m) => m.method === 'espèces' && (!session.cloudMode || m.pendingCloud)).reduce((sum, m) => sum + (m.kind === 'retrait' ? -m.amount : m.amount), 0)
  const expected = Math.round((Number(session.cloudMode ? session.cloudExpected ?? session.openingFloat : session.openingFloat) + cashDelta) * 100) / 100
  return { expected, byMethod, movements: own.length, receipts: own.filter((m) => m.kind === 'recette').reduce((n, m) => n + m.amount, 0) }
}
