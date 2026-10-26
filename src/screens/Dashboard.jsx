import { useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Wallet, TrendingUp, Car, AlertTriangle, ArrowUpRight, ArrowDownRight, Plus,
  ShoppingCart, KeyRound, Package, Users, ReceiptText, ArrowRight,
} from 'lucide-react'
import gsap from 'gsap'
import { db } from '../lib/db'
import { useApp } from '../App'
import { Card, CardHead, Badge, StatusBadge, Empty } from '../components/UI'
import { AreaChart, Donut, Counter } from '../components/Charts'
import { computeStats, growth } from '../lib/analytics'
import { fmtMoney, fmtDate, initials, fmtNum } from '../lib/format'
import { navigate } from '../lib/router'

const PersonalDashboard = lazy(()=>import('../components/PersonalDashboard'))
export default function Dashboard() {
  const { lot, user, isAdmin } = useApp()
  const cur = lot.currency
  const sales = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const vehicles = useLiveQuery(() => db.vehicles.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const expenses = useLiveQuery(() => db.expenses.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  
  const moves = useLiveQuery(() => db.stockMoves.where('lotId').equals(lot.id).reverse().sortBy('date'), [lot.id], [])
  const gridRef = useRef(null)

  const stats = useMemo(() => computeStats({ sales, vehicles, expenses, lot }), [sales, vehicles, expenses, lot])

  useEffect(() => {
    if (!gridRef.current || document.documentElement.dataset.motion==='reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const cards = gridRef.current.querySelectorAll('.kpi-card')
    const tw = gsap.fromTo(cards, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, stagger: 0.06, ease: 'power3.out' })
    return () => tw.kill()
  }, [])

  const recent = useMemo(() => [...sales].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6), [sales])
  const lowStock = useMemo(() => vehicles.filter((v) => v.status === 'stock').slice(0, 4), [vehicles])
  const g = growth(stats.monthRevenue, stats.prevRevenue)

  const kpis = [
    { label: 'Chiffre d’affaires', value: stats.salesTotal, icon: Wallet, cls: '', foot: `${stats.totalSales} transactions`, money: true },
    { label: 'Encaissé', value: stats.collected, icon: TrendingUp, cls: 'accent2', foot: `${stats.receivable > 0 ? `${fmtMoney(stats.receivable, cur)} à recouvrer` : 'Tout est réglé'}`, money: true },
    { label: 'Véhicules en stock', value: stats.stockCount, icon: Car, cls: 'warn', foot: `Valeur ${fmtMoney(stats.stockValue, cur)}`, money: false },
    { label: isAdmin ? 'Solde de trésorerie' : 'Créances clients', value: isAdmin ? stats.netResult : stats.receivable, icon: isAdmin ? (stats.netResult >= 0 ? ArrowUpRight : ArrowDownRight) : AlertTriangle, cls: (isAdmin ? stats.netResult : stats.receivable) >= 0 ? '' : 'danger', foot: isAdmin ? 'Encaissé − charges' : `${stats.unpaidCount} facture(s) ouverte(s)`, money: true },
  ]

  return (
    <div className="stack">
      <Suspense fallback={<p role="status">Chargement des widgets…</p>}><PersonalDashboard lot={lot} user={user}/></Suspense>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 className="page-h" style={{ fontSize: 26 }}>Bonjour {user.name.split(' ')[0]} 👋</h1>
          <p className="mut" style={{ margin: '5px 0 0', fontSize: 13 }}>
            {stats.monthCount} vente(s) ce mois · {fmtMoney(stats.monthRevenue, cur)}
            {g !== 0 && <span className={g >= 0 ? 'trend-up' : 'trend-down'} style={{ marginLeft: 8, fontSize: 12 }}>
              {g >= 0 ? '▲' : '▼'} {Math.abs(g).toFixed(0)} % vs mois dernier
            </span>}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/ventes/nouvelle')}>
          <Plus /> Nouvelle vente
        </button>
      </div>

      <div className="kpi" ref={gridRef}>
        {kpis.map((k) => (
          <div className={`kpi-card ${k.cls}`} key={k.label}>
            <div className="kpi-top"><k.icon /> {k.label}</div>
            <div className="kpi-val">
              {k.money
                ? <Counter value={k.value} format={(v) => fmtMoney(v, cur)} />
                : <Counter value={k.value} />}
            </div>
            <div className="kpi-foot">{k.foot}</div>
          </div>
        ))}
      </div>

      <div className="split">
        <Card>
          <CardHead title="Chiffre d’affaires" sub="6 derniers mois, toutes taxes comprises"
            right={<Badge tone="acc">{fmtMoney(stats.monthRevenue, cur)} ce mois</Badge>} />
          <AreaChart data={stats.series} height={195} format={(v) => fmtMoney(v, cur)} />
        </Card>

        <Card>
          <CardHead title="Raccourcis" icon={Plus} />
          <div style={{ display: 'grid', gap: 9 }}>
            {[
              { icon: ShoppingCart, label: 'Vendre un véhicule', to: '/ventes/nouvelle' },
              { icon: KeyRound, label: 'Louer un véhicule', to: '/locations' },
              { icon: Package, label: 'Ajouter au stock', to: '/stock' },
              { icon: ReceiptText, label: 'Factures & reçus', to: '/facturation' },
              { icon: Users, label: 'Nouveau client', to: '/clients' },
            ].map((a) => (
              <button key={a.label} className="list-row" style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', background: 'rgba(255,255,255,0.03)', cursor: 'pointer', width: '100%', textAlign: 'left' }}
                onClick={() => navigate(a.to)}>
                <div className="ico"><a.icon /></div>
                <div className="txt"><b>{a.label}</b></div>
                <ArrowRight style={{ width: 15, height: 15, color: 'var(--muted)' }} />
              </button>
            ))}
          </div>
        </Card>
      </div>

      <div className="split">
        <Card>
          <CardHead title="Dernières transactions" right={
            <button className="btn btn-sm btn-ghost" onClick={() => navigate('/ventes')}>Tout voir</button>
          } />
          {recent.length === 0 ? (
            <Empty icon={ReceiptText} title="Aucune vente" text="Créez votre première facture pour voir apparaître les transactions." />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Pièce</th><th>Client</th><th>Véhicule</th><th>Type</th><th className="t-right">Total</th><th>Statut</th></tr>
                </thead>
                <tbody>
                  {recent.map((s) => (
                    <tr key={s.id} onClick={() => navigate('/facturation')} style={{ cursor: 'pointer' }}>
                      <td className="mono">{s.invoiceNumber}</td>
                      <td>{s.clientSnapshot?.name || 'Comptant'}</td>
                      <td className="mut">{s.vehicleSnapshot?.brand} {s.vehicleSnapshot?.model}</td>
                      <td><Badge tone={s.type === 'location' ? 'warn' : 'info'}>{s.type === 'location' ? 'Location' : 'Vente'}</Badge></td>
                      <td className="t-right num strong">{fmtMoney(s.total, cur)}</td>
                      <td><StatusBadge status={s.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHead title="Répartition des paiements" sub="Modes d’encaissement" />
          {stats.methods.length ? (
            <Donut
              data={stats.methods.slice(0, 5).map((m, i) => ({ ...m, color: ['#c6f24e', '#4cc9f0', '#a78bfa', '#ffb347', '#2ee6a8'][i % 5] }))}
              centerLabel="encaissé"
              centerValue={fmtMoney(stats.collected, cur).replace(/,00$/, '')}
            />
          ) : <Empty icon={Wallet} title="Pas encore d’encaissement" />}
        </Card>
      </div>

      <div className="split">
        <Card>
          <CardHead title="Performance équipe" sub="Classement par chiffre d’affaires" right={
            isAdmin ? <button className="btn btn-sm btn-ghost" onClick={() => navigate('/statistiques')}>Détails</button> : null
          } />
          <div>
            {stats.employees.slice(0, 5).map((e, i) => (
              <div className="list-row" key={e.id}>
                <div className="ico" style={{ background: i === 0 ? 'var(--acc-soft)' : undefined, color: i === 0 ? 'var(--acc)' : undefined }}>
                  <span style={{ fontWeight: 700, fontSize: 12 }}>{initials(e.name)}</span>
                </div>
                <div className="txt">
                  <b>{e.name}</b>
                  <span>{e.count} vente(s) · {fmtMoney(e.collected, cur)} encaissés</span>
                </div>
                <div className="amt">
                  <span style={{ color: 'var(--acc)' }}>{fmtMoney(e.revenue, cur)}</span>
                </div>
              </div>
            ))}
            {!stats.employees.length && <Empty icon={Users} title="Aucune vente enregistrée" />}
          </div>
        </Card>

        <Card>
          <CardHead title="Disponibles à la vente" right={<Badge tone="ok">{stats.stockCount} en stock</Badge>} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {lowStock.map((v) => (
              <div className="list-row" key={v.id} onClick={() => navigate('/stock')} style={{ cursor: 'pointer' }}>
                <div className="ico"><Car /></div>
                <div className="txt">
                  <b>{v.brand} {v.model}</b>
                  <span>{v.plate} · {v.year} · {fmtNum(v.mileage)} km</span>
                </div>
                <div className="amt">{fmtMoney(v.price, cur)}</div>
              </div>
            ))}
            {!lowStock.length && <Empty icon={Car} title="Stock vide" text="Ajoutez des véhicules pour démarrer." />}
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="Derniers mouvements de stock" sub="Traçabilité automatique des entrées, ventes et locations" />
        {moves.length === 0 ? <Empty icon={Package} title="Aucun mouvement" /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Véhicule</th><th>Mouvement</th><th>Opérateur</th><th>Note</th></tr></thead>
              <tbody>
                {moves.slice(0, 7).map((m) => (
                  <tr key={m.id}>
                    <td className="mut">{fmtDate(m.date)}</td>
                    <td className="strong">{m.plate}</td>
                    <td><Badge tone={m.type === 'entrée' ? 'info' : m.type === 'vente' ? 'acc' : m.type === 'retour' ? 'ok' : 'warn'}>{m.type}</Badge></td>
                    <td className="mut">{m.userName}</td>
                    <td className="mut tiny">{m.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
