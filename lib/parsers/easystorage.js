// Easy Storage Solutions deposit summary parser
// Columns: Date | Processed | Adjustments | Fees | Net Amount | Status
// Only imports rows with Status = "Processed"
// Uses Net Amount as income (positive)

function parseDate(str) {
  if (!str) return null
  // "1/1/2026 06:37PM" → strip time, parse date
  const datePart = str.toString().trim().split(' ')[0]
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

function parseDollar(str) {
  if (!str) return null
  const cleaned = parseFloat(str.toString().replace(/[$,\s]/g, ''))
  return isNaN(cleaned) ? null : cleaned
}

function getCol(row, ...names) {
  const keys = Object.keys(row)
  for (const name of names) {
    const key = keys.find(k => k.trim().toLowerCase() === name.toLowerCase())
    if (key !== undefined) return row[key]
  }
  return undefined
}

export function parseEasyStorage(rows) {
  return rows
    .map(row => {
      const status = (getCol(row, 'Status', 'status') || '').toString().trim().toLowerCase()
      if (status !== 'processed') return null

      const dateRaw = getCol(row, 'Date', 'date')
      const date = parseDate(dateRaw)
      if (!date) return null

      const netRaw = getCol(row, 'Net Amount', 'net amount', 'Net', 'net')
      const amount = parseDollar(netRaw)
      if (amount === null) return null

      return {
        date,
        description: 'Deposit ACH MerchPayout SV9T',
        original_description: 'Deposit ACH MerchPayout SV9T',
        amount: Math.abs(amount), // always positive — income
        source: 'easystorage',
        source_type: 'bank',
        is_autopayment: false,
        category_id: '',
      }
    })
    .filter(Boolean)
}

// Card fees withheld per processed deposit, summed by month:
// → [{ month: 'YYYY-MM', fee, deposits }]
// Revenue itself comes from the bank (net deposits); this only supplies the
// fee so the books can be grossed up. See lib/reports/processorFees.js.
export function parseEasyStorageFees(rows) {
  const byMonth = new Map()
  rows.forEach(row => {
    const status = (getCol(row, 'Status', 'status') || '').toString().trim().toLowerCase()
    if (status !== 'processed') return
    const date = parseDate(getCol(row, 'Date', 'date'))
    // Fees may be written -$1.23, ($1.23) or $1.23; the sign doesn't matter
    const fee = parseDollar((getCol(row, 'Fees', 'fees', 'Fee', 'fee') ?? '').toString().replace(/[()]/g, ''))
    if (!date || fee === null) return
    const month = date.slice(0, 7)
    const cur = byMonth.get(month) || { month, fee: 0, deposits: 0 }
    cur.fee += Math.abs(fee)
    cur.deposits++
    byMonth.set(month, cur)
  })
  return [...byMonth.values()]
    .map(m => ({ ...m, fee: Math.round(m.fee * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month))
}
