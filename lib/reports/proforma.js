// Pro forma (next-year operating budget) computation helpers
//
// Each facility's pro forma is built from:
//   - a baseline: the trailing 3/6/9/12-month average of each category,
//     normalized to exclude CapEx, one-time items, and owner add-backs, and
//     drillable into vendors (grouped transaction descriptions)
//   - rent increases, shown as their own revenue rows on top of rental income
//   - manual lines (e.g. property tax paid in October)
//   - debt service (loan interest / principal), reported below NOI
//   - overrides: month-level edits that replace a row's computed value
//
// assumptions (version 3):
//   {
//     version: 3,
//     window: 3 | 6 | 9 | 12,
//     excludedCategories: { [categoryName]: boolean },   // explicit include/exclude
//     excludedVendors: { [categoryName]: [vendorKey] },  // dropped from the average
//     lineMethods: { [categoryName]: {                   // how a category is forecast (default: average)
//       method: 'average' | 'annual' | 'fixed',
//       amount,                   // annual: yearly total (null = trailing-12 total); fixed: per month
//       timing: 'spread' | 'months', months: [1-12],     // annual only
//     } },
//     rentIncreases: [{ id, month, type: 'pct' | 'dollar' | 'per_unit', value, units }],
//     manualLines: [{ id, name, type: 'income' | 'expense' | 'debt', frequency: 'monthly' | 'scheduled', amount, months }],
//   }
// overrides: { [rowKey]: { [month 1-12]: amount } } — rowKey is the category name or `manual:<id>`

import { filterTransactions } from '@/lib/reports/pl'

export const WINDOW_OPTIONS = [3, 6, 9, 12]

export const RENT_INCREASE_TYPES = [
  { value: 'pct', label: '% increase' },
  { value: 'dollar', label: '$ / month (total)' },
  { value: 'per_unit', label: '$ / unit / month' },
]

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const NORMALIZED_OUT = new Set(['capex', 'one_time', 'owner_addback'])

// Rent increases apply to every income category that is rental income
// ("Rental Income", "Rental Income (by Check)", …)
export function isRentCategory(name) {
  return /^rental income/i.test(name)
}

// Loan payments belong in Debt Service (below NOI), not operating expenses
export function isDebtServiceName(name) {
  return /loan service|mortgage|loan interest|loan principal|debt service/i.test(name || '')
}

export function defaultAssumptions() {
  return {
    version: 3,
    window: 12,
    excludedCategories: {},
    excludedVendors: {},
    lineMethods: {},
    rentIncreases: [],
    manualLines: [],
  }
}

// Upgrade assumptions saved by earlier versions of this page to the current
// shape, preserving what the user set:
//   v1 (baseline + per-line drivers) → v2 (window, exclusions, manual lines)
//   v2 → v3 (manual loan-payment lines move from expenses to debt service)
export function normalizeAssumptions(raw) {
  const a = raw?.version >= 2 ? { ...defaultAssumptions(), ...raw } : migrateV1(raw)
  if (a.version < 3) {
    a.manualLines = (a.manualLines || []).map(l =>
      l.type === 'expense' && isDebtServiceName(l.name) ? { ...l, type: 'debt' } : l
    )
    a.version = 3
  }
  return a
}

function migrateV1(raw) {
  const a = { ...defaultAssumptions(), ...(raw || {}) }
  a.version = 2
  a.window = raw?.baseline === 'last3_avg' ? 3 : 12
  a.excludedCategories = {}
  a.manualLines = []
  Object.entries(raw?.lines || {}).forEach(([name, cfg], i) => {
    const value = Number(cfg.value) || 0
    const id = `migrated-${i}`
    if (cfg.method === 'exclude') a.excludedCategories[name] = true
    else if (cfg.method === 'fixed') {
      a.excludedCategories[name] = true
      a.manualLines.push({ id, name, type: 'expense', frequency: 'monthly', amount: value, months: [] })
    } else if (cfg.method === 'scheduled') {
      a.excludedCategories[name] = true
      a.manualLines.push({ id, name, type: 'expense', frequency: 'scheduled', amount: value, months: cfg.months || [] })
    } else a.excludedCategories[name] = false
  })
  delete a.baseline
  delete a.lines
  return a
}

// Last fully completed month relative to `today`
export function lastCompleteMonth(today = new Date()) {
  const y = today.getFullYear()
  const m = today.getMonth() // 0-based → previous month as 1-based
  return m === 0 ? { year: y - 1, month: 12 } : { year: y, month: m }
}

// The 12 months ending at `end` (inclusive), oldest first
export function trailingMonths(end) {
  const out = []
  for (let i = 11; i >= 0; i--) {
    let m = end.month - i
    let y = end.year
    while (m < 1) { m += 12; y-- }
    out.push({ year: y, month: m })
  }
  return out
}

function monthKey({ year, month }) {
  return `${year}-${String(month).padStart(2, '0')}`
}

export function monthRangeLabel(months) {
  if (!months.length) return ''
  const a = months[0]
  const b = months[months.length - 1]
  return a.year === b.year
    ? `${MONTHS[a.month - 1]} – ${MONTHS[b.month - 1]} ${b.year}`
    : `${MONTHS[a.month - 1]} ${a.year} – ${MONTHS[b.month - 1]} ${b.year}`
}

// ── Vendor grouping ─────────────────────────────────────────────────
// Bank descriptions carry noise ("Withdrawal Debit Card … Card 0245",
// reference numbers, city/state). Strip it so the same vendor groups together.

const DESCRIPTION_PREFIXES = [
  /^RECURRING WITHDRAWAL DEBIT CARD\s+/,
  /^RECURRING WITHDRAWAL\s+/,
  /^WITHDRAWAL DEBIT CARD\s+/,
  /^WITHDRAWAL BILL PAYMENT\s+/,
  /^WITHDRAWAL ACH\s+/,
  /^WITHDRAWAL\s+/,
  /^DEPOSIT ACH\s+/,
  /^DEPOSIT\s+/,
  /^(POS|DEBIT CARD|PURCHASE|ACH|ONLINE)\s+/,
  /^(SQ|TST|SP|PP|PY|PAYPAL|ICI|DD|IN)\s*\*\s*/,
]

export function vendorKey(description) {
  let d = (description || '').toUpperCase().replace(/\(AUTOPAY\)/g, '').trim()
  let changed = true
  while (changed) {
    changed = false
    for (const re of DESCRIPTION_PREFIXES) {
      const next = d.replace(re, '').trim()
      if (next !== d) { d = next; changed = true }
    }
  }
  d = d
    .replace(/\bCARD\s+\d{4}\b/g, ' ')
    .replace(/#\s*\d+/g, ' ')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, ' ') // phone numbers
    .replace(/[*]/g, ' ')
    .replace(/\b[A-Z0-9]*\d[A-Z0-9]*\b/g, ' ')          // tokens containing digits (refs, store #s)
    .replace(/[^A-Z&'.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Drop a trailing state / country code
  d = d.replace(/\s+[A-Z]{2}$/, '')
  if (/^BY CHECK\b/.test(d)) return 'CHECK DEPOSIT'
  let words = d.split(' ').filter(Boolean)
    .map(w => (/\.(COM|NET|ORG|IO)$/.test(w) ? w : w.replace(/[.,]+$/, '')))
    .filter(Boolean)
  // Stop after a company suffix ("VERCEL INC. COVINA" → "VERCEL INC")
  const suffix = words.findIndex(w => /^(INC|LLC|CORP|CO|LTD|LP)\.?,?$/.test(w) || /\.(COM|NET|ORG|IO)$/.test(w))
  if (suffix >= 0) words = words.slice(0, suffix + 1)
  // Otherwise keep the leading words; one more when a connector sits inside ("CITY OF AVON PARK")
  const limit = words.slice(0, 3).some(w => ['OF', 'AND', '&', 'THE'].includes(w)) ? 4 : 3
  words = words.slice(0, limit)
  // Trailing fragments like "ST" (from "ST GEORGE") aren't part of the name
  while (words.length > 1 && words[words.length - 1].length <= 2 && words[words.length - 1] !== '&') words.pop()
  return words.join(' ').replace(/[.,-]+$/, '') || 'OTHER'
}

export function vendorLabel(key) {
  return key
    .toLowerCase()
    .replace(/\b([a-z])/g, c => c.toUpperCase())
    .replace(/\b(Llc|Ach|Usa|Utl|Lp)\b/g, w => w.toUpperCase())
    .replace(/\.(Com|Net|Org|Io)\b/g, w => w.toLowerCase())
    .replace(/\b(Of|And|The)\b/g, (w, _, i) => (i === 0 ? w : w.toLowerCase()))
}

// ── Trailing actuals ────────────────────────────────────────────────
// { byCategory: { [name]: { type, monthly[12], vendors: { [key]: { key, label, monthly[12], txs[] } } } }, uncategorized }
export function buildTrailingActuals(transactions, categories, companyId, months) {
  const index = Object.fromEntries(months.map((m, i) => [monthKey(m), i]))
  const catById = Object.fromEntries(categories.map(c => [c.id, c]))
  const scoped = filterTransactions(
    transactions.filter(t =>
      t.company_id === companyId &&
      index[t.date.slice(0, 7)] !== undefined &&
      !NORMALIZED_OUT.has(t.expense_type)
    ),
    'detailed'
  )

  const byCategory = {}
  let uncategorized = 0
  scoped.forEach(t => {
    const cat = t.category_id ? catById[t.category_id] : null
    if (!cat) { uncategorized += Math.abs(t.amount); return }
    const i = index[t.date.slice(0, 7)]
    // Income: positive = revenue. Expense: negative = cost, positive = refund.
    const amt = cat.type === 'income' ? Number(t.amount) : -Number(t.amount)
    const c = byCategory[cat.name] ||= { type: cat.type, monthly: Array(12).fill(0), vendors: {} }
    c.monthly[i] += amt
    const key = vendorKey(t.description)
    const v = c.vendors[key] ||= { key, label: vendorLabel(key), monthly: Array(12).fill(0), txs: [] }
    v.monthly[i] += amt
    v.txs.push({ id: t.id, date: t.date, description: t.description, amount: amt, monthIdx: i })
  })
  return { byCategory, uncategorized }
}

// The uplift each rent increase adds per month, applied in effective-month order
function rentUplifts(rentBase, increases) {
  const sorted = [...increases].sort((a, b) => a.month - b.month)
  const uplift = Object.fromEntries(sorted.map(inc => [inc.id, Array(12).fill(0)]))
  for (let i = 0; i < 12; i++) {
    let running = rentBase[i]
    sorted.forEach(inc => {
      if (Number(inc.month) > i + 1) return
      const v = Number(inc.value) || 0
      const next = inc.type === 'pct' ? running * (1 + v / 100)
        : inc.type === 'per_unit' ? running + v * (Number(inc.units) || 0)
        : running + v
      uplift[inc.id][i] = next - running
      running = next
    })
  }
  return uplift
}

export function rentIncreaseLabel(inc) {
  const v = Number(inc.value) || 0
  const amount = inc.type === 'pct' ? `${v}%`
    : inc.type === 'per_unit' ? `$${v}/unit × ${Number(inc.units) || 0} units`
    : `$${v.toLocaleString()}/mo`
  return `${amount} from ${MONTHS[(inc.month || 1) - 1]}`
}

function manualValues(line) {
  const amount = Number(line.amount) || 0
  if (line.frequency === 'monthly') return Array(12).fill(amount)
  const months = line.months || []
  return Array.from({ length: 12 }, (_, i) => (months.includes(i + 1) ? amount / months.length : 0))
}

export const LINE_METHODS = [
  { value: 'average', label: 'Trailing average' },
  { value: 'annual', label: 'Annual payment' },
  { value: 'fixed', label: 'Fixed amount' },
]

export function lineMethodDetail(cfg, amount) {
  if (cfg.method === 'fixed') return `Fixed · $${Math.round(amount).toLocaleString()}/mo`
  if (cfg.method !== 'annual') return null
  const total = `$${Math.round(amount).toLocaleString()}/yr`
  if (cfg.timing === 'months') {
    const months = (cfg.months || []).map(m => MONTHS[m - 1])
    return `Annual ${total} · ${months.length ? `paid ${months.join(', ')}` : 'no months selected'}`
  }
  return `Annual ${total} · spread monthly`
}

// Calendar months an annual item was actually paid in, for defaulting its timing
function paidMonths(monthly12, ttm) {
  const paid = ttm.map((m, i) => ({ month: m.month, amt: monthly12[i] })).filter(x => x.amt > 0)
  if (paid.length === 0) return []
  if (paid.length <= 4) return paid.map(x => x.month).sort((a, b) => a - b)
  return [paid.reduce((best, x) => (x.amt > best.amt ? x : best)).month]
}

export function manualLineDetail(line) {
  if (line.frequency === 'monthly') return 'Every month'
  const months = (line.months || []).map(m => MONTHS[m - 1])
  return months.length ? months.join(', ') : 'No months selected'
}

const sum = arr => arr.reduce((s, x) => s + x, 0)
const zeros = () => Array(12).fill(0)
const addArrays = (a, b) => a.map((x, i) => x + b[i])

// Build one facility's pro forma.
// `includedCategories` (Set of names, optional) is the default operating set —
// categories outside it start excluded unless the user has included them.
export function computeProForma({ transactions, categories, companyId, assumptions, overrides, asOf, includedCategories }) {
  const a = normalizeAssumptions(assumptions)
  const ov = overrides || {}
  const ttm = trailingMonths(asOf || lastCompleteMonth())
  const { byCategory, uncategorized } = buildTrailingActuals(transactions, categories, companyId, ttm)
  const catByName = Object.fromEntries(categories.map(c => [c.name, c]))
  const sortOrder = name => catByName[name]?.sort_order ?? 999

  const isExcluded = name => {
    if (a.excludedCategories[name] !== undefined) return a.excludedCategories[name]
    return includedCategories?.size ? !includedCategories.has(name) : false
  }

  // Months the facility was operating: from its first included income onward
  const operatingIncome = ttm.map((_, i) =>
    Object.entries(byCategory)
      .filter(([name, c]) => c.type === 'income' && !isExcluded(name))
      .reduce((s, [, c]) => s + c.monthly[i], 0)
  )
  const firstOperating = operatingIncome.findIndex(v => v > 0)
  const startIdx = firstOperating === -1 ? 0 : firstOperating
  const windowStart = Math.max(12 - a.window, startIdx)
  const windowMonths = ttm.slice(windowStart)
  const avgOf = monthly => (windowMonths.length ? sum(monthly.slice(windowStart)) / windowMonths.length : 0)

  // A category's trailing-12 monthly amounts, without excluded vendors
  function ttmMonthly(c, droppedVendors) {
    return Object.values(c.vendors)
      .filter(v => !droppedVendors.has(v.key))
      .reduce((acc, v) => addArrays(acc, v.monthly), zeros())
  }

  function withOverrides(key, computed) {
    const lineOv = ov[key] || {}
    const overridden = computed.map((_, i) => lineOv[i + 1] !== undefined && lineOv[i + 1] !== null)
    const values = computed.map((c, i) => (overridden[i] ? Number(lineOv[i + 1]) : c))
    return { computed, values, overridden, total: sum(values) }
  }

  const categoryRows = { income: [], expense: [], debt: [] }
  const excluded = []
  Object.entries(byCategory)
    .sort(([x], [y]) => sortOrder(x) - sortOrder(y) || x.localeCompare(y))
    .forEach(([name, c]) => {
      const droppedVendors = new Set(a.excludedVendors[name] || [])
      const cfg = { method: 'average', ...(a.lineMethods?.[name] || {}) }
      const annual = cfg.method === 'annual'
      const vendors = Object.values(c.vendors)
        .map(v => {
          const total12 = sum(v.monthly)
          return {
            key: v.key,
            label: v.label,
            // Annual items are sized from the full trailing 12 months, not the window
            avg: annual ? total12 / 12 : avgOf(v.monthly),
            total12,
            excluded: droppedVendors.has(v.key),
            txs: (annual ? v.txs : v.txs.filter(t => t.monthIdx >= windowStart))
              .sort((x, y) => y.date.localeCompare(x.date)),
            inWindow: v.txs.some(t => t.monthIdx >= windowStart),
          }
        })
        .sort((x, y) => Math.abs(y.avg) - Math.abs(x.avg))
      const included = vendors.filter(v => !v.excluded)
      const windowAvg = included.reduce((s, v) => s + avgOf(c.vendors[v.key].monthly), 0)
      const monthly12 = ttmMonthly(c, droppedVendors)
      const trailing12 = sum(monthly12)

      if (isExcluded(name)) {
        const trailingAvg = avgOf(c.monthly)
        if (Math.round(trailingAvg) !== 0) excluded.push({ name, type: c.type, avg: trailingAvg })
        return
      }
      // Hide categories with no activity in the last 12 months
      if (vendors.length === 0) return

      let computed
      let amount = null
      if (cfg.method === 'fixed') {
        amount = Number(cfg.amount) || 0
        computed = Array(12).fill(amount)
      } else if (annual) {
        amount = cfg.amount === null || cfg.amount === undefined ? trailing12 : Number(cfg.amount) || 0
        const months = cfg.timing === 'months' ? (cfg.months || []) : null
        computed = months
          ? Array.from({ length: 12 }, (_, i) => (months.includes(i + 1) ? amount / months.length : 0))
          : Array(12).fill(amount / 12)
      } else {
        computed = Array(12).fill(windowAvg)
      }

      const section = c.type === 'expense' && isDebtServiceName(name) ? 'debt' : c.type
      categoryRows[section].push({
        key: name,
        kind: 'category',
        name,
        type: c.type,
        avg: windowAvg,
        method: cfg.method,
        methodConfig: cfg,
        detail: lineMethodDetail(cfg, amount),
        trailing12,
        paidMonths: paidMonths(monthly12, ttm),
        vendors: annual ? vendors : vendors.filter(v => v.inWindow),
        ...withOverrides(name, computed),
      })
    })

  // Rent increases, stacked on the (post-override) rental income rows
  const rentBase = categoryRows.income
    .filter(r => isRentCategory(r.name))
    .reduce((acc, r) => addArrays(acc, r.values), zeros())
  const uplifts = rentUplifts(rentBase, a.rentIncreases || [])
  const rentRows = [...(a.rentIncreases || [])]
    .sort((x, y) => x.month - y.month)
    .map(inc => ({
      key: `rent:${inc.id}`,
      kind: 'rent',
      id: inc.id,
      name: 'Rent increase',
      detail: rentIncreaseLabel(inc),
      type: 'income',
      avg: null,
      computed: uplifts[inc.id],
      values: uplifts[inc.id],
      overridden: zeros().map(() => false),
      total: sum(uplifts[inc.id]),
    }))

  const manualRows = type => (a.manualLines || [])
    .filter(l => l.type === type)
    .map(l => ({
      key: `manual:${l.id}`,
      kind: 'manual',
      id: l.id,
      name: l.name || 'Untitled',
      detail: manualLineDetail(l),
      type,
      avg: null,
      ...withOverrides(`manual:${l.id}`, manualValues(l)),
    }))

  const incomeRows = [...categoryRows.income, ...rentRows, ...manualRows('income')]
  const expenseRows = [...categoryRows.expense, ...manualRows('expense')]
  const debtRows = [...categoryRows.debt, ...manualRows('debt')]
  const totalOf = rows => rows.reduce((acc, r) => addArrays(acc, r.values), zeros())
  const revenue = totalOf(incomeRows)
  const expenses = totalOf(expenseRows)
  const noi = revenue.map((r, i) => r - expenses[i])
  const debtService = totalOf(debtRows)
  const cashFlow = noi.map((n, i) => n - debtService[i])

  return {
    income: incomeRows,
    expenses: expenseRows,
    debt: debtRows,
    excluded,
    uncategorized,
    window: {
      requested: a.window,
      months: windowMonths,
      count: windowMonths.length,
      label: monthRangeLabel(windowMonths),
      limitedByOperating: startIdx > 12 - a.window,
    },
    totals: {
      revenue, expenses, noi,
      revenueTotal: sum(revenue),
      expenseTotal: sum(expenses),
      noiTotal: sum(noi),
      debtService, cashFlow,
      debtServiceTotal: sum(debtService),
      cashFlowTotal: sum(cashFlow),
      trailingDebtAvg: categoryRows.debt.reduce((s, r) => s + r.avg, 0),
      trailingRevenueAvg: categoryRows.income.reduce((s, r) => s + r.avg, 0),
      trailingExpenseAvg: categoryRows.expense.reduce((s, r) => s + r.avg, 0),
    },
  }
}

// Sum several facility pro formas into one read-only consolidated view
export function consolidateProFormas(list) {
  const merge = rows => {
    const map = new Map()
    rows.forEach(r => {
      const key = r.kind === 'rent' ? 'rent' : r.kind === 'manual' ? `manual:${r.name}` : r.key
      if (!map.has(key)) {
        map.set(key, {
          ...r,
          key,
          name: r.kind === 'rent' ? 'Rent increases' : r.name,
          detail: r.kind === 'category' ? undefined : 'All facilities',
          avg: r.avg === null ? null : 0,
          values: zeros(),
          overridden: zeros().map(() => false),
          total: 0,
          vendors: r.vendors ? [] : undefined,
        })
      }
      const m = map.get(key)
      if (r.avg !== null) m.avg += r.avg
      m.values = addArrays(m.values, r.values)
      m.total += r.total
      ;(r.vendors || []).forEach(v => {
        const existing = m.vendors.find(x => x.key === v.key)
        if (existing) {
          existing.avg += v.avg
          existing.txs = [...existing.txs, ...v.txs].sort((x, y) => y.date.localeCompare(x.date))
        } else m.vendors.push({ ...v, txs: [...v.txs] })
      })
      m.vendors?.sort((x, y) => Math.abs(y.avg) - Math.abs(x.avg))
    })
    const kindOrder = { category: 0, rent: 1, manual: 2 }
    return [...map.values()].sort((x, y) => kindOrder[x.kind] - kindOrder[y.kind])
  }
  const sumTotals = key => list.reduce((acc, p) => addArrays(acc, p.totals[key]), zeros())
  const sumKey = key => list.reduce((s, p) => s + p.totals[key], 0)
  const excludedMap = {}
  list.forEach(p => p.excluded.forEach(e => {
    excludedMap[e.name] ||= { ...e, avg: 0 }
    excludedMap[e.name].avg += e.avg
  }))

  return {
    income: merge(list.flatMap(p => p.income)),
    expenses: merge(list.flatMap(p => p.expenses)),
    debt: merge(list.flatMap(p => p.debt)),
    excluded: Object.values(excludedMap),
    uncategorized: list.reduce((s, p) => s + p.uncategorized, 0),
    window: null,
    totals: {
      revenue: sumTotals('revenue'),
      expenses: sumTotals('expenses'),
      noi: sumTotals('noi'),
      revenueTotal: sumKey('revenueTotal'),
      expenseTotal: sumKey('expenseTotal'),
      noiTotal: sumKey('noiTotal'),
      debtService: sumTotals('debtService'),
      cashFlow: sumTotals('cashFlow'),
      debtServiceTotal: sumKey('debtServiceTotal'),
      cashFlowTotal: sumKey('cashFlowTotal'),
      trailingDebtAvg: sumKey('trailingDebtAvg'),
      trailingRevenueAvg: sumKey('trailingRevenueAvg'),
      trailingExpenseAvg: sumKey('trailingExpenseAvg'),
    },
  }
}

// Accounting format: 1,234 / (1,234) / – ; whole dollars
export function formatAccounting(amount, { dollar = false } = {}) {
  const n = Math.round(amount || 0)
  if (n === 0) return '–'
  const s = Math.abs(n).toLocaleString('en-US')
  const body = dollar ? `$${s}` : s
  return n < 0 ? `(${body})` : body
}

export function formatWhole(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount)
}
