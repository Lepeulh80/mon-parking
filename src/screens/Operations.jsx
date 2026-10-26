import ParkingProfessional from '../components/ParkingProfessional'
import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Users, CalendarDays, Clock, Wallet, ShieldAlert, Gauge, Ticket, History, Plus, Download, Check } from 'lucide-react'
import { useApp } from '../App'
import { db, authorize } from '../lib/db'
import { Card, CardHead, Badge, Field, Input, Select, Modal, Tabs, useToast } from '../components/UI'
import { hasPermission, ROLE_LABELS, PERMISSION_LIST } from '../lib/permissions'
import { cashSummary } from '../lib/cashLedger'
import { OPS_TABLES, saveShift, cancelShift, clockAttendance, correctAttendance, attendanceMinutes,
  openCash, moveCash, closeCash, reviewCash, saveIncident, transitionIncident,
  saveRatePlan, issuePass, revokePass, operationalKPIs, csvRows } from '../lib/operations'
import { fmtMoney, fmtDateTime } from '../lib/format'
import '../operations.css'

const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const iso = (v) => new Date(v).toISOString()
const labelStatus = { ouvert: 'Ouvert', en_cours: 'En cours', resolu: 'Résolu', planifie: 'Planifié', annule: 'Annulé', ouverte: 'Ouverte', cloturee: 'Clôturée', actif: 'Actif', suspendu: 'Suspendu' }
const table = (headers, rows, empty = 'Aucune donnée pour cette sélection.') => rows.length ? <div className="table-wrap"><table className="tbl"><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows}</tbody></table></div> : <p className="mut tiny">{empty}</p>
const download = (name, value, mime = 'text/csv;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([value], { type: mime })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export default function Operations() {
  const { lot, user } = useApp(), toast = useToast()
  const can = (p) => hasPermission(user, p)
  const [tab, setTab] = useState('equipe'), [modal, setModal] = useState(null), [f, setF] = useState({}), [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(Date.now())
  const [range, setRange] = useState({ from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toLocaleDateString('en-CA'), to: new Date().toLocaleDateString('en-CA') })
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 30000); return () => clearInterval(t) }, [])
  const data = useLiveQuery(async () => {
    const out = {}
    for (const t of [...OPS_TABLES, 'users', 'spots', 'tickets', 'audit']) out[t] = await db.table(t).where('lotId').equals(lot.id).toArray()
    out.lotPolicy = await db.lots.get(lot.id)
    return out
  }, [lot.id], {})
  const staff = data.users || [], activeStaff = staff.filter((u) => u.active)
  const shifts = data.staffShifts || [], attendance = data.attendance || [], sessions = data.cashSessions || [], moves = data.cashMovements || []
  const incidents = data.incidents || [], plans = data.ratePlans || [], passes = data.parkingPasses || []
  const ownAttendance = attendance.filter((a) => a.userId === user.id && !a.outAt)[0]
  const onBreak = ownAttendance?.breaks?.at(-1) && !ownAttendance.breaks.at(-1).end
  const ownCash = sessions.find((s) => s.userId === user.id && s.status === 'ouverte')
  const kpi = operationalKPIs({ spots: data.spots, tickets: data.tickets, attendance, incidents, cashSessions: sessions, shifts, passes, at: tick })
  const visibleAttendance = attendance.filter((a) => (can('attendance.manage') || a.userId === user.id) && a.inAt.slice(0, 10) >= range.from && a.inAt.slice(0, 10) <= range.to)
  const visibleShifts = shifts.filter((s) => can('planning.manage') || s.userId === user.id).sort((a,b) => b.startAt.localeCompare(a.startAt))
  const money = (n) => fmtMoney(n, lot.currency)
  const run = async (fn, message = 'Enregistré.') => {
    setBusy(true)
    try { await fn(); toast.ok(message); setModal(null); setTick(Date.now()) }
    catch (e) { toast.err(e.message) }
    finally { setBusy(false) }
  }
  const open = (type, row) => {
    const start = new Date(), end = new Date(Date.now() + (type === 'pass' ? 30 * 86400000 : 8 * 3600000))
    const defaults = { userId: activeStaff.find((u) => u.role !== 'admin')?.id || user.id, startAt: localInput(start), endAt: localInput(end),
      name: '', zone: '', note: '', title: '', description: '', severity: 'moyenne', plate: '', assignedTo: '', photo: '', holder: '',
      amount: '', reason: '', kind: 'apport', hourlyRate: lot.hourlyRate ?? 500, dailyCap: lot.dailyCap ?? 6000, graceMinutes: lot.graceMinutes ?? 15, spotType: '', paymentMethod: 'espèces', status: 'en_cours' }
    if (type === 'correction') Object.assign(defaults, { inAt: localInput(new Date(row.inAt)), outAt: localInput(row.outAt ? new Date(row.outAt) : new Date()), reason: '' })
    if (type === 'rate' && row) Object.assign(defaults, row)
    if (type === 'follow') defaults.status = row.status === 'en_cours' ? 'resolu' : 'en_cours'
    if (type === 'close') defaults.amount = cashSummary(row, moves).expected
    setF(defaults); setModal({ type, row })
  }
  const set = (k) => (e) => setF((old) => ({ ...old, [k]: e.target.value }))
  const submit = () => run(async () => {
    switch (modal.type) {
      case 'shift': return saveShift(lot.id, user, { ...f, startAt: iso(f.startAt), endAt: iso(f.endAt) })
      case 'cancelShift': return cancelShift(modal.row.id, user, f.reason)
      case 'correction': return correctAttendance(modal.row.id, user, { ...f, inAt: iso(f.inAt), outAt: iso(f.outAt) })
      case 'open': return openCash(lot.id, user, f.amount)
      case 'move': return moveCash(ownCash.id, user, f)
      case 'close': return closeCash(modal.row.id, user, f.amount, f.reason)
      case 'incident': return saveIncident(lot.id, user, f)
      case 'follow': return transitionIncident(modal.row.id, user, f.status, f.reason)
      case 'rate': return saveRatePlan(lot.id, user, f, modal.row?.id)
      case 'pass': return issuePass(lot.id, user, { ...f, startAt: iso(f.startAt), endAt: iso(f.endAt) })
      case 'revoke': return revokePass(modal.row.id, user, f.reason)
      default: throw new Error('Formulaire inconnu.')
    }
  })
  const input = (label, key, type = 'text', extra = {}) => <Field label={label}><Input data-testid={`ops-${key}`} type={type} value={f[key] ?? ''} onChange={set(key)} {...extra} /></Field>
  const person = (name = 'userId', title = 'Employé') => <Field label={title}><Select value={f[name]} onChange={set(name)}>{name === 'assignedTo' && <option value="">Non affecté</option>}{activeStaff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
  const titles = { shift: 'Planifier une vacation', cancelShift: 'Annuler la vacation', correction: 'Corriger le pointage', open: 'Ouvrir ma caisse', move: 'Mouvement d’espèces', close: 'Clôturer ma caisse', incident: 'Signaler un incident', follow: 'Suivre l’incident', rate: 'Tarif de stationnement', pass: 'Émettre un abonnement', revoke: 'Suspendre l’abonnement' }
  const auditRows = [...(data.audit || [])].sort((a,b) => b.at.localeCompare(a.at))
  const exportHours = () => download('heures-personnel.csv', csvRows(['Employé', 'Début', 'Fin', 'Minutes travaillées', 'Heures', 'État', 'Motif correction'], visibleAttendance.map((a) => [a.userName, a.inAt, a.outAt || '', attendanceMinutes(a, tick), (attendanceMinutes(a, tick) / 60).toFixed(2), a.outAt ? 'Terminé' : 'En cours', a.correctionReason || ''])))
  return <div className="stack ops-page">
    <div className="row ops-wrap"><div><h1 style={{ fontSize: 22 }}>Équipe & exploitation</h1><p className="mut tiny">Contrôle opérationnel · {ROLE_LABELS[user.role] || user.role} · {lot.name}</p></div></div>
    <div className="ops-notice">RH locales à ce navigateur. Le partage transactionnel des tickets et de la caisse parking s’active dans « Rapports & parking pro ». L’apprentissage OCR conserve sa réplication v7. Les opérations automobiles restent sur une caisse locale distincte.</div>
    <Tabs value={tab} onChange={setTab} tabs={[
      ...(can('kpi.read') ? [{ value: 'cockpit', label: 'Pilotage & alertes' }] : []),
      { value: 'equipe', label: 'Planning & pointage' },
      ...(can('kpi.read') ? [{ value: 'professionnel', label: 'Rapports & parking pro' }] : []),
      ...(can('cash.open') ? [{ value: 'caisse', label: 'Caisse & rapprochement' }] : []),
      { value: 'incidents', label: 'Incidents' },
      ...(can('passes.issue') || can('rates.manage') ? [{ value: 'tarifs', label: 'Tarifs & abonnements' }] : []),
      ...(can('audit.read') ? [{ value: 'audit', label: 'Traçabilité' }, { value: 'droits', label: 'Matrice des droits' }] : []),
    ]} />
    {tab === 'professionnel' && can('kpi.read') && <ParkingProfessional lot={lot} user={user} />}
    {tab === 'cockpit' && can('kpi.read') && <>
      <div className="ops-kpis">{[
        ['Occupation', `${kpi.occupancy.toFixed(1)} %`, `${kpi.occupied}/${kpi.capacity} places hors maintenance`],
        ['Disponibles', kpi.free, 'Places immédiatement libres'], ['Recettes stationnement du jour', money(kpi.todayRevenue), `${kpi.todayExits} sorties, hors ventes automobiles et abonnements`],
        ['Équipe présente', kpi.onSite, `${kpi.missingAttendance} retard(s)/absence(s) à vérifier`],
        ['Incidents ouverts', kpi.openIncidents, `${kpi.overdue} séjour(s) > 24 h`], ['Abonnements valides', kpi.activePasses, `${kpi.unlinkedReceipts} recette(s) stationnement sans session de caisse`],
      ].map(([name, value, sub]) => <Card key={name}><div className="mut tiny">{name}</div><strong className="ops-value">{value}</strong><span className="tiny mut">{sub}</span></Card>)}</div>
      <Card><CardHead title="Alertes à traiter" icon={ShieldAlert} />{kpi.alerts.length ? kpi.alerts.map((a,i) => <p key={i}><Badge tone={a.severity}>{a.text}</Badge></p>) : <p className="tiny mut">Aucune alerte calculée.</p>}<p className="tiny mut">Actualisation locale toutes les 30 secondes ; ce ne sont pas des notifications SMS ou push.</p></Card>
      <Card><CardHead title="Occupation par zone" icon={Gauge} /><div className="ops-zone-grid">{[...new Set((data.spots || []).map((s) => s.zone))].map((zone) => { const spots = data.spots.filter((s) => s.zone === zone); return <div key={zone}><b>Zone {zone}</b><p>{spots.filter((s) => s.status === 'occupe').length} occupées · {spots.filter((s) => s.status === 'libre').length} libres · {spots.filter((s) => s.status === 'hs').length} hors service</p></div> })}</div></Card>
    </>}
    {tab === 'equipe' && <>
      <Card><CardHead title="Mon pointage" icon={Clock} sub="Début, pause, reprise et fin. Les corrections responsables sont justifiées et journalisées." />
        <p data-testid="attendance-state">{ownAttendance ? `${onBreak ? 'En pause' : 'En service'} depuis ${fmtDateTime(ownAttendance.inAt)} · ${(attendanceMinutes(ownAttendance, tick) / 60).toFixed(2)} h travaillées` : 'Non pointé'}</p>
        <div className="row ops-wrap">{(!ownAttendance ? [['in', 'Prendre mon service']] : [[onBreak ? 'resume' : 'pause', onBreak ? 'Reprendre le service' : 'Débuter ma pause'], ['out', 'Terminer mon service']]).map(([action, label]) => <button key={action} className="btn btn-primary" data-testid={`clock-${action}`} disabled={busy} onClick={() => run(() => clockAttendance(lot.id, user, action), 'Pointage enregistré.')}>{label}</button>)}</div>
      </Card>
      <Card><CardHead title="Planning des vacations" icon={CalendarDays} right={can('planning.manage') && <button className="btn btn-primary btn-sm" data-testid="new-shift" onClick={() => open('shift')}><Plus size={14} /> Planifier</button>} />
        {table(['Employé', 'Début', 'Fin', 'Zone', 'État', 'Action'], visibleShifts.map((s) => <tr key={s.id}><td>{s.userName}</td><td>{fmtDateTime(s.startAt)}</td><td>{fmtDateTime(s.endAt)}</td><td>{s.zone || 'Toutes'}</td><td>{labelStatus[s.status]}</td><td>{can('planning.manage') && s.status === 'planifie' && <button className="btn btn-ghost btn-sm" onClick={() => open('cancelShift', s)}>Annuler avec motif</button>}</td></tr>))}
      </Card>
      <Card><CardHead title="Feuille des heures" icon={Users} right={<button className="btn btn-ghost btn-sm" onClick={exportHours}><Download size={14} /> Export CSV</button>} />
        <div className="row ops-wrap" style={{ marginBottom: 14 }}><Field label="Du"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="Au"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field></div>
        {table(['Employé', 'Début', 'Fin', 'Heures nettes', 'Correction'], visibleAttendance.map((a) => <tr key={a.id}><td>{a.userName}</td><td>{fmtDateTime(a.inAt)}</td><td>{a.outAt ? fmtDateTime(a.outAt) : 'En cours'}</td><td>{(attendanceMinutes(a, tick) / 60).toFixed(2)}</td><td>{a.correctionReason && <span className="tiny">{a.correctionReason} </span>}{can('attendance.manage') && <button className="btn btn-ghost btn-sm" onClick={() => open('correction', a)}>Corriger</button>}</td></tr>))}
        <p className="tiny mut">Heures nettes de pauses, sans calcul légal de paie, d’heures supplémentaires ou de cotisations.</p>
      </Card>
    </>}
    {tab === 'caisse' && can('cash.open') && <>
      <Card><CardHead title="Ma caisse" icon={Wallet} sub="L’espèce et les paiements électroniques sont distingués. Les ventes, règlements et sorties sont reliés à votre session ouverte." />
        {ownCash ? <><div className="ops-kpis"><div><span className="tiny mut">Fond initial</span><b className="ops-value">{money(ownCash.openingFloat)}</b></div><div><span className="tiny mut">Espèces attendues</span><b className="ops-value" data-testid="cash-expected">{money(cashSummary(ownCash, moves).expected)}</b></div><div><span className="tiny mut">Recettes tous modes</span><b className="ops-value">{money(cashSummary(ownCash, moves).receipts)}</b></div></div><div className="row ops-wrap"><button className="btn btn-ghost" onClick={() => open('move')}>Apport / retrait</button><button className="btn btn-primary" data-testid="close-cash" onClick={() => open('close', ownCash)}>Clôturer ma caisse</button></div></> : <button className="btn btn-primary" data-testid="open-cash" onClick={() => open('open')}>Ouvrir ma caisse</button>}
        {user.role === 'admin' && <div style={{ marginTop: 15 }}><label className="tiny"><input type="checkbox" checked={!!(data.lotPolicy?.requireCashSession ?? lot.requireCashSession)} onChange={(e) => { const value = e.target.checked; run(async () => { await authorize(user, lot.id, 'cash.review'); await db.lots.update(lot.id, { requireCashSession: value }) }, value ? 'Caisse obligatoire activée.' : 'Caisse facultative.') }} /> Rendre obligatoire une session de caisse avant tout encaissement</label><p className="tiny mut">Paramètre local, désactivé par défaut pour préserver les flux existants.</p></div>}
      </Card>
      <Card><CardHead title="Clôtures et écarts" icon={Check} right={<button className="btn btn-ghost btn-sm" onClick={() => download('clotures-caisse.csv', csvRows(['Employé', 'Ouverture', 'Clôture', 'Attendu espèces', 'Compté', 'Écart', 'Motif', 'Contrôlé'], sessions.filter((s) => can('cash.review') || s.userId === user.id).map((s) => [s.userName, s.openedAt, s.closedAt, s.expected, s.counted, s.variance, s.reason, s.reviewedAt])))}>Export CSV</button>} />
        {table(['Employé', 'État', 'Attendu', 'Compté', 'Écart', 'Contrôle'], sessions.filter((s) => can('cash.review') || s.userId === user.id).sort((a,b) => b.openedAt.localeCompare(a.openedAt)).map((s) => <tr key={s.id}><td>{s.userName}</td><td>{labelStatus[s.status]}</td><td>{money(s.expected ?? cashSummary(s, moves).expected)}</td><td>{s.counted !== undefined ? money(s.counted) : '—'}</td><td><Badge tone={s.variance ? 'warn' : 'ok'}>{s.variance !== undefined ? money(s.variance) : '—'}</Badge></td><td>{s.reviewedAt ? 'Contrôlé' : s.status === 'cloturee' && can('cash.review') && s.userId !== user.id ? <button className="btn btn-ghost btn-sm" onClick={() => run(() => reviewCash(s.id, user), 'Contrôle enregistré.')}>Valider la revue</button> : 'En attente'}</td></tr>))}
      </Card>
      {ownCash && <Card><CardHead title="Journal de ma caisse ouverte" />{table(['Date', 'Type', 'Mode', 'Montant', 'Origine / motif'], moves.filter((m) => m.sessionId === ownCash.id).map((m) => <tr key={m.id}><td>{fmtDateTime(m.at)}</td><td>{m.kind}</td><td>{m.method}</td><td>{money(m.amount)}</td><td>{m.reason}</td></tr>))}</Card>}
    </>}
    {tab === 'incidents' && <Card><CardHead title="Incidents & dommages" icon={ShieldAlert} right={<button className="btn btn-primary btn-sm" data-testid="new-incident" onClick={() => open('incident')}>Signaler un incident</button>} />
      <div className="ops-incidents">{incidents.filter((i) => can('incidents.manage') || i.reportedBy === user.id || i.assignedTo === user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map((i) => <article key={i.id} className="ops-incident"><div className="row ops-wrap"><b>{i.title}</b><Badge tone={['critique','haute'].includes(i.severity) ? 'danger' : 'warn'}>{i.severity}</Badge><Badge>{labelStatus[i.status]}</Badge></div><p>{i.description}</p><p className="tiny mut">{i.plate || 'Sans plaque'} · {i.reportedName} · {fmtDateTime(i.createdAt)} · Affecté à {staff.find((u) => u.id === i.assignedTo)?.name || 'personne'}</p>{i.photo && <img className="ops-photo" src={i.photo} alt="Pièce jointe à l’incident" />}<ol>{i.history.map((h, j) => <li key={j} className="tiny">{fmtDateTime(h.at)} · {h.userName} · {labelStatus[h.to]} : {h.note}</li>)}</ol>{can('incidents.manage') && <button className="btn btn-ghost btn-sm" onClick={() => open('follow', i)}>{i.status === 'resolu' ? 'Rouvrir avec motif' : 'Mettre à jour'}</button>}</article>)}</div>
    </Card>}
    {tab === 'tarifs' && <>
      <Card><CardHead title="Grilles tarifaires" icon={Ticket} sub="Tarif et plafond figés à l’entrée. Le plafond s’applique aussi aux journées incomplètes." right={can('rates.manage') && <button className="btn btn-primary btn-sm" data-testid="new-rate" onClick={() => open('rate')}>Créer un tarif</button>} />{table(['Nom', 'Type place', 'Horaire', 'Plafond / 24 h', 'Franchise', 'Action'], plans.map((p) => <tr key={p.id}><td>{p.name} {!p.active && '(désactivé)'}</td><td>{p.spotType || 'Tous'}</td><td>{money(p.hourlyRate)}</td><td>{money(p.dailyCap)}</td><td>{p.graceMinutes} min</td><td>{can('rates.manage') && <button className="btn btn-ghost btn-sm" onClick={() => open('rate', p)}>Modifier</button>}</td></tr>))}</Card>
      <Card><CardHead title="Abonnements par plaque" icon={Ticket} sub="L’abonnement couvre un séjour entièrement compris dans sa période de validité. Il ne réserve pas une place et ne s’active qu’après enregistrement de son encaissement." right={can('passes.issue') && <button className="btn btn-primary btn-sm" data-testid="new-pass" onClick={() => open('pass')}>Émettre un abonnement</button>} />{table(['Titulaire', 'Plaque', 'Période', 'Montant', 'État', 'Action'], passes.map((p) => <tr key={p.id}><td>{p.holder}</td><td>{p.plate}</td><td>{fmtDateTime(p.startAt)} → {fmtDateTime(p.endAt)}</td><td>{money(p.amount)}</td><td>{p.status === 'actif' && p.endAt < new Date(tick).toISOString() ? 'Expiré' : labelStatus[p.status]}</td><td>{can('rates.manage') && p.status === 'actif' && <button className="btn btn-ghost btn-sm" onClick={() => open('revoke', p)}>Suspendre</button>}</td></tr>))}</Card>
    </>}
    {tab === 'audit' && can('audit.read') && <Card><CardHead title="Journal opérationnel" icon={History} sub="Traçabilité locale, non inviolable : un journal serveur append-only sera nécessaire en production." right={<button className="btn btn-ghost btn-sm" onClick={() => download('audit-operations.csv', csvRows(['Date', 'Acteur', 'Action', 'Cible', 'Détails'], auditRows.map((a) => [a.at, a.userName, a.action, a.target, a.details])))}>Exporter CSV</button>} />{table(['Date', 'Acteur', 'Action', 'Détails'], auditRows.slice(0,200).map((a) => <tr key={a.id}><td>{fmtDateTime(a.at)}</td><td>{a.userName}</td><td>{a.action}</td><td><details><summary>Voir</summary><pre className="ops-json">{a.details}</pre></details></td></tr>))}<p className="tiny mut">Les 200 événements les plus récents sont affichés ; l’export inclut l’ensemble du journal du parking.</p></Card>}
    {tab === 'droits' && can('audit.read') && <Card><CardHead title="Matrice des permissions" /><div className="table-wrap"><table className="tbl"><thead><tr><th>Permission</th>{Object.values(ROLE_LABELS).map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{PERMISSION_LIST.map((p) => <tr key={p}><td>{p}</td>{Object.keys(ROLE_LABELS).map((role) => <td key={role}>{hasPermission({ role, active: true }, p) ? 'Oui' : 'Non'}</td>)}</tr>)}</tbody></table></div><p className="tiny mut">Ces contrôles applicatifs ne remplacent pas les politiques RLS et les transactions métier d’un serveur de production.</p></Card>}
    <Modal open={!!modal} onClose={() => setModal(null)} title={titles[modal?.type]} footer={<><button className="btn btn-ghost" onClick={() => setModal(null)}>Annuler</button><button className="btn btn-primary" data-testid="ops-save" disabled={busy} onClick={submit}>{busy ? 'Traitement…' : 'Enregistrer'}</button></>}>
      {modal?.type === 'shift' && <>{person()}{input('Début', 'startAt', 'datetime-local')}{input('Fin', 'endAt', 'datetime-local')}{input('Zone', 'zone')}{input('Note', 'note')}</>}
      {modal?.type === 'correction' && <>{input('Entrée corrigée', 'inAt', 'datetime-local')}{input('Sortie corrigée', 'outAt', 'datetime-local')}{input('Justification obligatoire', 'reason')}</>}
      {['cancelShift','revoke'].includes(modal?.type) && input('Motif obligatoire', 'reason')}
      {['open','move','close'].includes(modal?.type) && <>{modal.type === 'move' && <Field label="Type"><Select value={f.kind} onChange={set('kind')}><option value="apport">Apport d’espèces</option><option value="retrait">Retrait d’espèces</option></Select></Field>}{input(modal.type === 'open' ? 'Fond de caisse initial' : modal.type === 'close' ? 'Espèces réellement comptées' : 'Montant', 'amount', 'number', { min: 0, step: '0.01' })}{modal.type !== 'open' && input(modal.type === 'close' ? 'Motif obligatoire si écart' : 'Motif obligatoire', 'reason')}{modal.type === 'close' && <p className="tiny mut">Le fond initial, les espèces encaissées et les apports/retraits sont rapprochés. Les autres modes ne sont pas comptés comme espèces.</p>}</>}
      {modal?.type === 'incident' && <>{input('Titre', 'title')}{input('Description', 'description')}{input('Plaque (optionnelle)', 'plate')}<Field label="Gravité"><Select value={f.severity} onChange={set('severity')}>{['faible','moyenne','haute','critique'].map((v) => <option key={v}>{v}</option>)}</Select></Field>{person('assignedTo', 'Affectation')}<Field label="Photo facultative (JPEG/PNG/WebP, 1 Mo maximum)"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 1048576 || !['image/jpeg','image/png','image/webp'].includes(file.type)) { toast.err('Photo de 1 Mo maximum.'); return }; const reader = new FileReader(); reader.onload = () => setF((prev) => ({ ...prev, photo: reader.result })); reader.readAsDataURL(file) }} /></Field></>}
      {modal?.type === 'follow' && <><Field label="Nouvel état"><Select value={f.status} onChange={set('status')}>{(modal.row.status === 'en_cours' ? ['resolu'] : ['en_cours']).map((s) => <option key={s} value={s}>{labelStatus[s]}</option>)}</Select></Field>{input('Commentaire obligatoire', 'reason')}</>}
      {modal?.type === 'rate' && <>{input('Nom', 'name')}{input('Prix horaire', 'hourlyRate', 'number', { min: 0 })}{input('Plafond par tranche de 24 h (0 = aucun)', 'dailyCap', 'number', { min: 0 })}{input('Franchise en minutes', 'graceMinutes', 'number', { min: 0 })}<Field label="Type de place"><Select value={f.spotType} onChange={set('spotType')}><option value="">Tous types</option>{['standard','pmr','moto','camion','electrique'].map((t) => <option key={t}>{t}</option>)}</Select></Field><label><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Tarif actif</label></>}
      {modal?.type === 'pass' && <>{input('Titulaire', 'holder')}{input('Plaque', 'plate')}{input('Début de validité', 'startAt', 'datetime-local')}{input('Fin de validité', 'endAt', 'datetime-local')}{input('Montant payé (0 = gratuité autorisée)', 'amount', 'number', { min: 0 })}<Field label="Mode"><Select value={f.paymentMethod} onChange={set('paymentMethod')}>{['espèces','mobile money','carte bancaire','virement'].map((v) => <option key={v}>{v}</option>)}</Select></Field></>}
    </Modal>
  </div>
}
