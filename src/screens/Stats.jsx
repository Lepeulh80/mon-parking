import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { TrendingUp, Trophy, Car, Users, Percent, Download, BarChart3, Medal, Wallet } from 'lucide-react'
import { db } from '../lib/db'
import { useApp } from '../App'
import { Card, CardHead, Empty, Seg, useToast } from '../components/UI'
import { AreaChart, Bars, Donut, Counter } from '../components/Charts'
import { computeStats } from '../lib/analytics'
import { fmtMoney, fmtNum, toCSV, downloadBlob } from '../lib/format'

export default function Stats() {
  const { lot } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const sales = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const vehicles = useLiveQuery(() => db.vehicles.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const expenses = useLiveQuery(() => db.expenses.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const [range, setRange] = useState('6')

  const stats = useMemo(() => computeStats({ sales, vehicles, expenses, lot, months: Number(range) }), [sales, vehicles, expenses, lot, range])

  const brandSplit = useMemo(() => {
    const m = new Map()
    for (const s of sales) {
      const b = s.vehicleSnapshot?.brand || 'Autre'
      m.set(b, (m.get(b) || 0) + Number(s.total || 0))
    }
    const colors = ['#c6f24e', '#4cc9f0', '#a78bfa', '#ffb347', '#2ee6a8', '#ff5c7a', '#f472b6', '#94a3b8']
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value], i) => ({ label, value, color: colors[i % colors.length] }))
  }, [sales])

  const catSplit = useMemo(() => {
    const m = new Map()
    for (const s of sales) {
      const c = s.vehicleSnapshot?.category || 'Autre'
      m.set(c, (m.get(c) || 0) + 1)
    }
    const colors = ['#c6f24e', '#4cc9f0', '#a78bfa', '#ffb347', '#2ee6a8']
    return [...m.values()].length ? [...m.entries()].map(([label, value], i) => ({ label, value, color: colors[i % colors.length] })) : []
  }, [sales])

  const best = stats.employees[0]

  const exportStats = () => {
    const csv = toCSV(stats.employees, [
      { label: 'Vendeur', key: 'name' },
      { label: 'Nombre de ventes', key: 'count' },
      { label: 'Chiffre d’affaires', key: 'revenue' },
      { label: 'Encaissé', key: 'collected' },
      { label: 'Panier moyen', value: (e) => Math.round(e.revenue / Math.max(1, e.count)) },
    ])
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `performance-equipe-${range}mois.csv`)
    toast.ok('Statistiques exportées.')
  }

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Statistiques</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>Performance commerciale, produits et équipe</p>
        </div>
        <span className="spacer" />
        <Seg value={range} onChange={setRange} options={[{ value: '3', label: '3 mois' }, { value: '6', label: '6 mois' }, { value: '12', label: '12 mois' }]} />
        <button className="btn btn-ghost btn-sm" onClick={exportStats}><Download style={{ width: 14, height: 14 }} /> CSV</button>
      </div>

      <div className="kpi">
        <div className="kpi-card"><div className="kpi-top"><Wallet /> CA total</div><div className="kpi-val" style={{ fontSize: 20 }}><Counter value={stats.salesTotal} format={(v) => fmtMoney(v, cur)} /></div><div className="kpi-foot">{stats.totalSales} opérations</div></div>
        <div className="kpi-card accent2"><div className="kpi-top"><Percent /> Panier moyen</div><div className="kpi-val" style={{ fontSize: 20 }}>{fmtMoney(stats.avgTicket, cur)}</div><div className="kpi-foot">Par facture</div></div>
        <div className="kpi-card warn"><div className="kpi-top"><Car /> Rotation stock</div><div className="kpi-val">{stats.soldCount + stats.rentedCount}</div><div className="kpi-foot">{stats.stockCount} encore en stock</div></div>
        <div className="kpi-card danger"><div className="kpi-top"><Users /> Meilleur vendeur</div><div className="kpi-val" style={{ fontSize: 15 }}>{best ? best.name : '—'}</div><div className="kpi-foot">{best ? fmtMoney(best.revenue, cur) : 'Aucune vente'}</div></div>
      </div>

      <Card>
        <CardHead title="Évolution du chiffre d’affaires" sub={`${range} derniers mois`} icon={TrendingUp} />
        <AreaChart data={stats.series} height={230} format={(v) => fmtMoney(v, cur)} />
      </Card>

      <div className="split">
        <Card>
          <CardHead title="Classement de l’équipe" sub="Chiffre d’affaires généré" icon={Trophy} />
          {stats.employees.length === 0 ? <Empty icon={Users} title="Pas encore de ventes" /> : (
            <div>
              {stats.employees.map((e, i) => (
                <div className="list-row" key={e.id}>
                  <div style={{
                    width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', flex: '0 0 auto',
                    background: i === 0 ? 'linear-gradient(140deg,#c6f24e,#9be02a)' : 'rgba(255,255,255,0.07)',
                    color: i === 0 ? '#0a0f18' : 'var(--muted)', fontWeight: 700, fontSize: 11,
                  }}>{i === 0 ? <Medal style={{ width: 13, height: 13 }} /> : i + 1}</div>
                  <div className="txt">
                    <b>{e.name}</b>
                    <span>{e.count} vente(s) · panier {fmtMoney(e.revenue / Math.max(1, e.count), cur)}</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="amt" style={{ color: 'var(--acc)' }}>{fmtMoney(e.revenue, cur)}</div>
                    <div className="tiny mut">{Math.round((e.revenue / Math.max(1, stats.salesTotal)) * 100)} % du CA</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <CardHead title="Répartition par marque" sub="Part du chiffre d’affaires" icon={BarChart3} />
          {brandSplit.length ? <Donut data={brandSplit} centerLabel="marques" centerValue={String(brandSplit.length)} /> : <Empty icon={Car} title="Aucune donnée" />}
        </Card>
      </div>

      <div className="split">
        <Card>
          <CardHead title="Ventes vs achats" sub="Comparaison mensuelle" />
          <Bars data={stats.expSeries.map((s) => ({ label: s.label, a: s.a, b: s.b }))} height={200} currency={cur} />
          <div className="legend">
            <span><i style={{ background: '#c6f24e' }} />Chiffre d’affaires</span>
            <span><i style={{ background: '#4cc9f0' }} />Charges</span>
          </div>
        </Card>
        <Card>
          <CardHead title="Top modèles vendus" sub="Par revenu généré" />
          {stats.topVehicles.length === 0 ? <Empty icon={Car} title="Aucune vente" /> : (
            <div style={{ display: 'grid', gap: 11 }}>
              {stats.topVehicles.map((v, _i) => (
                <div key={v.name}>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                    <span>{v.name} <span className="mut tiny">×{v.count}</span></span>
                    <b className="num">{fmtMoney(v.revenue, cur)}</b>
                  </div>
                  <div className="progress"><i style={{ width: `${(v.revenue / Math.max(1, stats.topVehicles[0].revenue)) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="split">
        <Card>
          <CardHead title="Analyse par catégorie" sub="Nombre de véhicules vendus" />
          {catSplit.length ? <Donut data={catSplit} centerLabel="catégories" centerValue={String(catSplit.length)} /> : <Empty icon={Car} title="Aucune donnée" />}
        </Card>
        <Card>
          <CardHead title="Indicateurs clés" sub="Sur l’ensemble de l’historique" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              ['Ventes réalisées', fmtNum(stats.soldCount)],
              ['Locations actives', fmtNum(stats.rentalActive)],
              ['Factures impayées', fmtNum(stats.unpaidCount)],
              ['TVA collectée', fmtMoney(stats.vatCollected, cur)],
              ['Revenus location', fmtMoney(stats.rentalRevenue, cur)],
              ['Valeur du stock', fmtMoney(stats.stockValue, cur)],
            ].map(([k, v]) => (
              <div key={k} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 11, padding: '11px 12px' }}>
                <div className="tiny mut">{k}</div>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 14, marginTop: 3 }}>{v}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
