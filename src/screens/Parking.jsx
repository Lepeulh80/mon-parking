import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  SquareParking, Ticket, CalendarCheck, Plus, Clock, Check, X, Search,
  ArrowRight, Wallet, Gauge, Trash2, Printer, AlertTriangle, Car, LogOut, ScanSearch,
} from 'lucide-react'
import { db } from '../lib/db'
import {
  SPOT_TYPES, SPOT_STATUS, RESA_STATUS, addZone, setSpotStatus, deleteSpot,
  createTicket, closeTicket, cancelTicket, saveReservation, cancelReservation,
  checkInReservation, computeParkingCharge, parkingStats,
} from '../lib/parking'
import { calculateParkingFee } from '../lib/feeEngine'
import { hasPermission } from '../lib/permissions'
import { subscriptionCovers } from '../lib/operations'
import { useApp } from '../App'
import { Card, CardHead, Badge, Modal, Confirm, Empty, Field, Input, Select, Tabs, useToast, IconBtn } from '../components/UI'
import { fmtMoney, fmtDate, fmtDateTime } from '../lib/format'
import { samePlate, compact } from '../lib/plate'
import { rankPlates, decide } from '../lib/match'
import { useOcrLearning, recordFeedback } from '../lib/learningStore'
import { buildParkingReceipt } from '../lib/pdf'
import PlateScanner, { PlateInput } from '../components/PlateScanner'

const typeOf = (v) => SPOT_TYPES.find((t) => t.value === v) || SPOT_TYPES[0]

function OccupancyRing({ rate, size = 92 }) {
  const r = (size - 14) / 2
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: '0 0 auto' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={rate > 85 ? '#ff5c7a' : rate > 60 ? '#ffb347' : '#c6f24e'} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${(rate / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .6s ease' }} />
      <text x="50%" y="47%" textAnchor="middle" fill="#e9eef7" fontSize="20" fontWeight="700" fontFamily="Space Grotesk, sans-serif">{rate}%</text>
      <text x="50%" y="60%" textAnchor="middle" fill="#8b97ad" fontSize="8.5">occupation</text>
    </svg>
  )
}

export default function Parking() {
  const { lot, user, isAdmin } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const spots = useLiveQuery(() => db.spots.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const tickets = useLiveQuery(() => db.tickets.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const reservations = useLiveQuery(() => db.reservations.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const clients = useLiveQuery(() => db.clients.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const vehicles = useLiveQuery(() => db.vehicles.where('lotId').equals(lot.id).toArray(), [lot.id], [])

  const [tab, setTab] = useState('plan')
  const [q, setQ] = useState('')
  const [entryOpen, setEntryOpen] = useState(false)
  const [spotPick, setSpotPick] = useState(null)
  const [closing, setClosing] = useState(null)
  const [detailSpot, setDetailSpot] = useState(null)
  const [resaOpen, setResaOpen] = useState(false)
  const [zoneOpen, setZoneOpen] = useState(false)
  const [toCancel, setToCancel] = useState(null)
  const [toCancelResa, setToCancelResa] = useState(null)
  const [exitScan, setExitScan] = useState(false)
  const learningState = useOcrLearning(lot.id)
  const [exitCandidates, setExitCandidates] = useState(null)
  const [exitNotFound, setExitNotFound] = useState(null)

  const stats = useMemo(() => parkingStats({ spots, tickets, lot }), [spots, tickets, lot])
  const openTickets = useMemo(() => tickets.filter((t) => t.status === 'ouvert').sort((a, b) => new Date(a.entryAt) - new Date(b.entryAt)), [tickets])
  const closedTickets = useMemo(() => tickets.filter((t) => t.status === 'cloture').sort((a, b) => new Date(b.exitAt) - new Date(a.exitAt)), [tickets])
  const activeResas = useMemo(() => reservations.filter((r) => r.status === 'confirmee' || r.status === 'en-cours').sort((a, b) => new Date(a.startAt) - new Date(b.startAt)), [reservations])

  const zones = useMemo(() => {
    const m = new Map()
    for (const s of spots) {
      if (!m.has(s.zone)) m.set(s.zone, [])
      m.get(s.zone).push(s)
    }
    return [...m.entries()].map(([zone, list]) => ({ zone, list: list.sort((a, b) => a.code.localeCompare(b.code)) })).sort((a, b) => a.zone.localeCompare(b.zone))
  }, [spots])

  const ticketOf = (spot) => openTickets.find((t) => t.spotId === spot.id) || null

  /* Toutes les plaques connues du parking, étiquetées par nature. */
  const knownPlateEntries = useMemo(() => {
    const list = []
    for (const t of openTickets) {
      list.push({
        plate: t.plate, kind: 'ticket', id: t.id, ref: t.id, ticket: t,
        label: `Ticket ${t.ref} · place ${t.spotCode}`,
      })
    }
    for (const r of activeResas) {
      list.push({
        plate: r.plate, kind: 'reservation', id: r.id, reservation: r,
        label: `Réservation ${fmtDate(r.startAt)}`,
      })
    }
    for (const v of vehicles) {
      if (v.status === 'vendu') continue
      list.push({ plate: v.plate, kind: 'vehicule', id: v.id, label: `${v.brand} ${v.model} · parc` })
    }
    const seen = new Set()
    for (const t of closedTickets.slice(0, 60)) {
      const key = compact(t.plate)
      if (seen.has(key)) continue
      seen.add(key)
      if (openTickets.some((o) => compact(o.plate) === key)) continue
      list.push({ plate: t.plate, kind: 'historique', id: t.id, label: `Déjà sorti · ${t.ref}` })
    }
    return list
  }, [openTickets, activeResas, vehicles, closedTickets])

  /* Recherche directe par plaque : renvoie le rapprochement le plus probable. */
  const findTicket = (plate) => {
    const matches = rankPlates(plate, knownPlateEntries, { minScore: 0.6, limit: 8, learning: learningState })
    return { matches, decision: decide(plate, matches) }
  }

  /* Scan de sortie : ouverture directe, liste de choix, ou repli explicite. */
  const onExitPlate = (plate) => {
    setExitScan(false)
    const { decision } = findTicket(plate)

    if (decision.status === 'found') {
      const t = decision.ticket.ticket
      setClosing(t)
      toast.ok(`Ticket ${t.ref} retrouvé · place ${t.spotCode} · ${plate}`)
      return
    }
    if (decision.status === 'ambiguous') {
      setExitCandidates({ plate, matches: decision.matches })
      return
    }
    if (decision.status === 'reservation') {
      toast.info(`« ${plate} » correspond à une réservation (${fmtDate(decision.reservation.reservation.startAt)}), aucun ticket en cours.`)
      return
    }
    if (decision.status === 'history') {
      toast.info(`« ${plate} » a déjà été encaissé (${decision.history.entry.ref}). Aucun ticket ouvert à clôturer.`)
      return
    }
    /* Aucune correspondance : on propose la saisie manuelle au lieu d'échouer sèchement. */
    setExitNotFound({ plate })
  }

  const filteredOpen = openTickets.filter((t) => !q.trim() || `${t.plate} ${t.ref} ${t.spotCode}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Stationnement</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
            {stats.total} place(s) · {stats.free} libre(s) · {fmtMoney(stats.todayRevenue, cur)} encaissés aujourd’hui
          </p>
        </div>
        <span className="spacer" />
        {isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => setZoneOpen(true)}><Plus style={{ width: 14, height: 14 }} /> Zone</button>}
        <button className="btn btn-ghost btn-sm" onClick={() => setResaOpen(true)}><CalendarCheck style={{ width: 14, height: 14 }} /> Réserver</button>
        <button className="btn btn-primary" data-testid="exit-scan-open" onClick={() => setExitScan(true)}>
          <LogOut style={{ width: 15, height: 15 }} /> Scan sortie
        </button>
        <button className="btn btn-ghost" onClick={() => { setSpotPick(null); setEntryOpen(true) }}>
          <Ticket /> Nouveau ticket
        </button>
      </div>

      <div className="kpi">
        <div className="kpi-card">
          <div className="kpi-top"><SquareParking /> Places libres</div>
          <div className="kpi-val">{stats.free}<span style={{ fontSize: 14, color: 'var(--muted)' }}> / {stats.total}</span></div>
          <div className="kpi-foot">{stats.reserved} réservée(s) · {stats.outOfService} HS</div>
        </div>
        <div className="kpi-card danger">
          <div className="kpi-top"><Car /> Véhicules garés</div>
          <div className="kpi-val">{stats.occupied}</div>
          <div className="kpi-foot">Tickets ouverts : {stats.openCount}</div>
        </div>
        <div className="kpi-card accent2">
          <div className="kpi-top"><Wallet /> Recette du jour</div>
          <div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.todayRevenue, cur)}</div>
          <div className="kpi-foot">{stats.todayCount} ticket(s) clôturé(s)</div>
        </div>
        <div className="kpi-card warn">
          <div className="kpi-top"><Gauge /> En cours de facturation</div>
          <div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.openEstimate, cur)}</div>
          <div className="kpi-foot">Ticket moyen {fmtMoney(stats.avgTicket, cur)}</div>
        </div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'plan', label: 'Plan des places' },
        { value: 'tickets', label: `Tickets en cours (${openTickets.length})` },
        { value: 'resa', label: `Réservations (${activeResas.length})` },
        { value: 'hist', label: 'Historique' },
      ]} />

      {tab === 'plan' && (
        <div className="split" style={{ gridTemplateColumns: '1.7fr 1fr' }}>
          <Card>
            <CardHead title="Plan du parking" sub="Cliquez sur une place pour ouvrir ou clôturer un ticket" icon={SquareParking}
              right={<Badge tone="acc" dot>{stats.rate} % occupé</Badge>} />
            {spots.length === 0 ? <Empty icon={SquareParking} title="Aucune place configurée" text="Ajoutez une zone pour commencer." /> : (
              <div style={{ display: 'grid', gap: 16 }}>
                {zones.map(({ zone, list }) => (
                  <div key={zone}>
                    <div className="row" style={{ marginBottom: 8 }}>
                      <b style={{ fontSize: 12, letterSpacing: '0.1em' }}>ZONE {zone}</b>
                      <span className="tiny mut">{list.filter((s) => s.status === 'libre').length}/{list.length} libres</span>
                      <span className="spacer" />
                      <div className="row" style={{ gap: 8 }}>
                        {Object.entries(SPOT_STATUS).slice(0, 3).map(([k, v]) => (
                          <span key={k} className="tiny mut" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <i style={{ width: 7, height: 7, borderRadius: 2, background: v.color, display: 'inline-block' }} />{v.label}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(74px,1fr))', gap: 8 }}>
                      {list.map((s) => {
                        const st = SPOT_STATUS[s.status] || SPOT_STATUS.libre
                        const t = ticketOf(s)
                        return (
                          <button key={s.id} onClick={() => { setDetailSpot(s); setSpotPick(s.id) }}
                            style={{
                              border: `1px solid ${s.status === 'libre' ? 'rgba(255,255,255,0.14)' : st.color + '66'}`,
                              background: s.status === 'libre' ? 'rgba(255,255,255,0.035)' : `${st.color}1f`,
                              borderRadius: 10, padding: '9px 6px', cursor: 'pointer', textAlign: 'center',
                              transition: 'transform .14s, border-color .14s',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.transform = 'none' }}
                          >
                            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 13, color: s.status === 'libre' ? 'var(--txt)' : st.color }}>{s.code}</div>
                            <div style={{ fontSize: 8.5, color: 'var(--muted)', letterSpacing: '0.04em' }}>{typeOf(s.type).label}</div>
                            {t && <div className="tiny" style={{ color: st.color, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.plate}</div>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="stack">
            <Card>
              <CardHead title="Taux d’occupation" />
              <div className="row" style={{ gap: 16 }}>
                <OccupancyRing rate={stats.rate} />
                <div style={{ display: 'grid', gap: 7, fontSize: 12, flex: 1 }}>
                  {Object.entries(SPOT_STATUS).map(([k, v]) => (
                    <div key={k} className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="mut" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <i style={{ width: 7, height: 7, borderRadius: 2, background: v.color, display: 'inline-block' }} />{v.label}
                      </span>
                      <b className="num">{spots.filter((s) => s.status === k).length}</b>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <CardHead title="Tarification" sub="Appliquée aux nouveaux tickets" icon={Wallet} />
              <div style={{ display: 'grid', gap: 9, fontSize: 12.5 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="mut">Tarif horaire</span><b>{fmtMoney(lot.hourlyRate ?? 500, cur)}</b>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="mut">Plafond journalier</span><b>{fmtMoney(lot.dailyCap ?? 6000, cur)}</b>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="mut">Tolérance de sortie</span><b>{lot.graceMinutes ?? 15} min offertes</b>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="mut">Tickets du mois</span><b>{fmtMoney(stats.monthRevenue, cur)}</b>
                </div>
              </div>
              {isAdmin && <p className="tiny mut" style={{ marginBottom: 0, marginTop: 10 }}>Modifiable dans Administration → Identité du parking.</p>}
            </Card>

            <Card>
              <CardHead title="Dernières sorties" />
              {closedTickets.slice(0, 4).map((t) => (
                <div className="list-row" key={t.id}>
                  <div className="ico"><Check /></div>
                  <div className="txt"><b>{t.plate}</b><span>{t.spotCode} · {t.billedMinutes} min</span></div>
                  <div className="amt" style={{ color: 'var(--ok)' }}>{fmtMoney(t.amount, cur)}</div>
                </div>
              ))}
              {!closedTickets.length && <p className="tiny mut" style={{ margin: 0 }}>Aucune sortie enregistrée.</p>}
            </Card>
          </div>
        </div>
      )}

      {tab === 'tickets' && (
        <Card>
          <CardHead title="Tickets ouverts" sub="Facturation calculée en temps réel" icon={Ticket}
            right={<div className="search-box" style={{ maxWidth: 230 }}><Search /><input className="input" placeholder="Plaque, ticket, place…" value={q} onChange={(e) => setQ(e.target.value)} /></div>} />
          {filteredOpen.length === 0 ? <Empty icon={Ticket} title="Aucun véhicule garé" text="Ouvrez un ticket à l’entrée d’un véhicule." /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Ticket</th><th>Plaque</th><th>Place</th><th>Entrée</th><th>Durée</th><th className="t-right">Montant estimé</th><th></th></tr></thead>
                <tbody>
                  {filteredOpen.map((t) => {
                    const ch = computeParkingCharge({ ...t, hourlyRate: t.hourlyRate || lot.hourlyRate })
                    return (
                      <tr key={t.id}>
                        <td className="mono">{t.ref}</td>
                        <td className="strong">{t.plate}</td>
                        <td><Badge tone="info">{t.spotCode}</Badge></td>
                        <td className="mut tiny">{fmtDateTime(t.entryAt)}</td>
                        <td className="mut">{ch.label}</td>
                        <td className="t-right num strong" style={{ color: 'var(--acc)' }}>{fmtMoney(ch.amount, cur)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                            <button className="btn btn-sm btn-primary" onClick={() => setClosing(t)}><ArrowRight style={{ width: 12, height: 12 }} /> Clôturer</button>
                            {isAdmin && <IconBtn title="Annuler le ticket" onClick={() => setToCancel(t)}><X /></IconBtn>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'resa' && (
        <Card>
          <CardHead title="Réservations" sub="Places bloquées à l’avance" icon={CalendarCheck}
            right={<button className="btn btn-sm btn-primary" onClick={() => setResaOpen(true)}><Plus style={{ width: 13, height: 13 }} /> Réserver</button>} />
          {activeResas.length === 0 ? <Empty icon={CalendarCheck} title="Aucune réservation" text="Réservez une place pour un client." /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Client</th><th>Plaque</th><th>Place</th><th>Du</th><th>Au</th><th className="t-right">Montant</th><th>Statut</th><th></th></tr></thead>
                <tbody>
                  {activeResas.map((r) => (
                    <tr key={r.id}>
                      <td>{r.clientSnapshot?.name || '—'}<br /><span className="tiny mut">{r.clientSnapshot?.phone}</span></td>
                      <td className="strong">{r.plate}</td>
                      <td><Badge tone="info">{r.spotCode || '—'}</Badge></td>
                      <td className="mut tiny">{fmtDateTime(r.startAt)}</td>
                      <td className="mut tiny">{fmtDateTime(r.endAt)}</td>
                      <td className="t-right num">{fmtMoney(r.amount, cur)}</td>
                      <td><Badge tone={RESA_STATUS[r.status]?.tone || 'default'} dot>{RESA_STATUS[r.status]?.label || r.status}</Badge></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          {r.status === 'confirmee' && (
                            <button className="btn btn-sm btn-primary" onClick={async () => {
                              try {
                                await checkInReservation(r, lot, user)
                                toast.ok('Arrivée enregistrée : ticket ouvert.')
                              } catch (e) { toast.err(e.message) }
                            }}>Arrivée</button>
                          )}
                          <IconBtn title="Annuler" onClick={() => setToCancelResa(r)}><Trash2 /></IconBtn>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'hist' && (
        <Card>
          <CardHead title="Historique des tickets" sub={`${closedTickets.length} ticket(s) clôturé(s)`} />
          {closedTickets.length === 0 ? <Empty icon={Clock} title="Aucun historique" /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Ticket</th><th>Plaque</th><th>Place</th><th>Entrée</th><th>Sortie</th><th>Durée</th><th>Paiement</th><th className="t-right">Montant</th><th></th></tr></thead>
                <tbody>
                  {closedTickets.slice(0, 120).map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.ref}</td>
                      <td className="strong">{t.plate}</td>
                      <td className="mut">{t.spotCode}</td>
                      <td className="mut tiny">{fmtDateTime(t.entryAt)}</td>
                      <td className="mut tiny">{fmtDateTime(t.exitAt)}</td>
                      <td className="mut">{t.billedMinutes} min</td>
                      <td className="mut tiny">{t.paymentMethod || '—'}</td>
                      <td className="t-right num strong">{fmtMoney(t.amount, cur)}</td>
                      <td>
                        <IconBtn title="Reçu PDF" onClick={async () => {
                          const doc = await buildParkingReceipt(t, lot)
                          doc.save(`${t.ref}.pdf`)
                          toast.ok('Reçu de parking généré.')
                        }}><Printer /></IconBtn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---- scan de sortie ---- */}
      <PlateScanner open={exitScan} intent="sortie" entries={knownPlateEntries} learning={learningState} observationContext={{lotId:lot.id,userId:user.id,city:lot.city||'',zone:'sortie',zoneForPlate:(p)=>{const t=openTickets.find(t=>samePlate(t.plate,p));return spots.find(s=>s.id===t?.spotId)?.zone||'Sortie non rattachée'}}}
        onFeedback={(f) => recordFeedback({
          lotId: lot.id, userId: user?.id, userName: user?.name,
          raw: f.raw, chosen: f.chosen, rejected: f.rejected, source: f.source,
        })}
        onClose={() => setExitScan(false)} onDetected={onExitPlate} />

      {/* ---- plusieurs tickets possibles ---- */}
      <Modal open={!!exitCandidates} onClose={() => setExitCandidates(null)}
        title="Plusieurs tickets correspondent" icon={ScanSearch}
        footer={<button className="btn btn-ghost" onClick={() => setExitCandidates(null)}>Fermer</button>}>
        <p className="tiny mut" style={{ marginTop: 0 }}>
          La lecture « {exitCandidates?.plate} » correspond à plusieurs tickets ouverts. Choisissez celui à clôturer.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {exitCandidates?.matches.map((m) => {
            const t = m.entry.ticket
            return (
              <button key={t.id} className="pick-row" data-testid="candidate-row"
                onClick={() => { setExitCandidates(null); setClosing(t) }}>
                <b style={{ fontFamily: 'Space Grotesk' }}>{t.plate}</b>
                <span className="mut tiny">{t.ref} · place {t.spotCode} · entrée {fmtDateTime(t.entryAt)}</span>
                <span className="badge info">{Math.round(m.score * 100)} %</span>
              </button>
            )
          })}
        </div>
      </Modal>

      {/* ---- aucune correspondance ---- */}
      <Modal open={!!exitNotFound} onClose={() => setExitNotFound(null)}
        title="Aucun ticket ouvert pour cette plaque" icon={AlertTriangle}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setExitNotFound(null)}>Fermer</button>
          <button className="btn btn-primary" onClick={() => { setExitNotFound(null); setSpotPick(null); setEntryOpen(true) }}>
            <Ticket style={{ width: 14, height: 14 }} /> Ouvrir un ticket d’entrée
          </button>
        </>}>
        <p className="tiny mut" style={{ marginTop: 0 }}>
          La plaque « {exitNotFound?.plate} » n’a été rapprochée d’aucun ticket ouvert, réservation ou véhicule du parc.
          Vérifiez la lecture, ou créez le ticket d’entrée correspondant.
        </p>
      </Modal>

      {/* ---- ouverture ticket ---- */}
      <TicketEntry open={entryOpen} onClose={() => setEntryOpen(false)} spots={spots} presetSpot={spotPick}
        lot={lot} user={user} clients={clients} vehicles={vehicles} cur={cur} toast={toast} />

      {/* ---- clôture ---- */}
      {closing && (
        <CloseTicket ticket={closing} lot={lot} cur={cur} user={user} toast={toast}
          onClose={() => setClosing(null)} />
      )}

      {/* ---- détail place ---- */}
      <SpotDetail spot={detailSpot} onClose={() => setDetailSpot(null)} lot={lot} cur={cur} isAdmin={isAdmin}
        ticket={detailSpot ? ticketOf(detailSpot) : null}
        onOpen={(spot) => { setSpotPick(spot.id); setDetailSpot(null); setEntryOpen(true) }}
        onCloseTicket={(t) => { setDetailSpot(null); setClosing(t) }}
        onFree={async (spot) => {
          await setSpotStatus(spot.id, 'libre')
          toast.ok(`Place ${spot.code} libérée.`)
          setDetailSpot(null)
        }}
        onDelete={async (spot) => {
          try { await deleteSpot(spot.id); toast.ok('Place supprimée.'); setDetailSpot(null) }
          catch (e) { toast.err(e.message) }
        }} />

      {/* ---- nouvelle zone ---- */}
      <ZoneModal open={zoneOpen} onClose={() => setZoneOpen(false)} lot={lot} toast={toast} />

      {/* ---- réservation ---- */}
      <ResaModal open={resaOpen} onClose={() => setResaOpen(false)} lot={lot} spots={spots} clients={clients} cur={cur} toast={toast} user={user} />

      <Confirm open={!!toCancel} danger title="Annuler le ticket"
        text={`Le ticket ${toCancel?.ref} (${toCancel?.plate}) sera annulé, sans facturation, et la place libérée.`}
        confirmLabel="Annuler le ticket"
        onCancel={() => setToCancel(null)}
        onConfirm={async () => { await cancelTicket(toCancel.id, user); setToCancel(null); toast.ok('Ticket annulé.') }} />

      <Confirm open={!!toCancelResa} danger title="Annuler la réservation"
        text={`La réservation de ${toCancelResa?.clientSnapshot?.name || toCancelResa?.plate} sera annulée et la place libérée.`}
        confirmLabel="Annuler la réservation"
        onCancel={() => setToCancelResa(null)}
        onConfirm={async () => { await cancelReservation(toCancelResa.id); setToCancelResa(null); toast.ok('Réservation annulée.') }} />
    </div>
  )
}

function TicketEntry({ open, onClose, spots, presetSpot, lot, user, clients, vehicles, cur, toast }) {
  const [plate, setPlate] = useState('')
  const [spotId, setSpotId] = useState(presetSpot || '')
  const [clientId, setClientId] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const [rate, setRate] = useState(lot.hourlyRate ?? 500)
  const [notes, setNotes] = useState('')
  const [ratePlanId, setRatePlanId] = useState('')
  const plans = useLiveQuery(() => db.ratePlans.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const [busy, setBusy] = useState(false)
  const free = spots.filter((s) => s.status === 'libre')

  const submit = async () => {
    setBusy(true)
    try {
      const t = await createTicket({
        lot, plate, spotId, clientId: clientId || null, vehicleId: vehicleId || null,
        user, notes, hourlyRate: Number(rate), ratePlanId,
      })
      toast.ok(`Ticket ${t.ref} ouvert · place ${t.spotCode}`)
      setPlate(''); setClientId(''); setVehicleId(''); setNotes('')
      onClose()
    } catch (e) { toast.err(e.message) }
    setBusy(false)
  }

  return (
    <Modal open={open} onClose={onClose} title="Ouvrir un ticket de stationnement" icon={Ticket}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? '…' : 'Enregistrer l’entrée'}</button></>}>
      <Field label="Grille tarifaire"><Select data-testid="entry-rate-plan" value={ratePlanId} onChange={(e) => {
        const selected = e.target.value; setRatePlanId(selected)
        const plan = plans.find((p) => p.id === selected); setRate(plan?.hourlyRate ?? lot.hourlyRate ?? 500)
      }}><option value="">Tarif standard du parking</option>{plans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
      <Field label="Immatriculation *" hint="Saisie manuelle ou scan caméra">
        <PlateInput value={plate} onChange={setPlate} placeholder="CI 4471 AB" autoFocus testId="entry-plate" />
      </Field>
      <div className="grid2">
        <Field label={`Place libre * (${free.length})`}>
          <Select data-testid="entry-spot" value={spotId} onChange={(e) => setSpotId(e.target.value)}>
            <option value="">— Choisir —</option>
            {free.map((s) => <option key={s.id} value={s.id}>{s.code} · {typeOf(s.type).label}</option>)}
          </Select>
        </Field>
        <Field label="Tarif horaire appliqué"><Input type="number" disabled={!hasPermission(user, 'rates.manage')} value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
      </div>
      <div className="grid2">
        <Field label="Véhicule du parc (optionnel)">
          <Select value={vehicleId} onChange={(e) => {
            setVehicleId(e.target.value)
            const v = vehicles.find((x) => x.id === e.target.value)
            if (v && !plate) setPlate(v.plate)
          }}>
            <option value="">— Aucun —</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} · {v.brand} {v.model}</option>)}
          </Select>
        </Field>
        <Field label="Client (optionnel)">
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">— Comptant —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Note"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex. véhicule de livraison, abonné…" /></Field>
      <p className="tiny mut" style={{ marginBottom: 0 }}>
        Le montant sera calculé automatiquement à la sortie : {fmtMoney(rate, cur)}/h, plafond journalier {fmtMoney(lot.dailyCap ?? 6000, cur)}, {lot.graceMinutes ?? 15} minutes offertes.
      </p>
    </Modal>
  )
}

function CloseTicket({ ticket, lot, cur, user, toast, onClose }) {
  const currentPass = useLiveQuery(() => ticket.passId ? db.parkingPasses.get(ticket.passId) : null, [ticket.passId], null)
  
  const covered = subscriptionCovers(currentPass, ticket, new Date().toISOString())
  const charge = calculateParkingFee({...ticket,exitAt:new Date().toISOString(),subscriber:covered})
  const [adjustmentReason, setAdjustmentReason] = useState('')
  useEffect(() => { setAmount(charge.amount) }, [covered, charge.amount])
  const [amount, setAmount] = useState(charge.amount)
  const [method, setMethod] = useState('espèces')
  const [busy, setBusy] = useState(false)

  const submit = async (print) => {
    setBusy(true)
    try {
      const closed = await closeTicket(ticket.id, { user, paymentMethod: covered && charge.amount===0 ? 'abonnement' : method, amount: hasPermission(user, 'parking.override') ? amount : undefined, notes: adjustmentReason })
      toast.ok(`Sortie enregistrée · ${fmtMoney(closed.amount, cur)}`)
      if (print) {
        const doc = await buildParkingReceipt(closed, lot)
        doc.save(`${closed.ref}.pdf`)
      }
      onClose()
    } catch (e) { toast.err(e.message) }
    setBusy(false)
  }

  return (
    <Modal open onClose={onClose} title={`Clôturer · ${ticket.ref}`} icon={Check}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
        <button className="btn btn-ghost" onClick={() => submit(false)} disabled={busy}>Encaisser</button>
        <button className="btn btn-primary" onClick={() => submit(true)} disabled={busy}>{busy ? '…' : <><Printer style={{ width: 14, height: 14 }} /> Encaisser & reçu</>}</button>
      </>}>
      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontFamily: 'Space Grotesk', fontWeight: 700 }}>{ticket.plate}</div>
          <div className="tiny mut">Place {ticket.spotCode} · {typeOf(ticket.spotType).label}</div>
        </div>
        <Badge tone="warn" dot>{charge.label}</Badge>
      </div>
      <div style={{ display: 'grid', gap: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 12, padding: 13, marginBottom: 14 }}>
        {[
          ['Entrée', fmtDateTime(ticket.entryAt)],
          ['Durée stationnée', charge.label],
          [`Tarif horaire`, fmtMoney(ticket.hourlyRate || lot.hourlyRate || 0, cur)],
          ['Temps facturé', charge.billableLabel],
        ].map(([k, v]) => (
          <div key={k} className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
            <span className="mut">{k}</span><span className="num">{v}</span>
          </div>
        ))}
        <div style={{ height: 1, background: 'var(--line)' }} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b style={{ fontSize: 12.5 }}>Montant calculé</b>
          <b style={{ fontFamily: 'Space Grotesk', fontSize: 18, color: 'var(--acc)' }}>{fmtMoney(charge.amount, cur)}</b>
        </div>
      </div>
      {covered && <p className="tiny" style={{ color: 'var(--ok)' }}>Séjour couvert par l’abonnement de {currentPass?.holder}.</p>}
      {hasPermission(user, 'parking.override') && <Field label="Motif de modification du montant (obligatoire si écart)"><Input data-testid="ticket-adjustment-reason" value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} /></Field>}
      <p className="tiny mut">Base {fmtMoney(charge.baseAmount,cur)} · Dépassement {fmtMoney(charge.overstayFee,cur)} · Ticket perdu {fmtMoney(charge.lostFee,cur)}</p>
      <div className="grid2">
        <Field label="Montant encaissé" hint="Modifiable (geste commercial, abonnement)"><Input type="number" disabled={!hasPermission(user, 'parking.override')} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Mode de paiement">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {['espèces', 'mobile money', 'carte bancaire', 'virement', 'abonnement'].map((m) => <option key={m}>{m}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

function SpotDetail({ spot, onClose, lot, cur, isAdmin, ticket, onOpen, onCloseTicket, onFree, onDelete }) {
  if (!spot) return null
  const st = SPOT_STATUS[spot.status] || SPOT_STATUS.libre
  const charge = ticket ? computeParkingCharge({ ...ticket, hourlyRate: ticket.hourlyRate ?? lot.hourlyRate }) : null
  return (
    <Modal open onClose={onClose} title={`Place ${spot.code}`} icon={SquareParking}
      footer={<>
        {isAdmin && <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => onDelete(spot)}><Trash2 style={{ width: 14, height: 14 }} /> Supprimer</button>}
        {spot.status === 'occupe' && <button className="btn btn-primary" onClick={() => onCloseTicket(ticket)}>Clôturer le ticket</button>}
        {spot.status === 'libre' && <button className="btn btn-primary" onClick={() => onOpen(spot)}>Ouvrir un ticket</button>}
        {spot.status === 'reserve' && <button className="btn btn-primary" onClick={() => onOpen(spot)}>Forcer l’entrée</button>}
        {spot.status === 'hs' && isAdmin && <button className="btn btn-primary" onClick={() => onFree(spot)}>Remettre en service</button>}
      </>}>
      <div className="row" style={{ marginBottom: 14 }}>
        <Badge tone={st.tone} dot>{st.label}</Badge>
        <Badge tone="info">{typeOf(spot.type).label}</Badge>
        <span className="spacer" />
        <span className="tiny mut">Zone {spot.zone}</span>
      </div>
      {ticket ? (
        <div style={{ display: 'grid', gap: 8, background: 'rgba(255,92,122,0.06)', border: '1px solid rgba(255,92,122,0.25)', borderRadius: 12, padding: 13 }}>
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
            <span className="mut">Véhicule</span><b>{ticket.plate}</b>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
            <span className="mut">Ticket</span><span className="mono">{ticket.ref}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
            <span className="mut">Entrée</span><span>{fmtDateTime(ticket.entryAt)}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
            <span className="mut">Durée</span><span>{charge.label}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b style={{ fontSize: 12.5 }}>Montant en cours</b>
            <b style={{ fontFamily: 'Space Grotesk', color: 'var(--acc)' }}>{fmtMoney(charge.amount, cur)}</b>
          </div>
        </div>
      ) : (
        <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.7, margin: 0 }}>
          {spot.status === 'libre' ? 'Cette place est disponible. Vous pouvez y ouvrir un ticket de stationnement.'
            : spot.status === 'reserve' ? 'Une réservation bloque cette place. Vous pouvez forcer l’entrée si le client est arrivé.'
              : 'Cette place est hors service. Remettez-la en service pour la rendre disponible.'}
        </p>
      )}
      {isAdmin && spot.status === 'libre' && (
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => onFree({ ...spot, status: 'hs' })}>
          Mettre hors service
        </button>
      )}
    </Modal>
  )
}

function ZoneModal({ open, onClose, lot, toast }) {
  const [zone, setZone] = useState('F')
  const [count, setCount] = useState(6)
  const [type, setType] = useState('standard')
  const [busy, setBusy] = useState(false)
  if (!open) return null
  return (
    <Modal open onClose={onClose} title="Ajouter une zone de places" icon={SquareParking}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" disabled={busy} onClick={async () => {
          if (!/^[A-Za-z0-9]{1,3}$/.test(zone)) { toast.err('Code de zone : 1 à 3 caractères.'); return }
          setBusy(true)
          const n = await addZone(lot.id, { zone: zone.toUpperCase(), count, type })
          toast.ok(`${n} place(s) ajoutée(s) en zone ${zone.toUpperCase()}.`)
          setBusy(false); onClose()
        }}>Créer</button></>}>
      <div className="grid2">
        <Field label="Code de zone *"><Input value={zone} onChange={(e) => setZone(e.target.value.toUpperCase())} maxLength={3} /></Field>
        <Field label="Nombre de places"><Input type="number" value={count} onChange={(e) => setCount(e.target.value)} /></Field>
      </div>
      <Field label="Type de place">
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {SPOT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
      </Field>
      <p className="tiny mut" style={{ marginBottom: 0 }}>Les places seront nommées {zone}01, {zone}02… et ajoutées au plan.</p>
    </Modal>
  )
}

function ResaModal({ open, onClose, lot, spots, clients, cur, toast, user }) {
  const [f, setF] = useState({ plate: '', clientId: '', spotId: '', startAt: '', endAt: '', amount: 0, deposit: 0, notes: '' })
  const [busy, setBusy] = useState(false)
  const free = spots.filter((s) => s.status === 'libre' || s.status === 'reserve')
  if (!open) return null

  const submit = async () => {
    if (!f.plate.trim()) { toast.err('La plaque est requise.'); return }
    if (!f.startAt || !f.endAt) { toast.err('Indiquez les dates de début et de fin.'); return }
    if (new Date(f.endAt) <= new Date(f.startAt)) { toast.err('La fin doit suivre le début.'); return }
    setBusy(true)
    try {
      const client = clients.find((c) => c.id === f.clientId)
      const spot = spots.find((s) => s.id === f.spotId)
      await saveReservation(lot.id, {
        plate: f.plate.trim().toUpperCase(), clientId: f.clientId || null,
        clientSnapshot: client ? { name: client.name, phone: client.phone } : { name: 'Client comptant', phone: '' },
        spotId: f.spotId || null, spotCode: spot?.code || null,
        startAt: new Date(f.startAt).toISOString(), endAt: new Date(f.endAt).toISOString(),
        amount: Number(f.amount) || 0, deposit: Number(f.deposit) || 0, notes: f.notes,
        userId: user?.id, userName: user?.name,
      })
      toast.ok('Réservation enregistrée.')
      setF({ plate: '', clientId: '', spotId: '', startAt: '', endAt: '', amount: 0, deposit: 0, notes: '' })
      onClose()
    } catch (e) { toast.err(e.message) }
    setBusy(false)
  }

  return (
    <Modal open onClose={onClose} title="Nouvelle réservation" icon={CalendarCheck}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? '…' : 'Réserver'}</button></>}>
      <div className="grid2">
        <Field label="Immatriculation *" hint="Scan caméra disponible">
          <PlateInput value={f.plate} onChange={(v) => setF({ ...f, plate: v })} placeholder="CI 7732 LM" testId="resa-plate" />
        </Field>
        <Field label="Client">
          <Select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
            <option value="">— Comptant —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Place attribuée">
        <Select value={f.spotId} onChange={(e) => setF({ ...f, spotId: e.target.value })}>
          <option value="">— Automatique à l’arrivée —</option>
          {free.map((s) => <option key={s.id} value={s.id}>{s.code} · {typeOf(s.type).label} · {SPOT_STATUS[s.status].label}</option>)}
        </Select>
      </Field>
      <div className="grid2">
        <Field label="Début *"><Input type="datetime-local" value={f.startAt} onChange={(e) => setF({ ...f, startAt: e.target.value })} /></Field>
        <Field label="Fin *"><Input type="datetime-local" value={f.endAt} onChange={(e) => setF({ ...f, endAt: e.target.value })} /></Field>
      </div>
      <div className="grid2">
        <Field label={`Montant (${cur})`}><Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label={`Acompte (${cur})`}><Input type="number" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} /></Field>
      </div>
      <Field label="Note"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <p className="tiny mut" style={{ marginBottom: 0 }}>Les chevauchements sur une même place sont refusés automatiquement.</p>
    </Modal>
  )
}
