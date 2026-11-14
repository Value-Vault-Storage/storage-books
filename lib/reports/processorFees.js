// Processing fees withheld by the management software's payment processor.
//
// Easy Storage and WebSelfStorage deposit rent NET of card fees, so the bank
// shows (and the books record) less revenue than tenants actually paid, and
// the fee never appears as an expense. Cubby bills fees separately, so its
// books are already gross.
//
// For each entity whose processor withholds fees, one fee amount per month
// (typed in, or summed from the processor's deposit report) becomes a pair
// of offsetting transactions dated at month-end:
//
//   + fee  Rental Income        "gross-up": revenue as tenants paid it
//   − fee  Payment Processing   the fee, as an operating expense
//
// The pair nets to zero, so NOI and the bank tie-out don't move (the pair
// has no bank source type). Revenue and opex now read the way a buyer
// underwrites them, and processing cost is comparable across facilities.
//
// The pair is tagged in `notes` as `processor-fee:YYYY-MM:<origin>`; saving a
// month replaces that month's pair, so it's never doubled.

export const PROCESSORS = [
  { value: 'easystorage', label: 'Easy Storage', withholds: true },
  { value: 'webselfstorage', label: 'WebSelfStorage', withholds: true },
  { value: 'cubby', label: 'Cubby', withholds: false },
  { value: 'other_withheld', label: 'Other (fees withheld)', withholds: true },
  { value: 'other_billed', label: 'Other (fees billed separately)', withholds: false },
]

export const processorInfo = value => PROCESSORS.find(p => p.value === value) || null

export const ORIGINS = {
  manual: 'Entered by hand',
  easystorage: 'Imported from Easy Storage report',
}

const SETTINGS_KEY = 'processor_settings'
export const REVENUE_CATEGORY = 'Rental Income'
export const FEE_CATEGORY = 'Payment Processing'
const TAG = 'processor-fee:'

// ── Settings: { [companyId]: processor value } in report_settings ────
export async function loadProcessorSettings(supabase) {
  const { data } = await supabase.from('report_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
  try { return data?.value ? JSON.parse(data.value) : {} } catch { return {} }
}

export async function saveProcessorSettings(supabase, settings) {
  const { error } = await supabase.from('report_settings').upsert(
    { key: SETTINGS_KEY, value: JSON.stringify(settings), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  return error?.message || null
}

// ── Reading the fee pairs back ─────────────────────────────────────
// → Map<companyId, Map<'YYYY-MM', { fee, origin, ids: [] }>>
export async function loadProcessorFees(supabase) {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, company_id, amount, notes')
    .like('notes', `${TAG}%`)
  if (error) return { fees: new Map(), error: error.message }
  const fees = new Map()
  ;(data || []).forEach(t => {
    const [, month, origin] = t.notes.split(':')
    if (!fees.has(t.company_id)) fees.set(t.company_id, new Map())
    const byMonth = fees.get(t.company_id)
    const cur = byMonth.get(month) || { fee: 0, origin: origin || 'manual', ids: [] }
    if (Number(t.amount) < 0) cur.fee += -Number(t.amount) // the expense leg carries the fee
    cur.ids.push(t.id)
    byMonth.set(month, cur)
  })
  return { fees, error: null }
}

export function isProcessorFeeTx(t) {
  return typeof t.notes === 'string' && t.notes.startsWith(TAG)
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(last).padStart(2, '0')}`
}

function monthName(month) {
  const [y, m] = month.split('-').map(Number)
  return `${new Date(2000, m - 1).toLocaleString('en-US', { month: 'short' })} ${y}`
}

// Find the two categories the pair posts to
export function feeCategories(categories) {
  const byName = name => categories.find(c => c.name.toLowerCase() === name.toLowerCase())
  return { revenue: byName(REVENUE_CATEGORY), fee: byName(FEE_CATEGORY) }
}

// Replace one entity-month's pair. fee 0 / empty removes it.
// Returns an error message or null.
export async function setProcessorFee(supabase, { companyId, month, fee, origin = 'manual', processorLabel, categories }) {
  const cats = feeCategories(categories)
  if (!cats.revenue) return `There's no "${REVENUE_CATEGORY}" category to gross revenue up to.`
  if (!cats.fee) return `There's no "${FEE_CATEGORY}" expense category. Add it in Settings → Chart of Accounts.`

  const del = await supabase.from('transactions').delete()
    .eq('company_id', companyId)
    .like('notes', `${TAG}${month}:%`)
  if (del.error) return del.error.message

  const amount = Math.round((Number(fee) || 0) * 100) / 100
  if (amount <= 0) return null

  const date = monthEnd(month)
  const by = processorLabel ? ` by ${processorLabel}` : ''
  const notes = `${TAG}${month}:${origin}`
  const base = { company_id: companyId, date, source: 'manual', source_type: null, is_autopayment: false, notes }
  const { error } = await supabase.from('transactions').insert([
    {
      ...base,
      category_id: cats.revenue.id,
      amount,
      description: `Card fees withheld${by}, ${monthName(month)} (revenue gross-up)`,
      original_description: 'Processor fee gross-up',
    },
    {
      ...base,
      category_id: cats.fee.id,
      amount: -amount,
      description: `Card fees withheld${by}, ${monthName(month)}`,
      original_description: 'Processor fee',
    },
  ])
  return error?.message || null
}
