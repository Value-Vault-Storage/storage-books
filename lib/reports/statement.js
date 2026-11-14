// Operating statement (P&L redesign, phase 1: Operating lens, cash basis).
//
// Lays the books out the way lenders and buyers read a real-estate operating
// statement, in a fixed order that doesn't change with the numbers:
//
//   Revenue − bad debt                 = Effective gross income (EGI)
//   EGI − operating expenses           = Net operating income (NOI, "reported")
//   NOI ± documented NOI adjustments   = Adjusted NOI
//   Reported NOI − capex − debt service = Cash flow after debt service
//
// What counts in NOI is the "What counts in NOI" selection in Settings (the
// bank_pl_categories table): each entity's own selection, falling back to the
// portfolio one. That's the same rule as Overview, Deal Room and Debt & Equity,
// so NOI agrees everywhere. Categories outside NOI land below the line when
// they look like capex or debt service; anything else is listed as "not on
// this statement" so nothing disappears silently.
//
// Each category is placed on a statement line by its name (STATEMENT_LINES).
// Phase 2 will make the mapping editable.

import { noiImpact, TREATMENTS, UNREVIEWED } from '@/lib/reports/adjustments'

export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ── Statement lines ─────────────────────────────────────────────────
// section: revenue | contra (bad debt, reduces revenue) | opex | below
// `match` is tested against the category name. Order within a section is
// the order shown. The last line of each kind is the fallback.
export const STATEMENT_LINES = [
  { key: 'rent',         section: 'revenue', label: 'Rental income',              match: /rent/i,                     not: /truck/i },
  { key: 'fees',         section: 'revenue', label: 'Admin and late fees',        match: /late fee|admin|setup|fee/i },
  { key: 'tenant_ins',   section: 'revenue', label: 'Tenant insurance',           match: /insurance|protection/i },
  { key: 'merch',        section: 'revenue', label: 'Merchandise',                match: /merch|retail|lock|box/i },
  { key: 'truck',        section: 'revenue', label: 'Truck rental',               match: /truck/i },
  { key: 'other_income', section: 'revenue', label: 'Other income',               match: null },

  { key: 'refunds',      section: 'contra',  label: 'Less: refunds and concessions', match: /refund|concession|discount/i },
  { key: 'bad_debt',     section: 'contra',  label: 'Less: bad debt',             match: /bad debt|write.?off|uncollect/i },

  { key: 'taxes',        section: 'opex',    label: 'Real estate taxes',          match: /property tax|real estate tax/i },
  // Premiums remitted for the tenant insurance program, not property insurance
  { key: 'tenant_ins_cost', section: 'opex', label: 'Tenant insurance program',  match: /tenant.*(insurance|protection)|(insurance|protection).*tenant/i },
  { key: 'insurance',    section: 'opex',    label: 'Insurance',                  match: /insurance/i },
  { key: 'utilities',    section: 'opex',    label: 'Utilities',                  match: /utilit|electric|water|trash|internet|phone/i },
  { key: 'rm',           section: 'opex',    label: 'Repairs and maintenance',    match: /repair|maint|landscap|snow|pest|clean/i },
  { key: 'payroll',      section: 'opex',    label: 'Payroll',                    match: /payroll|labor|wage|salar/i },
  { key: 'mgmt',         section: 'opex',    label: 'Management fees',            match: /management/i },
  { key: 'marketing',    section: 'opex',    label: 'Marketing',                  match: /advertis|marketing|website|seo/i },
  { key: 'ga',           section: 'opex',    label: 'General and administrative', match: null },

  { key: 'capex',        section: 'below',   label: 'Capital improvements',       match: /improvement|capital|capex/i },
  { key: 'interest',     section: 'below',   label: 'Debt service: interest',     match: /interest/i },
  { key: 'principal',    section: 'below',   label: 'Debt service: principal',    match: /principal/i },
]

const LINE = Object.fromEntries(STATEMENT_LINES.map(l => [l.key, l]))
export const lineInfo = key => LINE[key]
export const linesIn = section => STATEMENT_LINES.filter(l => l.section === section)

function matches(line, name) {
  return line.match && line.match.test(name) && !(line.not && line.not.test(name))
}

// Where a category lands on the statement when it is counted in NOI
export function noiLineFor(category) {
  if (!category) return null
  const name = category.name || ''
  if (category.type === 'income') {
    return (linesIn('revenue').find(l => matches(l, name)) || LINE.other_income).key
  }
  const contra = linesIn('contra').find(l => matches(l, name))
  if (contra) return contra.key
  return (linesIn('opex').find(l => matches(l, name)) || LINE.ga).key
}

// Where a category lands when it is NOT counted in NOI (null = off statement)
export function belowLineFor(category) {
  if (!category || category.type === 'income') return null
  return linesIn('below').find(l => matches(l, category.name || ''))?.key || null
}

// ── NOI config ──────────────────────────────────────────────────────
// rows: bank_pl_categories rows → { cats: Map<companyId, Set>, portfolioCats: Set }
export function groupNoiConfig(rows) {
  const cats = new Map()
  const portfolioCats = new Set()
  ;(rows || []).forEach(r => {
    if (r.company_id == null) { portfolioCats.add(r.category_id); return }
    if (!cats.has(r.company_id)) cats.set(r.company_id, new Set())
    cats.get(r.company_id).add(r.category_id)
  })
  return { cats, portfolioCats }
}

export function noiCatsFor(config, companyId) {
  return (companyId && config.cats.get(companyId)) || config.portfolioCats
}

// ── Periods ─────────────────────────────────────────────────────────
// Month keys are 'YYYY-MM'. A period is { from, to, months: [keys] }.
export function addMonths(key, n) {
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(5, 7)) - 1 + n
  const yy = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

export function monthLabel(key, { long = false } = {}) {
  const m = Number(key.slice(5, 7)) - 1
  const name = long ? new Date(2000, m).toLocaleString('en-US', { month: 'long' }) : MONTH_ABBR[m]
  return `${name} ${key.slice(0, 4)}`
}

function range(from, to) {
  const out = []
  for (let k = from; k <= to; k = addMonths(k, 1)) out.push(k)
  return out
}

// kind: 'month' | 'ytd' | 't12'; end: 'YYYY-MM'
export function periodFor(kind, end) {
  const from = kind === 'month' ? end : kind === 'ytd' ? `${end.slice(0, 4)}-01` : addMonths(end, -11)
  return { kind, from, to: end, months: range(from, end) }
}

export function priorPeriod(p) {
  const from = addMonths(p.from, -12)
  const to = addMonths(p.to, -12)
  return { kind: p.kind, from, to, months: range(from, to) }
}

export function periodTitle(p) {
  if (p.kind === 'month') return monthLabel(p.to, { long: true })
  if (p.kind === 'ytd') return `Year to date through ${monthLabel(p.to)}`
  return `Trailing 12 months ended ${monthLabel(p.to)}`
}

export function periodShort(p) {
  if (p.kind === 'month') return monthLabel(p.to)
  if (p.kind === 'ytd') return `YTD ${monthLabel(p.to)}`
  return `T12 ${monthLabel(p.to)}`
}

export function periodRange(p) {
  return p.from === p.to ? monthLabel(p.to) : `${monthLabel(p.from)} – ${monthLabel(p.to)}`
}

export function inPeriod(t, p) {
  const k = t.date.slice(0, 7)
  return k >= p.from && k <= p.to
}

// ── Classification ──────────────────────────────────────────────────
// Tags every transaction with where it lands:
//   { t, line, place: 'noi' | 'below' | 'off' | 'uncategorized' }
export function classify(transactions, categories, config) {
  const catById = new Map(categories.map(c => [c.id, c]))
  return transactions.map(t => {
    const cat = t.category_id ? catById.get(t.category_id) : null
    if (!cat) return { t, cat: null, line: null, place: 'uncategorized' }
    if (noiCatsFor(config, t.company_id).has(cat.id)) return { t, cat, line: noiLineFor(cat), place: 'noi' }
    const below = belowLineFor(cat)
    if (below) return { t, cat, line: below, place: 'below' }
    return { t, cat, line: null, place: 'off' }
  })
}

// ── Statement ───────────────────────────────────────────────────────
// items: output of classify(), already limited to one column's scope
// (period, entity). byTx: NOI adjustments by transaction id.
export function buildStatement(items, byTx) {
  const lines = Object.fromEntries(STATEMENT_LINES.map(l => [l.key, { amount: 0, count: 0, adjCount: 0 }]))
  const adjustments = Object.fromEntries([...TREATMENTS, UNREVIEWED].map(t => [t.value, { amount: 0, count: 0 }]))
  const off = new Map() // category name → amount (signed, as booked)
  let uncategorized = 0

  items.forEach(({ t, cat, line, place }) => {
    const amt = Number(t.amount) || 0
    if (place === 'uncategorized') { uncategorized++; return }
    if (place === 'off') { off.set(cat.name, (off.get(cat.name) || 0) + amt); return }
    const l = lines[line]
    // Revenue is positive as booked; costs are shown as positive amounts
    l.amount += LINE[line].section === 'revenue' ? amt : -amt
    l.count++
    if (place === 'noi') {
      const adj = byTx?.get(t.id)
      if (adj) {
        l.adjCount++
        const g = adjustments[adj.treatment] || adjustments.unreviewed
        g.amount += noiImpact(t, adj)
        g.count++
      }
    }
  })

  const sum = section => linesIn(section).reduce((s, l) => s + lines[l.key].amount, 0)
  const grossRevenue = sum('revenue')
  const contra = sum('contra')
  const egi = grossRevenue - contra
  const opex = sum('opex')
  const noi = egi - opex
  const totalAdjustments = Object.values(adjustments).reduce((s, a) => s + a.amount, 0)
  const adjustedNoi = noi + totalAdjustments
  const capex = lines.capex.amount
  const debtService = lines.interest.amount + lines.principal.amount
  // Cash flow is what actually happened, so it starts from reported NOI
  const cashFlow = noi - capex - debtService

  return {
    lines, adjustments, grossRevenue, contra, egi, opex, noi,
    totalAdjustments, adjustedNoi, capex, debtService, cashFlow,
    expenseRatio: egi > 0 ? opex / egi : null,
    count: items.length,
    off: [...off.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    uncategorized,
  }
}

// Rows of the statement in display order. Each row:
//   { kind: 'header' | 'line' | 'subtotal' | 'noi', key, label, get(stmt) → number,
//     cost: true when a higher number is unfavorable, drill: what to list on click }
export function statementRows(hasActivity) {
  const show = key => hasActivity(key)
  const line = l => ({
    kind: 'line', key: l.key, label: l.label,
    get: s => (l.section === 'contra' || l.section === 'below' ? -s.lines[l.key].amount : s.lines[l.key].amount),
    // Opex is shown as a positive cost (higher = worse); bad debt and
    // below-the-line rows are shown signed, so higher is already better.
    cost: l.section === 'opex',
    adjCount: s => s.lines[l.key].adjCount,
    drill: { line: l.key },
  })
  const adjRow = t => ({
    kind: 'line', key: `adj_${t.value}`, label: t.label,
    get: s => s.adjustments[t.value].amount,
    drill: { adjustment: t.value },
  })

  const rows = [
    { kind: 'header', key: 'h_rev', label: 'Revenue' },
    ...linesIn('revenue').filter(l => show(l.key)).map(line),
    ...linesIn('contra').filter(l => show(l.key)).map(line),
    { kind: 'subtotal', key: 'egi', label: 'Effective gross income', get: s => s.egi, pctBase: true },
    { kind: 'header', key: 'h_opex', label: 'Operating expenses' },
    ...linesIn('opex').filter(l => show(l.key)).map(line),
    { kind: 'subtotal', key: 'opex', label: 'Total operating expenses', get: s => s.opex, cost: true },
    { kind: 'noi', key: 'noi', label: 'Net operating income', get: s => s.noi },
  ]
  const adjTypes = [...TREATMENTS, UNREVIEWED].filter(t => show(`adj_${t.value}`))
  if (adjTypes.length > 0) {
    rows.push(
      { kind: 'header', key: 'h_adj', label: 'NOI adjustments' },
      ...adjTypes.map(adjRow),
      { kind: 'subtotal', key: 'adj_noi', label: 'Adjusted NOI', get: s => s.adjustedNoi },
    )
  }
  rows.push(
    { kind: 'header', key: 'h_below', label: 'Below the line' },
    ...linesIn('below').filter(l => show(l.key)).map(line),
    { kind: 'subtotal', key: 'cfads', label: 'Cash flow after debt service', get: s => s.cashFlow, note: 'from reported NOI' },
  )
  return rows
}

// Which rows have anything in them across all the columns shown
export function activityTest(statements) {
  return key => {
    if (key.startsWith('adj_')) {
      const v = key.slice(4)
      return statements.some(s => s.adjustments[v].count > 0)
    }
    return statements.some(s => s.lines[key].count > 0)
  }
}

// Variance with favorable positive. cost rows: lower is better.
export function variance(current, prior, cost) {
  const diff = cost ? prior - current : current - prior
  const pct = prior ? diff / Math.abs(prior) : null
  return { diff, pct }
}

// ── Formatting ──────────────────────────────────────────────────────
// Accounting style: whole dollars (or cents), negatives in parentheses,
// zero as a dash
export function acct(n, { dollar = false, cents = false } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return ''
  const digits = cents ? 2 : 0
  const f = 10 ** digits
  const r = Math.sign(n) * Math.round(Math.abs(n) * f) / f
  if (r === 0) return '–'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  const body = dollar ? `$${s}` : s
  return r < 0 ? `(${body})` : body
}

export function acctPct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return ''
  const s = `${Math.abs(x * 100).toFixed(digits)}%`
  return x < 0 ? `(${s})` : s
}

// ── Drill-down ──────────────────────────────────────────────────────
// items in scope → the ones behind a clicked cell
export function drillItems(items, drill, byTx) {
  if (drill.line) return items.filter(i => i.place !== 'off' && i.place !== 'uncategorized' && i.line === drill.line)
  if (drill.adjustment) {
    return items.filter(i => {
      if (i.place !== 'noi') return false
      const adj = byTx?.get(i.t.id)
      if (!adj) return false
      const known = [...TREATMENTS, UNREVIEWED].some(t => t.value === adj.treatment)
      return (known ? adj.treatment : 'unreviewed') === drill.adjustment
    })
  }
  if (drill.place) return items.filter(i => i.place === drill.place && (!drill.category || i.cat?.name === drill.category))
  return []
}

// ── Data health ─────────────────────────────────────────────────────
// Bank tie-out per month, same rule as the Balances page: a month ties when
// the statement balances at both ends differ by exactly the month's net bank
// activity. Returns [{ key, status: 'tied' | 'variance' | 'missing' }] for
// the months given, or null when no entity in scope has accounts.
export function bankTieOut({ months, companyIds, accounts, balances, transactions }) {
  const scoped = companyIds.filter(id => accounts.some(a => a.company_id === id))
  if (scoped.length === 0) return null

  const balanceOf = (accountId, key) => {
    const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7))
    const row = balances.find(b => b.account_id === accountId && b.year === y && b.month === m)
    return row ? parseFloat(row.balance) : null
  }
  const total = (companyId, key) => {
    let s = 0
    for (const a of accounts.filter(a => a.company_id === companyId)) {
      const b = balanceOf(a.id, key)
      if (b === null) return null
      s += b
    }
    return s
  }
  const net = (companyId, key) => transactions
    .filter(t => t.company_id === companyId && t.source_type === 'bank' && t.date.startsWith(key))
    .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0)

  return months.map(key => {
    let status = 'tied'
    for (const id of scoped) {
      const end = total(id, key)
      const start = total(id, addMonths(key, -1))
      if (end === null || start === null) { status = 'missing'; break }
      if (Math.abs(end - start - net(id, key)) >= 0.01) status = 'variance'
    }
    return { key, status }
  })
}

// "Jan, Feb, Mar" → "Jan – Mar" for runs of consecutive months
export function monthRuns(keys) {
  if (keys.length === 0) return ''
  const runs = []
  let start = keys[0], prev = keys[0]
  for (const k of keys.slice(1)) {
    if (k === addMonths(prev, 1)) { prev = k; continue }
    runs.push([start, prev]); start = prev = k
  }
  runs.push([start, prev])
  const sameYear = keys[0].slice(0, 4) === keys[keys.length - 1].slice(0, 4)
  const fmt = k => (sameYear ? MONTH_ABBR[Number(k.slice(5, 7)) - 1] : monthLabel(k))
  return runs.map(([a, b]) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`)).join(', ')
}
