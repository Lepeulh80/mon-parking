import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Car, ArrowRight, ShieldCheck, Zap, Database, CloudOff, Sparkles, Building2, Eye, EyeOff, KeyRound } from 'lucide-react'
import gsap from 'gsap'
import { signIn, verifyMfa } from '../lib/authSession'
const ThreeHero = lazy(()=>import('../components/ThreeHero'))
import { navigate } from '../lib/router'
import { useTranslation } from '../lib/useI18n'

export default function Auth({ onLogin }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // v19 : second facteur. Le serveur renvoie un défi au lieu d'une session.
  const [step, setStep] = useState('credentials')
  const [challenge, setChallenge] = useState('')
  const [code, setCode] = useState('')
  const [form, setForm] = useState({ lotName: '', adminName: '', username: '', pin: '', confirm: '', city: '', currency: 'XOF' })
  const copyRef = useRef(null)
  const cardRef = useRef(null)

  useEffect(() => {
    if(document.documentElement.dataset.motion==='reduced'||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
    if (copyRef.current) tl.from(copyRef.current.children, { y: 26, opacity: 0, duration: 0.75, stagger: 0.09 })
    if (cardRef.current) tl.from(cardRef.current, { y: 22, opacity: 0, duration: 0.7 }, 0.15)
    return () => tl.kill()
  }, [])

  const submitLogin = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signIn(username, pin)
      await onLogin()
      navigate('/dashboard')
    } catch (err) {
      setError(err.message || 'Connexion impossible.')
    }
    setBusy(false)
  }


  const submitMfa = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await verifyMfa(challenge, code)
      await onLogin()
      navigate('/dashboard')
    } catch (err) {
      setError(err.message || 'Code refusé.')
      if (err.status === 401) setCode('')
      if (err.status === 401 && /expir|Reconnectez/i.test(err.message)) { setStep('credentials'); setChallenge('') }
    }
    setBusy(false)
  }

  const submitCreate = async (e) => {
    e.preventDefault()
    setError('Le premier compte doit être créé par npm run auth:setup sur le serveur. Après connexion, un administrateur peut ajouter des parkings et des employés.')
  }

  return (
    <div className="auth">
      <div className="auth-visual">
        {document.documentElement.dataset.motion!=='reduced'&&<Suspense fallback={<div aria-hidden="true"/>}><ThreeHero /></Suspense>}
        <div className="grid-overlay" />
        <div className="auth-brand">
          <div className="brand-logo"><Car size={20} /></div>
          MON PARKING
        </div>
        <div className="auth-copy" ref={copyRef}>
          <div className="login-hero-badge"><Sparkles style={{ width: 12, height: 12 }} /> Suite de gestion automobile</div>
          <h1>Pilotez vos parkings<br /><em>comme une entreprise.</em></h1>
          <p>
            Stock, ventes, locations, factures et comptabilité réunis dans une seule
            application progressive — rapide, hors ligne et pensée pour le mobile.
          </p>
          <div className="auth-chips">
            <span className="chip">Multi-parcs</span>
            <span className="chip">Factures PDF</span>
            <span className="chip">Bilan comptable</span>
            <span className="chip">Hors ligne</span>
            <span className="chip">Rôles admin / employé</span>
          </div>
        </div>
        <div style={{ position: 'relative', zIndex: 2, display: 'flex', gap: 18, fontSize: 11, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ShieldCheck style={{ width: 13, height: 13, color: 'var(--acc)' }} /> Données chiffrées localement</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><CloudOff style={{ width: 13, height: 13, color: 'var(--acc-2)' }} /> 100 % offline-first</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Database style={{ width: 13, height: 13, color: 'var(--acc-2)' }} /> IndexedDB</span>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-card" ref={cardRef}>
          <div className="auth-tabs">
            <button className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setError('') }}>{t('auth.login')}</button>
            <button className={mode === 'create' ? 'on' : ''} onClick={() => { setMode('create'); setError('') }}>Créer un parking</button>
          </div>

          {mode === 'login' ? (
            <>
              {step === 'mfa' ? (
                <>
                  <h2>Vérification en deux étapes</h2>
                  <p className="sub">
                    Saisissez le code à 6 chiffres de votre application d’authentification
                    ou l’un de vos codes de secours.
                  </p>
                  <form onSubmit={submitMfa}>
                    <div className="field">
                      <label>{t('auth.mfa.code')}</label>
                      <input className="input" value={code} autoFocus inputMode="numeric" autoComplete="one-time-code"
                        onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 11))}
                        placeholder="000000"
                        style={{ letterSpacing: 5, fontSize: 19, textAlign: 'center' }} />
                    </div>
                    {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
                    <button className="btn btn-primary" style={{ width: '100%', padding: 12 }} disabled={busy || code.length < 6}>
                      {busy ? 'Vérification…' : <><ShieldCheck style={{ width: 15, height: 15 }} /> Valider</>}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }}
                      onClick={() => { setStep('credentials'); setChallenge(''); setCode(''); setError('') }}>
                      {t('auth.mfa.back')}
                    </button>
                  </form>
                  <div className="tiny mut" style={{ marginTop: 12 }}>
                    <KeyRound style={{ width: 11, height: 11 }} /> Téléphone perdu ? Utilisez un code de secours,
                    ou demandez à un administrateur de réinitialiser votre PIN (cela annule la 2FA).
                  </div>
                </>
              ) : (
              <>
              <h2>Bon retour</h2>
              <p className="sub">Connectez-vous à votre espace de gestion.</p>
              <form onSubmit={submitLogin}>
                <div className="field">
                  <label>{t('auth.identifier')}</label>
                  <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoCapitalize="none" autoComplete="username" />
                </div>
                <div className="field">
                  <label>{t('auth.pin')}</label>
                  <div style={{ position: 'relative' }}>
                    <input className="input" type={showPin ? 'text' : 'password'} value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\s/g, ''))} placeholder="••••" inputMode="numeric"
                      style={{ paddingRight: 42 }} autoComplete="current-password" />
                    <button type="button" onClick={() => setShowPin((v) => !v)}
                      style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer', padding: 6 }}>
                      {showPin ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
                {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
                <button className="btn btn-primary" style={{ width: '100%', padding: 12 }} disabled={busy}>
                  {busy ? t('auth.signing') : <>{t('auth.signin')} <ArrowRight style={{ width: 15, height: 15 }} /></>}
                </button>
              </form>
              </>)}
              <div className="demo-box">
                <b>Comptes de démonstration</b><br />
                Administrateur : <code>admin</code> / PIN <code>1234</code><br />
                Employé : <code>vendeur</code> / PIN <code>1111</code><br />
                Second vendeur : <code>vendeur2</code> / PIN <code>2222</code>
              </div>
            </>
          ) : (
            <>
              <h2>Créer votre parking</h2>
              <p className="sub">Un compte administrateur est créé avec l’espace.</p>
              <form onSubmit={submitCreate}>
                <div className="field">
                  <label>Nom du parking *</label>
                  <input className="input" value={form.lotName} onChange={(e) => setForm({ ...form, lotName: e.target.value })} placeholder="Ex. Auto Prestige Abidjan" />
                </div>
                <div className="grid2">
                  <div className="field">
                    <label>Votre nom complet *</label>
                    <input className="input" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} placeholder="Kouadio Yao" />
                  </div>
                  <div className="field">
                    <label>Ville</label>
                    <input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Abidjan" />
                  </div>
                </div>
                <div className="field">
                  <label>Identifiant de connexion *</label>
                  <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="monparking" autoCapitalize="none" />
                </div>
                <div className="grid2">
                  <div className="field">
                    <label>Code PIN *</label>
                    <input className="input" type="password" inputMode="numeric" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} placeholder="••••" />
                  </div>
                  <div className="field">
                    <label>Confirmer *</label>
                    <input className="input" type="password" inputMode="numeric" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} placeholder="••••" />
                  </div>
                </div>
                <div className="field">
                  <label>Devise</label>
                  <select className="select" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                    <option value="XOF">FCFA (XOF)</option>
                    <option value="EUR">Euro (EUR)</option>
                    <option value="USD">Dollar (USD)</option>
                    <option value="MAD">Dirham (MAD)</option>
                    <option value="GNF">Franc guinéen (GNF)</option>
                  </select>
                </div>
                {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
                <button className="btn btn-primary" style={{ width: '100%', padding: 12 }} disabled={busy}>
                  {busy ? 'Création…' : <><Building2 style={{ width: 15, height: 15 }} /> Créer mon espace</>}
                </button>
              </form>
            </>
          )}
          <div style={{ marginTop: 18, fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Zap style={{ width: 12, height: 12, color: 'var(--acc)' }} /> Installable sur iOS et Android depuis le navigateur.
          </div>
        </div>
      </div>
    </div>
  )
}
