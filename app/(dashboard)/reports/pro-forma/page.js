'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import { fetchAllRows } from '@/lib/fetchAll'
import {
  computeProForma, consolidateProFormas, defaultAssumptions, formatWhole,
  BASELINE_OPTIONS, METHOD_OPTIONS, RENT_INCREASE_TYPES, RENT_CATEGORY,
} from '@/lib/reports/proforma'
import PrintHeader from '@/components/PrintHeader'

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = [CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR + 2]
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const selectCls = 'border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900'

function planKey(companyId, year) {
  return `${companyId}:${year}`
}

export default function ProFormaPage() {
  const [transactions, setTransactions] = useState([])
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [reportSettings, setReportSettings] = useState({})
  const [plans, setPlans] = useState({}) // planKey → { assumptions, overrides }
  const [bankPLCats, setBankPLCats] = useState([]) // default operating categories
  const [loading, setLoading] = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null) // null | 'saving' | 'saved' | 'error'

  const [year, setYear] = useState(CURRENT_YEAR + 1)
  const [facility, setFacility] = useState('all')
  const [showAssumptions, setShowAssumptions] = useState(true)

  const saveTimers = useRef({})
  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [tx, { data: co }, { data: cat }, { data: branding }, { data: pf, error: pfError }, { data: bpl }] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date')),
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('report_settings').select('*'),
      supabase.from('pro_forma').select('*'),
      supabase.from('bank_pl_categories').select('company_id, category_id'),
    ])
    setTransactions(tx)
    setCompanies(co || [])
    setCategories(cat || [])
    setBankPLCats(bpl || [])
    if (branding) setReportSettings(Object.fromEntries(branding.map(r => [r.key, r.value])))
    if (pfError) {
      console.error('pro_forma:', pfError.message)
      setTableMissing(true)
    }
    setPlans(Object.fromEntries((pf || []).map(r => [
      planKey(r.company_id, r.year),
      { assumptions: { ...defaultAssumptions(), ...(r.assumptions || {}) }, overrides: r.overrides || {} },
    ])))
    if (co?.length) setFacility(co[0].id)
    setLoading(false)
  }

  function getPlan(companyId) {
    return plans[planKey(companyId, year)] || { assumptions: defaultAssumptions(), overrides: {} }
  }

  // Update one facility's plan and debounce-save it
  function updatePlan(companyId, fn) {
    const key = planKey(companyId, year)
    const next = fn(getPlan(companyId))
    setPlans(prev => ({ ...prev, [key]: next }))
    setSaveStatus('saving')
    clearTimeout(saveTimers.current[key])
    saveTimers.current[key] = setTimeout(async () => {
      const { error } = await supabase.from('pro_forma').upsert({
        company_id: companyId,
        year,
        assumptions: next.assumptions,
        overrides: next.overrides,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id,year' })
      if (error) console.error('pro_forma save:', error.message)
      setSaveStatus(error ? 'error' : 'saved')
    }, 600)
  }

  function setAssumption(field, value) {
    updatePlan(facility, p => ({ ...p, assumptions: { ...p.assumptions, [field]: value } }))
  }

  function setLine(name, patch) {
    updatePlan(facility, p => {
      const lines = { ...p.assumptions.lines }
      lines[name] = { method: 'growth', value: 0, ...lines[name], ...patch }
      return { ...p, assumptions: { ...p.assumptions, lines } }
    })
  }

  function setOverride(name, month, amount) {
    updatePlan(facility, p => {
      const overrides = { ...p.overrides, [name]: { ...(p.overrides[name] || {}) } }
      if (amount === null) delete overrides[name][month]
      else overrides[name][month] = amount
      if (Object.keys(overrides[name]).length === 0) delete overrides[name]
      return { ...p, overrides }
    })
  }

  function resetOverrides() {
    if (!confirm('Clear all manual edits for this facility? Values will return to the calculated amounts.')) return
    updatePlan(facility, p => ({ ...p, overrides: {} }))
  }

  // ── Rent increases ───────────────────────────────────────────────
  function addRentIncrease() {
    const list = getPlan(facility).assumptions.rentIncreases || []
    setAssumption('rentIncreases', [...list, { id: crypto.randomUUID(), month: 1, type: 'pct', value: 0, units: 0 }])
  }
  function updateRentIncrease(id, patch) {
    const list = getPlan(facility).assumptions.rentIncreases || []
    setAssumption('rentIncreases', list.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }
  function removeRentIncrease(id) {
    const list = getPlan(facility).assumptions.rentIncreases || []
    setAssumption('rentIncreases', list.filter(r => r.id !== id))
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  // ── Compute ──────────────────────────────────────────────────────
  // Default operating categories: the facility's Bank P&L selection, else the portfolio's
  const includedFor = companyId => {
    const own = bankPLCats.filter(r => r.company_id === companyId)
    const rows = own.length ? own : bankPLCats.filter(r => r.company_id === null)
    const catName = Object.fromEntries(categories.map(c => [c.id, c.name]))
    return new Set(rows.map(r => catName[r.category_id]).filter(Boolean))
  }
  const forecastFor = companyId => {
    const plan = getPlan(companyId)
    return computeProForma({
      transactions, categories, companyId,
      assumptions: plan.assumptions, overrides: plan.overrides,
      includedCategories: includedFor(companyId),
    })
  }
  const isConsolidated = facility === 'all'
  const pf = isConsolidated
    ? consolidateProFormas(companies.map(c => forecastFor(c.id)))
    : forecastFor(facility)
  const plan = isConsolidated ? null : getPlan(facility)
  const overrideCount = plan
    ? Object.values(plan.overrides).reduce((s, m) => s + Object.keys(m).length, 0)
    : 0

  const ttm = pf.ttmMonths
  const ttmLabel = ttm.length
    ? `${MONTHS[ttm[0].month - 1]} ${ttm[0].year} – ${MONTHS[ttm[11].month - 1]} ${ttm[11].year}`
    : ''
  const facilityName = isConsolidated ? 'All Facilities (Consolidated)' : companies.find(c => c.id === facility)?.name

  return (
    <div className="p-8">
      <div className="print-hide flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Pro Forma</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {year} budget · baseline from trailing 12 months ({ttmLabel})
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saveStatus && (
            <span className={`text-xs ${saveStatus === 'error' ? 'text-red-600' : 'text-slate-400'}`}>
              {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'All changes saved' : 'Save failed'}
            </span>
          )}
          <button onClick={() => window.print()}
            className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
            Print / Export
          </button>
        </div>
      </div>

      {tableMissing && (
        <div className="print-hide mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The <code className="font-mono">pro_forma</code> table wasn’t found, so changes can’t be saved yet.
          Run the <code className="font-mono">pro_forma</code> section of <code className="font-mono">supabase/schema.sql</code> in the Supabase SQL Editor, then reload.
        </div>
      )}

      {/* Controls */}
      <div className="print-hide bg-white rounded-xl border border-slate-200 p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Facility</label>
          <select value={facility} onChange={e => setFacility(e.target.value)} className={selectCls}>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="all">All Facilities (Consolidated)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Forecast Year</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))} className={selectCls}>
            {[...YEARS].sort().map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {!isConsolidated && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Baseline</label>
            <select value={plan.assumptions.baseline} onChange={e => setAssumption('baseline', e.target.value)} className={selectCls}>
              {BASELINE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        {!isConsolidated && (
          <button onClick={() => setShowAssumptions(v => !v)}
            className={`px-3 py-1.5 text-sm rounded-lg border ${showAssumptions ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
            Assumptions
          </button>
        )}
        {!isConsolidated && overrideCount > 0 && (
          <button onClick={resetOverrides}
            className="px-3 py-1.5 text-sm rounded-lg border border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100">
            Reset {overrideCount} manual edit{overrideCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {isConsolidated && (
        <p className="print-hide text-sm text-slate-500 mb-4">
          Consolidated view sums each facility’s pro forma. Select a facility to edit its assumptions or monthly values.
        </p>
      )}

      {!isConsolidated && showAssumptions && (
        <AssumptionsPanel
          plan={plan}
          pf={pf}
          categories={categories}
          onAddRent={addRentIncrease}
          onUpdateRent={updateRentIncrease}
          onRemoveRent={removeRentIncrease}
          onSetLine={setLine}
        />
      )}

      <div className="print-area">
        <PrintHeader
          logoUrl={reportSettings.logo_url}
          reportName={reportSettings.report_name}
          subtitle={reportSettings.report_subtitle}
          title={`Pro Forma — ${facilityName}`}
          dateRange={`Jan – Dec ${year}`}
        />
        <ProFormaTable pf={pf} readOnly={isConsolidated} onOverride={setOverride} />
        {pf.uncategorized > 0 && (
          <p className="print-hide text-xs text-slate-400 mt-3">
            {formatWhole(pf.uncategorized)} of uncategorized activity in the trailing 12 months is not included. Categorize those transactions to include them.
          </p>
        )}
        <p className="print-hide text-xs text-slate-400 mt-1">
          Baseline excludes CapEx, one-time, and add-back transactions. Click any monthly amount to edit it; clear the cell to restore the calculated value.
        </p>
      </div>
    </div>
  )
}

// ── Assumptions ─────────────────────────────────────────────────────

function AssumptionsPanel({ plan, pf, categories, onAddRent, onUpdateRent, onRemoveRent, onSetLine }) {
  const rentIncreases = plan.assumptions.rentIncreases || []
  const rentLine = pf.income.find(l => l.name === RENT_CATEGORY)
  const shownNames = new Set(pf.allLines.map(l => l.name))
  const addable = categories.filter(c => !shownNames.has(c.name))

  return (
    <div className="print-hide grid gap-6 mb-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      {/* Rent increases */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden self-start">
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Rent Increases</h2>
            <p className="text-xs text-slate-500 mt-0.5">Applied to {RENT_CATEGORY} from the effective month onward</p>
          </div>
          <button onClick={onAddRent}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-700">
            + Add
          </button>
        </div>
        <div className="p-4 space-y-3">
          {rentIncreases.length === 0 && (
            <p className="text-sm text-slate-400">No rent increases planned.</p>
          )}
          {rentIncreases.map(inc => (
            <div key={inc.id} className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Effective</label>
                <select value={inc.month} onChange={e => onUpdateRent(inc.id, { month: Number(e.target.value) })}
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Type</label>
                <select value={inc.type} onChange={e => onUpdateRent(inc.id, { type: e.target.value })}
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                  {RENT_INCREASE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">{inc.type === 'pct' ? 'Percent' : 'Amount'}</label>
                <NumberInput value={inc.value} onChange={v => onUpdateRent(inc.id, { value: v })}
                  prefix={inc.type === 'pct' ? null : '$'} suffix={inc.type === 'pct' ? '%' : null} />
              </div>
              {inc.type === 'per_unit' && (
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Occupied units</label>
                  <NumberInput value={inc.units} onChange={v => onUpdateRent(inc.id, { units: v })} />
                </div>
              )}
              <button onClick={() => onRemoveRent(inc.id)} title="Remove"
                className="px-2 py-1.5 text-sm text-slate-400 hover:text-red-600">
                ✕
              </button>
            </div>
          ))}
          {rentLine && (
            <div className="pt-3 mt-1 border-t border-slate-100 text-xs text-slate-500 flex justify-between">
              <span>{RENT_CATEGORY}: TTM {formatWhole(rentLine.ttmTotal)} → {formatWhole(rentLine.total)}</span>
              {rentLine.ttmTotal > 0 && (
                <span className={rentLine.total >= rentLine.ttmTotal ? 'text-emerald-600' : 'text-red-600'}>
                  {pctChange(rentLine.total, rentLine.ttmTotal)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Line drivers */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Line Item Drivers</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              How each category is projected before manual edits. Defaults follow your Bank P&L category selection.
              {pf.operatingMonths < 12 && ` Averages use the ${pf.operatingMonths} operating month${pf.operatingMonths === 1 ? '' : 's'} in the trailing window.`}
            </p>
          </div>
          {addable.length > 0 && (
            <select value="" onChange={e => e.target.value && onSetLine(e.target.value, { method: 'fixed', value: 0 })}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-600">
              <option value="">+ Add line item…</option>
              {['income', 'expense'].map(type => (
                <optgroup key={type} label={type === 'income' ? 'Income' : 'Expense'}>
                  {addable.filter(c => c.type === type).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </optgroup>
              ))}
            </select>
          )}
        </div>
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-100">
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Category</th>
                <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">TTM Avg / Mo</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Method</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Value</th>
                <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Forecast</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {['income', 'expense'].map(type => (
                pf.allLines.filter(l => l.type === type).map((line, idx) => {
                  const methods = METHOD_OPTIONS.filter(m => type === 'expense' || !m.expenseOnly)
                  const unit = METHOD_OPTIONS.find(m => m.value === line.method)?.unit
                  const excluded = line.method === 'exclude'
                  return (
                    <tr key={line.name} className={idx === 0 ? 'border-t-2 border-slate-100' : ''}>
                      <td className={`px-4 py-1.5 ${excluded ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                        {line.name}
                        <span className="ml-1.5 text-[10px] uppercase tracking-wider text-slate-400">{type === 'income' ? 'inc' : 'exp'}</span>
                      </td>
                      <td className="px-4 py-1.5 text-right font-mono text-slate-500">{formatWhole(line.ttmAvg)}</td>
                      <td className="px-4 py-1.5">
                        <select value={line.method} onChange={e => onSetLine(line.name, driverDefaults(e.target.value, line, pf.ttmMonths))}
                          className="border border-slate-200 rounded-md px-2 py-1 text-xs">
                          {methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-1.5">
                        {unit && (
                          <NumberInput value={line.value} onChange={v => onSetLine(line.name, { value: v })}
                            prefix={unit === '$' ? '$' : null} suffix={unit === '%' ? '%' : null} small />
                        )}
                        {line.method === 'scheduled' && (
                          <MonthPicker months={line.months} onChange={months => onSetLine(line.name, { months })} />
                        )}
                      </td>
                      <td className={`px-4 py-1.5 text-right font-mono ${excluded ? 'text-slate-300' : type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                        {excluded ? '—' : formatWhole(line.total)}
                      </td>
                    </tr>
                  )
                })
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// Starting values when a line switches driver method. For 'scheduled', seed the
// annual amount and payment months from what was actually paid in the trailing window.
function driverDefaults(method, line, ttmMonths) {
  if (method !== 'scheduled') return { method, value: 0 }
  const paidMonths = ttmMonths.filter((_, i) => line.actual[i] > 0).map(m => m.month)
  return {
    method,
    value: line.ttmTotal > 0 ? Math.round(line.ttmTotal) : 0,
    months: paidMonths.length > 0 && paidMonths.length <= 4 ? [...new Set(paidMonths)].sort((a, b) => a - b) : [],
  }
}

// Compact 12-month toggle row for choosing when a scheduled amount is paid
function MonthPicker({ months, onChange }) {
  const selected = new Set(months)
  function toggle(m) {
    const next = new Set(selected)
    next.has(m) ? next.delete(m) : next.add(m)
    onChange([...next].sort((a, b) => a - b))
  }
  return (
    <div className="mt-1">
      <div className="flex gap-0.5">
        {MONTHS.map((label, i) => (
          <button key={label} type="button" onClick={() => toggle(i + 1)} title={label}
            className={`w-5 h-5 rounded text-[10px] font-medium ${selected.has(i + 1) ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
            {label[0]}
          </button>
        ))}
      </div>
      {selected.size === 0 && <p className="text-[10px] text-amber-600 mt-0.5">Pick payment month(s)</p>}
    </div>
  )
}

// Numeric input that keeps its own text while typing (so "1." or "-" aren't clobbered)
function NumberInput({ value, onChange, prefix, suffix, small }) {
  const [text, setText] = useState(value ? String(value) : '')
  const [focused, setFocused] = useState(false)
  const shown = focused ? text : (value ? String(value) : '')
  return (
    <div className={`flex items-center border border-slate-200 rounded-lg bg-white focus-within:ring-2 focus-within:ring-slate-900 ${small ? 'w-24' : 'w-28'}`}>
      {prefix && <span className="pl-2 text-xs text-slate-400">{prefix}</span>}
      <input
        inputMode="decimal"
        value={shown}
        placeholder="0"
        onFocus={() => { setText(value ? String(value) : ''); setFocused(true) }}
        onBlur={() => setFocused(false)}
        onChange={e => {
          setText(e.target.value)
          const n = Number(e.target.value.replace(/[$,%\s]/g, ''))
          if (e.target.value.trim() === '') onChange(0)
          else if (Number.isFinite(n)) onChange(n)
        }}
        className={`w-full min-w-0 bg-transparent px-2 ${small ? 'py-1 text-xs' : 'py-1.5 text-sm'} text-right font-mono focus:outline-none`}
      />
      {suffix && <span className="pr-2 text-xs text-slate-400">{suffix}</span>}
    </div>
  )
}

function pctChange(next, prev) {
  if (!prev) return '—'
  const p = (next - prev) / Math.abs(prev) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`
}

// ── Monthly grid ────────────────────────────────────────────────────

function ProFormaTable({ pf, readOnly, onOverride }) {
  const [showIncome, setShowIncome] = useState(true)
  const [showExpenses, setShowExpenses] = useState(true)
  const colCount = 12 + 4
  const th = 'text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap'
  const stickyCell = 'sticky left-0 z-10'

  const t = pf.totals
  const noiTone = v => (v >= 0 ? 'text-emerald-600' : 'text-red-600')

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
      <table className="text-sm w-full">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className={`${stickyCell} bg-slate-50 text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider`}>Category</th>
            {MONTHS.map(m => <th key={m} className={th}>{m}</th>)}
            <th className={th}>Total</th>
            <th className={th}>TTM Actual</th>
            <th className={th}>Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          <tr className="bg-slate-50 cursor-pointer hover:bg-slate-100" onClick={() => setShowIncome(v => !v)}>
            <td colSpan={colCount} className="px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <span className="mr-1.5">{showIncome ? '▼' : '▶'}</span>Income
            </td>
          </tr>
          {showIncome && pf.income.map(line => <LineRow key={line.name} line={line} tone="text-emerald-600" readOnly={readOnly} onOverride={onOverride} />)}
          {showIncome && pf.income.length === 0 && (
            <tr><td colSpan={colCount} className="px-4 py-2 text-sm text-slate-400">No income in the trailing 12 months</td></tr>
          )}
          <TotalRow label="Total Income" values={t.income} total={t.incomeTotal} ttmTotal={t.ttmIncome} tone={() => 'text-emerald-600'} />

          <tr className="bg-slate-50 cursor-pointer hover:bg-slate-100" onClick={() => setShowExpenses(v => !v)}>
            <td colSpan={colCount} className="px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <span className="mr-1.5">{showExpenses ? '▼' : '▶'}</span>Operating Expenses
            </td>
          </tr>
          {showExpenses && pf.expenses.map(line => <LineRow key={line.name} line={line} tone="text-red-500" readOnly={readOnly} onOverride={onOverride} />)}
          {showExpenses && pf.expenses.length === 0 && (
            <tr><td colSpan={colCount} className="px-4 py-2 text-sm text-slate-400">No expenses in the trailing 12 months</td></tr>
          )}
          <TotalRow label="Total Expenses" values={t.expenses} total={t.expenseTotal} ttmTotal={t.ttmExpenses} tone={() => 'text-red-500'} />

          <TotalRow label="NOI" values={t.noi} total={t.noiTotal} ttmTotal={t.ttmIncome - t.ttmExpenses} tone={noiTone} strong />
          <tr>
            <td className={`${stickyCell} bg-white px-4 py-1.5 text-xs text-slate-500`}>NOI Margin</td>
            {t.noi.map((v, i) => (
              <td key={i} className="px-3 py-1.5 text-right font-mono text-xs text-slate-400">
                {t.income[i] ? `${(v / t.income[i] * 100).toFixed(1)}%` : '—'}
              </td>
            ))}
            <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-500">
              {t.incomeTotal ? `${(t.noiTotal / t.incomeTotal * 100).toFixed(1)}%` : '—'}
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-400">
              {t.ttmIncome ? `${((t.ttmIncome - t.ttmExpenses) / t.ttmIncome * 100).toFixed(1)}%` : '—'}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function LineRow({ line, tone, readOnly, onOverride }) {
  return (
    <tr className="group hover:bg-slate-50">
      <td className="sticky left-0 z-10 bg-white group-hover:bg-slate-50 px-4 py-1 text-slate-700 whitespace-nowrap">{line.name}</td>
      {line.values.map((v, i) => (
        <EditableCell key={i} value={v} computed={line.computed?.[i]} overridden={line.overridden[i]}
          readOnly={readOnly} tone={tone} onCommit={amt => onOverride(line.name, i + 1, amt)} />
      ))}
      <td className={`px-3 py-1 text-right font-mono font-semibold ${tone}`}>{formatWhole(line.total)}</td>
      <td className="px-3 py-1 text-right font-mono text-slate-400">{formatWhole(line.ttmTotal)}</td>
      <td className="px-3 py-1 text-right font-mono text-xs text-slate-400">{pctChange(line.total, line.ttmTotal)}</td>
    </tr>
  )
}

function TotalRow({ label, values, total, ttmTotal, tone, strong }) {
  return (
    <tr className={strong ? 'border-t-2 border-slate-200' : 'bg-slate-50 font-semibold'}>
      <td className={`sticky left-0 z-10 ${strong ? 'bg-white font-bold' : 'bg-slate-50'} px-4 py-2 text-slate-900 whitespace-nowrap`}>{label}</td>
      {values.map((v, i) => (
        <td key={i} className={`px-3 py-2 text-right font-mono ${strong ? 'font-bold' : ''} ${tone(v)}`}>{formatWhole(v)}</td>
      ))}
      <td className={`px-3 py-2 text-right font-mono ${strong ? 'font-bold' : ''} ${tone(total)}`}>{formatWhole(total)}</td>
      <td className="px-3 py-2 text-right font-mono text-slate-400">{formatWhole(ttmTotal)}</td>
      <td className="px-3 py-2 text-right font-mono text-xs text-slate-400">{pctChange(total, ttmTotal)}</td>
    </tr>
  )
}

// A month cell that renders as text but edits in place. Committing a value
// different from the calculated one stores an override; clearing it resets.
function EditableCell({ value, computed, overridden, readOnly, tone, onCommit }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const cancelled = useRef(false)

  if (readOnly) {
    return <td className={`px-3 py-1 text-right font-mono ${tone}`}>{value ? formatWhole(value) : '—'}</td>
  }

  function commit() {
    setEditing(false)
    if (cancelled.current) { cancelled.current = false; return }
    const raw = text.trim().replace(/[$,\s]/g, '')
    if (raw === '') {
      if (overridden) onCommit(null)
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    if (Math.abs(n - value) < 0.005) return
    // Typing the calculated amount back in is the same as resetting
    onCommit(computed !== undefined && Math.abs(n - computed) < 0.005 ? null : n)
  }

  return (
    <td className={`px-1 py-0.5 text-right ${overridden ? 'bg-amber-50' : ''}`}
      title={overridden ? `Manually edited (calculated: ${formatWhole(computed)}). Clear to reset.` : 'Click to edit'}>
      <input
        value={editing ? text : (value ? formatWhole(value) : '—')}
        onFocus={e => {
          setText(value ? String(Math.round(value * 100) / 100) : '')
          setEditing(true)
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
        }}
        className={`w-24 bg-transparent px-2 py-1 text-right font-mono rounded border border-transparent hover:border-slate-200 focus:border-slate-400 focus:bg-white focus:outline-none ${overridden ? 'text-amber-700 font-semibold' : tone}`}
      />
    </td>
  )
}
