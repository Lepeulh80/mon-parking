import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldOff, KeyRound, QrCode, Copy, Check, AlertTriangle, Smartphone, Loader2 } from 'lucide-react'
import { Card, CardHead, Badge, Field, Input, useToast, Confirm } from './UI'
import { enrollTotp, activateTotp, disableTotp } from '../lib/authSession'
import { useApp } from '../App'

// Enrôlement TOTP : le QR code est produit LOCALEMENT à partir de l'URI
// otpauth renvoyée par le serveur. Aucune image ne part vers un tiers (un
// service de QR code en ligne recevrait le secret, ce qui annulerait le 2FA).
async function qrDataUrl(text) {
  const mod = await import('qrcode')
  return mod.default.toDataURL(text, { margin: 1, width: 220, color: { dark: '#0a0e14', light: '#ffffff' } })
}

export default function TwoFactor() {
  const { user, mfa, refresh } = useApp()
  const toast = useToast()
  const [step, setStep] = useState('idle') // idle | enroll | backup
  const [secret, setSecret] = useState('')
  const [qr, setQr] = useState('')
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState([])
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [askDisable, setAskDisable] = useState(false)
  const [copied, setCopied] = useState('')

  const enabled = !!mfa?.enabled

  useEffect(() => { setError(''); setCode('') }, [step])

  const start = async () => {
    setBusy(true); setError('')
    try {
      const data = await enrollTotp()
      setSecret(data.secret)
      setQr(await qrDataUrl(data.otpauth))
      setStep('enroll')
    } catch (err) { setError(err.message) }
    setBusy(false)
  }

  const confirm = async (event) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const data = await activateTotp(String(code).replace(/\s/g, ''))
      setCodes(data.backupCodes)
      setStep('backup')
      toast.ok('Double authentification activée')
      refresh?.()
    } catch (err) { setError(err.message) }
    setBusy(false)
  }

  const disable = async () => {
    setBusy(true); setError('')
    try {
      await disableTotp(pin)
      setAskDisable(false); setPin(''); setStep('idle'); setCodes([])
      toast.ok('Double authentification désactivée')
      refresh?.()
    } catch (err) { setError(err.message) }
    setBusy(false)
  }

  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1600) }
    catch { setError('Copie impossible : sélectionnez le texte manuellement.') }
  }

  return (
    <Card>
      <CardHead
        title="Double authentification (TOTP)"
        icon={enabled ? ShieldCheck : ShieldOff}
        sub="Un code à 6 chiffres, renouvelé toutes les 30 secondes, en plus du PIN"
        right={<Badge tone={enabled ? 'ok' : 'warn'} dot>{enabled ? 'Active' : 'Inactive'}</Badge>}
      />

      {mfa?.required && !enabled && (
        <div className="alert-inline" style={{ marginBottom: 14 }}>
          <AlertTriangle style={{ width: 14, height: 14 }} />
          Votre politique d’entreprise exige la double authentification pour ce compte
          (<code>AUTH_2FA_POLICY={mfa.policy}</code>). Activez-la maintenant.
        </div>
      )}

      {!enabled && step === 'idle' && (
        <>
          <p className="tiny mut" style={{ marginTop: 0 }}>
            Compatible Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden
            et toute application TOTP standard (RFC 6238). Le secret reste sur le serveur : il n’est
            affiché qu’une seule fois, au moment de l’enrôlement.
          </p>
          <button className="btn btn-primary" onClick={start} disabled={busy}>
            {busy ? <Loader2 className="spin" style={{ width: 15, height: 15 }} /> : <QrCode style={{ width: 15, height: 15 }} />}
            Activer la double authentification
          </button>
        </>
      )}

      {!enabled && step === 'enroll' && (
        <div className="stack">
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ background: '#fff', padding: 8, borderRadius: 12, lineHeight: 0 }}>
              {qr ? <img src={qr} alt="QR code d’enrôlement TOTP" width={220} height={220} /> : <div style={{ width: 220, height: 220 }} />}
            </div>
            <div style={{ minWidth: 240, flex: 1 }}>
              <p className="tiny mut" style={{ marginTop: 0 }}>
                1. Ouvrez votre application d’authentification.<br />
                2. Scannez ce QR code, ou saisissez la clé ci-dessous.<br />
                3. Revenez ici et tapez le code à 6 chiffres affiché.
              </p>
              <Field label="Clé manuelle (base32)">
                <div className="row" style={{ gap: 8 }}>
                  <code style={{ fontSize: 12.5, letterSpacing: 1, wordBreak: 'break-all', flex: 1 }}>{secret}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(secret, 'secret')} type="button">
                    {copied === 'secret' ? <Check style={{ width: 13, height: 13 }} /> : <Copy style={{ width: 13, height: 13 }} />}
                  </button>
                </div>
              </Field>
            </div>
          </div>
          <form onSubmit={confirm}>
            <Field label="Code de vérification (6 chiffres)">
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric" autoComplete="one-time-code" placeholder="000000"
                style={{ letterSpacing: 6, fontSize: 20, textAlign: 'center', maxWidth: 200 }} />
            </Field>
            {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary" disabled={busy || code.length !== 6}>
                {busy ? 'Vérification…' : <><Smartphone style={{ width: 14, height: 14 }} /> Vérifier et activer</>}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setStep('idle'); setSecret(''); setQr('') }}>Annuler</button>
            </div>
          </form>
        </div>
      )}

      {step === 'backup' && (
        <div className="stack">
          <div className="alert-inline">
            <KeyRound style={{ width: 14, height: 14 }} />
            Codes de secours — affichés une seule fois. Conservez-les hors ligne : sans eux, un
            téléphone perdu vous oblige à passer par le serveur pour réinitialiser le PIN.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {codes.map((value) => (
              <code key={value} style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', fontSize: 13, textAlign: 'center' }}>{value}</code>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => copy(codes.join('\n'), 'codes')}>
              {copied === 'codes' ? <Check style={{ width: 13, height: 13 }} /> : <Copy style={{ width: 13, height: 13 }} />} Copier
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => { setStep('idle'); setCodes([]) }}>J’ai enregistré mes codes</button>
          </div>
        </div>
      )}

      {enabled && (
        <>
          <p className="tiny mut" style={{ marginTop: 0 }}>
            Compte <b>@{user?.username}</b> protégé par un second facteur. Il reste{' '}
            <b>{mfa?.backupRemaining ?? 0}</b> code(s) de secours non utilisés.
            {(mfa?.backupRemaining ?? 0) <= 2 && ' Régénérez-en en désactivant puis réactivant la double authentification.'}
          </p>
          <button className="btn btn-ghost" onClick={() => setAskDisable(true)}>
            <ShieldOff style={{ width: 15, height: 15 }} /> Désactiver
          </button>
        </>
      )}

      {error && step !== 'enroll' && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 10 }}>{error}</div>}

      <Confirm
        open={askDisable}
        onCancel={() => { setAskDisable(false); setPin('') }}
        onConfirm={disable}
        title="Désactiver la double authentification ?"
        text="Le compte retombera sur le PIN seul et toutes les sessions ouvertes seront fermées. Saisissez votre PIN dans le champ ci-dessous, puis confirmez."
        footerExtra={
          <div style={{ margin: '10px 0 0' }}>
            <Field label="Confirmez avec votre PIN">
              <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\s/g, ''))} placeholder="••••" />
            </Field>
            {error && <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</span>}
          </div>
        }
        danger
        confirmLabel={busy ? 'Désactivation…' : 'Désactiver'}
      />
    </Card>
  )
}
