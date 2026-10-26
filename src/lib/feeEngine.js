/** v9. Billing blocks are elapsed 24h periods, NOT calendar midnights. */
export const DEFAULT_FEES = { billingMode: 'hourly', hourlyRate: 500, dailyRate: 6000, dailyCap: 6000, graceMinutes: 15, lostTicketFee: 0, maxStayHours: 24, overstayHourlyRate: 0 }
export function validateFees(input = {}) {
  const p = { ...DEFAULT_FEES, ...input }
  if (!['hourly','daily'].includes(p.billingMode)) throw new Error('Mode tarifaire invalide.')
  for (const k of ['hourlyRate','dailyRate','dailyCap','graceMinutes','lostTicketFee','maxStayHours','overstayHourlyRate']) {
    p[k] = Number(p[k]); if (!Number.isFinite(p[k]) || p[k] < 0) throw new Error(`Tarif invalide : ${k}`)
  }
  if (!Number.isInteger(p.graceMinutes) || p.graceMinutes > 1440 || p.maxStayHours <= 0) throw new Error('Franchise ou durée maximale invalide.')
  return Object.fromEntries(Object.keys(DEFAULT_FEES).map((key)=>[key,p[key]]))
}
export function calculateParkingFee(input) {
  const p = validateFees(Object.fromEntries(Object.entries(input).filter(([,v]) => v !== undefined && v !== null)))
  const entry = Date.parse(input.entryAt), exit = input.exitAt ? Date.parse(input.exitAt) : Date.now()
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || exit < entry) throw new Error('Dates de stationnement invalides.')
  const minutes = Math.ceil((exit-entry)/60000), billable = Math.max(0,minutes-p.graceMinutes)
  const fullDays = Math.floor(billable/1440), rest = billable%1440, hours = fullDays*24+Math.ceil(rest/60)
  let baseAmount
  if (p.billingMode === 'daily') baseAmount = Math.ceil(billable/1440) * (p.dailyCap > 0 ? Math.min(p.dailyRate,p.dailyCap) : p.dailyRate)
  else baseAmount = fullDays*(p.dailyCap > 0 ? Math.min(24*p.hourlyRate,p.dailyCap) : 24*p.hourlyRate) + (p.dailyCap > 0 ? Math.min(Math.ceil(rest/60)*p.hourlyRate,p.dailyCap) : Math.ceil(rest/60)*p.hourlyRate)
  const overdueHours = Math.ceil(Math.max(0,minutes-p.maxStayHours*60)/60)
  const overstayFee = input.subscriber ? 0 : overdueHours*p.overstayHourlyRate
  if (input.subscriber) baseAmount=0
  const lostFee = input.lostTicket ? p.lostTicketFee : 0
  const round=(v)=>Math.round(v*100)/100
  return { minutes, hours, days: Math.ceil(billable/1440), baseAmount:round(baseAmount), overstayFee:round(overstayFee), lostFee:round(lostFee), amount:round(baseAmount+overstayFee+lostFee), overdueHours,
    label: minutes>=60 ? `${Math.floor(minutes/60)} h ${String(minutes%60).padStart(2,'0')} min` : `${minutes} min`,
    billableLabel: billable>0 ? p.billingMode==='daily' ? `${Math.ceil(billable/1440)} tranche(s) de 24 h` : `${hours} h facturée(s)` : 'Dans la gratuité' }
}
