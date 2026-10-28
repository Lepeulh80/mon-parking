import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Car, Plus, Search, Pencil, Trash2, Fuel, Gauge, Calendar, X, ImagePlus,
  ShoppingCart, Package, History, Check,
} from 'lucide-react'
import { db } from '../lib/db'
import { useRemoteRows } from '../lib/apiData'
import { saveVehicle, deleteVehicle } from '../lib/admin'
import { useApp } from '../App'
import { PlateInput } from '../components/PlateScanner'
import { Card, CardHead, Badge, StatusBadge, Modal, Confirm, Empty, Seg, Field, Input, Select, useToast, IconBtn } from '../components/UI'
import { PhotoStudio } from '../components/VehicleMedia'
import { useResolvedThumb } from '../lib/photoCrypto'
import { fmtMoney, fmtDate, fmtNum } from '../lib/format'
import { navigate } from '../lib/router'

const CATEGORIES = ['Berline', 'SUV', 'Citadine', 'Compacte', 'Pick-up', 'Utilitaire', 'Coupé', 'Monospace']
const FUELS = ['Essence', 'Diesel', 'Hybride', 'Électrique', 'GPL']
const GEARBOXES = ['Manuelle', 'Automatique']
const CONDITIONS = ['neuf', 'très bon état', 'bon état', 'occasion', 'à réparer']

export function CarArt({ vehicle, h = 148 }) {
  const color = vehicle?.color || '#2b3648'
  return (
    <svg viewBox="0 0 300 150" width="100%" height={h} preserveAspectRatio="xMidYMid slice" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`bg-${vehicle?.id || 'x'}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1a2331" />
          <stop offset="100%" stopColor="#0b1017" />
        </linearGradient>
        <linearGradient id={`car-${vehicle?.id || 'x'}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor="#0c1119" stopOpacity="1" />
        </linearGradient>
      </defs>
      <rect width="300" height="150" fill={`url(#bg-${vehicle?.id || 'x'})`} />
      <g opacity="0.35" stroke="#2a3646" strokeWidth="0.6">
        {[0, 1, 2, 3, 4, 5].map((i) => <line key={`v${i}`} x1={i * 60} y1="0" x2={i * 60} y2="150" />)}
        {[0, 1, 2].map((i) => <line key={`h${i}`} x1="0" y1={i * 50} x2="300" y2={i * 50} />)}
      </g>
      <ellipse cx="150" cy="122" rx="96" ry="9" fill="#000" opacity="0.45" />
      <path d="M52 106 q4 -20 26 -24 l26 -4 q16 -18 36 -18 h44 q22 0 34 18 l22 6 q16 4 16 20 v8 q0 6 -7 6 h-190 q-7 0 -7 -6 z"
        fill={`url(#car-${vehicle?.id || 'x'})`} stroke="#4c5a70" strokeWidth="1.2" />
      <path d="M108 82 q10 -14 26 -14 h44 q14 0 24 14 z" fill="#0d1622" stroke="#4c5a70" strokeWidth="1" />
      <line x1="146" y1="68" x2="146" y2="82" stroke="#4c5a70" strokeWidth="1" />
      <rect x="218" y="98" width="18" height="5" rx="2.5" fill="#c6f24e" opacity="0.95" />
      <rect x="56" y="99" width="14" height="4" rx="2" fill="#ff5c7a" opacity="0.9" />
      {[104, 202].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="110" r="15" fill="#0a0e14" stroke="#39445a" strokeWidth="2" />
          <circle cx={cx} cy="110" r="6.5" fill="none" stroke="#7c8798" strokeWidth="2" />
        </g>
      ))}
      <text x="14" y="24" fontFamily="Space Grotesk, sans-serif" fontSize="11" fill="#8b97ad" letterSpacing="2">
        {(vehicle?.brand || 'MON PARKING').toUpperCase()}
      </text>
    </svg>
  )
}

// Vignette de carte : déchiffrée à la demande. `useResolvedThumb` renvoie la
// tuile « coffre verrouillé » quand la clé n'est pas en mémoire, jamais l'image.
function VehicleHero({ lotId, vehicle }) {
  const src = useResolvedThumb(lotId, vehicle.photo)
  return src
    ? <img src={src} alt="" style={{ width: '100%', maxHeight: 240, objectFit: 'cover' }} />
    : <CarArt vehicle={vehicle} h={200} />
}

function StockThumb({ lotId, vehicle }) {
  const src = useResolvedThumb(lotId, vehicle.photo)
  if (!src) return <CarArt vehicle={vehicle} />
  return <img src={src} alt={`${vehicle.brand} ${vehicle.model}`} />
}

function VehicleForm({ open, onClose, lotId, initial }) {
  const toast = useToast()
  const [f, setF] = useState(() => ({
    brand: '', model: '', year: new Date().getFullYear(), plate: '', vin: '', category: 'Berline',
    fuel: 'Essence', gearbox: 'Manuelle', mileage: 0, color: '#2b3648', condition: 'bon état',
    purchasePrice: 0, price: 0, rentPriceDaily: 0, supplier: '', acquisitionDate: new Date().toISOString().slice(0, 10),
    description: '', photo: null, ...initial,
  }))
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }))

  if (!open) return null

  const pickPhoto = (file) => {
    if (!file) return
    if (file.size > 2_500_000) { toast.err('Image trop lourde (2,5 Mo max).'); return }
    const reader = new FileReader()
    reader.onload = () => set('photo', reader.result)
    reader.readAsDataURL(file)
  }

  const submit = async () => {
    if (!f.brand.trim() || !f.model.trim() || !f.plate.trim()) { toast.err('Marque, modèle et immatriculation sont requis.'); return }
    if (Number(f.price) <= 0) { toast.err('Le prix de vente doit être supérieur à 0.'); return }
    setBusy(true)
    try {
      await saveVehicle(lotId, {
        ...f, brand: f.brand.trim(), model: f.model.trim(), plate: f.plate.trim().toUpperCase(),
      }, initial?.id)
      toast.ok(initial?.id ? 'Véhicule mis à jour.' : 'Véhicule ajouté au stock.')
      onClose()
    } catch (e) { toast.err(e.message || 'Enregistrement impossible.') }
    setBusy(false)
  }

  return (
    <Modal open onClose={onClose} wide title={initial?.id ? 'Modifier le véhicule' : 'Ajouter un véhicule'} icon={Car}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Enregistrement…' : <><Check style={{ width: 15, height: 15 }} /> Enregistrer</>}</button>
      </>}>
      <div className="grid3">
        <Field label="Marque *"><Input value={f.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Toyota" /></Field>
        <Field label="Modèle *"><Input value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="Corolla" /></Field>
        <Field label="Année"><Input type="number" value={f.year} onChange={(e) => set('year', e.target.value)} /></Field>
      </div>
      <div className="grid3">
        <Field label="Immatriculation *" hint="Scan caméra"><PlateInput value={f.plate} onChange={(v) => set('plate', v)} placeholder="AB 1234 CI" testId="vehicle-plate" /></Field>
        <Field label="N° VIN / Châssis"><Input value={f.vin} onChange={(e) => set('vin', e.target.value)} placeholder="VF1..." /></Field>
        <Field label="Kilométrage"><Input type="number" value={f.mileage} onChange={(e) => set('mileage', e.target.value)} /></Field>
      </div>
      <div className="grid3">
        <Field label="Catégorie"><Select value={f.category} onChange={(e) => set('category', e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Carburant"><Select value={f.fuel} onChange={(e) => set('fuel', e.target.value)}>{FUELS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Boîte"><Select value={f.gearbox} onChange={(e) => set('gearbox', e.target.value)}>{GEARBOXES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
      </div>
      <div className="grid3">
        <Field label="Prix d’achat"><Input type="number" value={f.purchasePrice} onChange={(e) => set('purchasePrice', e.target.value)} /></Field>
        <Field label="Prix de vente *"><Input type="number" value={f.price} onChange={(e) => set('price', e.target.value)} /></Field>
        <Field label="Location / jour"><Input type="number" value={f.rentPriceDaily} onChange={(e) => set('rentPriceDaily', e.target.value)} /></Field>
      </div>
      <div className="grid3">
        <Field label="État"><Select value={f.condition} onChange={(e) => set('condition', e.target.value)}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Fournisseur"><Input value={f.supplier} onChange={(e) => set('supplier', e.target.value)} placeholder="Import Auto" /></Field>
        <Field label="Date d’acquisition"><Input type="date" value={f.acquisitionDate} onChange={(e) => set('acquisitionDate', e.target.value)} /></Field>
      </div>
      <div className="grid2">
        <Field label="Couleur"><Input type="color" value={f.color} onChange={(e) => set('color', e.target.value)} style={{ padding: 4, height: 40 }} /></Field>
        <Field label="Photo du véhicule" hint="JPG/PNG · 2,5 Mo max">
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><ImagePlus style={{ width: 14, height: 14 }} /> Choisir</button>
            {f.photo && <img src={f.photo} alt="" className="logo-prev" style={{ width: 40, height: 40 }} />}
            {f.photo && <IconBtn onClick={() => set('photo', null)} title="Retirer"><X /></IconBtn>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
        </Field>
      </div>
      <Field label="Description commerciale">
        <textarea className="input" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Options, équipements, historique d'entretien…" />
      </Field>
    </Modal>
  )
}

export function VehicleDetail({ vehicle, onClose, isAdmin, onEdit }) {
  const { lot } = useApp()
  const [tab, setTab] = useState('fiche')
  const sales = useLiveQuery(
    () => (vehicle ? db.sales.where('vehicleId').equals(vehicle.id).toArray() : []),
    [vehicle?.id], []
  )
  const moves = useLiveQuery(
    () => (vehicle ? db.stockMoves.where('vehicleId').equals(vehicle.id).reverse().sortBy('date') : []),
    [vehicle?.id], []
  )
  if (!vehicle) return null
  const spec = [
    ['Année', vehicle.year], ['Kilométrage', `${fmtNum(vehicle.mileage)} km`],
    ['Carburant', vehicle.fuel], ['Boîte', vehicle.gearbox],
    ['Catégorie', vehicle.category], ['État', vehicle.condition],
    ['Couleur', vehicle.color], ['VIN', vehicle.vin || '—'],
    ['Fournisseur', vehicle.supplier || '—'], ['Acquisition', fmtDate(vehicle.acquisitionDate)],
  ]
  return (
    <Modal open onClose={onClose} wide title={`${vehicle.brand} ${vehicle.model}`} icon={Car}
      footer={isAdmin ? <>
        <button className="btn btn-ghost" onClick={() => onEdit(vehicle)}><Pencil style={{ width: 14, height: 14 }} /> Modifier</button>
        {vehicle.status === 'stock' && (
          <button className="btn btn-primary" onClick={() => navigate('/ventes/nouvelle')}><ShoppingCart style={{ width: 14, height: 14 }} /> Vendre / louer</button>
        )}
      </> : null}>
      <Seg value={tab} onChange={setTab} options={[
        { value: 'fiche', label: 'Fiche technique' },
        { value: 'media', label: `Photos & 360°${vehicle.photoCount ? ` (${vehicle.photoCount})` : ''}` },
      ]} />
      {tab === 'fiche' ? <>
      <div style={{ borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
        <VehicleHero lotId={vehicle.lotId} vehicle={vehicle} />
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <StatusBadge status={vehicle.status} />
        <Badge tone="info">{vehicle.plate}</Badge>
        <span className="spacer" />
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 20, color: 'var(--acc)' }}>{fmtMoney(vehicle.price, lot.currency)}</div>
          <div className="tiny mut">Location {fmtMoney(vehicle.rentPriceDaily, lot.currency)} / jour</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginBottom: 16 }}>
        {spec.map(([k, v]) => (
          <div key={k} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 11px' }}>
            <div className="tiny mut">{k}</div>
            <div style={{ fontSize: 12.5, marginTop: 2, textTransform: k === 'Couleur' ? 'none' : undefined }}>{k === 'Couleur' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: v, display: 'inline-block' }} /> {v}</span> : v}</div>
          </div>
        ))}
      </div>
      {vehicle.description && <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.65, marginTop: 0 }}>{vehicle.description}</p>}
      </> : (
        <div style={{ marginTop: 12 }}>
          <PhotoStudio vehicle={vehicle} lotId={vehicle.lotId} canEdit={isAdmin} />
        </div>
      )}
      {tab === 'fiche' && <CardHead title="Historique" icon={History} />}
      {tab === 'fiche' && sales.length === 0 && moves.length === 0 && <Empty icon={History} title="Aucun historique" text="Ce véhicule n'a pas encore été vendu ou loué." />}
      {tab === 'fiche' && sales.map((s) => (
        <div className="list-row" key={s.id}>
          <div className="ico"><ShoppingCart /></div>
          <div className="txt"><b>{s.invoiceNumber} · {s.clientSnapshot?.name}</b><span>{fmtDate(s.date)} · {s.type === 'vente' ? 'Vente' : 'Location'}</span></div>
          <div className="amt">{fmtMoney(s.total, lot.currency)}</div>
          <StatusBadge status={s.status} />
        </div>
      ))}
      {tab === 'fiche' && moves.map((m) => (
        <div className="list-row" key={m.id}>
          <div className="ico"><Package /></div>
          <div className="txt"><b>{m.type}</b><span>{fmtDate(m.date)} · {m.userName}</span></div>
          <span className="tiny mut">{m.note}</span>
        </div>
      ))}
    </Modal>
  )
}

export default function Stock() {
  const { lot, isAdmin } = useApp()
  const cur = lot.currency
  const vehiclesLocal = useLiveQuery(() => db.vehicles.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const vehicles = useRemoteRows('vehicles', lot.id, vehiclesLocal)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('stock')
  const [editing, setEditing] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [toDelete, setToDelete] = useState(null)
  const toast = useToast()

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return vehicles
      .filter((v) => (filter === 'tous' ? true : v.status === filter))
      .filter((v) => !term || `${v.brand} ${v.model} ${v.plate} ${v.vin} ${v.category}`.toLowerCase().includes(term))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }, [vehicles, q, filter])

  const counts = useMemo(() => ({
    stock: vehicles.filter((v) => v.status === 'stock').length,
    vendu: vehicles.filter((v) => v.status === 'vendu').length,
    loue: vehicles.filter((v) => v.status === 'loue').length,
    tous: vehicles.length,
  }), [vehicles])

  const stockValue = vehicles.filter((v) => v.status === 'stock').reduce((a, v) => a + Number(v.purchasePrice || 0), 0)

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Parc automobile</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
            {counts.stock} disponible(s) · valeur d’achat {fmtMoney(stockValue, cur)}
          </p>
        </div>
        <span className="spacer" />
        {isAdmin && <button className="btn btn-primary" onClick={() => { setEditing(null); setFormOpen(true) }}><Plus /> Ajouter un véhicule</button>}
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="search-box">
            <Search />
            <input className="input" placeholder="Rechercher marque, modèle, plaque, VIN…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Seg value={filter} onChange={setFilter} options={[
            { value: 'stock', label: `En stock (${counts.stock})` },
            { value: 'loue', label: `En location (${counts.loue})` },
            { value: 'vendu', label: `Vendus (${counts.vendu})` },
            { value: 'tous', label: `Tous (${counts.tous})` },
          ]} />
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card><Empty icon={Car} title="Aucun véhicule" text={q ? 'Aucun résultat pour cette recherche.' : 'Ajoutez votre premier véhicule pour démarrer le stock.'}
          action={isAdmin ? <button className="btn btn-primary" onClick={() => setFormOpen(true)}><Plus /> Ajouter un véhicule</button> : null} /></Card>
      ) : (
        <div className="v-grid">
          {filtered.map((v) => (
            <div className="v-card" key={v.id} onClick={() => setDetail(v)}>
              <div className="v-thumb">
                <StockThumb lotId={v.lotId || lot?.id} vehicle={v} />
                <div className="v-status"><StatusBadge status={v.status} /></div>
                <div className="v-plate">{v.plate}</div>
                {(v.photoCount > 0 || v.frameCount > 0) && (
                  <div className="v-media-count" title={`${v.photoCount || 0} photo(s) · ${v.frameCount || 0} prises 360°`}>
                    <ImagePlus style={{ width: 10, height: 10 }} />{v.photoCount || 0}
                    {v.frameCount > 0 && <> · <Car style={{ width: 10, height: 10 }} />{v.frameCount}</>}
                  </div>
                )}
              </div>
              <div className="v-body">
                <h4>{v.brand} {v.model}</h4>
                <div className="v-meta">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Calendar style={{ width: 10, height: 10 }} />{v.year}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Gauge style={{ width: 10, height: 10 }} />{fmtNum(v.mileage)} km</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Fuel style={{ width: 10, height: 10 }} />{v.fuel}</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="v-price">{fmtMoney(v.price, cur)}</span>
                  {isAdmin && (
                    <div className="v-actions" onClick={(e) => e.stopPropagation()}>
                      <IconBtn title="Modifier" onClick={() => { setEditing(v); setFormOpen(true) }}><Pencil /></IconBtn>
                      <IconBtn title="Supprimer" onClick={() => setToDelete(v)}><Trash2 /></IconBtn>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <VehicleForm open={formOpen} onClose={() => setFormOpen(false)} lotId={lot.id} initial={editing} />
      <VehicleDetail vehicle={detail} onClose={() => setDetail(null)} isAdmin={isAdmin}
        onEdit={(v) => { setDetail(null); setEditing(v); setFormOpen(true) }} />
      <Confirm open={!!toDelete} danger title="Supprimer le véhicule"
        text={`Supprimer définitivement ${toDelete?.brand} ${toDelete?.model} (${toDelete?.plate}) ? Les ventes déjà enregistrées restent dans l'historique.`}
        confirmLabel="Supprimer"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          await deleteVehicle(toDelete.id)
          setToDelete(null)
          toast.ok('Véhicule supprimé.')
        }} />
    </div>
  )
}
