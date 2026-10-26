import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera, ImagePlus, Images, RotateCw, Trash2, Star, ChevronLeft, ChevronRight,
  Play, Pause, X, AlertTriangle, Database, Check, ArrowLeft, ArrowRight, Loader2, CloudUpload,
} from 'lucide-react'
import {
  addVehiclePhotos, removeVehiclePhoto, setCoverPhoto, moveFrame, clearVehicleFrames,
  useVehicleMedia, useMediaBudget, FRAME, PHOTO,
} from '../lib/photos'
import {
  dragToIndex, stepIndex, frameAngle, spinHint, formatBytes, storageLevel,
  RECOMMENDED_FRAMES, MIN_FRAMES,
} from '../lib/photoMath'
import { Card, CardHead, Badge, Empty, Seg, Modal, useToast, IconBtn } from './UI'
import { client, isConfigured } from '../lib/supabase'
import { publishVehicleMedia, summarizePublish } from '../lib/mediaPublish'

/* ------------------------------------------------------------------ */
/* Lecteur 360° : glisser, clavier, molette de défilement, lecture auto */
/* ------------------------------------------------------------------ */
export function Spin360({ frames, height = 300, alt = 'Véhicule' }) {
  const total = frames.length
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const drag = useRef(null)

  useEffect(() => { if (index >= total) setIndex(0) }, [total, index])

  // Préchargement des deux prises voisines : sans cela, le glissement
  // affiche des trous blancs au lieu d'une rotation continue.
  useEffect(() => {
    if (total < 2) return
    for (const offset of [1, -1, 2]) {
      const src = frames[stepIndex(index, offset, total)]?.data
      if (src) { const img = new Image(); img.src = src }
    }
  }, [index, frames, total])

  useEffect(() => {
    if (!playing || total < 2) return undefined
    const id = setInterval(() => setIndex((i) => stepIndex(i, 1, total)), 100)
    return () => clearInterval(id)
  }, [playing, total])

  if (!total) return null
  const frame = frames[index]

  const onPointerDown = (event) => {
    if (total < 2) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { x: event.clientX, start: index }
    setPlaying(false)
  }
  const onPointerMove = (event) => {
    if (!drag.current) return
    setIndex(dragToIndex(drag.current.start, event.clientX - drag.current.x, total))
  }
  const onPointerUp = () => { drag.current = null }
  const onKeyDown = (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex(stepIndex(index, -1, total)) }
    if (event.key === 'ArrowRight') { event.preventDefault(); setIndex(stepIndex(index, 1, total)) }
    if (event.key === ' ') { event.preventDefault(); setPlaying((p) => !p) }
  }
  const onWheel = (event) => {
    if (total < 2) return
    event.preventDefault()
    setIndex(stepIndex(index, event.deltaY > 0 ? 1 : -1, total))
  }

  return (
    <div className="spin">
      <div
        className="spin-stage"
        style={{ height }}
        tabIndex={0}
        role="group"
        aria-label={`Rotation 360° de ${alt}, ${total} prises`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
      >
        <img
          src={frame.data}
          alt={`${alt} vue ${frameAngle(index, total)}°`}
          draggable={false}
          className="spin-img"
        />
        <div className="spin-angle" aria-hidden="true">{frameAngle(index, total)}°</div>
        <div className="spin-hint">Glissez horizontalement, ou flèches ← →</div>
      </div>

      <div className="spin-controls">
        <IconBtn title="Prise précédente" onClick={() => setIndex(stepIndex(index, -1, total))}><ChevronLeft /></IconBtn>
        <button className="btn btn-ghost btn-sm" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
          {playing ? <><Pause style={{ width: 14, height: 14 }} /> Pause</> : <><Play style={{ width: 14, height: 14 }} /> Lecture</>}
        </button>
        <input
          className="spin-range"
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={index}
          onChange={(event) => setIndex(Number(event.target.value))}
          aria-label="Position de la rotation"
        />
        <span className="tiny mut" style={{ minWidth: 62, textAlign: 'right' }}>{index + 1} / {total}</span>
        <IconBtn title="Prise suivante" onClick={() => setIndex(stepIndex(index, 1, total))}><ChevronRight /></IconBtn>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Galerie                                                                 */
/* ------------------------------------------------------------------ */
function Gallery({ vehicle, lotId, canEdit, media }) {
  const toast = useToast()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState(null)

  const upload = async (files) => {
    if (!files?.length) return
    setBusy(true)
    try {
      const { added, rejected } = await addVehiclePhotos(lotId, vehicle.id, files, { kind: PHOTO })
      if (added.length) toast.ok(`${added.length} photo(s) ajoutée(s).`)
      for (const item of rejected) toast.err(`${item.name} — ${item.reason}`)
    } catch (error) { toast.err(error.message || 'Ajout impossible.') }
    setBusy(false)
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div>
          <b style={{ fontSize: 13 }}>Galerie</b>
          <div className="tiny mut">
            {media.photos.length} photo(s) · {formatBytes(media.photos.reduce((t, p) => t + (p.bytes || 0), 0))}
          </div>
        </div>
        <span className="spacer" />
        {canEdit && (
          <button className="btn btn-primary btn-sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <><Loader2 className="spin-icon" style={{ width: 14, height: 14 }} /> Traitement…</> : <><ImagePlus style={{ width: 14, height: 14 }} /> Ajouter des photos</>}
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden
          data-testid="vehicle-photo-input"
          onChange={(event) => { upload([...event.target.files]); event.target.value = '' }} />
      </div>

      {media.photos.length === 0 ? (
        <Empty icon={Images} title="Aucune photo"
          text="Ajoutez plusieurs vues du véhicule (avant, arrière, intérieur, compteur, documents). Les images sont compressées sur l'appareil."
          action={canEdit ? <button className="btn btn-primary" onClick={() => inputRef.current?.click()}><ImagePlus /> Ajouter des photos</button> : null} />
      ) : (
        <div className="photo-grid">
          {media.photos.map((photo) => (
            <div className="photo-cell" key={photo.id}>
              <button className="photo-open" onClick={() => setLightbox(photo)} aria-label="Agrandir la photo">
                <img src={photo.thumb} alt={photo.name || 'Photo du véhicule'} loading="lazy" />
              </button>
              {photo.cover && <span className="photo-cover"><Star style={{ width: 11, height: 11 }} /> Couverture</span>}
              {canEdit && (
                <div className="photo-tools">
                  {!photo.cover && (
                    <IconBtn title="Définir comme couverture" onClick={async () => {
                      try { await setCoverPhoto(vehicle.id, photo.id); toast.ok('Couverture mise à jour.') }
                      catch (error) { toast.err(error.message) }
                    }}><Star /></IconBtn>
                  )}
                  <IconBtn title="Supprimer" onClick={async () => {
                    try { await removeVehiclePhoto(vehicle.id, photo.id); toast.ok('Photo supprimée.') }
                    catch (error) { toast.err(error.message) }
                  }}><Trash2 /></IconBtn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={!!lightbox} onClose={() => setLightbox(null)} wide title={lightbox?.name || 'Photo du véhicule'} icon={Camera}>
        {lightbox && <img src={lightbox.data} alt={lightbox.name || ''} style={{ width: '100%', borderRadius: 12 }} />}
      </Modal>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Séquence 360°                                                           */
/* ------------------------------------------------------------------ */
function Frames({ vehicle, lotId, canEdit, media }) {
  const toast = useToast()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)

  const upload = async (files) => {
    if (!files?.length) return
    setBusy(true)
    try {
      const { added, rejected } = await addVehiclePhotos(lotId, vehicle.id, files, { kind: FRAME })
      if (added.length) toast.ok(`${added.length} prise(s) ajoutée(s) — l'ordre suit le nom des fichiers.`)
      for (const item of rejected) toast.err(`${item.name} — ${item.reason}`)
    } catch (error) { toast.err(error.message || 'Ajout impossible.') }
    setBusy(false)
  }

  return (
    <>
      <div className="guide">
        <div className="guide-title"><RotateCw style={{ width: 14, height: 14 }} /> Comment filmer une rotation utilisable</div>
        <ol className="guide-list">
          <li>Placez le véhicule au centre, sur sol uni, sans ombre dure.</li>
          <li>Tournez <b>autour du véhicule</b>, jamais le véhicule sur lui-même (les roues doivent rester visibles).</li>
          <li>Même distance, même hauteur, <b>pas de zoom</b> : {RECOMMENDED_FRAMES} prises tous les 15° donnent un rendu fluide ; {MIN_FRAMES} est le minimum.</li>
          <li>Nommez les fichiers dans l'ordre (<code>01.jpg</code>, <code>02.jpg</code>…). L'application les trie naturellement.</li>
        </ol>
        <div className="tiny mut">{spinHint(media.frames.length)}</div>
      </div>

      <div className="row" style={{ margin: '12px 0' }}>
        <span className="spacer" />
        {canEdit && (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => inputRef.current?.click()} disabled={busy}>
              {busy ? <><Loader2 className="spin-icon" style={{ width: 14, height: 14 }} /> Traitement…</> : <><Camera style={{ width: 14, height: 14 }} /> Ajouter des prises</>}
            </button>
            {media.frames.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                await clearVehicleFrames(vehicle.id)
                toast.ok('Séquence supprimée.')
              }}>Vider la séquence</button>
            )}
          </>
        )}
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden
          data-testid="vehicle-frame-input"
          onChange={(event) => { upload([...event.target.files]); event.target.value = '' }} />
      </div>

      {media.frames.length ? (
        <>
          <Spin360 frames={media.frames} alt={`${vehicle.brand} ${vehicle.model}`} />
          <div className="frame-strip">
            {media.frames.map((frame, i) => (
              <div className="frame-cell" key={frame.id} title={`${frameAngle(i, media.frames.length)}°`}>
                <img src={frame.thumb} alt={`Prise ${i + 1}`} loading="lazy" />
                <span className="frame-no">{i + 1}</span>
                {canEdit && (
                  <div className="frame-tools">
                    <button title="Reculer" disabled={i === 0} onClick={() => moveFrame(vehicle.id, frame.id, -1)}><ArrowLeft style={{ width: 11, height: 11 }} /></button>
                    <button title="Avancer" disabled={i === media.frames.length - 1} onClick={() => moveFrame(vehicle.id, frame.id, 1)}><ArrowRight style={{ width: 11, height: 11 }} /></button>
                    <button title="Supprimer" onClick={() => removeVehiclePhoto(vehicle.id, frame.id)}><X style={{ width: 11, height: 11 }} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <Empty icon={RotateCw} title="Aucune séquence 360°"
          text="Une seule photo ne peut pas tourner : il faut une série de prises autour du véhicule. Suivez le guide ci-dessus, puis importez les fichiers d'un seul geste." />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Panneau complet (onglet « Photos & 360° » de la fiche véhicule)          */
/* ------------------------------------------------------------------ */
export function PhotoStudio({ vehicle, lotId, canEdit }) {
  const toast = useToast()
  const [tab, setTab] = useState('photos')
  const [publishing, setPublishing] = useState(false)
  const [report, setReport] = useState(null)
  const media = useVehicleMedia(vehicle.id)
  const budget = useMediaBudget(lotId)
  const level = useMemo(() => storageLevel(budget.usage, budget.quota), [budget.usage, budget.quota])

  if (!vehicle) return null

  return (
    <div className="stack" style={{ gap: 12 }}>
      <Seg value={tab} onChange={setTab} options={[
        { value: 'photos', label: `Photos (${media.photos.length})` },
        { value: '360', label: `Rotation 360° (${media.frames.length})` },
      ]} />

      {tab === 'photos'
        ? <Gallery vehicle={vehicle} lotId={lotId} canEdit={canEdit} media={media} />
        : <Frames vehicle={vehicle} lotId={lotId} canEdit={canEdit} media={media} />}

      <Card>
        <CardHead title="Stockage des médias" icon={Database} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Badge tone={level.level === 'ok' ? 'ok' : 'warn'}>
            {formatBytes(budget.bytes)} de médias · {budget.photos} photos · {budget.frames} prises
          </Badge>
          {budget.quota > 0 && (
            <span className="tiny mut">
              Navigateur : {formatBytes(budget.usage)} / {formatBytes(budget.quota)} utilisés ({Math.round(level.ratio * 100)} %)
            </span>
          )}
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" disabled={publishing || !canEdit}
            title={!isConfigured() ? 'Configurez Supabase dans Intégrations pour publier les photos.' : 'Téléverser les photos vers le bucket vehicle-media'}
            onClick={async () => {
              // Publication vers Supabase Storage : jusqu'à la v19.4 aucune photo
              // ne quittait IndexedDB. Les policies du bucket exigent
              // <lot_id>/<vehicle_id>/<kind>/<id>.<ext> et un admin en aal2.
              if (!isConfigured()) { toast.err('Supabase non configuré : ouvrez Intégrations.'); return }
              const sb = client()
              if (!sb) { toast.err('Client Supabase indisponible.'); return }
              setPublishing(true)
              try {
                const photos = [...(media.photos || []), ...(media.frames || []).map((f) => ({ ...f, kind: 'spin' }))]
                const result = await publishVehicleMedia(sb, { lotId, vehicleId: vehicle.id, photos })
                setReport(result)
                if (result.published) toast.ok(summarizePublish(result))
                else toast.info(summarizePublish(result))
                if (result.failed) toast.err(`${result.failed} média(s) refusé(s) : ${result.errors[0]?.reason || 'voir détail'}`)
              } catch (error) {
                toast.err(error.message)
              } finally {
                setPublishing(false)
              }
            }}>
            <CloudUpload style={{ width: 13, height: 13 }} /> {publishing ? 'Publication…' : 'Publier vers le cloud'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={async () => {
            // Marque le stockage comme persistant : sans cela, le navigateur peut
            // purger IndexedDB (et donc toutes les photos) sous pression disque.
            if (!navigator.storage?.persist) { toast.err('Stockage persistant non pris en charge par ce navigateur.'); return }
            const granted = await navigator.storage.persist()
            if (granted) toast.ok('Stockage persistant accordé : le navigateur ne purgera pas les médias.')
            else toast.err('Refusé par le navigateur : installez l\'application puis réessayez.')
          }}><Check style={{ width: 13, height: 13 }} /> Rendre durable</button>
        </div>
        {level.level !== 'ok' && (
          <div className="alert-inline">
            <AlertTriangle style={{ width: 14, height: 14 }} />
            Stockage {level.level} : supprimez des photos ou exportez une sauvegarde avant de continuer.
          </div>
        )}
        {report && (
          <div className="tiny mut" style={{ marginTop: 8 }}>
            {summarizePublish(report)}
            {report.objects.length > 0 && <span className="mono"> — {report.objects.length} objet(s) publié(s)</span>}
            {report.errors.length > 0 && (
              <ul style={{ margin: '4px 0 0 14px', padding: 0 }}>
                {report.errors.slice(0, 3).map((e) => <li key={e.id}>{e.id} : {e.reason}</li>)}
              </ul>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}

export default PhotoStudio
