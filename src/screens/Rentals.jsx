import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { KeyRound, Plus, RotateCcw, CalendarDays, AlertTriangle, Car } from 'lucide-react'
import { db, returnRental } from '../lib/db'
import { useApp } from '../App'
import { Card, CardHead, Badge, Empty, Field, Input, Modal, useToast } from '../components/UI'
import { fmtMoney, fmtDate, daysBetween } from '../lib/format'
import { navigate } from '../lib/router'
import { buildInvoice } from '../lib/pdf'

export default function Rentals() {
  const { lot, user } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const sales = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  
  const rentals = useMemo(() => sales.filter((s) => s.type === 'location').sort((a, b) => new Date(b.date) - new Date(a.date)), [sales])
  const active = rentals.filter((r) => !r.returnedAt)
  const closed = rentals.filter((r) => r.returnedAt)
  const [returning, setReturning] = useState(null)
  const [fees, setFees] = useState(0)
  const [busy, setBusy] = useState(false)

  
  const overdue = (r) => r.rentalEnd && new Date(r.rentalEnd) < new Date()

  const doReturn = async () => {
    setBusy(true)
    try {
      await returnRental(returning.id, Number(fees) || 0, user)
      toast.ok('Retour enregistré · véhicule remis en stock.')
      setReturning(null)
      setFees(0)
    } catch (e) { toast.err(e.message) }
    setBusy(false)
  }

  const revenue = rentals.reduce((a, r) => a + Number(r.total || 0), 0)

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Locations</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
            {active.length} contrat(s) en cours · {fmtMoney(revenue, cur)} de revenus locatifs
          </p>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => navigate('/ventes/nouvelle')}><Plus /> Nouvelle location</button>
      </div>

      <Card>
        <CardHead title="Contrats en cours" sub="Cliquez sur « Retour » lorsque le véhicule revient" icon={KeyRound}
          right={<Badge tone="warn">{active.length} actif(s)</Badge>} />
        {active.length === 0 ? (
          <Empty icon={KeyRound} title="Aucune location en cours" text="Créez une location depuis « Nouvelle transaction »." />
        ) : (
          <div style={{ display: 'grid', gap: 11 }}>
            {active.map((r) => {
              
              const late = overdue(r)
              const remaining = r.rentalEnd ? daysBetween(new Date(), r.rentalEnd) : 0
              return (
                <div key={r.id} className="card" style={{ padding: 14, borderColor: late ? 'rgba(255,92,122,0.4)' : 'var(--line)' }}>
                  <div className="row" style={{ marginBottom: 9 }}>
                    <Badge tone={late ? 'danger' : 'ok'} dot>{late ? 'En retard' : remaining <= 1 ? 'Retour imminent' : `${remaining} j restants`}</Badge>
                    <span className="mono tiny mut">{r.invoiceNumber}</span>
                    <span className="spacer" />
                    <span style={{ fontFamily: 'Space Grotesk', fontWeight: 700, color: 'var(--acc)' }}>{fmtMoney(r.total, cur)}</span>
                  </div>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <b style={{ fontSize: 13.5 }}>{r.vehicleSnapshot?.brand} {r.vehicleSnapshot?.model}</b>
                      <div className="tiny mut">{r.vehicleSnapshot?.plate} · Client : {r.clientSnapshot?.name}</div>
                      <div className="tiny mut" style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
                        <CalendarDays style={{ width: 11, height: 11 }} /> {fmtDate(r.rentalStart)} → {fmtDate(r.rentalEnd)} ({r.rentalDays} j)
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={async () => {
                        const doc = await buildInvoice(r, lot); doc.save(`${r.invoiceNumber}.pdf`)
                        toast.ok('Facture téléchargée.')
                      }}>Facture</button>
                      <button className="btn btn-sm btn-primary" onClick={() => { setReturning(r); setFees(0) }}>
                        <RotateCcw style={{ width: 13, height: 13 }} /> Retour
                      </button>
                    </div>
                  </div>
                  <div className="tiny mut" style={{ marginTop: 8 }}>Caution déposée : {fmtMoney(r.deposit || 0, cur)} · Encaissé {fmtMoney(r.paid, cur)}</div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="Historique des locations" sub="Contrats clôturés" />
        {closed.length === 0 ? <Empty icon={Car} title="Aucun contrat clôturé" /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Facture</th><th>Véhicule</th><th>Client</th><th>Période</th><th>Durée</th><th className="t-right">Total</th><th className="t-right">Frais</th><th>Retour</th></tr></thead>
              <tbody>
                {closed.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.invoiceNumber}</td>
                    <td>{r.vehicleSnapshot?.brand} {r.vehicleSnapshot?.model}<br /><span className="tiny mut">{r.vehicleSnapshot?.plate}</span></td>
                    <td className="mut">{r.clientSnapshot?.name}</td>
                    <td className="mut tiny">{fmtDate(r.rentalStart)} → {fmtDate(r.rentalEnd)}</td>
                    <td>{r.rentalDays} j</td>
                    <td className="t-right num strong">{fmtMoney(r.total, cur)}</td>
                    <td className="t-right num mut">{fmtMoney(r.extraFees || 0, cur)}</td>
                    <td className="mut tiny">{fmtDate(r.returnedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!returning} onClose={() => setReturning(null)} title="Retour du véhicule" icon={RotateCcw}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setReturning(null)}>Annuler</button>
          <button className="btn btn-primary" onClick={doReturn} disabled={busy}>{busy ? '…' : 'Confirmer le retour'}</button>
        </>}>
        {returning && (
          <>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              <b>{returning.vehicleSnapshot?.brand} {returning.vehicleSnapshot?.model}</b> ({returning.vehicleSnapshot?.plate})<br />
              <span className="mut tiny">Client {returning.clientSnapshot?.name} · contrat {returning.invoiceNumber}</span>
            </p>
            <Field label="Frais supplémentaires (retard, carburant, dégâts)" hint="Ajoutés au total de la facture">
              <Input type="number" value={fees} onChange={(e) => setFees(e.target.value)} />
            </Field>
            <div style={{ background: 'rgba(255,179,71,0.1)', border: '1px solid rgba(255,179,71,0.3)', borderRadius: 10, padding: '9px 12px', fontSize: 12, color: 'var(--warn)', display: 'flex', gap: 8 }}>
              <AlertTriangle style={{ width: 15, height: 15, flex: '0 0 auto' }} />
              Le véhicule repassera automatiquement en stock et redeviendra disponible à la vente.
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
