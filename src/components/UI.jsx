import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useId, isValidElement, cloneElement, Fragment } from 'react'
import { Check, X, AlertTriangle, Info, Inbox } from 'lucide-react'
import { classNames } from '../lib/format'
import { createToastApi, NOOP_TOAST, TOAST_KINDS } from '../lib/toastApi'

/* ---------------- toasts ---------------- */
const ToastCtx = createContext(NOOP_TOAST)
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = useCallback((message, kind = 'info') => {
    const id = Math.random().toString(36).slice(2)
    setItems((prev) => [...prev.slice(-3), { id, message, kind }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200)
  }, [])
  const api = useMemo(() => createToastApi(push), [push])

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast ${TOAST_KINDS.includes(t.kind) ? t.kind : 'info'}`}>
            {t.kind === 'ok' ? <Check /> : t.kind === 'err' ? <AlertTriangle /> : <Info />}
            <div>{t.message}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------------- primitives ---------------- */
export function Card({ children, className = '', ...rest }) {
  return (
    <div className={classNames('card', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardHead({ title, sub, right = null, icon: Icon = null }) {
  return (
    <div className="card-h">
      {Icon && <Icon style={{ width: 16, height: 16, color: 'var(--acc)' }} />}
      <div>
        <h3>{title}</h3>
        {sub && <div className="card-sub">{sub}</div>}
      </div>
      {right && <div style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>{right}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'default', dot = false }) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <i className="dot" />}
      {children}
    </span>
  )
}

export function Field({label,hint='',children,span=false}) {
 const generated=useId(),canLabel=isValidElement(children)&&children.type!==Fragment,id=canLabel?(children.props.id||generated):undefined
 return <div className="field" style={span?{gridColumn:`span ${span}`}:undefined}>
 {label&&<label htmlFor={id}>{label}</label>}
 {canLabel?cloneElement(children,{id,'aria-describedby':hint?`${generated}-hint`:children.props['aria-describedby']}):children}
 {hint&&<span className="hint" id={`${generated}-hint`}>{hint}</span>}</div>
}

export function Input(props) {
  return <input className="input" {...props} />
}
export function Select({ children, ...props }) {
  return <select className="select" {...props}>{children}</select>
}

export function IconBtn({ children, title = '', ...rest }) {
  return <button className="icon-btn" title={title} aria-label={title} {...rest}>{children}</button>
}

export function Empty({ icon: Icon = Inbox, title = '', text = '', action = null }) {
  return (
    <div className="empty">
      <Icon />
      <h4>{title}</h4>
      {text && <p>{text}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function Seg({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({ open, onClose, title = '', children, footer = null, wide = false, icon: Icon = null }) {
  const ref = useRef(null), headingId=useId(), closeRef=useRef(onClose)
  closeRef.current=onClose
  useEffect(() => {
    if(!open)return
    const previous=document.activeElement,overflow=document.body.style.overflow
    const focusable=()=>[...ref.current.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(e=>e.offsetParent!==null)
    const timer=setTimeout(()=>{const el=ref.current?.querySelector('input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')||focusable()[0];el?.focus()},0)
    const key=(e)=>{const top=[...document.querySelectorAll('[role="dialog"]')].at(-1);if(top!==ref.current)return;if(e.key==='Escape'){e.stopPropagation();closeRef.current?.()}if(e.key==='Tab'){const els=focusable(),first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}}
    document.addEventListener('keydown',key);document.body.style.overflow='hidden'
    return()=>{clearTimeout(timer);document.removeEventListener('keydown',key);document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus()}
  },[open])
  if (!open) return null
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className={classNames('modal', wide && 'wide')} ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div className="modal-h">
          {Icon && <Icon style={{ width: 17, height: 17, color: 'var(--acc)' }} />}
          <h3 id={headingId}>{title}</h3>
          <IconBtn onClick={onClose} title="Fermer" style={{ marginLeft: 'auto' }}><X /></IconBtn>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  )
}

export function Confirm({ open, onCancel, onConfirm, title, text, danger, confirmLabel = 'Confirmer', footerExtra = null }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title || 'Confirmation'}
      icon={danger ? AlertTriangle : Info}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
          <button className={classNames('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm}>{confirmLabel}</button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65, color: 'var(--muted)' }}>{text}</p>
      {footerExtra}
    </Modal>
  )
}

export function Switch({ on, onChange, label = '' }) {
  return (
    <button type="button" className={classNames('switch', on && 'on')} onClick={() => onChange(!on)} aria-label={label} aria-pressed={on} />
  )
}

export function Progress({ value, tone = 'default' }) {
  return (
    <div className="progress">
      <i style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: tone }} />
    </div>
  )
}

export function StatRow({ icon: Icon, title = '', sub = '', amount, onClick = null, right = null }) {
  return (
    <div className="list-row" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      {Icon && <div className="ico"><Icon /></div>}
      <div className="txt">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {right}
      {amount !== undefined && <div className="amt">{amount}</div>}
    </div>
  )
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.value} type="button" className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export const STATUS_TONE = {
  stock: 'ok', vendu: 'info', loue: 'warn', reserve: 'acc', maintenance: 'danger',
  payee: 'ok', partielle: 'warn', impayee: 'danger',
}
export const STATUS_LABEL = {
  stock: 'En stock', vendu: 'Vendu', loue: 'En location', reserve: 'Réservé', maintenance: 'Maintenance',
  payee: 'Payée', partielle: 'Partielle', impayee: 'Impayée',
}

export function StatusBadge({ status = '' }) {
  return <Badge tone={STATUS_TONE[status] || 'default'} dot>{STATUS_LABEL[status] || status}</Badge>
}
