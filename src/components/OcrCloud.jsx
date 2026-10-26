import '../ocr-learning.css'
import { useEffect, useState } from 'react'
import { Cloud, RefreshCw } from 'lucide-react'
import { Card, CardHead, Field, Input, Badge, useToast } from './UI'
import { client, getConfig, setConfig } from '../lib/supabase'
import { cloudLotId, syncFeedback, useOcrSync } from '../lib/ocrSync'
import { fmtDateTime } from '../lib/format'

/** Configured URL/key are shared with existing Admin > Supabase settings.
 * PIN login is local; Supabase Auth is a separate device cloud session.
 */
export default function OcrCloud({ lot }) {
  const toast = useToast()
  const sync = useOcrSync(lot.id)
  const [remoteLot, setRemoteLot] = useState(cloudLotId(lot.id))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [session, setSession] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const sb = client()
    if (!sb) return
    let active = true
    sb.auth.getSession().then(({ data }) => { if (active) setSession(data.session) })
    const { data } = sb.auth.onAuthStateChange((_event, s) => { if (active) setSession(s) })
    return () => { active = false; data.subscription.unsubscribe() }
  }, [sync.configured])
  const run = async (fn) => {
    setBusy(true); setNotice('')
    try { await fn() } catch (e) { setNotice(e.message); toast.err(e.message) }
    finally { setBusy(false) }
  }
  const save = () => run(async () => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(remoteLot)) throw new Error('UUID du parking distant invalide.')
    const cfg = getConfig()
    if (!cfg) throw new Error('Configurez d’abord URL et clé publique dans Administration > Cloud Supabase.')
    setConfig({ ...cfg, ocrLotIds: { ...cfg.ocrLotIds, [lot.id]: remoteLot } })
    setNotice('Association enregistrée. La prochaine synchronisation utilisera ce parking distant.')
  })
  const connect = () => run(async () => {
    const sb = client()
    if (!sb) throw new Error('Supabase non configuré.')
    const { data, error } = await sb.auth.signInWithPassword({ email, password })
    if (error) throw error
    setPassword(''); setSession(data.session)
    setNotice('Session cloud ouverte. Les politiques RLS vérifieront votre appartenance au parking.')
  })
  const doSync = () => run(async () => {
    const result = await syncFeedback(lot.id)
    if (result.mode === 'error') throw new Error(result.error)
    setNotice(result.mode === 'local' ? 'Mode local : aucun serveur configuré.' : `${result.pushed} envoyé(s), ${result.pulled} reçu(s).`)
  })
  return <Card>
    <CardHead icon={Cloud} title="Apprentissage partagé entre postes"
      sub="Envoi après confirmation, réception toutes les 20 secondes et au retour réseau. Authentification Supabase obligatoire." />
    <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
      <Badge tone={sync.state?.mode === 'cloud' ? 'ok' : 'warn'} data-testid="ocr-sync-state">
        {sync.state?.mode === 'cloud' ? 'Dernier échange réussi' : sync.configured ? 'Local / cloud à vérifier' : 'Local uniquement'}
      </Badge>
      <span className="tiny mut" data-testid="ocr-pending">{sync.pendingCount} confirmation(s) en attente</span>
      <span className="tiny mut">{sync.state?.lastSyncAt ? `Dernier échange : ${fmtDateTime(sync.state.lastSyncAt)}` : 'Aucun échange cloud réussi'}</span>
    </div>
    <p className="tiny mut">Poste : <span className="mono">{sync.posteId}</span></p>
    <Field label="UUID du parking Supabase (lots.id)" hint="Tous les postes du même parking doivent utiliser le même UUID distant. Les identifiants locaux de démonstration ne sont pas des UUID Supabase.">
      <Input data-testid="ocr-cloud-lot" value={remoteLot} onChange={(e) => setRemoteLot(e.target.value.trim())} />
    </Field>
    <button className="btn btn-ghost btn-sm" data-testid="ocr-save-mapping" onClick={save} disabled={busy || !sync.configured}>Associer ce parking</button>
    {session ? <div className="row" style={{ marginTop: 14, gap: 8 }}>
      <span className="tiny">Session cloud : {session.user.email}</span>
      <button className="btn btn-ghost btn-sm" onClick={() => run(async () => {
        const { error } = await client().auth.signOut(); if (error) throw error; setSession(null)
      })}>Fermer la session cloud</button>
    </div> : <div style={{ marginTop: 14 }}>
      <p className="tiny mut">Le PIN local n’est pas une session Supabase. Utilisez un compte Supabase Auth inscrit dans memberships pour le parking distant.</p>
      <Field label="E-mail Supabase Auth"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Mot de passe cloud"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <button className="btn btn-ghost btn-sm" data-testid="ocr-cloud-login" onClick={connect} disabled={busy || !sync.configured || !email || !password}>Connecter ce poste au cloud</button>
    </div>}
    <div className="row" style={{ marginTop: 14, gap: 10 }}>
      <button className="btn btn-primary btn-sm" data-testid="ocr-sync-now" onClick={doSync} disabled={busy || !sync.configured}>
        <RefreshCw size={14} /> {busy ? 'Traitement…' : 'Synchroniser l’apprentissage'}
      </button>
    </div>
    {(notice || sync.state?.error) && <p className="tiny" role="status">{notice || sync.state.error}</p>}
    {!sync.configured && <p className="tiny mut">Aucune donnée n’est envoyée. Renseignez URL et clé publique dans Administration → Cloud Supabase, ou dans .env.local.</p>}
    <p className="tiny mut">Réinitialiser efface l’apprentissage de ce poste uniquement. L’historique partagé des autres postes reste intact.</p>
  </Card>
}
