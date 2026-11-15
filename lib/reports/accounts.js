// Category → account map: step 1 toward statements that tie.
//
// The books are a single list of categorized bank and card transactions.
// The P&L reads the categories counted in net income. A balance sheet also
// needs every other category posted somewhere: loan proceeds raise the loan,
// principal lowers it, a purchase adds to property, a payment to investors is
// a distribution, and so on. This map says where each category goes.
//
// Sign convention: a transaction's amount is its effect on cash (+ in, − out).
// The mapped account takes the other side. So for every account,
//   balance change = −(sum of amounts)
// read as "+ = credit". A liability or equity account goes up when cash comes
// in (loan proceeds, contributions); an asset account goes up when cash goes
// out (purchase, deposit). Nothing here changes any transaction.
//
// Stored in report_settings under `account_map` as { [categoryId]: accountKey },
// holding only the choices someone made; every other category uses
// defaultAccountFor(). Categories counted in NOI are always on the income
// statement, so this can never move a number on the P&L, Overview, Deal Room
// or Debt & Equity.

export const ACCOUNTS = [
  { key: 'pl',            group: 'Income statement', label: 'Income statement (net income)' },
  { key: 'property',      group: 'Assets',           label: 'Property and improvements, at cost' },
  { key: 'deposits',      group: 'Assets',           label: 'Deposits and escrow' },
  { key: 'transfer',      group: 'Assets',           label: 'Transfer between own accounts' },
  { key: 'loan',          group: 'Liabilities',      label: 'Loans payable' },
  { key: 'credit_card',   group: 'Liabilities',      label: 'Credit cards payable' },
  { key: 'affiliate',     group: 'Liabilities',      label: 'Due to / from affiliates' },
  { key: 'contributions', group: 'Equity',           label: 'Owner contributions' },
  { key: 'distributions', group: 'Equity',           label: 'Owner distributions' },
  { key: 'suspense',      group: 'Needs classifying', label: 'Needs classifying' },
]

const BY_KEY = Object.fromEntries(ACCOUNTS.map(a => [a.key, a]))
export const accountInfo = key => BY_KEY[key] || BY_KEY.suspense
export const ACCOUNT_GROUPS = [...new Set(ACCOUNTS.map(a => a.group))]

// First match wins. `why` is shown next to a default so it's clear it's a guess.
const RULES = [
  { account: 'suspense',      match: /tolspain|affiliate|intercompany|due (to|from)/i, why: 'Payment to or from a related entity: a loan between them, or a distribution or contribution?' },
  { account: 'loan',          match: /loan proceeds|loan funding|loan draw|principal/i },
  { account: 'pl',            match: /interest|dividend/i },
  { account: 'distributions', match: /investor|distribution|owner draw/i },
  { account: 'contributions', match: /capital injection|contribution|owner investment/i },
  { account: 'credit_card',   match: /(american express|amex|chase|credit card|visa|mastercard|card).*payment/i },
  { account: 'deposits',      match: /earnest|escrow|security deposit/i },
  { account: 'property',      match: /purchase of|acquisition|appraisal|environmental|survey|cost seg|closing cost|title|equipment|signage|improvement|capital|capex|building|roof|paving/i },
  { account: 'transfer',      match: /transfer/i },
]

// noiCategoryIds: categories counted in NOI for the portfolio or any entity
export function defaultAccountFor(category, noiCategoryIds) {
  if (!category) return { account: 'suspense', why: 'No category' }
  if (noiCategoryIds?.has(category.id)) return { account: 'pl', locked: true }
  const rule = RULES.find(r => r.match.test(category.name || ''))
  if (rule) return { account: rule.account, why: rule.why || null }
  // Operating items left out of NOI (legal, bank fees, pest control…) are
  // still income and expenses of the business
  return { account: 'pl', why: null }
}

// → { account, source: 'noi' | 'set' | 'default', why }
export function accountFor(category, map, noiCategoryIds) {
  const d = defaultAccountFor(category, noiCategoryIds)
  if (d.locked) return { account: 'pl', source: 'noi', why: null }
  const set = category && map?.[category.id]
  if (set && BY_KEY[set]) return { account: set, source: 'set', why: null }
  return { account: d.account, source: 'default', why: d.why }
}

// bank_pl_categories rows → Set of category ids counted in NOI anywhere
export function noiCategoryIdsFrom(rows) {
  return new Set((rows || []).map(r => r.category_id))
}

const SETTINGS_KEY = 'account_map'

export async function loadAccountMap(supabase) {
  const { data } = await supabase.from('report_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
  try { return data?.value ? JSON.parse(data.value) : {} } catch { return {} }
}

export async function saveAccountMap(supabase, map) {
  const { error } = await supabase.from('report_settings').upsert(
    { key: SETTINGS_KEY, value: JSON.stringify(map), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  return error?.message || null
}

// Totals per account. Uncategorized transactions count as needing classifying.
// → Map<accountKey, { cashIn, cashOut, net, count }>
export function totalsByAccount(transactions, categories, map, noiCategoryIds) {
  const cats = new Map(categories.map(c => [c.id, c]))
  const out = new Map()
  transactions.forEach(t => {
    const cat = t.category_id ? cats.get(t.category_id) : null
    const { account } = cat ? accountFor(cat, map, noiCategoryIds) : { account: 'suspense' }
    const cur = out.get(account) || { cashIn: 0, cashOut: 0, net: 0, count: 0 }
    const a = Number(t.amount) || 0
    if (a >= 0) cur.cashIn += a
    else cur.cashOut += a
    cur.net += a
    cur.count++
    out.set(account, cur)
  })
  return out
}
