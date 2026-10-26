import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { FileText, Search, Download, Receipt, Eye, Printer } from 'lucide-react'
import { db } from '../lib/db'
import { useApp } from '../App'
import { Card, Badge, StatusBadge, Empty, Seg, useToast, IconBtn } from '../components/UI'
import { fmtMoney, fmtDate } from '../lib/format'
import { buildInvoice, buildReceipt, docDataUri } from '../lib/pdf'
import { SaleDetail } from './Sales'

export default function Billing() {
  const { lot } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const sales = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('toutes')
  const [detail, setDetail] = useState(null)
  const [preview, setPreview] = useState(null)
  const [, setBusyId] = useState(null)

  const rows = useMemo(() => sales
    .filter((s) => filter === 'toutes' || (filter === 'impayees' ? s.status !== 'payee' : filter === 'payees' ? s.status === 'payee' : s.type === filter))
    .filter((s) => !q.trim() || `${s.invoiceNumber} ${s.receiptNumber} ${s.clientSnapshot?.name}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => new Date(b.date) - new Date(a.date)), [sales, q, filter])

  const stats = useMemo(() => ({
    invoices: sales.length,
    total: sales.reduce((a, s) => a + Number(s.total || 0), 0),
    due: sales.reduce((a, s) => a + Math.max(0, Number(s.total || 0) - Number(s.paid || 0)), 0),
    vat: sales.reduce((a, s) => a + Number(s.vatAmount || 0), 0),
  }), [sales])

  const download = async (s, kind) => {
    setBusyId(s.id)
    try {
      const doc = kind === 'receipt' ? await buildReceipt(s, lot) : await buildInvoice(s, lot)
      doc.save(`${kind === 'receipt' ? s.receiptNumber : s.invoiceNumber}.pdf`)
      toast.ok(`${kind === 'receipt' ? 'Reçu' : 'Facture'} téléchargé.`)
    } catch (_e) { toast.err('Génération impossible.') }
    setBusyId(null)
  }

  const openPreview = async (s, kind) => {
    const doc = kind === 'receipt' ? await buildReceipt(s, lot) : await buildInvoice(s, lot)
    setPreview({ uri: docDataUri(doc), title: `${kind === 'receipt' ? s.receiptNumber : s.invoiceNumber}`, sale: s, kind })
  }

  const printAll = async () => {
    toast.info('Génération en cours…')
    for (const s of rows.slice(0, 25)) {
      const doc = await buildInvoice(s, lot)
      doc.save(`${s.invoiceNumber}.pdf`)
    }
    toast.ok(`${Math.min(rows.length, 25)} facture(s) générée(s).`)
  }

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Facturation</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
            {stats.invoices} facture(s) · {fmtMoney(stats.total, cur)} facturés · TVA {fmtMoney(stats.vat, cur)}
          </p>
        </div>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={printAll}><Printer style={{ width: 14, height: 14 }} /> Tout exporter</button>
      </div>

      <div className="kpi">
        <div className="kpi-card"><div className="kpi-top"><FileText /> Documents émis</div><div className="kpi-val">{stats.invoices}</div><div className="kpi-foot">Facture + reçu par opération</div></div>
        <div className="kpi-card accent2"><div className="kpi-top"><Receipt /> Total facturé TTC</div><div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.total, cur)}</div><div className="kpi-foot">Toutes opérations</div></div>
        <div className="kpi-card warn"><div className="kpi-top"><FileText /> TVA collectée</div><div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.vat, cur)}</div><div className="kpi-foot">À reverser</div></div>
        <div className="kpi-card danger"><div className="kpi-top"><FileText /> Encours client</div><div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.due, cur)}</div><div className="kpi-foot">Factures non soldées</div></div>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="search-box"><Search /><input className="input" placeholder="N° facture, reçu, client…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Seg value={filter} onChange={setFilter} options={[
            { value: 'toutes', label: 'Toutes' },
            { value: 'vente', label: 'Ventes' },
            { value: 'location', label: 'Locations' },
            { value: 'impayees', label: 'Non soldées' },
          ]} />
        </div>
      </Card>

      <Card>
        {rows.length === 0 ? <Empty icon={FileText} title="Aucun document" text="Les factures générées apparaissent ici." /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Facture</th><th>Reçu</th><th>Date</th><th>Client</th><th>Type</th><th className="t-right">TTC</th><th className="t-right">Reste</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.invoiceNumber}</td>
                    <td className="mono mut">{s.receiptNumber}</td>
                    <td className="mut">{fmtDate(s.date)}</td>
                    <td>{s.clientSnapshot?.name || 'Comptant'}</td>
                    <td><Badge tone={s.type === 'location' ? 'warn' : 'info'}>{s.type}</Badge></td>
                    <td className="t-right num strong">{fmtMoney(s.total, cur)}</td>
                    <td className="t-right num" style={{ color: s.total - s.paid > 0.5 ? 'var(--danger)' : 'var(--ok)' }}>{fmtMoney(Math.max(0, s.total - s.paid), cur)}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end' }}>
                        <IconBtn title="Aperçu" onClick={() => openPreview(s, 'invoice')}><Eye /></IconBtn>
                        <IconBtn title="Facture PDF" onClick={() => download(s, 'invoice')}><Download /></IconBtn>
                        <IconBtn title="Reçu PDF" onClick={() => download(s, 'receipt')}><Receipt /></IconBtn>
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

      {preview && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 780 }}>
            <div className="modal-h">
              <FileText style={{ width: 17, height: 17, color: 'var(--acc)' }} />
              <h3>Aperçu · {preview.title}</h3>
              <IconBtn onClick={() => setPreview(null)} style={{ marginLeft: 'auto' }}>✕</IconBtn>
            </div>
            <div className="modal-b" style={{ padding: 12, background: '#e8ecf2' }}>
              <iframe title="aperçu" src={preview.uri} style={{ width: '100%', height: '62dvh', border: 0, borderRadius: 8, background: '#fff' }} />
            </div>
            <div className="modal-f">
              <button className="btn btn-ghost" onClick={() => setPreview(null)}>Fermer</button>
              <button className="btn btn-primary" onClick={() => download(preview.sale, preview.kind)}><Download style={{ width: 14, height: 14 }} /> Télécharger</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
