import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Building2, Plus, Users, Shield, Download, Upload, Trash2, Pencil, Check,
  ImagePlus, Save, Database, KeyRound, AlertTriangle, Car, FileText, Clock, X, SquareParking,
} from 'lucide-react'
import { ROLE_LABELS } from '../lib/permissions'
import { db } from '../lib/db'
import { createEmployee, updateEmployee, deleteEmployee, updateLot, createAdditionalLot, exportBackup, importBackup } from '../lib/admin'
import { useApp } from '../App'
import { Card, CardHead, Badge, Modal, Confirm, Empty, Field, Input, Select, Tabs, useToast, IconBtn, Switch } from '../components/UI'
import { fmtMoney, fmtDateTime, initials } from '../lib/format'
import { SyncPanel } from './Sync'
import OcrLearningPanel from '../components/OcrLearning'
import TwoFactor from '../components/TwoFactor'
import VaultPanel from '../components/VaultPanel'

export default function Admin() {
  const { lot, user, isAdmin, onSwitchLot } = useApp()
  
  const [tab, setTab] = useState('parking')
  if (!isAdmin) return <Card><Empty icon={Shield} title="Accès restreint" text="Seul un administrateur peut accéder à cette section." /></Card>

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Administration</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>Identité du parking, employés, références et données</p>
        </div>
        <span className="spacer" />
        <Badge tone="acc" dot>Administrateur</Badge>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'parking', label: 'Identité du parking' },
        { value: 'lots', label: 'Mes parkings' },
        { value: 'staff', label: 'Employés' },
        { value: 'security', label: 'Sécurité' },
        { value: 'data', label: 'Données & sauvegarde' },
        { value: 'tarifs', label: 'Tarifs stationnement' },
        { value: 'ocr', label: 'Apprentissage OCR' },
        { value: 'sync', label: 'Cloud Supabase' },
        { value: 'audit', label: 'Journal d’activité' },
      ]} />

      {tab === 'parking' && <LotProfile lot={lot} />}
      {tab === 'lots' && <Lots user={user} lot={lot} onSwitchLot={onSwitchLot} />}
      {tab === 'staff' && <Staff lot={lot} />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'data' && <DataTab lot={lot} />}
      {tab === 'tarifs' && <Tariffs lot={lot} />}
      {tab === 'ocr' && <OcrLearningPanel lot={lot} />}
      {tab === 'sync' && <SyncPanel embedded />}
      {tab === 'audit' && <Audit lot={lot} />}
    </div>
  )
}

function SecurityTab() {
  return (
    <div className="stack">
      <TwoFactor />
      <VaultPanel />
    </div>
  )
}

function LotProfile({ lot }) {
  const toast = useToast()
  const fileRef = useRef(null)
  const [f, setF] = useState({
    name: lot.name, logo: lot.logo, address: lot.address || '', city: lot.city || '',
    phone: lot.phone || '', email: lot.email || '', taxId: lot.taxId || '',
    currency: lot.currency || 'XOF', vatRate: lot.vatRate ?? 18,
    invoicePrefix: lot.invoicePrefix || 'FAC', receiptPrefix: lot.receiptPrefix || 'REC',
    tagline: lot.tagline || '', footerNote: lot.footerNote || '',
  })
  const [busy, setBusy] = useState(false)
  useEffect(() => { setF((p) => ({ ...p, name: lot.name, logo: lot.logo })) }, [lot.id])

  const pick = (file) => {
    if (!file) return
    if (file.size > 1_500_000) { toast.err('Logo trop lourd (1,5 Mo max).'); return }
    const r = new FileReader(); r.onload = () => setF((p) => ({ ...p, logo: r.result })); r.readAsDataURL(file)
  }

  const save = async () => {
    if (!f.name.trim()) { toast.err('Le nom du parking est requis.'); return }
    setBusy(true)
    await updateLot(lot.id, { ...f, name: f.name.trim(), vatRate: Number(f.vatRate) || 0 })
    toast.ok('Identité du parking mise à jour. Les prochaines factures utiliseront ces informations.')
    setBusy(false)
  }

  return (
    <div className="split">
      <Card>
        <CardHead title="Identité & coordonnées" sub="Apparaît sur toutes les factures et reçus" icon={Building2} />
        <div className="row" style={{ marginBottom: 16 }}>
          <div style={{ width: 64, height: 64, borderRadius: 15, overflow: 'hidden', background: '#141c28', display: 'grid', placeItems: 'center', border: '1px solid var(--line-2)' }}>
            {f.logo ? <img src={f.logo} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Car style={{ width: 26, height: 26, color: 'var(--muted)' }} />}
          </div>
          <div>
            <button className="btn btn-sm btn-ghost" onClick={() => fileRef.current?.click()}>
              <ImagePlus style={{ width: 13, height: 13 }} /> {f.logo ? 'Changer le logo' : 'Ajouter un logo'}
            </button>
            {f.logo && <button className="btn btn-sm btn-ghost" style={{ marginLeft: 6 }} onClick={() => setF({ ...f, logo: null })}>Retirer</button>}
            <div className="tiny mut" style={{ marginTop: 5 }}>PNG/JPG · 1,5 Mo max</div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        <Field label="Nom du parking *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Slogan / activité"><Input value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="Téléphone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="E-mail"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <div className="grid2">
          <Field label="Adresse"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="Ville"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        </div>
        <Field label="N° fiscal / IFU / RCCM"><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Enregistrement…' : <><Save style={{ width: 15, height: 15 }} /> Enregistrer</>}
        </button>
      </Card>

      <div className="stack">
        <Card>
          <CardHead title="Facturation" sub="Références et taxes" icon={FileText} />
          <div className="grid2">
            <Field label="Devise">
              <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
                {['XOF', 'XAF', 'EUR', 'USD', 'MAD', 'GNF', 'CDF', 'CAD'].map((c) => <option key={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="TVA appliquée (%)"><Input type="number" value={f.vatRate} onChange={(e) => setF({ ...f, vatRate: e.target.value })} /></Field>
          </div>
          <div className="grid2">
            <Field label="Préfixe facture"><Input value={f.invoicePrefix} onChange={(e) => setF({ ...f, invoicePrefix: e.target.value.toUpperCase() })} /></Field>
            <Field label="Préfixe reçu"><Input value={f.receiptPrefix} onChange={(e) => setF({ ...f, receiptPrefix: e.target.value.toUpperCase() })} /></Field>
          </div>
          <div style={{ background: 'rgba(76,201,240,0.08)', border: '1px solid rgba(76,201,240,0.25)', borderRadius: 10, padding: '10px 12px', fontSize: 11.5, color: '#8fd8f0', lineHeight: 1.6 }}>
            Prochaines références :<br />
            <span className="mono">{f.invoicePrefix}-{new Date().getFullYear()}-{String(lot.invoiceNext || 1).padStart(4, '0')}</span> ·
            <span className="mono"> {f.receiptPrefix}-{new Date().getFullYear()}-{String(lot.receiptNext || 1).padStart(4, '0')}</span>
          </div>
        </Card>
        <Card>
          <CardHead title="Mentions de bas de page" />
          <Field label="Note imprimée sur les documents">
            <textarea className="input" value={f.footerNote} onChange={(e) => setF({ ...f, footerNote: e.target.value })} placeholder="Merci de votre confiance…" />
          </Field>
        </Card>
      </div>
    </div>
  )
}

function Lots({ user, lot, onSwitchLot }) {
  const toast = useToast()
  const lots = useLiveQuery(async () => {
    const rows = await db.users.where('username').equals(user.username).toArray()
    return (await db.lots.bulkGet(rows.map((r) => r.lotId))).filter(Boolean)
  }, [user.username], [])
  const vehicles = useLiveQuery(() => db.vehicles.toArray(), [], [])
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ name: '', city: '', currency: lot.currency })

  const create = async () => {
    if (!f.name.trim()) { toast.err('Le nom est requis.'); return }
    const l = await createAdditionalLot(user, { name: f.name.trim(), city: f.city, currency: f.currency })
    toast.ok(`Parking « ${l.name} » créé.`)
    setOpen(false)
    setF({ name: '', city: '', currency: lot.currency })
  }

  return (
    <div className="stack">
      <Card>
        <CardHead title="Parkings gérés" sub="Basculez d’un parking à l’autre à tout moment" icon={Building2}
          right={<button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}><Plus style={{ width: 13, height: 13 }} /> Nouveau parking</button>} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12 }}>
          {lots.map((l) => {
            const count = vehicles.filter((v) => v.lotId === l.id).length
            return (
              <div key={l.id} className="card" style={{ padding: 14, borderColor: l.id === lot.id ? 'rgba(198,242,78,0.4)' : 'var(--line)' }}>
                <div className="row" style={{ marginBottom: 9 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 11, overflow: 'hidden', background: '#141c28', display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>
                    {l.logo ? <img src={l.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Building2 style={{ width: 17, height: 17, color: 'var(--muted)' }} />}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{l.name}</div>
                    <div className="tiny mut">{l.city || '—'} · {count} véhicule(s)</div>
                  </div>
                </div>
                <div className="row">
                  {l.id === lot.id
                    ? <Badge tone="acc" dot>Parking actif</Badge>
                    : <button className="btn btn-sm btn-ghost" onClick={() => { onSwitchLot(l); toast.ok(`Basculé sur ${l.name}`) }}>Activer</button>}
                  <span className="spacer" />
                  <span className="tiny mut">{l.currency}</span>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Créer un parking" icon={Building2}
        footer={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>Annuler</button>
          <button className="btn btn-primary" onClick={create}>Créer</button></>}>
        <Field label="Nom du parking *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Auto Prestige Yamoussoukro" /></Field>
        <div className="grid2">
          <Field label="Ville"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          <Field label="Devise">
            <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              {['XOF', 'XAF', 'EUR', 'USD', 'MAD', 'GNF'].map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        <p className="tiny mut">Votre compte administrateur sera automatiquement associé à ce nouveau parking.</p>
      </Modal>
    </div>
  )
}

function Staff({ lot }) {
  const { user } = useApp()
  const toast = useToast()
  const staff = useLiveQuery(() => db.users.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const sales = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [f, setF] = useState({ name: '', username: '', pin: '', role: 'employe', phone: '' })
  const [toDelete, setToDelete] = useState(null)

  const openForm = (u) => {
    setEditing(u || null)
    setF(u ? { name: u.name, username: u.username, pin: '', role: u.role, phone: u.phone || '' } : { name: '', username: '', pin: '', role: 'employe', phone: '' })
    setOpen(true)
  }

  const save = async () => {
    if (!f.name.trim() || !f.username.trim()) { toast.err('Nom et identifiant requis.'); return }
    if (!editing && f.pin.length < 4) { toast.err('PIN : 4 chiffres minimum.'); return }
    try {
      if (editing) {
        const patch = { name: f.name.trim(), role: f.role, phone: f.phone }
        if (f.pin) patch.pin = f.pin
        await updateEmployee(editing.id, patch, user)
        toast.ok('Employé mis à jour.')
      } else {
        await createEmployee(lot.id, { ...f, name: f.name.trim() }, user)
        toast.ok('Employé créé.')
      }
      setOpen(false)
    } catch (e) { toast.err(e.message) }
  }

  const perf = (id) => {
    const list = sales.filter((s) => s.userId === id)
    return { count: list.length, revenue: list.reduce((a, s) => a + Number(s.total || 0), 0) }
  }

  return (
    <div className="stack">
      <Card>
        <CardHead title="Équipe du parking" sub="Les employés peuvent vendre et consulter le stock" icon={Users}
          right={<button className="btn btn-sm btn-primary" onClick={() => openForm(null)}><Plus style={{ width: 13, height: 13 }} /> Ajouter</button>} />
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Membre</th><th>Identifiant</th><th>Rôle</th><th>Ventes</th><th className="t-right">CA généré</th><th>Statut</th><th></th></tr></thead>
            <tbody>
              {staff.map((u) => {
                const p = perf(u.id)
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div className="avatar" style={{ width: 27, height: 27, fontSize: 10 }}>{initials(u.name)}</div>
                        <div>
                          <div className="strong" style={{ fontSize: 12.5 }}>{u.name}</div>
                          <div className="tiny mut">@{u.username}</div>
                        </div>
                      </div>
                    </td>
                    <td className="mono mut">{u.username}</td>
                    <td><Badge tone={u.role === 'admin' ? 'acc' : 'info'}>{ROLE_LABELS[u.role] || u.role}</Badge></td>
                    <td>{p.count}</td>
                    <td className="t-right num strong">{fmtMoney(p.revenue, lot.currency)}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <Switch on={!!u.active} onChange={async (v) => { try { await updateEmployee(u.id, { active: v }, user); toast.ok(v ? 'Compte activé' : 'Compte désactivé') } catch (e) { toast.err(e.message) } }} />
                        <span className="tiny mut">{u.active ? 'actif' : 'inactif'}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end' }}>
                        <IconBtn title="Modifier" onClick={() => openForm(u)}><Pencil /></IconBtn>
                        <IconBtn title="Supprimer" onClick={() => setToDelete(u)}><Trash2 /></IconBtn>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHead title="Matrice des droits" icon={Shield} />
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Fonctionnalité</th><th className="t-center">Administrateur</th><th className="t-center">Employé</th></tr></thead>
            <tbody>
              {[
                ['Consulter le stock', true, true],
                ['Réaliser une vente ou une location', true, true],
                ['Générer factures et reçus', true, true],
                ['Encaisser un paiement', true, true],
                ['Créer / modifier des véhicules', true, false],
                ['Gérer les clients', true, true],
                ['Accéder à la comptabilité', true, false],
                ['Voir les statistiques globales', true, false],
                ['Gérer les employés', true, false],
                ['Modifier l’identité du parking', true, false],
                ['Annuler une transaction', true, false],
                ['Créer un nouveau parking', true, false],
              ].map(([label, a, e]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="t-center">{a ? <Check style={{ width: 14, height: 14, color: 'var(--ok)' }} /> : <X style={{ width: 14, height: 14, color: 'var(--muted)' }} />}</td>
                  <td className="t-center">{e ? <Check style={{ width: 14, height: 14, color: 'var(--ok)' }} /> : <X style={{ width: 14, height: 14, color: 'var(--muted)' }} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Modifier l’employé' : 'Nouvel employé'} icon={Users}
        footer={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>Annuler</button>
          <button className="btn btn-primary" onClick={save}>Enregistrer</button></>}>
        <Field label="Nom complet *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="Identifiant *"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" disabled={!!editing} /></Field>
          <Field label="Rôle">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {Object.entries(ROLE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid2">
          <Field label={editing ? 'Nouveau PIN (optionnel)' : 'Code PIN *'} hint="4 chiffres minimum">
            <Input type="password" inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value })} />
          </Field>
          <Field label="Téléphone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
      </Modal>

      <Confirm open={!!toDelete} danger title="Archiver l’employé"
        text={`Archiver le compte de ${toDelete?.name} (@${toDelete?.username}) ? Ses ventes, pointages et opérations restent dans l'historique.`}
        confirmLabel="Archiver"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => { try { await deleteEmployee(toDelete.id, user); setToDelete(null); toast.ok('Employé archivé.') } catch (e) { toast.err(e.message) } }} />
    </div>
  )
}

function DataTab({ lot }) {
  const toast = useToast()
  const fileRef = useRef(null)
  const [confirmImport, setConfirmImport] = useState(null)

  const doExport = async () => {
    const data = await exportBackup(lot.id)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `monparking-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    toast.ok('Sauvegarde téléchargée.')
  }

  const onFile = (file) => {
    if (!file) return
    const r = new FileReader()
    r.onload = () => { try { setConfirmImport(JSON.parse(r.result)) } catch { toast.err('Fichier JSON invalide.') } }
    r.readAsText(file)
  }

  return (
    <div className="split">
      <Card>
        <CardHead title="Sauvegarde & restauration" sub="Vos données restent sur votre appareil" icon={Database} />
        <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: 0 }}>
          MON PARKING stocke toutes les données localement (IndexedDB). Exportez régulièrement une sauvegarde
          pour la conserver ou la restaurer sur un autre appareil.
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn btn-primary" onClick={doExport}><Download style={{ width: 14, height: 14 }} /> Exporter</button>
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}><Upload style={{ width: 14, height: 14 }} /> Importer</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        <div style={{ marginTop: 16, background: 'rgba(255,179,71,0.08)', border: '1px solid rgba(255,179,71,0.28)', borderRadius: 10, padding: '10px 12px', fontSize: 11.5, color: 'var(--warn)', display: 'flex', gap: 8, lineHeight: 1.6 }}>
          <AlertTriangle style={{ width: 15, height: 15, flex: '0 0 auto' }} />
          La restauration ajoute les enregistrements du fichier à la base existante. Les comptes utilisateurs sont restaurés sans leur PIN.
        </div>
      </Card>

      <Card>
        <CardHead title="Sécurité & architecture" icon={KeyRound} />
        <div style={{ display: 'grid', gap: 10 }}>
          {[
            ['Stockage', 'IndexedDB chiffrable, 100 % hors ligne'],
            ['Authentification', 'PIN haché (SHA-256, salage, 3 itérations)'],
            ['Cloisonnement', 'Chaque parking est isolé par lotId'],
            ['Traçabilité', 'Journal d’activité inaltérable par utilisateur'],
            ['Production', 'Schéma PostgreSQL + RLS fourni (supabase/schema.sql)'],
          ].map(([k, v]) => (
            <div key={k} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px' }}>
              <div className="tiny mut">{k}</div>
              <div style={{ fontSize: 12.5, marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>
      </Card>

      <Modal open={!!confirmImport} onClose={() => setConfirmImport(null)} title="Confirmer la restauration" icon={Upload}
        footer={<><button className="btn btn-ghost" onClick={() => setConfirmImport(null)}>Annuler</button>
          <button className="btn btn-primary" onClick={async () => {
            try { await importBackup(confirmImport); toast.ok('Données restaurées.'); setTimeout(() => window.location.reload(), 900) }
            catch (e) { toast.err(e.message) }
            setConfirmImport(null)
          }}>Restaurer</button></>}>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>
          Sauvegarde du {confirmImport?.exportedAt ? fmtDateTime(confirmImport.exportedAt) : '—'}.<br />
          {confirmImport?.data ? Object.entries(confirmImport.data).map(([k, v]) => `${v.length} ${k}`).join(' · ') : ''}
        </p>
      </Modal>
    </div>
  )
}

function Tariffs({ lot }) {
  const toast = useToast()
  const spots = useLiveQuery(() => db.spots.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const tickets = useLiveQuery(() => db.tickets.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const [f, setF] = useState({
    hourlyRate: lot.hourlyRate ?? 500,
    dailyCap: lot.dailyCap ?? 6000,
    graceMinutes: lot.graceMinutes ?? 15,
  })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    await updateLot(lot.id, {
      hourlyRate: Number(f.hourlyRate) || 0,
      dailyCap: Number(f.dailyCap) || 0,
      graceMinutes: Number(f.graceMinutes) || 0,
    })
    toast.ok('Tarifs de stationnement mis à jour.')
    setBusy(false)
  }
  return (
    <div className="split">
      <Card>
        <CardHead title="Tarification du stationnement" sub="Appliquée aux nouveaux tickets" icon={SquareParking} />
        <div className="grid3">
          <Field label="Tarif horaire"><Input type="number" value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: e.target.value })} /></Field>
          <Field label="Plafond / 24 h"><Input type="number" value={f.dailyCap} onChange={(e) => setF({ ...f, dailyCap: e.target.value })} /></Field>
          <Field label="Tolérance (min)"><Input type="number" value={f.graceMinutes} onChange={(e) => setF({ ...f, graceMinutes: e.target.value })} /></Field>
        </div>
        <p className="tiny mut" style={{ lineHeight: 1.7 }}>
          Facturation arrondie à l’heure commencée, plafonnée par journée de 24 h. Les {f.graceMinutes} premières minutes sont offertes.
        </p>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Enregistrement…' : <><Save style={{ width: 15, height: 15 }} /> Enregistrer les tarifs</>}
        </button>
      </Card>
      <Card>
        <CardHead title="Parc de places" sub={`${spots.length} place(s) configurée(s)`} icon={SquareParking} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
          {['libre', 'occupe', 'reserve', 'hs'].map((k) => (
            <div key={k} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 11px' }}>
              <div className="tiny mut" style={{ textTransform: 'capitalize' }}>{k === 'hs' ? 'hors service' : k}</div>
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 15 }}>{spots.filter((s) => s.status === k).length}</div>
            </div>
          ))}
        </div>
        <p className="tiny mut" style={{ marginTop: 12, marginBottom: 0 }}>
          {tickets.filter((t) => t.status === 'ouvert').length} ticket(s) en cours · {tickets.filter((t) => t.status === 'cloture').length} clôturé(s).
          Gérez les zones depuis l’écran Stationnement.
        </p>
      </Card>
    </div>
  )
}

function Audit({ lot }) {
  const logs = useLiveQuery(() => db.audit.where('lotId').equals(lot.id).reverse().sortBy('at'), [lot.id], [])
  const iconFor = (a) => a.startsWith('vente') ? FileText : a.startsWith('location') ? KeyRound : a === 'connexion' ? Shield : Clock
  return (
    <Card>
      <CardHead title="Journal d’activité" sub="Toutes les actions horodatées" icon={Clock} right={<Badge tone="info">{logs.length} entrée(s)</Badge>} />
      {logs.length === 0 ? <Empty icon={Clock} title="Aucune activité" /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Horodatage</th><th>Utilisateur</th><th>Action</th><th>Détails</th></tr></thead>
            <tbody>
              {logs.slice(0, 200).map((l) => {
                const I = iconFor(l.action)
                return (
                  <tr key={l.id}>
                    <td className="mut tiny">{fmtDateTime(l.at)}</td>
                    <td>{l.userName || '—'}</td>
                    <td><Badge tone={l.action.includes('vente') ? 'acc' : l.action === 'connexion' ? 'info' : 'default'}><I style={{ width: 9, height: 9 }} /> {l.action}</Badge></td>
                    <td className="mut tiny">{l.details}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
