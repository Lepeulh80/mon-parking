import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  CloudUpload, CloudDownload, Link2, CheckCircle2, AlertCircle, Database,
  Trash2, Shield, Radio, Clock, ExternalLink,
} from 'lucide-react'
import { db } from '../lib/db'
import { useApp } from '../App'
import { Card, CardHead, Badge, Field, Input, Confirm, useToast } from '../components/UI'
import {
  getConfig, setConfig, clearConfig, testConnection, pushAll, pullAll, subscribe,
  getLastSync, isConfigured,
} from '../lib/supabase'
import { fmtDateTime } from '../lib/format'
import { isToastApi, NOOP_TOAST as NOOP_TOAST_STUB } from '../lib/toastApi'



export function SyncPanel({ embedded = false }) {
  const { lot } = useApp()
  const rawToast = useToast()
  const toast = isToastApi(rawToast) ? rawToast : NOOP_TOAST_STUB
  const [url, setUrl] = useState('')
  const [anonKey, setAnonKey] = useState('')
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState(null)
  const [progress, setProgress] = useState(null)
  const [last, setLast] = useState(null)
  const [live, setLive] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const counts = useLiveQuery(async () => {
    const tables = ['vehicles', 'clients', 'sales', 'payments', 'expenses', 'spots', 'tickets', 'reservations', 'audit']
    const out = {}
    for (const t of tables) out[t] = await db.table(t).where('lotId').equals(lot.id).count()
    return out
  }, [lot.id], {})

  useEffect(() => {
    const c = getConfig()
    if (c) { setUrl(c.url || ''); setAnonKey(c.anonKey || '') }
    getLastSync().then(setLast)
  }, [])

  useEffect(() => () => setProgress(null), [])

  const configured = isConfigured()

  const connect = async () => {
    setBusy('test'); setStatus(null)
    const res = await testConnection(url.trim().replace(/\/$/, ''), anonKey.trim())
    setStatus(res)
    if (res.ok) {
      setConfig({ ...getConfig(), url: url.trim().replace(/\/$/, ''), anonKey: anonKey.trim() })
      toast.ok('Connexion Supabase validée.')
    } else {
      toast.err(res.error)
    }
    setBusy('')
  }

  const push = async () => {
    setBusy('push'); setProgress({ table: '…', count: 0 })
    try {
      const res = await pushAll(lot.id, (p) => setProgress(p))
      const total = Object.values(res).reduce((a, b) => a + b, 0)
      toast.ok(`${total} enregistrement(s) envoyé(s) vers le cloud.`)
      setLast(await getLastSync())
    } catch (e) { toast.err(e.message) }
    setBusy(''); setProgress(null)
  }

  const pull = async () => {
    setBusy('pull'); setProgress({ table: '…', count: 0 })
    try {
      const res = await pullAll(lot.id, (p) => setProgress(p))
      const total = Object.values(res).reduce((a, b) => a + b, 0)
      toast.ok(`${total} enregistrement(s) récupéré(s) du cloud.`)
      setLast(await getLastSync())
    } catch (e) { toast.err(e.message) }
    setBusy(''); setProgress(null)
  }

  const toggleLive = () => {
    if (live) { setLive(false); return }
    subscribe(lot.id, (evt) => toast.info(`Mise à jour distante : ${evt.table} (${evt.event})`))
    setLive(true)
    toast.ok('Temps réel activé sur ce parking.')
  }

  const totalLocal = useMemo(() => Object.values(counts || {}).reduce((a, b) => a + b, 0), [counts])

  return (
    <div className={embedded ? 'stack' : 'stack'}>
      {!embedded && (
        <div className="row">
          <div>
            <h1 style={{ fontSize: 22 }}>Synchronisation cloud</h1>
            <p className="mut" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
              Base locale IndexedDB + réplication Supabase (PostgreSQL)
            </p>
          </div>
          <span className="spacer" />
          <Badge tone={configured ? 'ok' : 'warn'} dot>{configured ? 'Configuré' : 'Non configuré'}</Badge>
        </div>
      )}

      <div className="kpi">
        <div className="kpi-card">
          <div className="kpi-top"><Database /> Enregistrements locaux</div>
          <div className="kpi-val">{totalLocal}</div>
          <div className="kpi-foot">Parking « {lot.name} »</div>
        </div>
        <div className="kpi-card accent2">
          <div className="kpi-top"><Link2 /> État du lien</div>
          <div className="kpi-val" style={{ fontSize: 17 }}>{configured ? 'Connecté' : 'Hors ligne'}</div>
          <div className="kpi-foot">{configured ? 'Clé anon + RLS' : 'Fonctionne en local uniquement'}</div>
        </div>
        <div className="kpi-card warn">
          <div className="kpi-top"><Clock /> Dernière synchro</div>
          <div className="kpi-val" style={{ fontSize: 15 }}>{last ? fmtDateTime(last.at) : 'Jamais'}</div>
          <div className="kpi-foot">{last ? (last.direction === 'push' ? 'Envoi' : 'Réception') : '—'}</div>
        </div>
        <div className="kpi-card danger">
          <div className="kpi-top"><Radio /> Temps réel</div>
          <div className="kpi-val" style={{ fontSize: 17 }}>{live ? 'Actif' : 'Inactif'}</div>
          <div className="kpi-foot">Écoute des changements distants</div>
        </div>
      </div>

      <div className="split">
        <Card>
          <CardHead title="Connexion à Supabase" sub="Vos identifiants restent sur cet appareil" icon={Link2} />
          <Field label="Project URL" hint="Ex. https://abcdefgh.supabase.co">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxxx.supabase.co" autoCapitalize="none" />
          </Field>
          <Field label="Clé publique (anon key)" hint="La sécurité repose sur les politiques RLS du schéma fourni">
            <Input value={anonKey} onChange={(e) => setAnonKey(e.target.value)} placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6…" type="password" />
          </Field>
          <div className="row">
            <button className="btn btn-primary" onClick={connect} disabled={busy === 'test'}>
              {busy === 'test' ? 'Test…' : <><CheckCircle2 style={{ width: 15, height: 15 }} /> Tester & enregistrer</>}
            </button>
            {configured && (
              <button className="btn btn-ghost" onClick={() => setConfirmReset(true)}>
                <Trash2 style={{ width: 14, height: 14 }} /> Déconnecter
              </button>
            )}
          </div>
          {status && (
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.6,
              background: status.ok ? 'rgba(46,230,168,0.09)' : 'rgba(255,92,122,0.09)',
              border: `1px solid ${status.ok ? 'rgba(46,230,168,0.3)' : 'rgba(255,92,122,0.3)'}`,
              color: status.ok ? 'var(--ok)' : 'var(--danger)',
              display: 'flex', gap: 8,
            }}>
              {status.ok ? <CheckCircle2 style={{ width: 15, height: 15, flex: '0 0 auto' }} /> : <AlertCircle style={{ width: 15, height: 15, flex: '0 0 auto' }} />}
              <div>{status.ok ? 'Connexion réussie : la table « lots » est accessible.' : status.error}</div>
            </div>
          )}
        </Card>

        <Card>
          <CardHead title="Réplication" sub="Envoyez ou récupérez les données du parking" icon={CloudUpload} />
          <div style={{ display: 'grid', gap: 9 }}>
            <button className="btn btn-primary" style={{ justifyContent: 'flex-start', padding: '13px 15px' }} onClick={push} disabled={!configured || !!busy}>
              <CloudUpload style={{ width: 17, height: 17 }} />
              <div style={{ textAlign: 'left', flex: 1 }}>
                <div>Envoyer vers le cloud</div>
                <div className="tiny" style={{ opacity: 0.72, fontWeight: 400 }}>{totalLocal} enregistrement(s) locaux</div>
              </div>
            </button>
            <button className="btn btn-ghost" style={{ justifyContent: 'flex-start', padding: '13px 15px' }} onClick={pull} disabled={!configured || !!busy}>
              <CloudDownload style={{ width: 17, height: 17 }} />
              <div style={{ textAlign: 'left', flex: 1 }}>
                <div>Récupérer depuis le cloud</div>
                <div className="tiny mut" style={{ fontWeight: 400 }}>Fusion par identifiant</div>
              </div>
            </button>
            <button className="btn btn-ghost" style={{ justifyContent: 'flex-start', padding: '13px 15px' }} onClick={toggleLive} disabled={!configured}>
              <Radio style={{ width: 17, height: 17, color: live ? 'var(--ok)' : undefined }} />
              <div style={{ textAlign: 'left', flex: 1 }}>
                <div>{live ? 'Désactiver le temps réel' : 'Activer le temps réel'}</div>
                <div className="tiny mut" style={{ fontWeight: 400 }}>WebSocket Supabase Realtime</div>
              </div>
            </button>
          </div>
          {progress && (
            <div style={{ marginTop: 13 }}>
              <div className="tiny mut" style={{ marginBottom: 5 }}>
                {busy === 'push' ? 'Envoi' : 'Réception'} · {progress.table} · {progress.count}
              </div>
              <div className="progress"><i style={{ width: '55%' }} /></div>
            </div>
          )}
          {!configured && (
            <p className="tiny mut" style={{ marginBottom: 0, marginTop: 12 }}>
              L’application reste pleinement fonctionnelle hors ligne. Configurez Supabase pour partager les données entre appareils.
            </p>
          )}
        </Card>
      </div>

      <div className="split">
        <Card>
          <CardHead title="Contenu à répliquer" sub="Par table" icon={Database} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
            {Object.entries(counts || {}).map(([k, v]) => (
              <div key={k} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 11px' }}>
                <div className="tiny mut" style={{ textTransform: 'capitalize' }}>{k}</div>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 14 }}>{v}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHead title="Mise en place" sub="3 étapes" icon={ExternalLink} />
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9, color: 'var(--muted)' }}>
            <li>Créer un projet sur <a href="https://supabase.com" target="_blank" rel="noreferrer" style={{ color: 'var(--acc)' }}>supabase.com</a></li>
            <li>Coller <span className="mono">supabase_schema.sql</span> dans le SQL Editor</li>
            <li>Copier l’URL du projet et la clé <span className="mono">anon</span> ci-contre</li>
          </ol>
          <div style={{ marginTop: 12, background: 'rgba(76,201,240,0.08)', border: '1px solid rgba(76,201,240,0.25)', borderRadius: 10, padding: '10px 12px', fontSize: 11.5, color: '#8fd8f0', display: 'flex', gap: 8, lineHeight: 1.6 }}>
            <Shield style={{ width: 15, height: 15, flex: '0 0 auto' }} />
            La clé anon est publique par conception : chaque table est protégée par Row Level Security (membre vs administrateur du parking).
          </div>
        </Card>
      </div>

      <Confirm open={confirmReset} danger title="Déconnecter Supabase"
        text="Les identifiants seront effacés de cet appareil. Vos données locales restent intactes."
        confirmLabel="Déconnecter"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => { clearConfig(); setUrl(''); setAnonKey(''); setStatus(null); setConfirmReset(false); toast.ok('Supabase déconnecté.') }} />
    </div>
  )
}

export default function Sync() {
  return <SyncPanel />
}
