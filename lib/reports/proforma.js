// Pro forma (next-year budget) computation helpers
//
// A pro forma is built per facility (company) per year from:
//   - trailing-12-month actuals (the baseline), normalized to exclude
//     CapEx, one-time items, and owner add-backs
//   - assumptions: baseline method, per-line drivers, and rent increases
//   - overrides: manual month-level edits that replace the computed value
//
// assumptions shape:
//   {
//     baseline: 'ttm_avg' | 'last3_avg' | 'seasonal',
//     rentIncreases: [{ id, month, type: 'pct' | 'dollar' | 'per_unit', value, units }],
//     lines: { [categoryName]: { method: 'growth' | 'pct_income' | 'fixed' | 'exclude', value } },
//   }
// overrides shape: { [categoryName]: { [month 1-12]: amount } }

import { filterTransactions, buildPL } from '@/lib/reports/pl'

export const RENT_CATEGORY = 'Rental Income'

export const BASELINE_OPTIONS = [
  { value: 'ttm_avg', label: 'Trailing 12-month average' },
  { value: 'last3_avg', label: 'Last 3-month average (run rate)' },
  { value: 'seasonal', label: 'Same month, trailing 12 (seasonal)' },
]

export const METHOD_OPTIONS = [
  { value: 'growth', label: 'Baseline + growth %', unit: '%' },
  { value: 'pct_income', label: '% of total income', unit: '%', expenseOnly: true },
  { value: 'fixed', label: 'Fixed $ / month', unit: '$' },
  { value: 'exclude', label: 'Exclude', unit: null },
]

export const RENT_INCREASE_TYPES = [
  { value: 'pct', label: '% increase' },
  { value: 'dollar', label: '$ / month (total)' },
  { value: 'per_unit', label: '$ / unit / month' },
]

const NORMALIZED_OUT = new Set(['capex', 'one_time', 'owner_addback'])

export function defaultAssumptions() {
  return { baseline: 'ttm_avg', rentIncreases: [], lines: {} }
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

// Per-category trailing-12 actuals for one company:
// { income: { name: [12] }, expenses: { name: [12] }, uncategorized: number }
export function buildTrailingActuals(transactions, categories, companyId, months) {
  const keys = new Set(months.map(monthKey))
  const scoped = filterTransactions(
    transactions.filter(t =>
      t.company_id === companyId &&
      keys.has(t.date.slice(0, 7)) &&
      !NORMALIZED_OUT.has(t.expense_type)
    ),
    'detailed'
  )

  const income = {}
  const expenses = {}
  let uncategorized = 0
  months.forEach((mo, i) => {
    const key = monthKey(mo)
    const pl = buildPL(scoped.filter(t => t.date.startsWith(key)), categories)
    const add = (bucket, name, amt) => {
      if (name === 'Uncategorized') { uncategorized += Math.abs(amt); return }
      if (!bucket[name]) bucket[name] = Array(12).fill(0)
      bucket[name][i] += amt
    }
    pl.income.forEach(([name, amt]) => add(income, name, amt))
    pl.expenses.forEach(([name, amt]) => add(expenses, name, amt))
  })
  return { income, expenses, uncategorized }
}

// Baseline amount for each calendar month (index 0 = Jan)
function baselineByMonth(actual, months, method) {
  const sum = arr => arr.reduce((s, v) => s + v, 0)
  if (method === 'seasonal') {
    const out = Array(12).fill(0)
    months.forEach((mo, i) => { out[mo.month - 1] = actual[i] })
    return out
  }
  const avg = method === 'last3_avg' ? sum(actual.slice(-3)) / 3 : sum(actual) / 12
  return Array(12).fill(avg)
}

// Rental income for one month after rent increases effective on/before it
function applyRentIncreases(amount, month, increases) {
  return [...increases]
    .filter(inc => Number(inc.month) <= month)
    .sort((a, b) => a.month - b.month)
    .reduce((amt, inc) => {
      const v = Number(inc.value) || 0
      if (inc.type === 'pct') return amt * (1 + v / 100)
      if (inc.type === 'per_unit') return amt + v * (Number(inc.units) || 0)
      return amt + v
    }, amount)
}

// Build the full pro forma for one company.
// Returns { income: [line], expenses: [line], excluded: [line], totals, ttmMonths, uncategorized }
// where line = { name, type, method, value, baseline[12], computed[12], values[12],
//                overridden[12], total, ttmTotal }
export function computeProForma({ transactions, categories, companyId, assumptions, overrides, asOf }) {
  const a = { ...defaultAssumptions(), ...(assumptions || {}) }
  const ov = overrides || {}
  const ttmMonths = trailingMonths(asOf || lastCompleteMonth())
  const actuals = buildTrailingActuals(transactions, categories, companyId, ttmMonths)

  const catByName = Object.fromEntries(categories.map(c => [c.name, c]))
  const sortOrder = name => catByName[name]?.sort_order ?? 999

  // Every category with trailing activity, plus any added manually via assumptions
  const names = { income: new Set(Object.keys(actuals.income)), expense: new Set(Object.keys(actuals.expenses)) }
  Object.keys(a.lines).forEach(name => {
    const type = catByName[name]?.type
    if (type) names[type].add(name)
  })

  function buildLine(name, type, totalIncome) {
    const actual = (type === 'income' ? actuals.income : actuals.expenses)[name] || Array(12).fill(0)
    const cfg = a.lines[name] || { method: 'growth', value: 0 }
    const method = type === 'income' && cfg.method === 'pct_income' ? 'growth' : cfg.method
    const v = Number(cfg.value) || 0
    const baseline = baselineByMonth(actual, ttmMonths, a.baseline)

    const computed = baseline.map((base, i) => {
      const month = i + 1
      let amt
      if (method === 'exclude') amt = 0
      else if (method === 'fixed') amt = v
      else if (method === 'pct_income') amt = (totalIncome?.[i] || 0) * v / 100
      else amt = base * (1 + v / 100)
      if (name === RENT_CATEGORY && method !== 'exclude') {
        amt = applyRentIncreases(amt, month, a.rentIncreases || [])
      }
      return amt
    })

    const lineOv = ov[name] || {}
    const overridden = computed.map((_, i) => lineOv[i + 1] !== undefined && lineOv[i + 1] !== null)
    const values = computed.map((c, i) => (overridden[i] ? Number(lineOv[i + 1]) : c))

    return {
      name, type, method, value: cfg.value ?? 0,
      baseline, computed, values, overridden,
      total: values.reduce((s, x) => s + x, 0),
      ttmTotal: actual.reduce((s, x) => s + x, 0),
      ttmAvg: actual.reduce((s, x) => s + x, 0) / 12,
    }
  }

  const byOrder = (x, y) => sortOrder(x) - sortOrder(y) || x.localeCompare(y)

  const incomeAll = [...names.income].sort(byOrder).map(n => buildLine(n, 'income'))
  const income = incomeAll.filter(l => l.method !== 'exclude')
  const totalIncome = Array.from({ length: 12 }, (_, i) => income.reduce((s, l) => s + l.values[i], 0))

  const expenseAll = [...names.expense].sort(byOrder).map(n => buildLine(n, 'expense', totalIncome))
  const expenses = expenseAll.filter(l => l.method !== 'exclude')
  const totalExpenses = Array.from({ length: 12 }, (_, i) => expenses.reduce((s, l) => s + l.values[i], 0))

  const noi = totalIncome.map((inc, i) => inc - totalExpenses[i])
  const sum = arr => arr.reduce((s, x) => s + x, 0)

  return {
    income,
    expenses,
    allLines: [...incomeAll, ...expenseAll],
    ttmMonths,
    uncategorized: actuals.uncategorized,
    totals: {
      income: totalIncome,
      expenses: totalExpenses,
      noi,
      incomeTotal: sum(totalIncome),
      expenseTotal: sum(totalExpenses),
      noiTotal: sum(noi),
      ttmIncome: sum(income.map(l => l.ttmTotal)),
      ttmExpenses: sum(expenses.map(l => l.ttmTotal)),
    },
  }
}

// Sum several company pro formas into one consolidated view (read-only)
export function consolidateProFormas(list) {
  const merge = (lines) => {
    const map = {}
    lines.forEach(l => {
      if (!map[l.name]) {
        map[l.name] = { ...l, values: [...l.values], overridden: Array(12).fill(false), total: 0, ttmTotal: 0 }
        map[l.name].values.fill(0)
      }
      const m = map[l.name]
      l.values.forEach((v, i) => { m.values[i] += v })
      m.total += l.total
      m.ttmTotal += l.ttmTotal
    })
    return Object.values(map)
  }
  const add = (key) => Array.from({ length: 12 }, (_, i) => list.reduce((s, p) => s + p.totals[key][i], 0))
  const sumKey = (key) => list.reduce((s, p) => s + p.totals[key], 0)
  const incomeOrder = list.flatMap(p => p.income.map(l => l.name))
  const expenseOrder = list.flatMap(p => p.expenses.map(l => l.name))
  const orderBy = order => (x, y) => order.indexOf(x.name) - order.indexOf(y.name)

  return {
    income: merge(list.flatMap(p => p.income)).sort(orderBy(incomeOrder)),
    expenses: merge(list.flatMap(p => p.expenses)).sort(orderBy(expenseOrder)),
    ttmMonths: list[0]?.ttmMonths || [],
    uncategorized: list.reduce((s, p) => s + p.uncategorized, 0),
    totals: {
      income: add('income'),
      expenses: add('expenses'),
      noi: add('noi'),
      incomeTotal: sumKey('incomeTotal'),
      expenseTotal: sumKey('expenseTotal'),
      noiTotal: sumKey('noiTotal'),
      ttmIncome: sumKey('ttmIncome'),
      ttmExpenses: sumKey('ttmExpenses'),
    },
  }
}

export function formatWhole(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount)
}
