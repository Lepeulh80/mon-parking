import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ShoppingCart, Search, FileText, Receipt, Trash2, Plus, Eye, Download, CreditCard,
} from 'lucide-react'
import { useRemoteRows } from '../lib/apiData'
import { db, addPayment, deleteSale } from '../lib/db'
import { useApp } from '../App'
import { Card, CardHead, Badge, StatusBadge, Modal, Confirm, Empty, Seg, Field, Input, useToast, IconBtn } from '../components/UI'
import { fmtMoney, fmtDate, fmtDateTime, toCSV, downloadBlob } from '../lib/format'
import { buildInvoice, buildReceipt } from '../lib/pdf'
import { navigate } from '../lib/router'

export function SaleDetail({ sale, onClose }) {
  const { lot } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const [payOpen, setPayOpen] = useState(false)
  const [amount, setAmount] = useState(0)
  const [method, setMethod] = useState('espèces')
  const [busy, setBusy] = useState(false)
  if (!sale) return null
  const due = Math.max(0, Number(sale.total) - Number(sale.paid || 0))

  const doPay = async () => {
    if (Number(amount) <= 0) { toast.err('Montant invalide.'); return }
    setBusy(true)
    try {
      await addPayment(sale.id, Number(amount), method, { id: 'runtime', name: 'Caisse' })
      toast.ok('Encaissement enregistré.')
      setPayOpen(false)
      onClose()
    } catch (e) { toast.err(e.message) }
    setBusy(false)
  }

  const dl = async (kind) => {
    const doc = kind === 'invoice' ? await buildInvoice(sale, lot) : await buildReceipt(sale, lot)
    doc.save(`${kind === 'invoice' ? sale.invoiceNumber : sale.receiptNumber}.pdf`)
    toast.ok('Document PDF généré.')
  }

  return (
    <Modal open onClose={onClose} wide title={`${sale.type === 'location' ? 'Location' : 'Vente'} · ${sale.invoiceNumber}`}
      icon={FileText}
      footer={<>
        <button className="btn btn-ghost" onClick={() => dl('receipt')}><Receipt style={{ width: 14, height: 14 }} /> Reçu</button>
        <button className="btn btn-ghost" onClick={() => dl('invoice')}><Download style={{ width: 14, height: 14 }} /> Facture PDF</button>
        {due > 0.5 && <button className="btn btn-primary" onClick={() => { setAmount(due); setPayOpen(true) }}><CreditCard style={{ width: 14, height: 14 }} /> Encaisser</button>}
      </>}>
      <div className="split" style={{ gridTemplateColumns: '1fr 260px', gap: 16 }}>
        <div>
          <div style={{ display: 'grid', gap: 10 }}>
            {[
              ['Client', sale.clientSnapshot?.name || 'Client comptant', sale.clientSnapshot?.phone || ''],
              ['Véhicule', `${sale.vehicleSnapshot?.brand || ''} ${sale.vehicleSnapshot?.model || ''} ${sale.vehicleSnapshot?.year || ''}`, `${sale.vehicleSnapshot?.plate || ''} · ${sale.vehicleSnapshot?.vin || ''}`],
              ['Date', fmtDateTime(sale.date), `Vendeur : ${sale.userName}`],
              ['Paiement', sale.paymentMethod, sale.type === 'location' ? `Caution ${fmtMoney(sale.deposit || 0, cur)}` : ''],
            ].map(([k, v, s]) => (
              <div key={k} style={{ display: 'flex', gap: 12, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
                <div style={{ width: 82, fontSize: 11, color: 'var(--muted)' }}>{k}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{v}</div>
                  {s && <div className="tiny mut">{s}</div>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <CardHead title="Lignes" />
            <table className="tbl">
              <thead><tr><th>Désignation</th><th className="t-right">Montant</th></tr></thead>
              <tbody>
                <tr><td>{sale.vehicleSnapshot?.brand} {sale.vehicleSnapshot?.model} {sale.type === 'location' ? `— ${sale.rentalDays} jour(s)` : ''}</td><td className="t-right num">{fmtMoney(sale.price, cur)}</td></tr>
                {!!sale.discount && <tr><td className="mut">Remise</td><td className="t-right num" style={{ color: 'var(--danger)' }}>- {fmtMoney(sale.discount, cur)}</td></tr>}
                <tr><td className="mut">Sous-total HT</td><td className="t-right num">{fmtMoney(sale.subtotal, cur)}</td></tr>
                <tr><td className="mut">TVA ({sale.vatRate} %)</td><td className="t-right num">{fmtMoney(sale.vatAmount, cur)}</td></tr>
                {!!sale.extraFees && <tr><td className="mut">Frais supplémentaires</td><td className="t-right num">{fmtMoney(sale.extraFees, cur)}</td></tr>}
                <tr><td className="strong">Total TTC</td><td className="t-right num strong" style={{ color: 'var(--acc)' }}>{fmtMoney(sale.total, cur)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="card" style={{ padding: 14 }}>
            <div className="tiny mut">Réglé</div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 19, fontWeight: 700, color: 'var(--ok)' }}>{fmtMoney(sale.paid, cur)}</div>
            <div className="progress" style={{ margin: '9px 0' }}><i style={{ width: `${Math.min(100, (sale.paid / sale.total) * 100)}%` }} /></div>
            <div className="tiny mut">Reste à payer</div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 700, color: due > 0 ? 'var(--danger)' : 'var(--ok)' }}>{fmtMoney(due, cur)}</div>
            <div style={{ marginTop: 9 }}><StatusBadge status={sale.status} /></div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="tiny mut" style={{ marginBottom: 6 }}>Références</div>
            <div className="mono">Facture : {sale.invoiceNumber}</div>
            <div className="mono" style={{ marginTop: 4 }}>Reçu : {sale.receiptNumber}</div>
            {sale.rentalStart && <div className="tiny mut" style={{ marginTop: 8 }}>Du {fmtDate(sale.rentalStart)} au {fmtDate(sale.rentalEnd)}</div>}
          </div>
        </div>
      </div>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Encaisser un paiement" icon={CreditCard}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setPayOpen(false)}>Annuler</button>
          <button className="btn btn-primary" onClick={doPay} disabled={busy}>{busy ? '…' : 'Valider l’encaissement'}</button>
        </>}>
        <Field label="Montant reçu"><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Mode de paiement">
          <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
            {['espèces', 'mobile money', 'virement', 'chèque', 'carte bancaire'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </Field>
        <p className="tiny mut">Reste dû avant encaissement : {fmtMoney(due, cur)}</p>
      </Modal>
    </Modal>
  )
}

export default function Sales() {
  const { lot, isAdmin, user } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const salesLocal = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const sales = useRemoteRows('sales', lot.id, salesLocal)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('tous')
  const [type, setType] = useState('tous')
  const [detail, setDetail] = useState(null)
  const [toDelete, setToDelete] = useState(null)

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return sales
      .filter((s) => type === 'tous' || s.type === type)
      .filter((s) => status === 'tous' || s.status === status)
      .filter((s) => !term || `${s.invoiceNumber} ${s.clientSnapshot?.name} ${s.vehicleSnapshot?.brand} ${s.vehicleSnapshot?.model} ${s.vehicleSnapshot?.plate}`.toLowerCase().includes(term))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
  }, [sales, q, status, type])

  const totals = useMemo(() => ({
    total: filtered.reduce((a, s) => a + Number(s.total || 0), 0),
    paid: filtered.reduce((a, s) => a + Number(s.paid || 0), 0),
  }), [filtered])

  const exportCsv = () => {
    const csv = toCSV(filtered, [
      { label: 'Facture', key: 'invoiceNumber' },
      { label: 'Date', value: (s) => fmtDate(s.date) },
      { label: 'Type', key: 'type' },
      { label: 'Client', value: (s) => s.clientSnapshot?.name || '' },
      { label: 'Véhicule', value: (s) => `${s.vehicleSnapshot?.brand || ''} ${s.vehicleSnapshot?.model || ''}` },
      { label: 'Plaque', value: (s) => s.vehicleSnapshot?.plate || '' },
      { label: 'Total', key: 'total' },
      { label: 'Payé', key: 'paid' },
      { label: 'Statut', key: 'status' },
      { label: 'Vendeur', key: 'userName' },
    ])
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `ventes-${new Date().toISOString().slice(0, 10)}.csv`)
    toast.ok('Export CSV téléchargé.')
  }

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Ventes & locations</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
            {filtered.length} document(s) · {fmtMoney(totals.total, cur)} TTC · {fmtMoney(totals.paid, cur)} encaissés
          </p>
        </div>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={exportCsv}><Download style={{ width: 14, height: 14 }} /> CSV</button>
        <button className="btn btn-primary" onClick={() => navigate('/ventes/nouvelle')}><Plus /> Nouvelle vente</button>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="search-box"><Search /><input className="input" placeholder="Facture, client, véhicule…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Seg value={type} onChange={setType} options={[{ value: 'tous', label: 'Tout' }, { value: 'vente', label: 'Ventes' }, { value: 'location', label: 'Locations' }]} />
          <Seg value={status} onChange={setStatus} options={[{ value: 'tous', label: 'Tous' }, { value: 'payee', label: 'Payées' }, { value: 'partielle', label: 'Partielles' }, { value: 'impayee', label: 'Impayées' }]} />
        </div>
      </Card>

      <Card>
        {filtered.length === 0 ? (
          <Empty icon={ShoppingCart} title="Aucune transaction" text="Les ventes et locations apparaîtront ici."
            action={<button className="btn btn-primary" onClick={() => navigate('/ventes/nouvelle')}><Plus /> Créer une vente</button>} />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Pièce</th><th>Date</th><th>Client</th><th>Véhicule</th><th>Type</th><th className="t-right">Total</th><th className="t-right">Payé</th><th>Statut</th><th></th></tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.invoiceNumber}</td>
                    <td className="mut">{fmtDate(s.date)}</td>
                    <td>{s.clientSnapshot?.name || 'Comptant'}</td>
                    <td className="mut">{s.vehicleSnapshot?.brand} {s.vehicleSnapshot?.model}<br /><span className="tiny">{s.vehicleSnapshot?.plate}</span></td>
                    <td><Badge tone={s.type === 'location' ? 'warn' : 'info'}>{s.type === 'location' ? 'Location' : 'Vente'}</Badge></td>
                    <td className="t-right num strong">{fmtMoney(s.total, cur)}</td>
                    <td className="t-right num mut">{fmtMoney(s.paid, cur)}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <IconBtn title="Détails" onClick={() => setDetail(s)}><Eye /></IconBtn>
                        {isAdmin && <IconBtn title="Annuler la vente" onClick={() => setToDelete(s)}><Trash2 /></IconBtn>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <SaleDetail sale={detail} onClose={() => setDetail(null)} />
      <Confirm open={!!toDelete} danger title="Annuler cette transaction"
        text={`Seul un document sans règlement peut être annulé. La facture ${toDelete?.invoiceNumber} sera supprimée et le véhicule remis en stock si aucune autre opération ne le mobilise. Cette action est irréversible.`}
        confirmLabel="Annuler la transaction"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          try {
            await deleteSale(toDelete.id, user)
            setToDelete(null)
            toast.ok('Transaction annulée, véhicule remis en stock.')
          } catch (e) { toast.err(e.message) }
        }} />
    </div>
  )
}
