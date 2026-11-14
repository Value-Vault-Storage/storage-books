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
// An entity can be split into facilities (e.g. Fort Meade and Bowling Green
// under one LLC) when the processor reports them separately; each facility
// then gets its own row and its own pair of transactions.
//
// The pair is tagged in `notes` as `processor-fee:YYYY-MM:<origin>[:<facility>]`
// (facility URI-encoded); saving a month replaces that row's pair, so it's
// never doubled.

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

// ── Settings in report_settings ───────────────────────────────────────
// { [companyId]: { processor, facilities: [name] } }. Older saves stored just
// the processor string; entitySetting() reads both.
export function entitySetting(settings, companyId) {
  const v = settings?.[companyId]
  if (!v) return { processor: '', facilities: [] }
  if (typeof v === 'string') return { processor: v, facilities: [] }
  return { processor: v.processor || '', facilities: Array.isArray(v.facilities) ? v.facilities : [] }
}

// "Fort Meade, Bowling Green" → ['Fort Meade', 'Bowling Green']
export function parseFacilities(text) {
  return [...new Set((text || '').split(',').map(f => f.trim()).filter(Boolean))]
}

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
// → Map<companyId, Map<facility ('' = whole entity), Map<'YYYY-MM', { fee, origin, ids: [] }>>>
export async function loadProcessorFees(supabase) {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, company_id, amount, notes')
    .like('notes', `${TAG}%`)
  if (error) return { fees: new Map(), error: error.message }
  const fees = new Map()
  ;(data || []).forEach(t => {
    const [, month, origin, fac] = t.notes.split(':')
    const facility = fac ? decodeURIComponent(fac) : ''
    if (!fees.has(t.company_id)) fees.set(t.company_id, new Map())
    const byFacility = fees.get(t.company_id)
    if (!byFacility.has(facility)) byFacility.set(facility, new Map())
    const byMonth = byFacility.get(facility)
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

function tag(month, origin, facility) {
  return `${TAG}${month}:${origin}${facility ? `:${encodeURIComponent(facility)}` : ''}`
}

// Replace one entity (or facility) month's pair. fee 0 / empty removes it.
// Returns an error message or null.
export async function setProcessorFee(supabase, { companyId, facility = '', month, fee, origin = 'manual', processorLabel, categories }) {
  const cats = feeCategories(categories)
  if (!cats.revenue) return `There's no "${REVENUE_CATEGORY}" category to gross revenue up to.`
  if (!cats.fee) return `There's no "${FEE_CATEGORY}" expense category. Add it in Settings → Chart of Accounts.`

  // Exact tags for this row under every origin, so other facilities' rows
  // for the same month are left alone
  const del = await supabase.from('transactions').delete()
    .eq('company_id', companyId)
    .in('notes', Object.keys(ORIGINS).map(o => tag(month, o, facility)))
  if (del.error) return del.error.message

  const amount = Math.round((Number(fee) || 0) * 100) / 100
  if (amount <= 0) return null

  const date = monthEnd(month)
  const by = (processorLabel ? ` by ${processorLabel}` : '') + (facility ? `, ${facility}` : '')
  const notes = tag(month, origin, facility)
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
