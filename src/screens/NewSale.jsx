import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Car, User, CreditCard, Check, ArrowLeft, ArrowRight, Search, Plus, FileText,
  AlertTriangle,
} from 'lucide-react'
import { db, createSale, nowIso } from '../lib/db'
import { saveClient } from '../lib/admin'
import { useApp } from '../App'
import { Card, CardHead, Badge, Empty, Field, Input, Select, useToast, Seg, Modal } from '../components/UI'
import { CarArt } from './Stock'
import { useResolvedThumb } from '../lib/photoCrypto'
import { fmtMoney, fmtDate, daysBetween, addDays } from '../lib/format'
import { buildInvoice, buildReceipt } from '../lib/pdf'
import { navigate } from '../lib/router'

const STEPS = ['Véhicule', 'Client', 'Conditions', 'Validation']

function SaleThumb({ lotId, value, h }) {
  const src = useResolvedThumb(lotId, value)
  if (!src) return <div style={{ height: h, background: 'rgba(255,255,255,0.04)' }} />
  return <img src={src} alt="" style={{ width: '100%', height: h, objectFit: 'cover' }} />
}

export default function NewSale() {
  const { lot, user } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const vehicles = useLiveQuery(() => db.vehicles.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const clients = useLiveQuery(() => db.clients.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const stock = useMemo(() => vehicles.filter((v) => v.status === 'stock'), [vehicles])

  const [step, setStep] = useState(0)
  const [q, setQ] = useState('')
  const [vehicleId, setVehicleId] = useState(null)
  const [clientId, setClientId] = useState(null)
  const [type, setType] = useState('vente')
  const [price, setPrice] = useState(0)
  const [discount, setDiscount] = useState(0)
  const [vatRate, setVatRate] = useState(lot.vatRate ?? 18)
  const [paid, setPaid] = useState(0)
  const [paidTouched, setPaidTouched] = useState(false)
  const [method, setMethod] = useState('espèces')
  const [notes, setNotes] = useState('')
  const [rentalStart, setRentalStart] = useState(new Date().toISOString().slice(0, 10))
  const [rentalEnd, setRentalEnd] = useState(addDays(new Date(), 7).toISOString().slice(0, 10))
  const [deposit, setDeposit] = useState(0)
  const [clientModal, setClientModal] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '', address: '', type: 'particulier', taxId: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  const vehicle = stock.find((v) => v.id === vehicleId) || null
  const client = clients.find((c) => c.id === clientId) || null
  const days = Math.max(1, daysBetween(rentalStart, rentalEnd))


  useEffect(() => {
    if (!vehicle) return
    if (type === 'vente') {
      setPrice(vehicle.price)
      setPaid(vehicle.price)
    } else {
      const total = (vehicle.rentPriceDaily || 0) * days
      setPrice(total)
      setPaid(total)
      setDeposit(vehicle.price * 0.15)
    }
  }, [vehicleId, type, days])

  const subtotal = Math.max(0, Number(price) - Number(discount))
  const vatAmount = Math.round(subtotal * (Number(vatRate) / 100))
  const total = subtotal + vatAmount
  const due = Math.max(0, total - Number(paid))

  useEffect(() => {
    if (!paidTouched) setPaid(total)
  }, [total, paidTouched])

  const filteredStock = stock.filter((v) =>
    !q.trim() || `${v.brand} ${v.model} ${v.plate} ${v.category}`.toLowerCase().includes(q.toLowerCase())
  )

  const createClientInline = async () => {
    if (!newClient.name.trim()) { toast.err('Le nom du client est requis.'); return }
    const id = await saveClient(lot.id, { ...newClient, name: newClient.name.trim() })
    setClientId(id)
    setClientModal(false)
    setNewClient({ name: '', phone: '', email: '', address: '', type: 'particulier', taxId: '' })
    toast.ok('Client créé.')
  }

  const finalize = async (printMode) => {
    if (!vehicle) return toast.err('Sélectionnez un véhicule.')
    if (total <= 0) return toast.err('Le montant total doit être supérieur à 0.')
    setBusy(true)
    try {
      const sale = await createSale({
        lotId: lot.id, type, vehicleId: vehicle.id,
        vehicleSnapshot: {
          brand: vehicle.brand, model: vehicle.model, year: vehicle.year, plate: vehicle.plate,
          vin: vehicle.vin, mileage: vehicle.mileage, category: vehicle.category,
          purchasePrice: vehicle.purchasePrice,
        },
        clientId: client?.id || null,
        clientSnapshot: client
          ? { name: client.name, phone: client.phone, email: client.email, address: client.address, taxId: client.taxId }
          : { name: 'Client comptant', phone: '', email: '', address: '', taxId: '' },
        userId: user.id, userName: user.name,
        date: nowIso(), price: Number(price), discount: Number(discount), vatRate: Number(vatRate),
        subtotal, vatAmount, total: Number(total), paid: Number(paid), paymentMethod: method,
        notes, rentalStart: type === 'location' ? new Date(rentalStart).toISOString() : null,
        rentalEnd: type === 'location' ? new Date(rentalEnd).toISOString() : null,
        rentalDays: type === 'location' ? days : 0,
        deposit: type === 'location' ? Number(deposit) : 0,
      })
      setDone(sale)
      toast.ok(`Transaction enregistrée · ${sale.invoiceNumber}`)
      if (printMode) {
        const doc = await buildInvoice(sale, lot)
        doc.save(`${sale.invoiceNumber}.pdf`)
      }
    } catch (e) {
      toast.err(e.message || 'Enregistrement impossible.')
    }
    setBusy(false)
  }

  const download = async (kind) => {
    if (!done) return
    const doc = kind === 'receipt' ? await buildReceipt(done, lot) : await buildInvoice(done, lot)
    doc.save(`${kind === 'receipt' ? done.receiptNumber : done.invoiceNumber}.pdf`)
  }

  if (done) {
    return (
      <div className="stack" style={{ maxWidth: 720, margin: '0 auto' }}>
        <Card style={{ textAlign: 'center', padding: 34 }}>
          <div style={{ width: 62, height: 62, borderRadius: '50%', background: 'var(--acc-soft)', border: '1px solid rgba(198,242,78,0.4)', display: 'grid', placeItems: 'center', margin: '0 auto 16px', color: 'var(--acc)' }}>
            <Check style={{ width: 30, height: 30 }} />
          </div>
          <h1 style={{ fontSize: 23 }}>Transaction enregistrée</h1>
          <p className="mut" style={{ fontSize: 13, marginTop: 6 }}>
            {done.invoiceNumber} · {done.receiptNumber}<br />
            Stock mis à jour automatiquement — véhicule désormais « {type === 'vente' ? 'vendu' : 'en location'} ».
          </p>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', margin: '20px 0', flexWrap: 'wrap' }}>
            <div><div className="tiny mut">Total TTC</div><div style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700, color: 'var(--acc)' }}>{fmtMoney(total, cur)}</div></div>
            <div><div className="tiny mut">Encaissé</div><div style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700 }}>{fmtMoney(paid, cur)}</div></div>
            {due > 0 && <div><div className="tiny mut">Reste dû</div><div style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700, color: 'var(--danger)' }}>{fmtMoney(due, cur)}</div></div>}
          </div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn btn-ghost" onClick={() => download('receipt')}><FileText style={{ width: 14, height: 14 }} /> Reçu PDF</button>
            <button className="btn btn-ghost" onClick={() => download('invoice')}><FileText style={{ width: 14, height: 14 }} /> Facture PDF</button>
            <button className="btn btn-primary" onClick={() => navigate('/ventes')}>Voir les ventes <ArrowRight style={{ width: 14, height: 14 }} /></button>
          </div>
        </Card>
        <Card>
          <CardHead title="Nouvelle opération" />
          <p className="mut" style={{ fontSize: 12.5, marginTop: 0 }}>Vous pouvez enchaîner immédiatement sur une autre vente ou location.</p>
          <button className="btn btn-ghost" onClick={() => {
            setDone(null); setStep(0); setVehicleId(null); setClientId(null); setPrice(0); setPaid(0); setDiscount(0); setNotes('')
          }}><Plus style={{ width: 14, height: 14 }} /> Créer une autre transaction</button>
        </Card>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="row">
        <button className="icon-btn" onClick={() => navigate('/ventes')}><ArrowLeft /></button>
        <div>
          <h1 style={{ fontSize: 22 }}>Nouvelle transaction</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>Facture et reçu générés automatiquement</p>
        </div>
        <span className="spacer" />
        <Seg value={type} onChange={(v) => { setType(v) }} options={[
          { value: 'vente', label: 'Vente' }, { value: 'location', label: 'Location' },
        ]} />
      </div>

      <div className="row" style={{ gap: 6 }}>
        {STEPS.map((s, i) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 11, flex: '0 0 auto',
              background: i <= step ? 'var(--acc)' : 'rgba(255,255,255,0.09)',
              color: i <= step ? '#0a0f18' : 'var(--muted)', fontWeight: 700,
            }}>{i < step ? '✓' : i + 1}</div>
            <span className="tiny" style={{ color: i === step ? 'var(--txt)' : 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s}</span>
            {i < STEPS.length - 1 && <div style={{ flex: 1, height: 1, background: 'var(--line)', minWidth: 8 }} />}
          </div>
        ))}
      </div>

      <div className="split" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="stack">
          {step === 0 && (
            <Card>
              <CardHead title="1. Choisir le véhicule" sub={`${stock.length} véhicule(s) disponible(s)`} icon={Car} />
              <div className="search-box" style={{ maxWidth: '100%', marginBottom: 12 }}>
                <Search /><input className="input" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {filteredStock.length === 0 ? <Empty icon={Car} title="Aucun véhicule disponible" text="Ajoutez un véhicule au stock pour vendre ou louer." /> : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {filteredStock.map((v) => (
                    <button key={v.id} data-testid="vehicle-option" onClick={() => { setVehicleId(v.id); setStep(1) }}
                      style={{
                        display: 'flex', gap: 11, alignItems: 'center', padding: 9, borderRadius: 12, cursor: 'pointer',
                        background: vehicleId === v.id ? 'var(--acc-soft)' : 'rgba(255,255,255,0.035)',
                        border: `1px solid ${vehicleId === v.id ? 'rgba(198,242,78,0.45)' : 'var(--line)'}`, textAlign: 'left', width: '100%',
                      }}>
                      <div style={{ width: 68, height: 46, borderRadius: 8, overflow: 'hidden', flex: '0 0 auto' }}>
                        {v.photo ? <SaleThumb lotId={v.lotId} value={v.photo} h={46} /> : <CarArt vehicle={v} h={46} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{v.brand} {v.model} {v.year}</div>
                        <div className="tiny mut">{v.plate} · {v.fuel} · {v.category}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, color: 'var(--acc)', fontSize: 13 }}>{fmtMoney(v.price, cur)}</div>
                        <div className="tiny mut">{fmtMoney(v.rentPriceDaily, cur)}/j</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}

          {step === 1 && (
            <Card>
              <CardHead title="2. Choisir le client" sub="Vente au comptant possible sans fiche client" icon={User}
                right={<button className="btn btn-sm btn-primary" onClick={() => setClientModal(true)}><Plus style={{ width: 13, height: 13 }} /> Nouveau</button>} />
              <button data-testid="cash-client" onClick={() => { setClientId(null); setStep(2) }}
                style={{ width: '100%', textAlign: 'left', padding: 11, borderRadius: 11, marginBottom: 8, cursor: 'pointer', background: clientId === null ? 'var(--acc-soft)' : 'rgba(255,255,255,0.03)', border: `1px solid ${clientId === null ? 'rgba(198,242,78,0.45)' : 'var(--line)'}` }}>
                <b style={{ fontSize: 13 }}>Client comptant</b>
                <div className="tiny mut">Aucune fiche — facture au porteur</div>
              </button>
              {clients.map((c) => (
                <button key={c.id} onClick={() => { setClientId(c.id); setStep(2) }}
                  style={{ width: '100%', textAlign: 'left', padding: 11, borderRadius: 11, marginBottom: 8, cursor: 'pointer', background: clientId === c.id ? 'var(--acc-soft)' : 'rgba(255,255,255,0.03)', border: `1px solid ${clientId === c.id ? 'rgba(198,242,78,0.45)' : 'var(--line)'}` }}>
                  <div className="row">
                    <b style={{ fontSize: 13 }}>{c.name}</b>
                    <Badge tone={c.type === 'entreprise' ? 'info' : 'default'}>{c.type}</Badge>
                  </div>
                  <div className="tiny mut">{c.phone} {c.email && `· ${c.email}`}</div>
                </button>
              ))}
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHead title="3. Conditions commerciales" icon={CreditCard} />
              <div className="grid2">
                <Field label={type === 'location' ? 'Montant de la location' : 'Prix de vente'}>
                  <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
                </Field>
                <Field label="Remise"><Input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
              </div>
              {type === 'location' && (
                <div className="grid3">
                  <Field label="Début"><Input type="date" value={rentalStart} onChange={(e) => setRentalStart(e.target.value)} /></Field>
                  <Field label="Fin"><Input type="date" value={rentalEnd} onChange={(e) => setRentalEnd(e.target.value)} /></Field>
                  <Field label={`Durée : ${days} j`} hint={`${fmtMoney(vehicle?.rentPriceDaily || 0, cur)} / jour`}>
                    <Input type="number" value={days} readOnly />
                  </Field>
                </div>
              )}
              <div className="grid3">
                <Field label="TVA (%)"><Input type="number" value={vatRate} onChange={(e) => setVatRate(e.target.value)} /></Field>
                <Field label="Montant encaissé"><Input type="number" value={paid} onChange={(e) => { setPaidTouched(true); setPaid(e.target.value) }} /></Field>
                <Field label="Mode de paiement">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {['espèces', 'mobile money', 'virement', 'chèque', 'carte bancaire', 'à crédit'].map((m) => <option key={m}>{m}</option>)}
                  </Select>
                </Field>
              </div>
              {type === 'location' && (
                <Field label="Caution / dépôt de garantie"><Input type="number" value={deposit} onChange={(e) => setDeposit(e.target.value)} /></Field>
              )}
              <Field label="Notes sur la facture">
                <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Conditions particulières, accessoires livrés…" />
              </Field>
              <div className="row">
                <button className="btn btn-ghost" onClick={() => setStep(1)}><ArrowLeft style={{ width: 14, height: 14 }} /> Retour</button>
                <span className="spacer" />
                <button className="btn btn-primary" onClick={() => setStep(3)}>Récapitulatif <ArrowRight style={{ width: 14, height: 14 }} /></button>
              </div>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <CardHead title="4. Valider la transaction" icon={Check} />
              <div style={{ display: 'grid', gap: 9, marginBottom: 14 }}>
                {[
                  ['Véhicule', vehicle ? `${vehicle.brand} ${vehicle.model} ${vehicle.year} · ${vehicle.plate}` : '—'],
                  ['Client', client ? client.name : 'Client comptant'],
                  ['Type', type === 'vente' ? 'Vente' : `Location ${days} jour(s)`],
                  ...(type === 'location' ? [['Période', `${fmtDate(rentalStart)} → ${fmtDate(rentalEnd)}`], ['Caution', fmtMoney(deposit, cur)]] : []),
                  ['Paiement', `${method} · ${fmtMoney(paid, cur)}`],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
                    <span className="mut" style={{ width: 84, flex: '0 0 auto' }}>{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
              {due > 0 && (
                <div style={{ background: 'rgba(255,179,71,0.1)', border: '1px solid rgba(255,179,71,0.3)', borderRadius: 10, padding: '9px 12px', fontSize: 12, color: 'var(--warn)', display: 'flex', gap: 8, marginBottom: 13 }}>
                  <AlertTriangle style={{ width: 15, height: 15, flex: '0 0 auto' }} />
                  Paiement partiel : {fmtMoney(due, cur)} resteront dus. La facture sera marquée « partielle ».
                </div>
              )}
              <div className="row">
                <button className="btn btn-ghost" onClick={() => setStep(2)}><ArrowLeft style={{ width: 14, height: 14 }} /> Retour</button>
                <span className="spacer" />
                <button className="btn btn-ghost" onClick={() => finalize(false)} disabled={busy}>Enregistrer</button>
                <button className="btn btn-primary" onClick={() => finalize(true)} disabled={busy}>
                  {busy ? 'Traitement…' : <><FileText style={{ width: 14, height: 14 }} /> Valider & facture PDF</>}
                </button>
              </div>
            </Card>
          )}
        </div>

        <Card style={{ position: 'sticky', top: 78, alignSelf: 'start' }}>
          <CardHead title="Récapitulatif" />
          {vehicle ? (
            <div style={{ borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
              {vehicle.photo ? <SaleThumb lotId={vehicle.lotId} value={vehicle.photo} h={110} /> : <CarArt vehicle={vehicle} h={110} />}
            </div>
          ) : <p className="tiny mut" style={{ marginTop: 0 }}>Aucun véhicule sélectionné.</p>}
          <div style={{ display: 'grid', gap: 7, fontSize: 12.5 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="mut">Prix</span><span className="num">{fmtMoney(price, cur)}</span></div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="mut">Remise</span><span className="num" style={{ color: 'var(--danger)' }}>- {fmtMoney(discount, cur)}</span></div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="mut">Sous-total HT</span><span className="num">{fmtMoney(subtotal, cur)}</span></div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="mut">TVA {vatRate}%</span><span className="num">{fmtMoney(vatAmount, cur)}</span></div>
            <div style={{ height: 1, background: 'var(--line)', margin: '3px 0' }} />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>Total TTC</b>
              <b style={{ fontFamily: 'Space Grotesk', fontSize: 17, color: 'var(--acc)' }}>{fmtMoney(total, cur)}</b>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="mut">Encaissé</span><span className="num" style={{ color: 'var(--ok)' }}>{fmtMoney(paid, cur)}</span></div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mut">Reste</span>
              <span className="num" style={{ color: due > 0 ? 'var(--danger)' : 'var(--ok)' }}>{fmtMoney(due, cur)}</span>
            </div>
          </div>
          <div className="tiny mut" style={{ marginTop: 12, lineHeight: 1.6 }}>
            Facture n° <span className="mono" style={{ color: 'var(--acc)' }}>{lot.invoicePrefix}-{new Date().getFullYear()}-{String(lot.invoiceNext || 1).padStart(4, '0')}</span><br />
            Reçu n° <span className="mono">{lot.receiptPrefix}-{new Date().getFullYear()}-{String(lot.receiptNext || 1).padStart(4, '0')}</span>
          </div>
        </Card>
      </div>

      <Modal open={clientModal} onClose={() => setClientModal(false)} title="Nouveau client" icon={User}
        footer={<><button className="btn btn-ghost" onClick={() => setClientModal(false)}>Annuler</button>
          <button className="btn btn-primary" onClick={createClientInline}>Créer le client</button></>}>
        <Field label="Nom / raison sociale *"><Input value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} placeholder="Fatou Bamba" /></Field>
        <div className="grid2">
          <Field label="Téléphone"><Input value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} placeholder="+225 …" /></Field>
          <Field label="Type">
            <Select value={newClient.type} onChange={(e) => setNewClient({ ...newClient, type: e.target.value })}>
              <option value="particulier">Particulier</option><option value="entreprise">Entreprise</option>
            </Select>
          </Field>
        </div>
        <Field label="E-mail"><Input value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} /></Field>
        <Field label="Adresse"><Input value={newClient.address} onChange={(e) => setNewClient({ ...newClient, address: e.target.value })} /></Field>
      </Modal>
    </div>
  )
}
