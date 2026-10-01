// CSV export helpers shared by the report pages
import Papa from 'papaparse'

// Round money to cents so floating-point noise doesn't reach the spreadsheet
export function money(n) {
  if (n === null || n === undefined || n === '') return ''
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : ''
}

export function pct(n, digits = 1) {
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : ''
}

// "Pro Forma", "Avon Park", 2027 → "pro-forma-avon-park-2027.csv"
export function csvFilename(...parts) {
  const slug = parts
    .filter(p => p !== null && p !== undefined && p !== '')
    .join(' ')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'export'}.csv`
}

// rows: array of arrays. Triggers a browser download.
export function downloadCSV(filename, rows) {
  const csv = Papa.unparse(rows.map(r => r.map(c => (c === null || c === undefined ? '' : c))))
  // BOM so Excel opens UTF-8 (en dashes, accents) correctly
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Rows for one or more P&Ls side by side (months, entities, or a single period).
// columns: [{ label, pl }] where pl comes from buildPL(). `total` adds a summed
// column; pass false when the columns already include a total (e.g. Portfolio).
export function plRows(columns, { total = columns.length > 1, totalLabel = 'Total', marginRow = true } = {}) {
  const names = key => {
    const sums = {}
    columns.forEach(c => c.pl[key].forEach(([n, amt]) => { sums[n] = (sums[n] || 0) + amt }))
    return Object.keys(sums).sort((a, b) => sums[b] - sums[a])
  }
  const line = (label, pick) => {
    const values = columns.map(c => pick(c.pl))
    return [label, ...values.map(money), ...(total ? [money(values.reduce((s, v) => s + v, 0))] : [])]
  }
  const amount = (key, name) => pl => pl[key].find(([n]) => n === name)?.[1] || 0
  const blank = Array(columns.length + (total ? 1 : 0)).fill('')

  const rows = [
    ['Category', ...columns.map(c => c.label), ...(total ? [totalLabel] : [])],
    ['Income', ...blank],
    ...names('income').map(n => line(n, amount('income', n))),
    line('Total Income', pl => pl.totalIncome),
    ['Expenses', ...blank],
    ...names('expenses').map(n => line(n, amount('expenses', n))),
    line('Total Expenses', pl => pl.totalExpenses),
    line('Net Operating Income', pl => pl.noi),
  ]
  if (marginRow) {
    const margin = (noi, income) => (income > 0 ? pct(noi / income * 100) : '')
    const totalIncome = columns.reduce((s, c) => s + c.pl.totalIncome, 0)
    const totalNOI = columns.reduce((s, c) => s + c.pl.noi, 0)
    rows.push([
      'NOI Margin %',
      ...columns.map(c => margin(c.pl.noi, c.pl.totalIncome)),
      ...(total ? [margin(totalNOI, totalIncome)] : []),
    ])
  }
  return rows
}
