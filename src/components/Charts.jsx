import { useEffect, useRef, useState } from 'react'
import { fmtMoney } from '../lib/format'

/* ---------- animated area/line chart ---------- */
export function AreaChart({ data, height = 190, color = '#c6f24e', format = (v) => v, showGrid = true }) {
  const [hover, setHover] = useState(null)
  const w = 640
  const h = height
  const pad = { l: 6, r: 6, t: 14, b: 22 }
  const max = Math.max(1, ...data.map((d) => d.value))
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  const x = (i) => pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw)
  const y = (v) => pad.t + ih - (v / max) * ih
  const pts = data.map((d, i) => [x(i), y(d.value)])
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${x(data.length - 1)},${pad.t + ih} L${x(0)},${pad.t + ih} Z`
  const id = `g${color.replace('#', '')}`

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" style={{ height }} preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const rel = ((e.clientX - r.left) / r.width) * w
          let best = 0
          pts.forEach((p, i) => { if (Math.abs(p[0] - rel) < Math.abs(pts[best][0] - rel)) best = i })
          setHover(best)
        }}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {showGrid && [0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line key={t} x1={pad.l} x2={w - pad.r} y1={pad.t + ih * t} y2={pad.t + ih * t} stroke="rgba(255,255,255,0.07)" strokeDasharray="3 5" />
        ))}
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round"
          style={{ filter: `drop-shadow(0 4px 12px ${color}55)` }} />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r={hover === i ? 5 : 2.6} fill={hover === i ? color : '#0a0f18'} stroke={color} strokeWidth="2" />
          </g>
        ))}
        {hover !== null && (
          <line x1={pts[hover][0]} x2={pts[hover][0]} y1={pad.t} y2={pad.t + ih} stroke="rgba(255,255,255,0.22)" />
        )}
        {data.map((d, i) => (
          <text key={d.label + i} x={x(i)} y={h - 5} fill="#6c7890" fontSize="10" textAnchor="middle">{d.label}</text>
        ))}
      </svg>
      {hover !== null && (
        <div style={{
          position: 'absolute', left: `${(x(hover) / w) * 100}%`, top: 0, transform: 'translateX(-50%)',
          background: '#131b28', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 9, padding: '5px 9px',
          fontSize: 11, pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 3,
        }}>
          <b style={{ color }}>{format(data[hover].value)}</b>
          <span className="mut"> · {data[hover].label}</span>
        </div>
      )}
    </div>
  )
}

/* ---------- grouped bars ---------- */
export function Bars({ data, height = 195, currency = 'XOF' }) {
  const max = Math.max(1, ...data.flatMap((d) => [d.a || 0, d.b || 0]))
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height, padding: '0 2px' }}>
        {data.map((d, i) => (
          <div key={d.label + i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: '100%', width: '100%', justifyContent: 'center' }}>
              <div title={`${d.label} : ${fmtMoney(d.a, currency)}`} style={{
                width: '38%', maxWidth: 16, borderRadius: '5px 5px 2px 2px',
                height: `${Math.max(2, (d.a / max) * 100)}%`,
                background: 'linear-gradient(180deg,#c6f24e,#8fd21f)', transition: 'height .5s cubic-bezier(.2,.9,.3,1)',
              }} />
              {d.b !== undefined && (
                <div title={`${d.label} : ${fmtMoney(d.b, currency)}`} style={{
                  width: '38%', maxWidth: 16, borderRadius: '5px 5px 2px 2px',
                  height: `${Math.max(2, (d.b / max) * 100)}%`,
                  background: 'linear-gradient(180deg,#4cc9f0,#2b8fb3)', transition: 'height .5s cubic-bezier(.2,.9,.3,1)',
                }} />
              )}
            </div>
            <span style={{ fontSize: 10, color: '#6c7890' }}>{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- donut ---------- */
export function Donut({ data, size = 168, thickness = 22, centerLabel, centerValue }) {
  const total = data.reduce((a, b) => a + b.value, 0) || 1
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: '0 0 auto' }}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={thickness} />
          {data.map((d, i) => {
            const len = (d.value / total) * c
            const el = (
              <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={d.color} strokeWidth={thickness}
                strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-offset} strokeLinecap="round"
                style={{ transition: 'stroke-dasharray .6s ease' }} />
            )
            offset += len
            return el
          })}
        </g>
        <text x="50%" y="46%" textAnchor="middle" fill="#e9eef7" fontSize="17" fontWeight="700" fontFamily="Space Grotesk, sans-serif">
          {centerValue}
        </text>
        <text x="50%" y="58%" textAnchor="middle" fill="#8b97ad" fontSize="9.5">{centerLabel}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 120 }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <i style={{ width: 8, height: 8, borderRadius: 3, background: d.color, flex: '0 0 auto' }} />
            <span className="mut" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
            <b className="num">{Math.round((d.value / total) * 100)}%</b>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- sparkline ---------- */
export function Spark({ values, color = '#c6f24e', height = 30 }) {
  const max = Math.max(1, ...values)
  const w = 90
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, values.length - 1)) * w},${height - (v / max) * height}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width={w} height={height} style={{ overflow: 'visible' }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/* ---------- animated counter ---------- */
export function Counter({ value, duration = 900, format = (v) => Math.round(v).toLocaleString('fr-FR') }) {
  const [display, setDisplay] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    if(document.documentElement.dataset.motion==='reduced'||window.matchMedia('(prefers-reduced-motion: reduce)').matches){setDisplay(Number(value)||0);from.current=Number(value)||0;return}
    const start = performance.now()
    const a = from.current
    const b = Number(value) || 0
    let raf
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(a + (b - a) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
      else from.current = b
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <>{format(display)}</>
}
