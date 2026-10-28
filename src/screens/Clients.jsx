import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Users, Plus, Search, Pencil, Trash2, Phone, Mail, MapPin, Building2, User } from 'lucide-react'
import { db } from '../lib/db'
import { useRemoteRows } from '../lib/apiData'
import { saveClient, deleteClient } from '../lib/admin'
import { useApp } from '../App'
import { Card, Badge, Modal, Confirm, Empty, Field, Input, Select, useToast, IconBtn } from '../components/UI'
import { fmtMoney, fmtDate, initials } from '../lib/format'

export default function Clients() {
  const { lot, isAdmin } = useApp()
  const cur = lot.currency
  const toast = useToast()
  const clientsLocal = useLiveQuery(() => db.clients.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const clients = useRemoteRows('clients', lot.id, clientsLocal)
  const salesLocal = useLiveQuery(() => db.sales.where('lotId').equals(lot.id).toArray(), [lot.id], [])
  const sales = useRemoteRows('sales', lot.id, salesLocal)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [toDelete, setToDelete] = useState(null)
  const [f, setF] = useState({ name: '', phone: '', email: '', address: '', type: 'particulier', taxId: '' })

  const enriched = useMemo(() => clients.map((c) => {
    const list = sales.filter((s) => s.clientId === c.id)
    return {
      ...c,
      count: list.length,
      revenue: list.reduce((a, s) => a + Number(s.total || 0), 0),
      due: list.reduce((a, s) => a + Math.max(0, Number(s.total || 0) - Number(s.paid || 0)), 0),
      last: list.sort((a, b) => new Date(b.date) - new Date(a.date))[0]?.date,
    }
  }).filter((c) => !q.trim() || `${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.revenue - a.revenue), [clients, sales, q])

  const openForm = (c) => {
    setEditing(c || null)
    setF(c ? { name: c.name, phone: c.phone || '', email: c.email || '', address: c.address || '', type: c.type || 'particulier', taxId: c.taxId || '' } : { name: '', phone: '', email: '', address: '', type: 'particulier', taxId: '' })
    setOpen(true)
  }

  const submit = async () => {
    if (!f.name.trim()) { toast.err('Le nom est requis.'); return }
    await saveClient(lot.id, { ...f, name: f.name.trim() }, editing?.id)
    toast.ok(editing ? 'Client mis à jour.' : 'Client ajouté.')
    setOpen(false)
  }

  const totalReceivable = enriched.reduce((a, c) => a + c.due, 0)

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 22 }}>Clients</h1>
          <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
            {clients.length} fiche(s) · {fmtMoney(totalReceivable, cur)} d’encours total
          </p>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => openForm(null)}><Plus /> Nouveau client</button>
      </div>

      <Card>
        <div className="search-box" style={{ maxWidth: 380 }}>
          <Search /><input className="input" placeholder="Nom, téléphone, e-mail…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Card>

      {enriched.length === 0 ? (
        <Card><Empty icon={Users} title="Aucun client" text="Créez des fiches clients pour suivre leurs achats et encours."
          action={<button className="btn btn-primary" onClick={() => openForm(null)}><Plus /> Nouveau client</button>} /></Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(290px,1fr))', gap: 14 }}>
          {enriched.map((c) => (
            <Card key={c.id} style={{ padding: 16 }}>
              <div className="row" style={{ marginBottom: 10 }}>
                <div className="avatar" style={{ width: 38, height: 38 }}>{initials(c.name)}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                  <Badge tone={c.type === 'entreprise' ? 'info' : 'default'}>{c.type === 'entreprise' ? <><Building2 style={{ width: 10, height: 10 }} /> Entreprise</> : <><User style={{ width: 10, height: 10 }} /> Particulier</>}</Badge>
                </div>
                {isAdmin && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <IconBtn title="Modifier" onClick={() => openForm(c)}><Pencil /></IconBtn>
                    <IconBtn title="Supprimer" onClick={() => setToDelete(c)}><Trash2 /></IconBtn>
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)' }}>
                {c.phone && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Phone style={{ width: 11, height: 11 }} />{c.phone}</span>}
                {c.email && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Mail style={{ width: 11, height: 11 }} />{c.email}</span>}
                {c.address && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><MapPin style={{ width: 11, height: 11 }} />{c.address}</span>}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 12, paddingTop: 11, borderTop: '1px solid var(--line)' }}>
                <div style={{ flex: 1 }}>
                  <div className="tiny mut">{c.count} achat(s)</div>
                  <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 13, color: 'var(--acc)' }}>{fmtMoney(c.revenue, cur)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="tiny mut">Encours</div>
                  <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 13, color: c.due > 0 ? 'var(--danger)' : 'var(--ok)' }}>{fmtMoney(c.due, cur)}</div>
                </div>
              </div>
              {c.last && <div className="tiny mut" style={{ marginTop: 7 }}>Dernier achat : {fmtDate(c.last)}</div>}
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Modifier le client' : 'Nouveau client'} icon={Users}
        footer={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>Annuler</button>
          <button className="btn btn-primary" onClick={submit}>Enregistrer</button></>}>
        <Field label="Nom / raison sociale *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Fatou Bamba" /></Field>
        <div className="grid2">
          <Field label="Téléphone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+225 …" /></Field>
          <Field label="E-mail"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <div className="grid2">
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="particulier">Particulier</option><option value="entreprise">Entreprise</option>
          </Select></Field>
          <Field label="N° fiscal / IFU"><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field>
        </div>
        <Field label="Adresse"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      </Modal>

      <Confirm open={!!toDelete} danger title="Supprimer le client"
        text={`Supprimer la fiche de ${toDelete?.name} ? Les factures existantes conserveront les informations du client.`}
        confirmLabel="Supprimer"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => { await deleteClient(toDelete.id); setToDelete(null); toast.ok('Client supprimé.') }} />
    </div>
  )
}
