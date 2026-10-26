import { jsPDF } from 'jspdf'
import autoTableImport from 'jspdf-autotable'

// CJS/ESM interop: the bundled default can be wrapped one level deep.
const autoTable = typeof autoTableImport === 'function' ? autoTableImport : autoTableImport.default
import { fmtMoney, fmtDate, fmtNum, fmtDateTime } from './format.js'

/* convert any image src (svg data-url, png, jpeg) to a PNG data-url jsPDF can embed */
export async function toPngDataUrl(src) {
  if (!src) return null
  if (/^data:image\/(png|jpeg|jpg)/i.test(src)) return src
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const size = 320
        const c = document.createElement('canvas')
        c.width = size
        c.height = size
        const ctx = c.getContext('2d')
        const ratio = Math.min(size / img.width, size / img.height)
        const w = img.width * ratio
        const h = img.height * ratio
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, size, size)
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        resolve(c.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

const INK = [16, 22, 31]
const MUTED = [110, 122, 140]


function header(doc, lot, kind, number, date, logoData) {
  const W = doc.internal.pageSize.getWidth()
  doc.setFillColor(...INK)
  doc.rect(0, 0, W, 34, 'F')
  if (logoData) {
    try { doc.addImage(logoData, 'PNG', 14, 7, 20, 20) } catch { /* ignore */ }
  }
  const x = logoData ? 40 : 16
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(lot.name || 'Mon Parking', x, 16)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.6)
  doc.setTextColor(198, 242, 78)
  doc.text((lot.tagline || 'Vente & location de véhicules').toUpperCase(), x, 21.5)
  doc.setTextColor(205, 214, 228)
  doc.text([lot.address, lot.city].filter(Boolean).join(' · ') || '—', x, 27)
  doc.text(lot.phone || '', x, 31)
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text(kind.toUpperCase(), W - 14, 15, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.6)
  doc.setTextColor(198, 242, 78)
  doc.text(number, W - 14, 21, { align: 'right' })
  doc.setTextColor(205, 214, 228)
  doc.setFontSize(8)
  doc.text(`Date : ${fmtDate(date)}`, W - 14, 26.5, { align: 'right' })
  if (lot.taxId) doc.text(`N° fiscal : ${lot.taxId}`, W - 14, 30.5, { align: 'right' })
}

function partyBlock(doc, y, client, lot) {
  const W = doc.internal.pageSize.getWidth()
  doc.setDrawColor(230, 234, 241)
  doc.setFillColor(247, 249, 252)
  doc.roundedRect(14, y, (W - 38) / 2, 30, 3, 3, 'FD')
  doc.roundedRect(W / 2 + 5, y, (W - 38) / 2, 30, 3, 3, 'FD')
  doc.setFontSize(6.8)
  doc.setTextColor(...MUTED)
  doc.text('FACTURÉ À', 18, y + 6)
  doc.text('ÉMIS PAR', W / 2 + 9, y + 6)
  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text((client?.name || 'Client comptant').slice(0, 46), 18, y + 12)
  doc.text((lot.name || '').slice(0, 46), W / 2 + 9, y + 12)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.4)
  doc.setTextColor(...MUTED)
  const cLines = [client?.phone, client?.email, client?.address, client?.taxId ? `N° fiscal ${client.taxId}` : ''].filter(Boolean)
  cLines.slice(0, 3).forEach((l, i) => doc.text(String(l).slice(0, 52), 18, y + 17.5 + i * 3.6))
  const oLines = [lot.phone, lot.email, lot.city].filter(Boolean)
  oLines.slice(0, 3).forEach((l, i) => doc.text(String(l).slice(0, 52), W / 2 + 9, y + 17.5 + i * 3.6))
  return y + 36
}

function totalsBlock(doc, y, sale, lot, currency) {
  const W = doc.internal.pageSize.getWidth()
  const rows = [
    ['Sous-total', fmtMoney(sale.subtotal ?? sale.total, currency)],
    ...(sale.discount ? [['Remise', `- ${fmtMoney(sale.discount, currency)}`]] : []),
    ...(sale.vatRate ? [[`TVA (${sale.vatRate} %)`, fmtMoney(sale.vatAmount, currency)]] : []),
  ]
  doc.setFontSize(8)
  rows.forEach(([k, v], i) => {
    doc.setTextColor(...MUTED)
    doc.text(k, W - 78, y + i * 5)
    doc.setTextColor(...INK)
    doc.text(v, W - 14, y + i * 5, { align: 'right' })
  })
  const ty = y + rows.length * 5
  doc.setFillColor(...INK)
  doc.rect(W - 80, ty, 66, 12, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.4)
  doc.text('TOTAL', W - 76, ty + 7.4)
  doc.setTextColor(198, 242, 78)
  doc.setFontSize(10.5)
  doc.text(fmtMoney(sale.total, currency), W - 17, ty + 7.8, { align: 'right' })
  const by = ty + 18
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.6)
  doc.setTextColor(...(Number(sale.paid) >= Number(sale.total) ? [30, 150, 100] : [180, 60, 80]))
  doc.text(`Déjà réglé : ${fmtMoney(sale.paid, currency)}`, W - 14, by, { align: 'right' })
  const due = Number(sale.total) - Number(sale.paid || 0)
  if (due > 0.5) doc.text(`Reste à payer : ${fmtMoney(due, currency)}`, W - 14, by + 4.6, { align: 'right' })
  else doc.text('SOLDÉ', W - 14, by + 4.6, { align: 'right' })
  return by + 10
}

function footer(doc, lot) {
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  doc.setDrawColor(230, 234, 241)
  doc.line(14, H - 22, W - 14, H - 22)
  doc.setFontSize(6.9)
  doc.setTextColor(...MUTED)
  doc.text((lot.footerNote || 'Merci de votre confiance.').slice(0, 130), 14, H - 17)
  doc.text(`${lot.name}${lot.taxId ? ` · ${lot.taxId}` : ''} · ${lot.phone || ''}`, 14, H - 13)
  doc.text(`Document généré par MON PARKING le ${new Date().toLocaleString('fr-FR')}`, 14, H - 9)
  doc.setFont('helvetica', 'italic')
  doc.text('Signature & cachet', W - 14, H - 12, { align: 'right' })
}

export async function buildInvoice(sale, lot) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const logo = await toPngDataUrl(lot.logo)
  const cur = lot.currency || 'XOF'
  const isRental = sale.type === 'location'
  header(doc, lot, isRental ? 'Facture de location' : 'Facture', sale.invoiceNumber, sale.date, logo)
  let y = partyBlock(doc, 42, sale.clientSnapshot, lot)

  const v = sale.vehicleSnapshot || {}
  autoTable(doc, {
    startY: y,
    head: [['Désignation', 'Année', 'Immatriculation', 'Kilométrage', 'Qté', 'P.U. HT', 'Total HT']],
    body: [[
      `${v.brand || ''} ${v.model || ''}${v.vin ? ` — VIN ${v.vin}` : ''}`,
      v.year || '—', v.plate || '—', v.mileage ? `${fmtNum(v.mileage)} km` : '—',
      isRental ? `${sale.rentalDays || 1} j` : '1',
      fmtMoney(isRental ? (sale.price / Math.max(1, sale.rentalDays || 1)) : sale.price, cur),
      fmtMoney(sale.price, cur),
    ]],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.8, cellPadding: 2.6, textColor: INK, lineColor: [232, 236, 243], lineWidth: 0.2 },
    headStyles: { fillColor: [16, 22, 31], textColor: [255, 255, 255], fontSize: 6.9, halign: 'left' },
    columnStyles: { 4: { halign: 'center' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  })
  y = doc.lastAutoTable.finalY + 7

  if (isRental) {
    doc.setFillColor(248, 250, 252)
    doc.roundedRect(14, y, 90, 20, 2, 2, 'F')
    doc.setFontSize(7.2)
    doc.setTextColor(...MUTED)
    doc.text('PÉRIODE DE LOCATION', 18, y + 6)
    doc.setTextColor(...INK)
    doc.setFontSize(8)
    doc.text(`${fmtDate(sale.rentalStart)} → ${fmtDate(sale.rentalEnd)}  (${sale.rentalDays} jours)`, 18, y + 12)
    doc.text(`Caution : ${fmtMoney(sale.deposit || 0, cur)}`, 18, y + 17)
    y += 26
  }

  if (sale.notes) {
    doc.setFontSize(7.4)
    doc.setTextColor(...MUTED)
    doc.text(`Note : ${sale.notes}`.slice(0, 160), 14, y)
    y += 6
  }

  totalsBlock(doc, y, sale, lot, cur)
  footer(doc, lot)
  return doc
}

async function smallReceiptHeader(doc, lot, title) {
  const W=doc.internal.pageSize.getWidth()
  const logo = await toPngDataUrl(lot.logo)
  doc.setFillColor(...INK)
  doc.rect(0, 0, W, 26, 'F')
  if (logo) { try { doc.addImage(logo, 'PNG', W / 2 - 6, 3, 12, 12) } catch {} }
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text((lot.name || 'Mon Parking').slice(0, 30), W / 2, logo ? 20 : 12, { align: 'center' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.2)
  doc.setTextColor(198, 242, 78)
  doc.text(title, W / 2, 24, { align: 'center' })

}

export async function buildReceipt(sale, lot) {
  const doc = new jsPDF({ unit: 'mm', format: [80, 160] })
  const W = doc.internal.pageSize.getWidth()
  const cur = lot.currency || 'XOF'
  await smallReceiptHeader(doc,lot,'REÇU DE PAIEMENT')

  let y = 32
  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.2)
  doc.text(sale.receiptNumber, W / 2, y, { align: 'center' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.4)
  doc.setTextColor(...MUTED)
  doc.text(fmtDate(sale.date), W / 2, y + 4, { align: 'center' })
  y += 10
  doc.setDrawColor(230, 234, 241)
  doc.line(6, y, W - 6, y)
  y += 5

  const line = (k, v, bold) => {
    doc.setFontSize(6.6)
    doc.setTextColor(...MUTED)
    doc.text(k, 6, y)
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setTextColor(...INK)
    const wrapped = doc.splitTextToSize(String(v), 42)
    doc.text(wrapped, W - 6, y, { align: 'right' })
    y += Math.max(4.6, wrapped.length * 3.4)
    doc.setFont('helvetica', 'normal')
  }
  line('Client', sale.clientSnapshot?.name || 'Comptant')
  const vv = sale.vehicleSnapshot || {}
  line('Véhicule', `${vv.brand || ''} ${vv.model || ''}`)
  line('Immatriculation', vv.plate || '—')
  line('Type', sale.type === 'location' ? 'Location' : 'Vente')
  line('Mode de paiement', sale.paymentMethod)
  doc.line(6, y, W - 6, y)
  y += 5
  line('Montant total', fmtMoney(sale.total, cur), true)
  line('Montant réglé', fmtMoney(sale.paid, cur), true)
  const due = Number(sale.total) - Number(sale.paid || 0)
  line(due > 0.5 ? 'Reste à payer' : 'Statut', due > 0.5 ? fmtMoney(due, cur) : 'SOLDÉ', true)
  doc.line(6, y, W - 6, y)
  y += 6
  doc.setFontSize(5.6)
  doc.setTextColor(...MUTED)
  doc.text(doc.splitTextToSize(lot.footerNote || 'Merci de votre confiance.', W - 14), W / 2, y, { align: 'center' })
  y += 10
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(5.8)
  doc.text('Signature', W / 2, y, { align: 'center' })
  return doc
}

export async function openDoc(doc, filename, mode = 'download') {
  if (mode === 'print') {
    const url = doc.output('bloburl')
    window.open(url, '_blank')
    return
  }
  doc.save(filename)
}

export function docDataUri(doc) {
  return doc.output('datauristring')
}

export async function buildStatement(lot, rows, totals, periodLabel) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const cur = lot.currency || 'XOF'
  const logo = await toPngDataUrl(lot.logo)
  header(doc, lot, 'Relevé comptable', periodLabel, new Date(), logo)
  autoTable(doc, {
    startY: 42,
    head: [['Date', 'Pièce', 'Type', 'Client', 'Véhicule', 'Statut', 'Total TTC', 'Encaissé', 'Reste']],
    body: rows.map((s) => [
      fmtDate(s.date), s.invoiceNumber, s.type === 'location' ? 'Location' : 'Vente',
      (s.clientSnapshot?.name || '—').slice(0, 26),
      `${s.vehicleSnapshot?.brand || ''} ${s.vehicleSnapshot?.plate || ''}`.slice(0, 26),
      s.status, fmtMoney(s.total, cur), fmtMoney(s.paid, cur), fmtMoney(Math.max(0, s.total - s.paid), cur),
    ]),
    theme: 'striped',
    styles: { fontSize: 6.9, cellPadding: 1.9, textColor: INK },
    headStyles: { fillColor: INK, textColor: [255, 255, 255], fontSize: 6.4 },
    columnStyles: { 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  })
  let y = doc.lastAutoTable.finalY + 8
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...INK)
  doc.text('Synthèse de la période', 14, y)
  y += 4
  autoTable(doc, {
    startY: y,
    body: [
      ['Chiffre d’affaires TTC', fmtMoney(totals.revenue, cur)],
      ['Encaissements', fmtMoney(totals.collected, cur)],
      ['Créances clients', fmtMoney(totals.receivable, cur)],
      ['Charges', fmtMoney(totals.expenses, cur)],
      ['Résultat net', fmtMoney(totals.result, cur)],
    ],
    theme: 'plain',
    styles: { fontSize: 8, cellPadding: 2, textColor: INK },
    columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: 14, right: 90 },
  })
  footer(doc, lot)
  return doc
}

export async function buildParkingReceipt(ticket, lot) {
  const doc = new jsPDF({ unit: 'mm', format: [80, 150] })
  const W = doc.internal.pageSize.getWidth()
  const cur = lot.currency || 'XOF'
  await smallReceiptHeader(doc,lot,'TICKET DE STATIONNEMENT')

  let y = 33
  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.2)
  doc.text(ticket.ref, W / 2, y, { align: 'center' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.4)
  doc.setTextColor(...MUTED)
  doc.text(ticket.paymentMethod ? `Payé par ${ticket.paymentMethod}` : 'Ticket en cours', W / 2, y + 4, { align: 'center' })
  y += 10
  doc.setDrawColor(230, 234, 241)
  doc.line(6, y, W - 6, y)
  y += 5

  const line = (k, v, bold) => {
    doc.setFontSize(6.7)
    doc.setTextColor(...MUTED)
    doc.text(k, 6, y)
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setTextColor(...INK)
    const wrapped = doc.splitTextToSize(String(v), 42)
    doc.text(wrapped, W - 6, y, { align: 'right' })
    y += Math.max(4.8, wrapped.length * 3.4)
    doc.setFont('helvetica', 'normal')
  }
  line('Immatriculation', ticket.plate, true)
  line('Place', `${ticket.spotCode || '—'} (${ticket.spotType || 'standard'})`)
  line('Entrée', fmtDateTime(ticket.entryAt))
  if (ticket.exitAt) line('Sortie', fmtDateTime(ticket.exitAt))
  line('Durée', ticket.billedMinutes ? `${ticket.billedMinutes} min` : 'en cours')
  line('Tarif horaire', fmtMoney(ticket.hourlyRate ?? lot.hourlyRate ?? 0, cur))
  doc.line(6, y, W - 6, y)
  y += 5
  if(ticket.lostTicket) line('Ticket perdu', fmtMoney(ticket.feeBreakdown?.lostFee ?? ticket.lostFee ?? ticket.lostTicketFee ?? 0,cur))
  if(ticket.feeBreakdown?.overstayFee || ticket.overstayFee) line('Dépassement',fmtMoney(ticket.feeBreakdown?.overstayFee ?? ticket.overstayFee,cur))
  line('TOTAL', fmtMoney(ticket.amount || 0, cur), true)
  doc.line(6, y, W - 6, y)
  y += 6
  doc.setFontSize(5.6)
  doc.setTextColor(...MUTED)
  doc.text(doc.splitTextToSize(lot.footerNote || 'Merci de votre visite.', W - 14), W / 2, y, { align: 'center' })
  y += 9
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(5.8)
  doc.text('Bon stationnement — conservez ce ticket', W / 2, y, { align: 'center' })
  return doc
}
