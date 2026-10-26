/** Application permissions. These local checks do NOT replace server RLS. */
export const ROLE_LABELS = { admin: 'Administrateur', responsable: 'Responsable', caissier: 'Caissier', agent: 'Agent de parking', employe: 'Vendeur' }
const common = ['stock.read', 'attendance.self', 'incidents.report', 'operations.read']
const permissions = {
  admin: ['*'],
  responsable: [...common, 'planning.manage', 'attendance.manage', 'cash.open', 'cash.move', 'cash.review', 'incidents.manage', 'rates.manage', 'passes.issue', 'kpi.read', 'audit.read', 'parking.entry', 'parking.close', 'parking.override', 'sales.write', 'sales.collect'],
  caissier: [...common, 'cash.open', 'cash.move', 'parking.entry', 'parking.close', 'passes.issue', 'sales.write', 'sales.collect'],
  agent: [...common, 'parking.entry'],
  employe: [...common, 'cash.open', 'sales.write', 'sales.collect'],
}
export const hasPermission = (user, permission) => !!user?.active && (permissions[user.role]?.includes('*') || permissions[user.role]?.includes(permission))
export const PERMISSION_LIST = [...new Set(Object.values(permissions).flat())].filter((x) => x !== '*')
export const routeAllowed = (user, route) => {
  if (!user?.active) return false
  if (['admin', 'sync', 'comptabilite', 'statistiques'].includes(route)) return user.role === 'admin'
  if (['ventes', 'locations', 'clients', 'facturation'].includes(route)) return hasPermission(user, 'sales.write')
  if (route === 'stationnement') return hasPermission(user, 'parking.entry')
  return true
}
