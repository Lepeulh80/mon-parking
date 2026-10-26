import './experience.css'
import { initializeAppearance, applyUI, readAppearance } from './lib/experience'
import BackgroundAlerts from './components/BackgroundAlerts'
import ExperienceBar from './components/ExperienceBar'
import { routeAllowed } from './lib/permissions'
const Operations = lazy(() => import('./screens/Operations'))
import { createContext, useContext, useEffect, useMemo, useState, useRef, lazy, Suspense } from 'react'
import { restoreSession, signOut, switchSessionLot, notifyAuthChange } from './lib/authSession'
import { client as cloudClient } from './lib/supabase'
import {
  LayoutDashboard, Car, ShoppingCart, KeyRound, Users, FileText, Calculator,
  TrendingUp, Settings, LogOut, Menu, X, Wifi, WifiOff, Download, ChevronsUpDown, SquareParking,
} from 'lucide-react'
import { startParkingSync } from './lib/parkingSync'
import { startOcrSync } from './lib/ocrSync'
import { db, seedDemo } from './lib/db'
import { ensureParkingSetup, seedParkingDemo } from './lib/parking'
import { useRoute, navigate } from './lib/router'
import { ToastProvider, Badge } from './components/UI'
import Auth from './screens/Auth'
const Dashboard = lazy(() => import('./screens/Dashboard'))
const Stock = lazy(() => import('./screens/Stock'))
const Sales = lazy(() => import('./screens/Sales'))
const NewSale = lazy(() => import('./screens/NewSale'))
const Rentals = lazy(() => import('./screens/Rentals'))
const Clients = lazy(() => import('./screens/Clients'))
const Billing = lazy(() => import('./screens/Billing'))
const Accounting = lazy(() => import('./screens/Accounting'))
const Stats = lazy(() => import('./screens/Stats'))
const Admin = lazy(() => import('./screens/Admin'))
const Parking = lazy(() => import('./screens/Parking'))
const Sync = lazy(() => import('./screens/Sync'))
import { initials, classNames } from './lib/format'
import { useTranslation } from './lib/useI18n'

const ExperienceHub = lazy(() => import('./screens/ExperienceHub'))
initializeAppearance()

export const AppCtx = createContext(null)
export const useApp = () => useContext(AppCtx)

const NAV = [
  { group: 'nav.group.pilotage', items: [
    { to: '/dashboard', label: 'nav.dashboard', icon: LayoutDashboard },
    { to: '/experience', label: 'nav.experience', icon: Settings },
    { to: '/statistiques', label: 'nav.stats', icon: TrendingUp, admin: true },
  ] },
  { group: 'nav.group.operations', items: [
    { to: '/stock', label: 'nav.stock', icon: Car },
    { to: '/stationnement', label: 'nav.parking', icon: SquareParking },
    { to: '/exploitation', label: 'nav.team', icon: Users },
    { to: '/ventes', label: 'nav.sales', icon: ShoppingCart },
    { to: '/locations', label: 'nav.rentals', icon: KeyRound },
    { to: '/clients', label: 'nav.clients', icon: Users },
  ] },
  { group: 'nav.group.finance', items: [
    { to: '/facturation', label: 'nav.billing', icon: FileText },
    { to: '/comptabilite', label: 'nav.accounting', icon: Calculator, admin: true },
  ] },
  { group: 'nav.group.config', items: [
    { to: '/admin', label: 'nav.admin', icon: Settings, admin: true },
  ] },
]

const TITLES = {
  experience: ['title.experience', 'sub.experience'],
  dashboard: ['title.dashboard', 'sub.dashboard'],
  stock: ['title.stock', 'sub.stock'],
  stationnement: ['title.parking', 'sub.parking'],
  exploitation: ['title.team', 'sub.team'],
  sync: ['title.dashboard', 'sub.dashboard'],
  ventes: ['title.sales', 'sub.sales'],
  locations: ['title.rentals', 'sub.rentals'],
  clients: ['title.clients', 'sub.clients'],
  facturation: ['title.billing', 'sub.billing'],
  comptabilite: ['title.accounting', 'sub.accounting'],
  statistiques: ['title.stats', 'sub.stats'],
  admin: ['title.admin', 'sub.admin'],
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

function useInstallPrompt() {
  const [evt, setEvt] = useState(null)
  useEffect(() => {
    const h = (e) => { e.preventDefault(); setEvt(e) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])
  const install = async () => {
    if (!evt) return false
    evt.prompt()
    const res = await evt.userChoice
    setEvt(null)
    return res.outcome === 'accepted'
  }
  return { canInstall: !!evt, install }
}

function Shell({ session, onLogout, onSwitchLot }) {
  const { t } = useTranslation()
  useEffect(() => startOcrSync(session.lot.id), [session.lot.id])
  useEffect(() => startParkingSync(session.lot.id), [session.lot.id])
  const route = useRoute()
  const online = useOnline()
  const { canInstall, install } = useInstallPrompt()
  const [menuOpen, setMenuOpen] = useState(false)
  const [lotMenu, setLotMenu] = useState(false)
  const isAdmin = session.user.role === 'admin'
  const ADMIN_ONLY = { comptabilite: 1, statistiques: 1, admin: 1, sync: 1 }
  const [titleKey, subKey] = (!isAdmin && ADMIN_ONLY[route.segment])
    ? TITLES.dashboard
    : (TITLES[route.segment] || TITLES.dashboard)
  const title = t(titleKey)
  const sub = t(subKey)

  useEffect(() => { setMenuOpen(false); setLotMenu(false) }, [route.path])

  const items = NAV.map((g) => ({ ...g, items: g.items.filter((i) => (!i.admin || isAdmin) && routeAllowed(session.user, i.to.slice(1))) })).filter((g) => g.items.length)

  const page = useMemo(() => {
    if (!routeAllowed(session.user, route.segment)) return <div className="card"><h2>{t('app.restricted.title')}</h2><p>{t('app.restricted.text')}</p></div>
    switch (route.segment) {
      case 'experience': return <ExperienceHub />
      case 'exploitation': return <Operations />
      case 'stock': return <Stock />
      case 'stationnement': return <Parking />
      case 'sync': return <Sync />
      case 'ventes':
        return route.parts[1] === 'nouvelle' ? <NewSale /> : <Sales />
      case 'locations': return <Rentals />
      case 'clients': return <Clients />
      case 'facturation': return <Billing />
      case 'comptabilite': return isAdmin ? <Accounting /> : <Dashboard />
      case 'statistiques': return isAdmin ? <Stats /> : <Dashboard />
      case 'admin': return isAdmin ? <Admin /> : <Dashboard />
      default: return session.user.role === 'agent' ? <Operations /> : <Dashboard />
    }
  }, [route.segment, route.parts.join('/'), isAdmin, session.user.role, session.user.active])

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content" onClick={(e)=>{e.preventDefault();document.getElementById('main-content')?.focus()}}>{t('app.skip')}</a>
      <aside aria-label={t('common.nav.main')} className={classNames('sidebar', menuOpen && 'open')}>
        <div className="brand">
          <div className="brand-logo">
            {session.lot.logo ? <img src={session.lot.logo} alt="logo" /> : <Car size={20} />}
          </div>
          <div className="brand-txt">
            <strong>{t('app.name')}</strong>
            <span>{session.lot.name}</span>
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto', display: menuOpen ? 'grid' : 'none' }} onClick={() => setMenuOpen(false)}>
            <X />
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, margin: '0 -4px', padding: '0 4px' }}>
          {items.map((g) => (
            <div key={g.group}>
              <div className="nav-group-label">{t(g.group)}</div>
              {g.items.map((i) => (
                <a key={i.to} className={classNames('nav-item', route.path.startsWith(i.to) && 'on')} href={`#${i.to}`}>
                  <i.icon />
                  <span>{t(i.label)}</span>
                </a>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="row" style={{ marginBottom: 10, gap: 6 }}>
            <Badge tone={online ? 'ok' : 'danger'} dot>{t(online ? 'common.online' : 'common.offline')}</Badge>
            <Badge tone="acc">{t(isAdmin ? 'common.admin' : 'common.employee')}</Badge>
          </div>
          <button className="user-pill" onClick={onLogout}>
            <div className="avatar">{initials(session.user.name)}</div>
            <div className="meta">
              <b>{session.user.name}</b>
              <span>@{session.user.username} · {t('common.logout')}</span>
            </div>
            <LogOut style={{ width: 15, height: 15, color: 'var(--muted)', marginLeft: 'auto' }} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn" aria-label={t('common.nav.open')} onClick={() => setMenuOpen(true)} style={{ display: 'grid' }}>
            <Menu />
          </button>
          <div className="page-title">
            {title}
            <small>{sub}</small>
          </div>
          <div className="topbar-actions">
            {canInstall && (
              <button className="install-pill" onClick={install} title="Installer l'application sur cet appareil">
                <Download style={{ width: 13, height: 13 }} /> Installer
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <button className="btn btn-sm btn-ghost" onClick={() => setLotMenu((v) => !v)}>
                <Car style={{ width: 13, height: 13 }} />
                <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.lot.name}</span>
                <ChevronsUpDown style={{ width: 12, height: 12 }} />
              </button>
              {lotMenu && (
                <div style={{
                  position: 'absolute', right: 0, top: 'calc(100% + 8px)', minWidth: 260, zIndex: 60,
                  background: '#111826', border: '1px solid var(--line-2)', borderRadius: 13, padding: 7,
                  boxShadow: 'var(--shadow)',
                }}>
                  <div className="tiny mut" style={{ padding: '6px 9px' }}>MES PARKINGS</div>
                  {session.lots.map((l) => (
                    <button key={l.id} className="nav-item" style={{ width: '100%', border: 0, background: l.id === session.lot.id ? 'var(--acc-soft)' : 'transparent' }}
                      onClick={() => { setLotMenu(false); onSwitchLot(l) }}>
                      <span style={{ width: 22, height: 22, borderRadius: 6, overflow: 'hidden', background: '#1b2434', display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>
                        {l.logo ? <img src={l.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Car size={12} />}
                      </span>
                      <span style={{ flex: 1, textAlign: 'left', fontSize: 12.5 }}>{l.name}</span>
                      {l.id === session.lot.id && <span className="tiny" style={{ color: 'var(--acc)' }}>actif</span>}
                    </button>
                  ))}
                  {isAdmin && (
                    <a className="nav-item" href="#/admin" style={{ fontSize: 12.5 }}>
                      <Settings style={{ width: 14, height: 14 }} /> Gérer les parkings
                    </a>
                  )}
                </div>
              )}
            </div>
            <Badge tone={online ? 'ok' : 'danger'}>{online ? <Wifi style={{ width: 11, height: 11 }} /> : <WifiOff style={{ width: 11, height: 11 }} />}</Badge>
          </div>
        </header>

        <BackgroundAlerts lot={session.lot} user={session.user} />
        <ExperienceBar lot={session.lot} user={session.user} />
        <main className="content" id="main-content" tabIndex="-1"><Suspense fallback={<p role="status">{t('app.section.loading')}</p>}>{page}</Suspense></main>

        <nav aria-label={t('common.nav.mobile')} className="mobile-bottom">
          {[
            { to: '/dashboard', label: 'nav.home', icon: LayoutDashboard },
            { to: '/stock', label: 'nav.stock.short', icon: Car },
            { to: '/stationnement', label: 'nav.parking.short', icon: SquareParking },
            { to: '/ventes/nouvelle', label: 'nav.sell', icon: ShoppingCart },
            { to: '/facturation', label: 'nav.invoices', icon: FileText },
            { to: isAdmin ? '/admin' : '/experience', label: isAdmin ? 'nav.admin' : 'nav.settings', icon: Settings },
          ].map((i) => (
            <a key={i.to} href={`#${i.to}`} className={route.path === i.to ? 'on' : ''}>
              <i.icon />
              {t(i.label)}
            </a>
          ))}
        </nav>
      </div>
    </div>
  )
}

export default function App() {
  const { t } = useTranslation()
  // Réglages d'affichage (langue, devise, thème) dès le premier rendu, puis à
  // chaque enregistrement : un écran déjà monté se retraduit sans rechargement.
  useEffect(() => {
    const apply = (value) => { try { applyUI(value || readAppearance()) } catch { /* préférences illisibles : défauts */ } }
    apply()
    const sync = (event) => apply(event.detail)
    window.addEventListener('mp-appearance', sync)
    return () => window.removeEventListener('mp-appearance', sync)
  }, [])
  const [session, setSession] = useState(null)
  const [ready, setReady] = useState(false)
  const authEpoch = useRef(0)
  const pendingValidation = useRef(null)
  const hydrate = async (identity, epoch) => {
    // Only a freshly validated server response supplies identity and memberships.
    const { user, lot, memberships } = identity
    await db.transaction('rw',db.users,db.lots,async()=>{
      for(const member of memberships){
        const old=await db.lots.get(member.lot.id)
        await db.lots.put({ ...member.lot, ...old, id:member.lot.id })
        await db.users.put(member.user)
      }
    })
    await ensureParkingSetup(lot)
    await seedParkingDemo(lot)
    if(epoch!==authEpoch.current)return
    localStorage.removeItem('mp_session')
    const cached=await db.lots.get(lot.id)
    if(epoch===authEpoch.current)setSession({user,lot:cached||lot,lots:memberships.map(m=>m.lot)})
  }
  const validateSession = async () => {
    if(pendingValidation.current)return pendingValidation.current
    const epoch=++authEpoch.current
    const task=(async()=>{
      try {
        if(localStorage.getItem('mp_logout_pending')){
          setSession(null)
          await signOut()
          localStorage.removeItem('mp_logout_pending')
        }
        await hydrate(await restoreSession(),epoch)
      }
      catch { if(epoch===authEpoch.current)setSession(null) }
      finally { if(epoch===authEpoch.current)setReady(true) }
    })()
    pendingValidation.current=task
    try{return await task}finally{pendingValidation.current=null}
  }
  useEffect(() => {
    let stopped=false
    localStorage.removeItem('mp_session') // Old IDs/tokens never authenticate again.
    ;(async()=>{try{await seedDemo()}catch{/* Existing cache can still be used after server validation. */}if(!stopped)await validateSession()})()
    const check=()=>{if(!stopped)void validateSession()}
    const offline=()=>{++authEpoch.current;setSession(null);setReady(true)}
    let channel;try{channel=new BroadcastChannel('mp-auth');channel.onmessage=check}catch{/* Polling remains authoritative. */}
    window.addEventListener('focus',check);window.addEventListener('online',check)
    window.addEventListener('offline',offline);window.addEventListener('mp-auth-check',check)
    // Un onglet de caisse reste ouvert des heures : 2 s de sondage = 30 requêtes
    // SQLite/minute par onglet. Le focus, la visibilité, le retour réseau et la
    // diffusion inter-onglets couvrent déjà la réactivité ; le sondage n'est qu'un filet.
    const onVisible=()=>{if(document.visibilityState==='visible')check()}
    document.addEventListener('visibilitychange',onVisible)
    const timer=setInterval(check,15000)
    return()=>{stopped=true;++authEpoch.current;clearInterval(timer);channel?.close();document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('focus',check);window.removeEventListener('online',check);window.removeEventListener('offline',offline);window.removeEventListener('mp-auth-check',check)}
    // The listeners always ask the server; no captured local identity is trusted.
  }, [])
  const handleLogin = async () => { await validateSession();notifyAuthChange() }
  const handleLogout = async () => {
    localStorage.setItem('mp_logout_pending','1') // A lock only; never an authentication proof.
    ++authEpoch.current;setSession(null);setReady(false)
    try {
      await signOut()
      localStorage.removeItem('mp_logout_pending')
      await cloudClient()?.auth.signOut({scope:'local'})
    } catch {
      // No false claim that a server-side logout succeeded while disconnected.
      window.alert('Déconnexion serveur non confirmée. Reconnectez le réseau et réessayez avant de quitter ce poste.')
    } finally { ++authEpoch.current;setSession(null);setReady(true);notifyAuthChange();navigate('/dashboard') }
  }
  const switchLot = async (lot) => {
    const epoch=++authEpoch.current
    try{await hydrate(await switchSessionLot(lot.id),epoch);notifyAuthChange()}
    catch{setSession(null)}
  }

  if (!ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', color: 'var(--muted)', fontSize: 13 }}>
        <div style={{ textAlign: 'center' }}>
          <div className="brand-logo" style={{ margin: '0 auto 14px', width: 46, height: 46 }}><Car size={22} /></div>
          {t('app.loading')}
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      {session ? (
        <AppCtx.Provider value={{ ...session, isAdmin: session.user.role === 'admin', onSwitchLot: switchLot, refresh: validateSession }}>
          <Shell session={session} onLogout={handleLogout} onSwitchLot={switchLot} />
        </AppCtx.Provider>
      ) : (
        <Auth onLogin={handleLogin} />
      )}
    </ToastProvider>
  )
}
