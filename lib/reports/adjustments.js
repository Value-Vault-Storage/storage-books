// NOI adjustments: documented exclusions from NOI.
//
// An adjustment marks all or part of one transaction as excluded from NOI,
// with a treatment (why it is out) and a written reason. It applies in every
// view — Bank P&L, Overview, Deal Room, Debt & Equity — so the same invoice
// can't count in one report and not another.
//
//   Reported NOI  = Bank P&L categories, every transaction counted
//   Adjusted NOI  = Reported NOI with adjustments removed
//
// NOI is simply the sum of signed transaction amounts (income positive,
// expenses negative, refunds positive), so removing `e` dollars of a
// transaction with amount sign `s` changes NOI by −s·e.

import { buildPL } from '@/lib/reports/pl'
import { vendorKey, vendorLabel } from '@/lib/reports/proforma'

export const TREATMENTS = [
  {
    value: 'capex',
    label: 'Capital improvement',
    short: 'CapEx',
    hint: 'Extends the life of or improves the property (roof, paving, new doors). Buyers deduct a replacement reserve instead.',
    badge: 'bg-amber-50 text-amber-700 border-amber-200',
    expenseType: 'capex',
  },
  {
    value: 'non_recurring',
    label: 'Non-recurring',
    short: 'Non-recurring',
    hint: 'A genuine one-off: storm damage, catching up on deferred maintenance, a specific event.',
    badge: 'bg-orange-50 text-orange-700 border-orange-200',
    expenseType: 'one_time',
  },
  {
    value: 'owner',
    label: 'Owner / non-operating',
    short: 'Owner',
    hint: 'Personal or unrelated to running the property.',
    badge: 'bg-purple-50 text-purple-700 border-purple-200',
    expenseType: 'owner_addback',
  },
  {
    value: 'reimbursed',
    label: 'Reimbursed',
    short: 'Reimbursed',
    hint: 'Paid back by insurance or a third party.',
    badge: 'bg-sky-50 text-sky-700 border-sky-200',
    expenseType: 'one_time',
  },
]

export const UNREVIEWED = {
  value: 'unreviewed',
  label: 'Needs reason',
  short: 'Needs reason',
  hint: 'Excluded before reasons were recorded. Pick a treatment and add a note.',
  badge: 'bg-red-50 text-red-700 border-red-200',
  expenseType: null,
}

export function treatmentInfo(value) {
  return TREATMENTS.find(t => t.value === value) || UNREVIEWED
}

// ── Loading ─────────────────────────────────────────────────────────
// Returns { byTx: Map<transaction_id, adjustment>, legacy }.
// If the noi_adjustments table hasn't been created yet, falls back to the
// old bank_pl_exclusions rows (any view) so NOI doesn't move before the
// migration runs; `legacy` is then true and editing is disabled.
export async function loadAdjustments(supabase) {
  const { data, error } = await supabase.from('noi_adjustments').select('*')
  if (!error) {
    return { byTx: new Map((data || []).map(a => [a.transaction_id, a])), legacy: false }
  }
  console.warn('noi_adjustments unavailable, using legacy exclusions:', error.message)
  const { data: old } = await supabase.from('bank_pl_exclusions').select('transaction_id')
  const byTx = new Map()
  ;(old || []).forEach(r => {
    byTx.set(r.transaction_id, {
      id: `legacy-${r.transaction_id}`, transaction_id: r.transaction_id,
      treatment: 'unreviewed', amount: null, reason: '', legacy: true,
    })
  })
  return { byTx, legacy: true }
}

// ── Math ────────────────────────────────────────────────────────────
// Dollars of `tx` excluded by `adj` (positive, capped at the transaction)
export function excludedAmount(tx, adj) {
  if (!adj) return 0
  const full = Math.abs(Number(tx.amount) || 0)
  const part = adj.amount == null || adj.amount === '' ? full : Math.abs(Number(adj.amount))
  return Math.min(full, part)
}

// Change in NOI from applying the adjustment (positive = NOI goes up)
export function noiImpact(tx, adj) {
  const e = excludedAmount(tx, adj)
  return Number(tx.amount) < 0 ? e : -e
}

export function isPartial(tx, adj) {
  return !!adj && excludedAmount(tx, adj) < Math.abs(Number(tx.amount) || 0) - 0.005
}

// Transactions with adjustments removed: fully excluded ones are dropped,
// partially excluded ones keep only the included remainder.
export function applyAdjustments(transactions, byTx) {
  if (!byTx || byTx.size === 0) return transactions
  const out = []
  transactions.forEach(t => {
    const adj = byTx.get(t.id)
    if (!adj) { out.push(t); return }
    const amt = Number(t.amount)
    const remaining = Math.abs(amt) - excludedAmount(t, adj)
    if (remaining > 0.005) out.push({ ...t, amount: Math.sign(amt) * Math.round(remaining * 100) / 100 })
  })
  return out
}

// Reported → adjusted NOI walk for a set of Bank P&L transactions.
// `transactions` should already be limited to the period, entity and
// Bank P&L categories, with no adjustments applied.
export function buildNoiWalk(transactions, categories, byTx) {
  const reported = buildPL(transactions, categories)
  const adjusted = buildPL(applyAdjustments(transactions, byTx), categories)
  const catName = Object.fromEntries(categories.map(c => [c.id, c.name]))

  const groups = new Map([...TREATMENTS, UNREVIEWED].map(t => [t.value, { treatment: t, items: [], total: 0 }]))
  transactions.forEach(t => {
    const adj = byTx?.get(t.id)
    if (!adj) return
    const g = groups.get(adj.treatment) || groups.get('unreviewed')
    const impact = noiImpact(t, adj)
    g.items.push({ tx: t, adj, category: catName[t.category_id] || 'Uncategorized', excluded: excludedAmount(t, adj), impact })
    g.total += impact
  })
  const steps = [...groups.values()].filter(g => g.items.length > 0)
  steps.forEach(g => g.items.sort((a, b) => b.impact - a.impact))
  return { reported, adjusted, steps, totalAdjustment: adjusted.noi - reported.noi }
}

// ── Guardrails ──────────────────────────────────────────────────────
// Vendors excluded as "non-recurring" in two or more calendar years.
// items: [{ tx, adj }]
export function recurringNonRecurring(items) {
  const byVendor = new Map()
  items.forEach(({ tx, adj }) => {
    if (adj.treatment !== 'non_recurring') return
    const key = vendorKey(tx.description)
    if (!byVendor.has(key)) byVendor.set(key, { key, label: vendorLabel(key), years: new Set(), count: 0, total: 0 })
    const v = byVendor.get(key)
    v.years.add(tx.date.slice(0, 4))
    v.count++
    v.total += excludedAmount(tx, adj)
  })
  return [...byVendor.values()]
    .filter(v => v.years.size >= 2)
    .map(v => ({ ...v, years: [...v.years].sort() }))
}

// Per expense category: total spent vs. excluded, for the given transactions
export function exclusionShareByCategory(transactions, categories, byTx) {
  const cats = Object.fromEntries(categories.map(c => [c.id, c]))
  const rows = new Map()
  transactions.forEach(t => {
    const cat = cats[t.category_id]
    if (!cat || cat.type !== 'expense') return
    if (!rows.has(cat.id)) rows.set(cat.id, { name: cat.name, total: 0, excluded: 0 })
    const r = rows.get(cat.id)
    r.total += -Number(t.amount) // expenses negative, refunds reduce
    r.excluded += noiImpact(t, byTx?.get(t.id))
  })
  return [...rows.values()]
    .filter(r => r.excluded !== 0)
    .map(r => ({ ...r, share: r.total > 0 ? r.excluded / r.total : null }))
    .sort((a, b) => b.excluded - a.excluded)
}

// ── Writes ──────────────────────────────────────────────────────────
// Keeps transactions.expense_type in step so the Pro Forma baseline (which
// normalizes out CapEx / One-Time / Add-Back) agrees with NOI.
function expenseTypeFor(tx, adj) {
  if (!adj) return Number(tx.amount) < 0 ? 'opex' : null
  if (isPartial(tx, adj)) return 'opex'
  return treatmentInfo(adj.treatment).expenseType
}

// Save one adjustment per transaction. `amount` null = whole transaction.
// Returns { saved: [adjustment], error }.
export async function saveAdjustments(supabase, transactions, { treatment, amount, reason }) {
  if (!reason?.trim()) return { saved: [], error: 'A reason is required.' }
  const now = new Date().toISOString()
  const rows = transactions.map(t => ({
    transaction_id: t.id,
    treatment,
    amount: transactions.length === 1 && amount != null && amount !== '' ? Math.abs(Number(amount)) : null,
    reason: reason.trim(),
    updated_at: now,
  }))
  const { data, error } = await supabase
    .from('noi_adjustments')
    .upsert(rows, { onConflict: 'transaction_id' })
    .select()
  if (error) return { saved: [], error: error.message }
  await syncExpenseTypes(supabase, transactions, new Map((data || []).map(a => [a.transaction_id, a])))
  return { saved: data || [], error: null }
}

export async function removeAdjustments(supabase, transactions) {
  const ids = transactions.map(t => t.id)
  const { error } = await supabase.from('noi_adjustments').delete().in('transaction_id', ids)
  if (error) return { error: error.message }
  await syncExpenseTypes(supabase, transactions, new Map())
  return { error: null }
}

async function syncExpenseTypes(supabase, transactions, byTx) {
  const groups = new Map()
  transactions.forEach(t => {
    const type = expenseTypeFor(t, byTx.get(t.id))
    const key = type ?? '__null__'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t.id)
  })
  await Promise.all([...groups.entries()].map(([key, ids]) =>
    supabase.from('transactions').update({ expense_type: key === '__null__' ? null : key }).in('id', ids)
  ))
}

export function expenseTypeAfter(tx, adj) {
  return expenseTypeFor(tx, adj)
}
