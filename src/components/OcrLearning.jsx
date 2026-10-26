import OcrCloud from './OcrCloud'
import { useState } from 'react'
import {
  Brain, Download, Trash2, ArrowRight, Check, Gauge, History, Sparkles, ShieldCheck,
} from 'lucide-react'
import { Card, CardHead, Badge, Confirm, Empty, useToast } from './UI'
import { useOcrLearning, resetLearning, downloadLearning } from '../lib/learningStore'
import { fmtDateTime } from '../lib/format'
import { MIN_COUNT, MIN_COST, BOOST_MAX } from '../lib/learning'

/** Panneau d'administration de l'apprentissage OCR (par parking). */
export default function OcrLearningPanel({ lot }) {
  const toast = useToast()
  const [confirmReset, setConfirmReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const { events, pairs, plateMemory, counts } = useOcrLearning(lot.id)

  const doExport = () => {
    if (!events.length) { toast.info('Aucune donnée à exporter pour l’instant.'); return }
    downloadLearning(events, { lotId: lot.id, lotName: lot.name })
    toast.ok(`Export de ${events.length} confirmation(s).`)
  }

  const doReset = async () => {
    setBusy(true)
    try {
      const n = await resetLearning(lot.id)
      setConfirmReset(false)
      toast.ok(`${n} confirmation(s) supprimée(s) — apprentissage remis à zéro.`)
    } catch (e) { toast.err(e.message) }
    setBusy(false)
  }

  return (
    <div className="stack">
      <OcrCloud lot={lot} />
      <Card>
        <CardHead icon={Brain} title="Apprentissage des confusions OCR"
          sub="Chaque plaque suggérée retenue par un opérateur est mémorisée, puis transformée en coût de substitution partagé quand le cloud est configuré." />
        <div className="learn-kpi">
          <div className="learn-kpi-card">
            <span>Confirmations</span>
            <b>{counts.confirmations}</b>
            <i>Suggestion retenue</i>
          </div>
          <div className="learn-kpi-card">
            <span>Corrections</span>
            <b>{counts.corrections}</b>
            <i>Lecture rectifiée</i>
          </div>
          <div className="learn-kpi-card accent">
            <span>Paires actives</span>
            <b>{counts.pairsActive}</b>
            <i>sur {counts.pairsTotal} observée(s)</i>
          </div>
          <div className="learn-kpi-card">
            <span>Plaques mémorisées</span>
            <b>{counts.platesKnown}</b>
            <i>lecture → plaque</i>
          </div>
        </div>
        <p className="tiny mut" style={{ marginBottom: 0 }}>
          Une paire devient active à partir de <b>{MIN_COUNT} occurrences</b> : un clic isolé n’apprend rien.
          Son coût descend jusqu’à un plancher de <b>{MIN_COST}</b>, et la remise sur une plaque mémorisée est plafonnée à <b>{BOOST_MAX}</b> caractère(s),
          pour qu’une erreur de manipulation ne puisse pas détourner durablement le rapprochement.
        </p>
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="btn btn-ghost btn-sm" data-testid="learn-export" onClick={doExport} disabled={!events.length}>
            <Download style={{ width: 14, height: 14 }} /> Exporter (JSON)
          </button>
          <button className="btn btn-ghost btn-sm" data-testid="learn-reset" onClick={() => setConfirmReset(true)} disabled={!events.length}>
            <Trash2 style={{ width: 14, height: 14 }} /> Réinitialiser
          </button>
          <span className="spacer" />
          {events[0] && <span className="tiny mut">Dernière confirmation : {fmtDateTime(events[events.length - 1]?.at)}</span>}
        </div>
      </Card>

      <Card>
        <CardHead icon={Gauge} title="Confusions apprises"
          sub="Substitutions observées entre la lecture du moteur et la plaque validée." />
        {pairs.length === 0 ? (
          <Empty icon={Sparkles} title="Rien à apprendre encore"
            text="Retenez une plaque suggérée lors d’un scan : la substitution correspondante apparaîtra ici." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Lecture</th><th>Plaque validée</th><th>Occurrences</th><th>Coût</th><th>État</th></tr>
              </thead>
              <tbody>
                {pairs.map((p) => (
                  <tr key={`${p.from}>${p.to}`}>
                    <td><span className="pair-glyph">{p.from}</span></td>
                    <td><ArrowRight style={{ width: 12, height: 12, color: 'var(--muted)' }} /> <span className="pair-glyph ok">{p.to}</span></td>
                    <td className="num">{p.count}</td>
                    <td className="num">{p.cost != null ? p.cost.toFixed(2) : '1.00'}</td>
                    <td>
                      {p.active
                        ? <Badge tone="ok"><Check style={{ width: 10, height: 10 }} /> active</Badge>
                        : <Badge tone="warn">en attente ({MIN_COUNT})</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHead icon={ShieldCheck} title="Plaques mémorisées"
          sub="Correspondances lecture → plaque confirmées, utilisées pour remonter la suggestion." />
        {plateMemory.length === 0 ? (
          <Empty icon={History} title="Aucune plaque mémorisée"
            text="Les confirmations apparaîtront ici dès le premier scan rectifié." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Lecture OCR</th><th>Plaque retenue</th><th>Confirmations</th><th>Remise</th></tr>
              </thead>
              <tbody>
                {plateMemory.map((m) => (
                  <tr key={`${m.raw}>${m.chosen}`}>
                    <td className="mono tiny">{m.raw}</td>
                    <td className="strong">{m.chosen}</td>
                    <td className="num">{m.count}</td>
                    <td className="num">{m.boost > 0 ? `−${m.boost}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHead icon={History} title={`Journal des confirmations (${events.length})`}
          sub="Traçabilité : qui a retenu quelle plaque, à partir de quelle lecture." />
        {events.length === 0 ? (
          <Empty icon={History} title="Journal vide" text="Aucune confirmation enregistrée pour ce parking." />
        ) : (
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>Date</th><th>Opérateur</th><th>Lecture</th><th>Retenu</th><th>Origine</th></tr>
              </thead>
              <tbody>
                {[...events].reverse().slice(0, 60).map((e) => (
                  <tr key={e.id}>
                    <td className="tiny mut">{fmtDateTime(e.at)}</td>
                    <td className="tiny">{e.userName || '—'}</td>
                    <td className="mono tiny">{e.rawCompact || '—'}</td>
                    <td className="strong">{e.chosen}</td>
                    <td>
                      {e.source === 'suggestion'
                        ? <Badge tone="info">suggestion</Badge>
                        : <Badge tone="warn">correction</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Confirm open={confirmReset} danger
        title="Réinitialiser l’apprentissage ?"
        text={`Les ${events.length} confirmation(s) seront oubliées sur ce poste uniquement, sans effacer le cloud ni les autres postes. Le rapprochement reviendra aux confusions génériques (0/O, 1/I, 8/B, 5/S, 2/Z, 6/G).`}
        confirmLabel="Réinitialiser"
        onCancel={() => setConfirmReset(false)}
        onConfirm={doReset} />
      {busy && <span className="tiny mut">Suppression…</span>}
    </div>
  )
}
