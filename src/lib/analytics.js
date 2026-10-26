import { monthBuckets, monthKey } from './format'

export const PAID = (s) => (s.status === 'payee' ? s.total : 0)

export function computeStats({ sales = [], vehicles = [], expenses = [], months = 6 }) {
  const now = new Date()
  const thisMonth = monthKey(now)
  const salesTotal = sales.reduce((a, s) => a + (Number(s.total) || 0), 0)
  const collected = sales.reduce((a, s) => a + (Number(s.paid) || 0), 0)
  const receivable = Math.max(0, salesTotal - collected)
  const expensesTotal = expenses.reduce((a, e) => a + (Number(e.amount) || 0), 0)
  const grossMargin = sales.reduce((a, s) => {
    const cost = Number(s.vehicleSnapshot?.purchasePrice) || Number(vehicles.find((v) => v.id === s.vehicleId)?.purchasePrice) || 0
    return a + ((Number(s.total) || 0) - cost)
  }, 0)
  const stockValue = vehicles.filter((v) => v.status === 'stock').reduce((a, v) => a + (Number(v.purchasePrice) || 0), 0)
  const stockRetail = vehicles.filter((v) => v.status === 'stock').reduce((a, v) => a + (Number(v.price) || 0), 0)
  const stockCount = vehicles.filter((v) => v.status === 'stock').length
  const soldCount = vehicles.filter((v) => v.status === 'vendu').length
  const rentedCount = vehicles.filter((v) => v.status === 'loue').length

  const monthSales = sales.filter((s) => monthKey(s.date) === thisMonth)
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMonth = monthKey(prevMonthDate)
  const prevSales = sales.filter((s) => monthKey(s.date) === prevMonth)

  const series = monthBuckets(months).map((b) => ({
    label: b.label,
    value: sales.filter((s) => monthKey(s.date) === b.key).reduce((a, s) => a + (Number(s.total) || 0), 0),
    count: sales.filter((s) => monthKey(s.date) === b.key).length,
  }))

  const expSeries = monthBuckets(months).map((b) => ({
    label: b.label,
    a: sales.filter((s) => monthKey(s.date) === b.key).reduce((a, s) => a + (Number(s.total) || 0), 0),
    b: expenses.filter((e) => monthKey(e.date) === b.key).reduce((a, x) => a + (Number(x.amount) || 0), 0),
  }))

  const employeeMap = new Map()
  for (const s of sales) {
    const key = s.userId || 'unknown'
    const row = employeeMap.get(key) || { id: key, name: s.userName || 'Inconnu', count: 0, revenue: 0, collected: 0 }
    row.count += 1
    row.revenue += Number(s.total) || 0
    row.collected += Number(s.paid) || 0
    employeeMap.set(key, row)
  }
  const employees = [...employeeMap.values()].sort((a, b) => b.revenue - a.revenue)

  const vehicleMap = new Map()
  for (const s of sales) {
    const key = `${s.vehicleSnapshot?.brand || ''} ${s.vehicleSnapshot?.model || ''}`.trim() || 'Inconnu'
    const row = vehicleMap.get(key) || { name: key, count: 0, revenue: 0 }
    row.count += 1
    row.revenue += Number(s.total) || 0
    vehicleMap.set(key, row)
  }
  const topVehicles = [...vehicleMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6)

  const methodMap = new Map()
  for (const s of sales) {
    const k = s.paymentMethod || 'espèces'
    methodMap.set(k, (methodMap.get(k) || 0) + (Number(s.paid) || 0))
  }
  const methods = [...methodMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)

  const categoryMap = new Map()
  for (const v of vehicles) {
    const k = v.category || 'Autre'
    categoryMap.set(k, (categoryMap.get(k) || 0) + 1)
  }
  const categories = [...categoryMap.entries()].map(([label, value]) => ({ label, value }))

  const netResult = collected - expensesTotal

  return {
    salesTotal, collected, receivable, expensesTotal, grossMargin, netResult,
    stockValue, stockRetail, stockCount, soldCount, rentedCount,
    monthRevenue: monthSales.reduce((a, s) => a + (Number(s.total) || 0), 0),
    monthCount: monthSales.length,
    prevRevenue: prevSales.reduce((a, s) => a + (Number(s.total) || 0), 0),
    prevCount: prevSales.length,
    series, expSeries, employees, topVehicles, methods, categories,
    totalSales: sales.length,
    vatCollected: sales.reduce((a, s) => a + (Number(s.vatAmount) || 0), 0),
    avgTicket: sales.length ? salesTotal / sales.length : 0,
    unpaidCount: sales.filter((s) => s.status !== 'payee').length,
    rentalActive: sales.filter((s) => s.type === 'location' && !s.returnedAt).length,
    rentalRevenue: sales.filter((s) => s.type === 'location').reduce((a, s) => a + (Number(s.total) || 0), 0),
    salesRevenue: sales.filter((s) => s.type === 'vente').reduce((a, s) => a + (Number(s.total) || 0), 0),
  }
}

export function growth(current, previous) {
  if (!previous) return current > 0 ? 100 : 0
  return ((current - previous) / previous) * 100
}

export function agingBuckets(sales) {
  const now = Date.now()
  const buckets = [
    { label: '0-30 j', min: 0, max: 30, value: 0, count: 0 },
    { label: '31-60 j', min: 31, max: 60, value: 0, count: 0 },
    { label: '61-90 j', min: 61, max: 90, value: 0, count: 0 },
    { label: '+90 j', min: 91, max: 1e9, value: 0, count: 0 },
  ]
  for (const s of sales) {
    const due = Number(s.total) - Number(s.paid || 0)
    if (due <= 0.5) continue
    const days = Math.floor((now - new Date(s.date).getTime()) / 86400000)
    const b = buckets.find((x) => days >= x.min && days <= x.max)
    if (b) { b.value += due; b.count += 1 }
  }
  return buckets
}
