import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Calculator, Plus, Trash2, TrendingDown, TrendingUp, Wallet, Coins, FileText } from 'lucide-react'
import { db } from '../lib/db'
import { addExpense, deleteExpense } from '../lib/admin'
import { useApp } from '../App'
import { Card, CardHead, Badge, Modal, Confirm, Empty, Field, Input, Select, useToast, IconBtn, Tabs } from '../components/UI'
import { AreaChart, Bars, Donut } from '../components/Charts'
import { computeStats, agingBuckets } from '../lib/analytics'
import { fmtMoney, fmtDate, monthKey, monthBuckets } from '../lib/format'
import { buildStatement } from '../lib/pdf'

const CATS = [
  { value: 'loyer', label: 'Loyer', color: '#c6f24e' },
  { value: 'salaires', label: 'Salaires', color: '#4cc9f0' },
  { value: 'logistique', label: 'Logistique', color: '#a78bfa' },
  { value: 'marketing', label: 'Marketing', color: '#ffb347' },
  { value: 'maintenance', label: 'Maintenance', color: '#2ee6a8' },
  { value: 'charges', label: 'Charges', color: '#ff5c7a' },
  { value: 'taxes', label: 'Taxes', color: '#8b97ad' },
  { value: 'commissions', label: 'Commissions', color: '#f472b6' },
  { value: 'divers', label: 'Divers', color: '#94a3b8' },
]

export default function Accounting() {
  const { lot, user } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const sales = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const expenses = useLiveQuery(() => db.expenses.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const vehicles = useLiveQuery(() => db.vehicles.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const [tab, setTab] = useState('synthese')
  const [open, setOpen] = useState(false)
  const [toDelete, setToDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ label: '', category: 'charges', amount: 0, date: new Date().toISOString().slice(0, 10), notes: '' })

  const stats = useMemo(() => computeStats({ sales, vehicles, expenses, lot }), [sales, vehicles, expenses, lot])
  const aging = useMemo(() => agingBuckets(sales), [sales])

  const expByCat = useMemo(() => {
    const m = new Map()
    for (const e of expenses) m.set(e.category, (m.get(e.category) || 0) + Number(e.amount || 0))
    return [...m.entries()].map(([k, v]) => ({
      label: CATS.find((c) => c.value === k)?.label || k,
      value: v,
      color: CATS.find((c) => c.value === k)?.color || '#8b97ad',
    })).sort((a, b) => b.value - a.value)
  }, [expenses])

  const monthly = useMemo(() => monthBuckets(6).map((b) => ({
    label: b.label,
    revenue: sales.filter((s) => monthKey(s.date) === b.key).reduce((a, s) => a + Number(s.paid || 0), 0),
    expense: expenses.filter((e) => monthKey(e.date) === b.key).reduce((a, e) => a + Number(e.amount || 0), 0),
  })), [sales, expenses])

  const margin = stats.collected - stats.expensesTotal
  const grossOnVehicles = stats.grossMargin

  const submit = async () => {
    if (!f.label.trim()) { toast.err('Le libellé est requis.'); return }
    if (Number(f.amount) <= 0) { toast.err('Le montant doit être supérieur à 0.'); return }
    setBusy(true)
    await addExpense(lot.id, { ...f, label: f.label.trim() }, user.id)
    toast.ok('Charge enregistrée.')
    setOpen(false)
    setF({ label: '', category: 'charges', amount: 0, date: new Date().toISOString().slice(0, 10), notes: '' })
    setBusy(false)
  }

  const exportStatement = async () => {
    const rows = [...sales].sort((a, b) => new Date(a.date) - new Date(b.date))
    const doc = await buildStatement(lot, rows, {
      revenue: stats.salesTotal, collected: stats.collected, receivable: stats.receivable,
      expenses: stats.expensesTotal, result: margin,
    }, `Exercice ${new Date().getFullYear()}`)
    doc.save(`releve-comptable-${new Date().toISOString().slice(0, 10)}.pdf`)
    toast.ok('Relevé comptable exporté.')
  }

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Comptabilité</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>Charges, encaissements, résultat et bilan simplifié</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={exportStatement}><FileText style={{ width: 14, height: 14 }} /> Relevé PDF</button>
        <button className="btn btn-primary" onClick={() => setOpen(true)}><Plus /> Nouvelle charge</button>
      </div>

      <div className="kpi">
        <div className="kpi-card"><div className="kpi-top"><Wallet /> Encaissements</div><div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.collected, cur)}</div><div className="kpi-foot">Produits réalisés</div></div>
        <div className="kpi-card danger"><div className="kpi-top"><TrendingDown /> Charges</div><div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.expensesTotal, cur)}</div><div className="kpi-foot">{expenses.length} écriture(s)</div></div>
        <div className="kpi-card accent2"><div className="kpi-top">{margin >= 0 ? <TrendingUp /> : <TrendingDown />} Solde de trésorerie</div><div className="kpi-val" style={{ fontSize: 20, color: margin >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtMoney(margin, cur)}</div><div className="kpi-foot">Encaissé − charges</div></div>
        <div className="kpi-card warn"><div className="kpi-top"><Coins /> Marge brute véhicules</div><div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(grossOnVehicles, cur)}</div><div className="kpi-foot">Prix de vente − prix d’achat</div></div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'synthese', label: 'Synthèse' },
        { value: 'charges', label: `Charges (${expenses.length})` },
        { value: 'creances', label: 'Créances clients' },
        { value: 'bilan', label: 'Bilan simplifié' },
      ]} />

      {tab === 'synthese' && (
        <>
          <div className="split">
            <Card>
              <CardHead title="Produits vs charges" sub="Encaissements et dépenses par mois" />
              <AreaChart data={monthly.map((m) => ({ label: m.label, value: m.revenue }))} height={180} format={(v) => fmtMoney(v, cur)} />
              <Bars data={monthly.map((m) => ({ label: m.label, a: m.revenue, b: m.expense }))} height={150} currency={cur} />
              <div className="legend">
                <span><i style={{ background: '#c6f24e' }} />Encaissements</span>
                <span><i style={{ background: '#4cc9f0' }} />Charges</span>
              </div>
            </Card>
            <Card>
              <CardHead title="Structure des charges" />
              {expByCat.length ? <Donut data={expByCat} centerLabel="charges" centerValue={fmtMoney(stats.expensesTotal, cur).replace(/,00$/, '')} /> : <Empty icon={Calculator} title="Aucune charge" text="Ajoutez vos charges pour calculer le résultat." />}
            </Card>
          </div>
          <div className="split">
            <Card>
              <CardHead title="Compte de résultat simplifié" sub={`Exercice ${new Date().getFullYear()}`} />
              <table className="tbl">
                <tbody>
                  {[
                    ['Ventes de véhicules (TTC)', stats.salesRevenue, false],
                    ['Revenus de location', stats.rentalRevenue, false],
                    ['Total produits facturés', stats.salesTotal, true],
                    ['dont TVA collectée', -stats.vatCollected, false],
                    ['Produits encaissés (HT)', stats.collected - stats.vatCollected, true],
                    ['Charges d’exploitation', -stats.expensesTotal, false],
                    ['Solde de trésorerie de la période', margin, true],
                  ].map(([label, val, strong]) => (
                    <tr key={label}>
                      <td className={strong ? 'strong' : 'mut'}>{label}</td>
                      <td className="t-right num" style={{ fontWeight: strong ? 700 : 400, color: val < 0 ? 'var(--danger)' : undefined }}>{fmtMoney(val, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card>
              <CardHead title="Trésorerie" sub="Position actuelle" />
              <div style={{ display: 'grid', gap: 12 }}>
                {[
                  ['Encaissé clients', stats.collected, 'var(--ok)'],
                  ['Encore à encaisser', stats.receivable, 'var(--warn)'],
                  ['Charges payées', stats.expensesTotal, 'var(--danger)'],
                  ['Trésorerie nette', margin, margin >= 0 ? 'var(--acc)' : 'var(--danger)'],
                ].map(([k, v, c]) => (
                  <div key={k}>
                    <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                      <span className="mut">{k}</span>
                      <b style={{ color: c, fontFamily: 'Space Grotesk' }}>{fmtMoney(v, cur)}</b>
                    </div>
                    <div className="progress"><i style={{ width: `${Math.min(100, Math.abs(v) / Math.max(1, stats.salesTotal) * 100)}%`, background: c }} /></div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}

      {tab === 'charges' && (
        <Card>
          <CardHead title="Journal des charges" sub="Toutes les dépenses de l’exploitation"
            right={<button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}><Plus style={{ width: 13, height: 13 }} /> Ajouter</button>} />
          {expenses.length === 0 ? <Empty icon={Calculator} title="Aucune charge" text="Enregistrez vos dépenses pour un bilan fiable." /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Libellé</th><th>Catégorie</th><th className="t-right">Montant</th><th>Note</th><th></th></tr></thead>
                <tbody>
                  {[...expenses].sort((a, b) => new Date(b.date) - new Date(a.date)).map((e) => (
                    <tr key={e.id}>
                      <td className="mut">{fmtDate(e.date)}</td>
                      <td className="strong">{e.label}</td>
                      <td><Badge tone="info">{CATS.find((c) => c.value === e.category)?.label || e.category}</Badge></td>
                      <td className="t-right num strong" style={{ color: 'var(--danger)' }}>- {fmtMoney(e.amount, cur)}</td>
                      <td className="mut tiny">{e.notes || '—'}</td>
                      <td><IconBtn title="Supprimer" onClick={() => setToDelete(e)}><Trash2 /></IconBtn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'creances' && (
        <div className="split">
          <Card>
            <CardHead title="Balance âgée des créances" sub="Antériorité des impayés" />
            <div style={{ display: 'grid', gap: 12 }}>
              {aging.map((b) => (
                <div key={b.label}>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                    <span className="mut">{b.label} · {b.count} facture(s)</span>
                    <b className="num">{fmtMoney(b.value, cur)}</b>
                  </div>
                  <div className="progress"><i style={{ width: `${Math.min(100, (b.value / Math.max(1, stats.receivable)) * 100)}%`, background: b.min >= 61 ? 'var(--danger)' : b.min >= 31 ? 'var(--warn)' : 'var(--acc)' }} /></div>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <CardHead title="Factures non soldées" />
            {sales.filter((s) => s.status !== 'payee').length === 0 ? <Empty icon={Wallet} title="Aucun impayé" text="Toutes les factures sont réglées." /> : (
              <div style={{ display: 'grid', gap: 2 }}>
                {sales.filter((s) => s.status !== 'payee').sort((a, b) => new Date(a.date) - new Date(b.date)).map((s) => (
                  <div className="list-row" key={s.id}>
                    <div className="ico"><FileText /></div>
                    <div className="txt"><b>{s.clientSnapshot?.name}</b><span>{s.invoiceNumber} · {fmtDate(s.date)}</span></div>
                    <div className="amt" style={{ color: 'var(--danger)' }}>{fmtMoney(s.total - s.paid, cur)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'bilan' && (
        <div className="split">
          <Card>
            <CardHead title="Actif" sub="Ce que possède le parking" />
            <table className="tbl">
              <tbody>
                <tr><td className="mut">Stock de véhicules (valeur d’achat)</td><td className="t-right num">{fmtMoney(stats.stockValue, cur)}</td></tr>
                <tr><td className="mut">Créances clients</td><td className="t-right num">{fmtMoney(stats.receivable, cur)}</td></tr>
                <tr><td className="mut">Trésorerie nette cumulée</td><td className="t-right num">{fmtMoney(Math.max(0, margin), cur)}</td></tr>
                <tr><td className="strong">Total actif</td><td className="t-right num strong" style={{ color: 'var(--acc)' }}>{fmtMoney(stats.stockValue + stats.receivable + Math.max(0, margin), cur)}</td></tr>
              </tbody>
            </table>
          </Card>
          <Card>
            <CardHead title="Passif & résultat" sub="Origine des ressources" />
            <table className="tbl">
              <tbody>
                <tr><td className="mut">Produits encaissés (HT)</td><td className="t-right num">{fmtMoney(stats.collected - stats.vatCollected, cur)}</td></tr>
                <tr><td className="mut">Charges d’exploitation</td><td className="t-right num">- {fmtMoney(stats.expensesTotal, cur)}</td></tr>
                <tr><td className="mut">TVA à reverser</td><td className="t-right num">{fmtMoney(stats.vatCollected, cur)}</td></tr>
                <tr><td className="strong">Résultat de l’exercice</td><td className="t-right num strong" style={{ color: margin >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtMoney(margin, cur)}</td></tr>
              </tbody>
            </table>
            <p className="tiny mut" style={{ marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              Bilan simplifié calculé à partir des opérations enregistrées. Il ne remplace pas une liasse fiscale.
            </p>
          </Card>
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Enregistrer une charge" icon={Calculator}
        footer={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>Annuler</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? '…' : 'Enregistrer'}</button></>}>
        <Field label="Libellé *"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Loyer du showroom" /></Field>
        <div className="grid2">
          <Field label="Catégorie">
            <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {CATS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Montant *"><Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        </div>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </Modal>

      <Confirm open={!!toDelete} danger title="Supprimer la charge"
        text={`Supprimer « ${toDelete?.label} » (${fmtMoney(toDelete?.amount || 0, cur)}) du journal des charges ?`}
        confirmLabel="Supprimer"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => { await deleteExpense(toDelete.id); setToDelete(null); toast.ok('Charge supprimée.') }} />
    </div>
  )
}
