// Loan balance roll-forward.
//
// A loan's "statement balance" (loans.current_balance) is the balance on a
// specific lender statement, and its date is stored here in report_settings
// (key `loan_balance_as_of`: { [loanId]: 'YYYY-MM-DD' }). The current balance
// is that statement balance minus the principal payments recorded for the
// loan's entity after that date, i.e. transactions in a category named like
// "Loan Service (Principal)". Entering a newer statement balance and date
// re-anchors it.
//
// Payments are matched to a loan by entity, so this only rolls forward when
// the entity has a single loan; with more than one, the statement balance is
// shown as-is.
//
// The expected principal for the same months comes from the loan's own
// amortization (statement balance, rate, monthly payment). A large gap
// between expected and recorded principal usually means a missed payment or
// a payment split wrongly between interest and principal.

const SETTINGS_KEY = 'loan_balance_as_of'

export async function loadLoanAnchors(supabase) {
  const { data } = await supabase.from('report_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
  try { return data?.value ? JSON.parse(data.value) : {} } catch { return {} }
}

// Read-modify-write one loan's date (null removes it)
export async function saveLoanAnchor(supabase, loanId, date) {
  const anchors = await loadLoanAnchors(supabase)
  if (date) anchors[loanId] = date
  else delete anchors[loanId]
  const { error } = await supabase.from('report_settings').upsert(
    { key: SETTINGS_KEY, value: JSON.stringify(anchors), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  return error?.message || null
}

export function isPrincipalCategory(c) {
  return !!c && c.type === 'expense' && /principal/i.test(c.name || '')
}

function nextMonth(key) {
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7))
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

// → {
//   status: 'ok' | 'no_date' | 'multi_loan',
//   statement, asOf, balance, principalSince, payments,
//   expectedPrincipal, months, gap, flag
// }
export function rollForward({ loan, asOf, loansInEntity, transactions, categories }) {
  const statement = parseFloat(loan.current_balance) || 0
  const base = { statement, asOf: asOf || null, balance: statement, principalSince: 0, payments: 0, expectedPrincipal: null, months: 0, gap: null, flag: false }
  if (!asOf) return { ...base, status: 'no_date' }
  if (loansInEntity > 1) return { ...base, status: 'multi_loan' }

  const principalCats = new Set(categories.filter(isPrincipalCategory).map(c => c.id))
  const paid = transactions.filter(t =>
    t.company_id === loan.company_id && principalCats.has(t.category_id) && t.date > asOf)
  // Expense rows are negative; a positive row (reversal) reduces principal paid
  const principalSince = paid.reduce((s, t) => s - (Number(t.amount) || 0), 0)
  const balance = Math.round((statement - principalSince) * 100) / 100

  // Expected principal: amortize month by month from the statement balance
  // through the latest month with any transaction for this entity
  const latest = transactions
    .filter(t => t.company_id === loan.company_id)
    .reduce((m, t) => (t.date.slice(0, 7) > m ? t.date.slice(0, 7) : m), asOf.slice(0, 7))
  const rate = (parseFloat(loan.interest_rate) || 0) / 100 / 12
  const payment = parseFloat(loan.monthly_payment) || 0
  let months = 0, expected = 0, bal = statement
  if (payment > 0) {
    for (let k = nextMonth(asOf.slice(0, 7)); k <= latest; k = nextMonth(k)) {
      const p = Math.max(0, Math.min(bal, payment - bal * rate))
      expected += p
      bal -= p
      months++
    }
  }
  const expectedPrincipal = payment > 0 ? Math.round(expected * 100) / 100 : null
  const gap = expectedPrincipal === null ? null : Math.round((principalSince - expectedPrincipal) * 100) / 100
  // Flag a gap bigger than half a month's principal
  const monthlyPrincipal = Math.max(0, payment - statement * rate)
  const flag = gap !== null && months > 0 && Math.abs(gap) > Math.max(25, monthlyPrincipal / 2)

  return { ...base, status: 'ok', balance, principalSince: Math.round(principalSince * 100) / 100, payments: paid.length, expectedPrincipal, months, gap, flag }
}
