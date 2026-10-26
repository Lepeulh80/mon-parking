import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera, CameraOff, ScanLine, ImageUp, Keyboard, Check, RotateCcw,
  Loader2, AlertTriangle, Zap, ZapOff, SwitchCamera, Pencil, ScanSearch, LogOut,
  CircleDot, History, CalendarCheck, Car, Ticket, CornerDownLeft,
} from 'lucide-react'
import { Modal, Input, Badge, useToast } from './UI'
import { normalizePlate, validatePlate, compact, PLATE_HELP } from '../lib/plate'
import { recognizePlate, warmUpOcr } from '../lib/ocr'
import { detectPlateBox, cropBox } from '../lib/detect'
import { recordOcrValidation } from '../lib/experience'
import { rankPlates } from '../lib/match'

/* Bande de cadrage de repli, en fraction de l'image caméra. */
const CROP = { x: 0.05, y: 0.3, w: 0.9, h: 0.4 }

const isSecure = () =>
  typeof window !== 'undefined' &&
  (window.isSecureContext || ['localhost', '127.0.0.1'].includes(window.location.hostname))

const CAM_ERRORS = {
  NotAllowedError: 'Accès à la caméra refusé. Autorisez la caméra pour ce site, ou utilisez « Photo ».',
  PermissionDeniedError: 'Accès à la caméra refusé. Autorisez la caméra pour ce site, ou utilisez « Photo ».',
  NotFoundError: 'Aucune caméra détectée. Utilisez « Photo » ou la saisie manuelle.',
  DevicesNotFoundError: 'Aucune caméra détectée sur cet appareil.',
  NotReadableError: 'La caméra est déjà utilisée par une autre application.',
  OverconstrainedError: 'La caméra demandée n’est pas disponible.',
  SecurityError: 'Contexte non sécurisé : la caméra exige HTTPS.',
}

/**
 * Lecture d'immatriculation : caméra (avec détection automatique du rectangle),
 * photo, ou saisie manuelle.
 *
 * Props :
 *  - open, onClose
 *  - onDetected(plate)
 *  - intent : 'entree' | 'sortie' — adapte le libellé et l'aide affichée
 *  - title
 */
export default function PlateScanner({
  open, onClose, onDetected, title, intent = 'entree', entries = [], learning = null, onFeedback = null, observationContext = null,
}) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const streamRef = useRef(null)
  const fileRef = useRef(null)
  const aliveRef = useRef(true)
  const toast = useToast()

  const [mode, setMode] = useState('camera')
  const [camState, setCamState] = useState('idle') // idle | starting | live | error
  const [camError, setCamError] = useState('')
  const [aspect, setAspect] = useState('16 / 9')
  const [facing, setFacing] = useState('environment')
  const [torch, setTorch] = useState(false)
  const [torchable, setTorchable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ label: '', progress: 0 })
  const [result, setResult] = useState(null)
  const [draft, setDraft] = useState('')
  const [shots, setShots] = useState(0)
  const [autoBox, setAutoBox] = useState(null)
  const [autoDetect, setAutoDetect] = useState(true)
  const [picked, setPicked] = useState(null)
  const feedbackRef = useRef(false)
  const pendingFeedback = useRef(null)

  /* Une confirmation = lecture brute + plaque retenue : c'est la matière
     première de l'apprentissage local des confusions. */
  const sendFeedback = (chosen, source, rejected = []) => {
    if (!chosen) return
    const raw = result?.text || draft
    pendingFeedback.current={raw,chosen,rejected,source}
    feedbackRef.current=true
  }

  /* Plaques déjà enregistrées, classées par ressemblance avec la lecture. */
  const suggestions = useMemo(() => {
    if (!draft || !entries.length) return []
    return rankPlates(draft, entries, { minScore: 0.68, limit: 5, learning })
      .filter((m) => m.entry.plate && m.score < 1) // l'exactitude est déjà dans le champ
      .filter((m) => compact(m.entry.plate) !== compact(draft))
  }, [draft, entries, learning])

  useEffect(() => () => { aliveRef.current = false }, [])

  const stopCam = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    const s = streamRef.current
    if (s) s.getTracks().forEach((t) => { try { t.stop() } catch { /* ignore */ } })
    streamRef.current = null
    if (videoRef.current) { try { videoRef.current.srcObject = null } catch { /* ignore */ } }
    setTorch(false)
    setTorchable(false)
    setAutoBox(null)
  }, [])

  /* La vidéo est peinte sur un canvas : ce que l'utilisateur voit correspond
     exactement aux pixels analysés. */
  const paint = useCallback(() => {
    const v = videoRef.current
    const c = canvasRef.current
    if (v && c && v.videoWidth && v.readyState >= 2) {
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
        c.width = v.videoWidth
        c.height = v.videoHeight
        setAspect(`${v.videoWidth} / ${v.videoHeight}`)
      }
      const ctx = c.getContext('2d')
      ctx.drawImage(v, 0, 0, c.width, c.height)
    }
    rafRef.current = requestAnimationFrame(paint)
  }, [])

  useEffect(() => {
    if (camState === 'live') {
      rafRef.current = requestAnimationFrame(paint)
      return () => cancelAnimationFrame(rafRef.current)
    }
    return undefined
  }, [camState, paint])

  /* Boucle de détection : ~3 analyses/seconde, sans bloquer l'aperçu. */
  useEffect(() => {
    if (camState !== 'live' || !autoDetect) { setAutoBox(null); return undefined }
    let stopped = false
    let timer = 0
    const tick = () => {
      if (stopped) return
      try {
        const v = videoRef.current
        if (v && v.readyState >= 2) setAutoBox(detectPlateBox(v))
      } catch { setAutoBox(null) }
      timer = setTimeout(tick, 340)
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [camState, autoDetect])

  const startCam = useCallback(async (facingMode) => {
    const want = facingMode || 'environment'
    if (!isSecure()) {
      setCamState('error')
      setCamError('La caméra exige HTTPS (ou localhost). Ouvrez l’application en HTTPS, ou importez une photo.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamState('error')
      setCamError('Ce navigateur ne donne pas accès à la caméra. Utilisez « Photo ».')
      return
    }
    setCamState('starting')
    setCamError('')
    try {
      stopCam()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      streamRef.current = stream
      const v = videoRef.current
      if (!v) return
      v.srcObject = stream
      await v.play().catch(() => {})
      let caps = {}
      try { caps = stream.getVideoTracks()[0]?.getCapabilities?.() || {} } catch { caps = {} }
      setTorchable(!!caps.torch)
      setCamState('live')
    } catch (e) {
      setCamState('error')
      setCamError(CAM_ERRORS[e?.name] || `Caméra indisponible (${e?.name || 'erreur'}).`)
    }
  }, [stopCam])

  useEffect(() => {
    if (!open) { stopCam(); return }
    setResult(null); setDraft(''); setMode('camera'); setBusy(false); setShots(0)
    setProgress({ label: '', progress: 0 }); setAspect('16 / 9'); setAutoBox(null); setPicked(null)
    warmUpOcr()
    startCam('environment')
    return () => stopCam()
  }, [open])

  const close = () => { stopCam(); onClose?.() }

  /* ---------------- captures ---------------- */

  /** Découpe une zone normalisée (0 → 1). */
  const grabRegion = (box) => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return null
    const sx = v.videoWidth * Math.max(0, box.x)
    const sy = v.videoHeight * Math.max(0, box.y)
    const sw = Math.min(v.videoWidth - sx, v.videoWidth * box.w)
    const sh = Math.min(v.videoHeight - sy, v.videoHeight * box.h)
    if (sw < 24 || sh < 12) return null
    const c = document.createElement('canvas')
    c.width = Math.max(48, Math.round(sw))
    c.height = Math.max(24, Math.round(sh))
    c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height)
    return c
  }

  const expand = (box, mx = 0.08, my = 0.26) => ({
    x: Math.max(0, box.x - box.w * mx),
    y: Math.max(0, box.y - box.h * my),
    w: box.w * (1 + mx * 2),
    h: box.h * (1 + my * 2),
  })

  /**
   * Zones candidates, dans l'ordre de préférence : boîte détectée (élargie pour
   * ne pas couper le préfixe pays), bande de cadrage, puis image entière.
   * Sur un cadrage trop serré, l'OCR perd le « CI » de tête : la comparaison des
   * trois zones rattrape ce cas.
   */
  const regions = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return []
    const list = []
    let box = autoDetect ? autoBox : null
    if (!box && autoDetect) { try { box = detectPlateBox(v) } catch { box = null } }
    if (box) list.push({ name: 'auto', canvas: grabRegion(expand(box)) })
    list.push({ name: 'cadre', canvas: grabRegion(CROP) })
    list.push({ name: 'plein', canvas: grabRegion({ x: 0, y: 0, w: 1, h: 1 }) })
    return list.filter((r) => r.canvas)
  }

  const runOcr = useCallback(async (source, { apply = true } = {}) => {
    setBusy(true)
    setProgress({ label: 'Préparation de l’image…', progress: 4 })
    try {
      const res = await recognizePlate(source, {
        onProgress: (p) => { if (aliveRef.current) setProgress({ label: p.label, progress: Math.max(6, p.progress) }) },
      })
      if (!aliveRef.current) return null
      setProgress({ label: 'Analyse terminée', progress: 100 })
      if (apply) {
        feedbackRef.current = false; pendingFeedback.current=null
        setResult(res)
        if (res.best) setDraft(res.best.value)
        else toast.info('Aucune plaque lisible. Rapprochez-vous, évitez le reflet, ou importez une photo.')
      }
      return res
    } catch (e) {
      toast.err(`Lecture impossible : ${e.message}`)
      return null
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [toast])

  const scoreOf = (res) => (res ? res.confidence + (res.best?.ok ? 14 : 0) + (res.best ? 4 : -30) : -100)

  const capture = async () => {
    if (busy) return
    const list = regions()
    if (!list.length) { toast.err('La caméra n’est pas encore prête.'); return }
    let best = null
    let used = ''
    setShots(0)
    for (let i = 0; i < list.length; i += 1) {
      if (!aliveRef.current) return
      setShots(i + 1)
      const res = await runOcr(list[i].canvas, { apply: false })
      if (scoreOf(res) > scoreOf(best)) { best = res; used = list[i].name }
      if (best && best.reliable && best.confidence >= 80) break
      await new Promise((r) => setTimeout(r, 90))
    }
    if (best) {
      setResult({ ...best, source: used })
      setDraft(best.best?.value || '')
      setProgress({ label: 'Analyse terminée', progress: 100 })
      if (!best.best) toast.info('Aucune plaque lisible. Rapprochez-vous, évitez le reflet, ou importez une photo.')
    }
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    stopCam()
    setCamState('idle')
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = reject
        im.src = url
      })
      try {
        const box = detectPlateBox(img)
        if (box) {
          await runOcr(cropBox(img, box))
        } else {
          await runOcr(img)
        }
      } catch {
        await runOcr(img)
      }
    } catch {
      toast.err('Image illisible.')
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0]
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch }] })
      setTorch(!torch)
    } catch {
      setTorchable(false)
      toast.info('La torche n’est pas disponible sur cette caméra.')
    }
  }

  const switchCamera = async () => {
    const next = facing === 'environment' ? 'user' : 'environment'
    setFacing(next)
    await startCam(next)
  }

  const proposal = useMemo(() => (draft ? normalizePlate(draft) : null), [draft])
  const check = useMemo(() => (draft ? validatePlate(draft) : null), [draft])

  const apply = (value) => {
    const norm = normalizePlate(value ?? draft)
    if (!norm.value) { toast.err('Saisissez une immatriculation.'); return }
    // Lecture corrigée à la main : matière d'apprentissage (source « correction »).
    if (!feedbackRef.current && result?.text && compact(result.text) !== compact(norm.value)) {
      sendFeedback(norm.value, 'correction')
    }
    if(pendingFeedback.current && typeof onFeedback==='function') {onFeedback({...pendingFeedback.current,chosen:norm.value});pendingFeedback.current=null}
    if(result?.text && observationContext?.lotId) void recordOcrValidation({...observationContext,zone:observationContext.zoneForPlate?.(norm.value)||observationContext.zone,raw:result.text,proposed:result.best?.value||'',chosen:norm.value,confidence:result.confidence}).catch(console.warn)
    onDetected?.(norm.value)
    toast.ok(`Plaque appliquée : ${norm.value}`)
    close()
  }

  if (!open) return null

  const conf = result?.confidence ?? 0
  const confTone = conf >= 70 ? 'ok' : conf >= 40 ? 'warn' : 'default'
  const isExit = intent === 'sortie'
  const heading = title || (isExit ? 'Scan de sortie' : 'Scanner une plaque')

  return (
    <Modal open onClose={close} title={heading} icon={isExit ? LogOut : ScanLine} wide
      footer={<>
        <button className="btn btn-ghost" onClick={close}>Annuler</button>
        <button className="btn btn-primary" data-testid="scan-apply" onClick={() => apply(draft)} disabled={!String(draft).trim()}>
          <Check style={{ width: 15, height: 15 }} /> {isExit ? 'Retrouver le ticket' : 'Utiliser cette plaque'}
        </button>
      </>}>

      {isExit && (
        <div className="scan-intent">
          <LogOut style={{ width: 15, height: 15 }} />
          <span>La plaque lue est recherchée parmi les <b>tickets ouverts</b> : le ticket correspondant s’ouvre directement pour l’encaissement.</span>
        </div>
      )}

      <div className="scan-tabs">
        <button className={mode === 'camera' ? 'on' : ''} onClick={() => { setMode('camera'); if (camState !== 'live') startCam(facing) }}>
          <Camera style={{ width: 14, height: 14 }} /> Caméra
        </button>
        <button className={mode === 'manual' ? 'on' : ''} onClick={() => { setMode('manual'); stopCam(); setCamState('idle') }}>
          <Keyboard style={{ width: 14, height: 14 }} /> Saisie manuelle
        </button>
      </div>

      {mode === 'camera' && (
        <>
          <div className={`scan-stage ${camState}`}>
            <div className="scan-view" style={{ aspectRatio: aspect }}>
              <video ref={videoRef} playsInline muted autoPlay style={{ display: 'none' }} />
              <canvas ref={canvasRef} className="scan-canvas" />

              {autoDetect ? (
                autoBox ? (
                  <div className="scan-autobox" data-testid="scan-autobox"
                    style={{ left: `${autoBox.x * 100}%`, top: `${autoBox.y * 100}%`, width: `${autoBox.w * 100}%`, height: `${autoBox.h * 100}%` }}>
                    <span className="scan-autobox-tag"><ScanSearch style={{ width: 10, height: 10 }} /> plaque détectée</span>
                    <i className="c1" /><i className="c2" /><i className="c3" /><i className="c4" />
                  </div>
                ) : (
                  <div className="scan-search" data-testid="scan-searching">
                    <ScanSearch style={{ width: 15, height: 15 }} /> recherche de la plaque…
                  </div>
                )
              ) : (
                <div className="scan-frame" style={{ left: `${CROP.x * 100}%`, top: `${CROP.y * 100}%`, width: `${CROP.w * 100}%`, height: `${CROP.h * 100}%` }}>
                  <i className="c1" /><i className="c2" /><i className="c3" /><i className="c4" />
                </div>
              )}

              {camState === 'live' && <span className={`scan-sweep ${busy ? 'fast' : ''}`} />}

              <div className="scan-hud">
                <Badge tone={camState === 'live' ? 'ok' : camState === 'error' ? 'danger' : 'warn'} dot>
                  {camState === 'live' ? 'Flux caméra' : camState === 'starting' ? 'Activation…' : camState === 'error' ? 'Indisponible' : 'En pause'}
                </Badge>
                {busy && shots > 0 && <Badge tone="info">zone {shots}/3</Badge>}
                {busy && <Badge tone="info"><Loader2 className="scan-spin" style={{ width: 10, height: 10 }} /> analyse</Badge>}
                {autoDetect && autoBox && <Badge tone="ok"><CircleDot style={{ width: 10, height: 10 }} /> auto</Badge>}
              </div>
            </div>

            {camState === 'starting' && (
              <div className="scan-veil"><Loader2 className="scan-spin" style={{ width: 22, height: 22 }} /> Activation de la caméra…</div>
            )}
            {camState === 'error' && (
              <div className="scan-veil err">
                <AlertTriangle style={{ width: 20, height: 20 }} />
                <div>{camError}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => startCam(facing)}><RotateCcw style={{ width: 13, height: 13 }} /> Réessayer</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><ImageUp style={{ width: 13, height: 13 }} /> Importer une photo</button>
                </div>
              </div>
            )}
            {camState === 'idle' && (
              <div className="scan-veil">
                <CameraOff style={{ width: 20, height: 20 }} />
                <div>Caméra en pause.</div>
                <button className="btn btn-ghost btn-sm" onClick={() => startCam(facing)}><Camera style={{ width: 13, height: 13 }} /> Réactiver</button>
              </div>
            )}
          </div>

          <div className="scan-actions">
            <button className="btn btn-primary scan-capture" data-testid="scan-capture" onClick={capture} disabled={camState !== 'live' || busy}>
              {busy ? <Loader2 className="scan-spin" style={{ width: 16, height: 16 }} /> : <ScanLine style={{ width: 16, height: 16 }} />}
              {busy ? 'Lecture en cours…' : 'Capturer la plaque'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><ImageUp style={{ width: 14, height: 14 }} /> Photo</button>
            <button className={`btn btn-ghost btn-sm ${autoDetect ? 'on' : ''}`} onClick={() => setAutoDetect((v) => !v)}
              title="Détecter automatiquement le rectangle de la plaque">
              <ScanSearch style={{ width: 14, height: 14 }} /> Auto
            </button>
            {torchable && (
              <button className={`btn btn-ghost btn-sm ${torch ? 'on' : ''}`} onClick={toggleTorch}>
                {torch ? <ZapOff style={{ width: 14, height: 14 }} /> : <Zap style={{ width: 14, height: 14 }} />} Torche
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={switchCamera}><SwitchCamera style={{ width: 14, height: 14 }} /> Caméra</button>
            {camState === 'live' && (
              <button className="btn btn-ghost btn-sm" onClick={() => { stopCam(); setCamState('idle') }}>
                <CameraOff style={{ width: 14, height: 14 }} /> Couper
              </button>
            )}
          </div>
          <p className="tiny mut" style={{ margin: '6px 0 0' }}>
            {autoDetect
              ? 'Détection automatique : le cadre vert entoure la plaque trouvée. Désactivez « Auto » pour viser manuellement.'
              : PLATE_HELP}
          </p>
        </>
      )}

      {mode === 'manual' && (
        <p className="tiny mut" style={{ marginTop: 0 }}>
          Saisissez l’immatriculation : elle est normalisée au format officiel (AA-123-AA, CI 1234 AB…).
        </p>
      )}

      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} data-testid="scan-file" onChange={onFile} />

      {busy && (
        <div className="scan-progress">
          <div className="scan-progress-h"><span>{progress.label || 'Lecture…'}</span><b>{progress.progress}%</b></div>
          <div className="scan-bar"><i style={{ width: `${Math.min(100, progress.progress)}%` }} /></div>
        </div>
      )}

      {(result || mode === 'manual' || draft) && (
        <div className="scan-result" data-testid="scan-result">
          <div className="scan-result-top">
            {result?.preview && <img src={result.preview} alt="Zone analysée" />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="scan-label">
                {result ? 'Immatriculation lue — corrigez si besoin' : 'Immatriculation'}
              </div>
              <input
                className="scan-value"
                data-testid="scan-result-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value.toUpperCase())}
                onBlur={() => { const n = normalizePlate(draft); if (n.value) setDraft(n.value) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { const n = normalizePlate(draft); if (n.value) setDraft(n.value) } }}
                placeholder="AA-123-AA"
                spellCheck={false}
                autoFocus={mode === 'manual'}
              />
              <div className="scan-meta">
                {result && <Badge tone={confTone}>confiance {conf} %</Badge>}
                {proposal?.label && <Badge tone="info">{proposal.label}</Badge>}
                {check?.ok
                  ? <Badge tone="ok"><Check style={{ width: 11, height: 11 }} /> format validé</Badge>
                  : <Badge tone="warn">{check?.warning || 'à vérifier'}</Badge>}
                {result && !result.reliable && <Badge tone="warn"><Pencil style={{ width: 10, height: 10 }} /> lecture à confirmer</Badge>}
              </div>
            </div>
          </div>

          {suggestions.length > 0 && (
            <div className="scan-match" data-testid="scan-matches">
              <div className="scan-match-h">
                <History style={{ width: 13, height: 13 }} />
                <span>Plaques déjà enregistrées qui ressemblent à la lecture</span>
              </div>
              {suggestions.map((m) => {
                const e = m.entry
                const Icon = e.kind === 'ticket' ? Ticket : e.kind === 'reservation' ? CalendarCheck : e.kind === 'vehicule' ? Car : History
                return (
                  <button key={`${e.kind}-${e.id || e.plate}`} className={`scan-match-row ${picked === e.plate ? 'on' : ''}`}
                    data-testid="scan-match-row"
                    onClick={() => {
                    setPicked(e.plate)
                    setDraft(e.plate)
                    sendFeedback(e.plate, 'suggestion',
                      suggestions.filter((x) => x.entry.plate !== e.plate).map((x) => x.entry.plate))
                  }}>
                    <Icon style={{ width: 13, height: 13 }} />
                    <b>{e.plate}</b>
                    <span className="scan-match-meta">{e.label || e.kind}</span>
                    <span className="scan-match-score">{Math.round(m.score * 100)} %</span>
                    {picked === e.plate && <CornerDownLeft style={{ width: 12, height: 12, color: 'var(--acc)' }} />}
                  </button>
                )
              })}
              <p className="tiny mut" style={{ margin: '7px 0 0' }}>
                Cliquez une plaque pour la retenir : la correspondance tolère les confusions de caractères (0/O, 1/I, 8/B, 5/S).
              </p>
            </div>
          )}

          {result?.candidates?.length > 1 && (
            <div className="scan-alts">
              <span className="tiny mut">Autres lectures :</span>
              {result.candidates.slice(1, 5).map((c) => (
                <button key={c.value} className="scan-chip" onClick={() => setDraft(c.value)} title={c.label}>
                  {c.value}{c.ok ? '' : ' ?'}
                </button>
              ))}
            </div>
          )}

          {result?.text && (
            <details className="scan-raw">
              <summary>Texte brut lu par le moteur ({result.variant})</summary>
              <pre>{result.text || '—'}</pre>
            </details>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Champ immatriculation avec bouton de scan intégré. */
export function PlateInput({ value, onChange, placeholder = 'CI 4471 AB', autoFocus, testId, id, 'aria-describedby':descriptionId }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="plate-input">
        <Input id={id} aria-describedby={descriptionId}
          value={value}
          onChange={(e) => onChange(String(e.target.value).toUpperCase())}
          placeholder={placeholder}
          autoFocus={autoFocus}
          data-testid={testId}
          spellCheck={false}
        />
        <button type="button" className="plate-scan-btn" data-testid="plate-scan-btn"
          onClick={() => setOpen(true)} title="Scanner la plaque avec la caméra">
          <ScanLine style={{ width: 16, height: 16 }} />
        </button>
      </div>
      <PlateScanner open={open} onClose={() => setOpen(false)} onDetected={(p) => onChange(p)} />
    </>
  )
}
