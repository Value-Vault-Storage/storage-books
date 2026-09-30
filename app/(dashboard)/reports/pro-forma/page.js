'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import { fetchAllRows } from '@/lib/fetchAll'
import {
  computeProForma, consolidateProFormas, normalizeAssumptions, formatWhole, formatAccounting,
  WINDOW_OPTIONS,
} from '@/lib/reports/proforma'
import PrintHeader from '@/components/PrintHeader'
import ProFormaTable from '@/components/pro-forma/ProFormaTable'
import { ManualLineModal, RentIncreaseModal } from '@/components/pro-forma/LineItemModal'
import { Segmented, KpiCard, Delta, Icon } from '@/components/pro-forma/ui'

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = [CURRENT_YEAR, CURRENT_YEAR + 1, CURRENT_YEAR + 2]

const selectCls = 'border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400'

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
  const [view, setView] = useState('monthly')
  const [modal, setModal] = useState(null) // { kind: 'manual' | 'rent', initial }

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
      { assumptions: normalizeAssumptions(r.assumptions), overrides: r.overrides || {} },
    ])))
    if (co?.length) setFacility(co[0].id)
    setLoading(false)
  }

  function getPlan(companyId) {
    return plans[planKey(companyId, year)] || { assumptions: normalizeAssumptions(null), overrides: {} }
  }

  // Update the selected facility's plan and debounce-save it
  function updatePlan(fn) {
    const companyId = facility
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

  const updateAssumptions = fn => updatePlan(p => ({ ...p, assumptions: fn(p.assumptions) }))

  function setOverride(key, month, amount) {
    updatePlan(p => {
      const overrides = { ...p.overrides, [key]: { ...(p.overrides[key] || {}) } }
      if (amount === null) delete overrides[key][month]
      else overrides[key][month] = amount
      if (Object.keys(overrides[key]).length === 0) delete overrides[key]
      return { ...p, overrides }
    })
  }

  function resetOverrides() {
    if (!confirm('Clear all manual cell edits for this facility? Values return to the calculated amounts.')) return
    updatePlan(p => ({ ...p, overrides: {} }))
  }

  function setCategoryExcluded(name, excluded) {
    updateAssumptions(a => ({ ...a, excludedCategories: { ...a.excludedCategories, [name]: excluded } }))
  }

  function toggleVendor(categoryName, vendorKey) {
    updateAssumptions(a => {
      const current = new Set(a.excludedVendors[categoryName] || [])
      current.has(vendorKey) ? current.delete(vendorKey) : current.add(vendorKey)
      return { ...a, excludedVendors: { ...a.excludedVendors, [categoryName]: [...current] } }
    })
  }

  function saveManualLine(line) {
    updateAssumptions(a => {
      const exists = a.manualLines.some(l => l.id === line.id)
      return { ...a, manualLines: exists ? a.manualLines.map(l => (l.id === line.id ? line : l)) : [...a.manualLines, line] }
    })
    setModal(null)
  }

  function deleteManualLine(id) {
    updatePlan(p => {
      const overrides = { ...p.overrides }
      delete overrides[`manual:${id}`]
      return { assumptions: { ...p.assumptions, manualLines: p.assumptions.manualLines.filter(l => l.id !== id) }, overrides }
    })
    setModal(null)
  }

  function saveRentIncrease(inc) {
    updateAssumptions(a => {
      const exists = a.rentIncreases.some(r => r.id === inc.id)
      return { ...a, rentIncreases: exists ? a.rentIncreases.map(r => (r.id === inc.id ? inc : r)) : [...a.rentIncreases, inc] }
    })
    setModal(null)
  }

  function deleteRentIncrease(id) {
    updateAssumptions(a => ({ ...a, rentIncreases: a.rentIncreases.filter(r => r.id !== id) }))
    setModal(null)
  }

  function editRow(row) {
    const a = getPlan(facility).assumptions
    if (row.kind === 'manual') setModal({ kind: 'manual', initial: a.manualLines.find(l => l.id === row.id) })
    if (row.kind === 'rent') setModal({ kind: 'rent', initial: a.rentIncreases.find(r => r.id === row.id) })
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="h-7 w-40 bg-slate-200 rounded animate-pulse" />
        <div className="mt-6 grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map(i => <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />)}
        </div>
        <div className="mt-6 h-96 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    )
  }

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
  const facilityName = isConsolidated ? 'All Facilities' : companies.find(c => c.id === facility)?.name
  const t = pf.totals
  const trailingRevenueRun = t.trailingRevenueAvg * 12
  const trailingExpenseRun = t.trailingExpenseAvg * 12
  const trailingNOIRun = trailingRevenueRun - trailingExpenseRun

  return (
    <div className="p-8 max-w-[100rem]">
      {/* Header */}
      <div className="print-hide flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Reports</p>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight mt-0.5">Pro Forma</h1>
          <p className="text-sm text-slate-500 mt-1">FY {year} operating budget · {facilityName}</p>
        </div>
        <div className="flex items-center gap-2">
          {saveStatus && (
            <span className={`inline-flex items-center gap-1.5 text-xs mr-2 ${saveStatus === 'error' ? 'text-red-600' : 'text-slate-400'}`}>
              {saveStatus === 'saved' && <Icon name="check" className="w-3.5 h-3.5" />}
              {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : 'Save failed'}
            </span>
          )}
          {!isConsolidated && overrideCount > 0 && (
            <button onClick={resetOverrides}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-amber-200 text-amber-800 bg-amber-50 hover:bg-amber-100">
              <Icon name="reset" className="w-3.5 h-3.5" />
              Reset {overrideCount} edit{overrideCount === 1 ? '' : 's'}
            </button>
          )}
          <button onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
            <Icon name="printer" className="w-4 h-4" />
            Print
          </button>
        </div>
      </div>

      {tableMissing && (
        <div className="print-hide mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The <code className="font-mono">pro_forma</code> table wasn’t found, so changes can’t be saved. Run the
          <code className="font-mono"> pro_forma</code> section of <code className="font-mono">supabase/schema.sql</code> in Supabase, then reload.
        </div>
      )}

      {/* Toolbar */}
      <div className="print-hide flex flex-wrap items-center gap-x-6 gap-y-3 mb-6">
        <div className="flex items-center gap-2">
          <select value={facility} onChange={e => setFacility(e.target.value)} className={selectCls} aria-label="Facility">
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="all">All Facilities (Consolidated)</option>
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))} className={selectCls} aria-label="Forecast year">
            {YEARS.map(y => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </div>
        {!isConsolidated && (
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-slate-500">Trailing average</span>
            <Segmented size="sm" value={plan.assumptions.window}
              onChange={w => updateAssumptions(a => ({ ...a, window: w }))}
              options={WINDOW_OPTIONS.map(n => ({ value: n, label: `${n}M` }))} />
          </div>
        )}
        <div className="ml-auto">
          <Segmented size="sm" value={view} onChange={setView}
            options={[{ value: 'monthly', label: 'Monthly' }, { value: 'summary', label: 'Summary' }]} />
        </div>
      </div>

      {/* KPIs */}
      <div className="print-hide grid grid-cols-2 xl:grid-cols-4 gap-4 mb-3">
        <KpiCard label={`Revenue · FY ${year}`} value={formatWhole(t.revenueTotal)}
          sub={<><Delta current={t.revenueTotal} previous={trailingRevenueRun} /> vs {formatWhole(trailingRevenueRun)} trailing run-rate</>} />
        <KpiCard label="Operating Expenses" value={formatWhole(t.expenseTotal)}
          sub={<><Delta current={t.expenseTotal} previous={trailingExpenseRun} invert /> vs {formatWhole(trailingExpenseRun)} trailing run-rate</>} />
        <KpiCard label="Net Operating Income" value={formatWhole(t.noiTotal)} tone={t.noiTotal < 0 ? 'negative' : 'default'}
          sub={t.debtServiceTotal > 0 && t.revenueTotal
            ? <><Delta current={t.noiTotal} previous={trailingNOIRun} /> vs trailing · {(t.noiTotal / t.revenueTotal * 100).toFixed(1)}% margin</>
            : <><Delta current={t.noiTotal} previous={trailingNOIRun} /> vs {formatWhole(trailingNOIRun)} trailing run-rate</>} />
        {t.debtServiceTotal > 0 ? (
          <KpiCard label="Cash Flow After Debt Service" value={formatWhole(t.cashFlowTotal)} tone={t.cashFlowTotal < 0 ? 'negative' : 'default'}
            sub={<>DSCR <span className="font-medium text-slate-700">{(t.noiTotal / t.debtServiceTotal).toFixed(2)}x</span> on {formatWhole(t.debtServiceTotal)} debt service</>} />
        ) : (
          <KpiCard label="NOI Margin" value={t.revenueTotal ? `${(t.noiTotal / t.revenueTotal * 100).toFixed(1)}%` : '–'}
            sub={t.revenueTotal ? `Expense ratio ${(t.expenseTotal / t.revenueTotal * 100).toFixed(1)}%` : null} />
        )}
      </div>
      <p className="print-hide text-xs text-slate-500 mb-6">
        {isConsolidated
          ? 'Sum of each facility’s pro forma, using each facility’s own averaging window. Select a facility to make changes.'
          : <>
              Baseline averages {pf.window.label} ({pf.window.count} month{pf.window.count === 1 ? '' : 's'})
              {pf.window.limitedByOperating && ` — ${facilityName} has only ${pf.window.count} operating month${pf.window.count === 1 ? '' : 's'} of history`}
              . CapEx, one-time, and add-back transactions are excluded. Click a category to see vendors; click any month to edit it.
            </>}
      </p>

      <div className="print-area">
        <PrintHeader
          logoUrl={reportSettings.logo_url}
          reportName={reportSettings.report_name}
          subtitle={reportSettings.report_subtitle}
          title={`Pro Forma — ${facilityName}`}
          dateRange={`FY ${year}`}
        />
        <ProFormaTable
          key={facility}
          pf={pf}
          view={view}
          year={year}
          readOnly={isConsolidated}
          onOverride={setOverride}
          onExcludeCategory={name => setCategoryExcluded(name, true)}
          onToggleVendor={toggleVendor}
          onEditRow={editRow}
          onAdd={kind => setModal(kind === 'rent'
            ? { kind: 'rent', initial: null }
            : { kind: 'manual', initial: { type: kind } })}
        />
      </div>

      {/* Excluded categories */}
      {pf.excluded.length > 0 && (
        <div className="print-hide mt-6 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-5 py-3 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-900">Excluded from forecast</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Non-operating or one-off categories. Defaults follow your Bank P&L selection{isConsolidated ? '' : ' — include any that belong in operations'}.
            </p>
          </div>
          <ul className="divide-y divide-slate-100">
            {pf.excluded.map(e => (
              <li key={e.name} className="flex items-center gap-3 px-5 py-2 text-sm">
                <span className="text-slate-600">{e.name}</span>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{e.type === 'income' ? 'Revenue' : 'Expense'}</span>
                <span className="ml-auto tabular-nums text-slate-400">{formatAccounting(e.avg, { dollar: true })} / mo</span>
                {!isConsolidated && (
                  <button onClick={() => setCategoryExcluded(e.name, false)}
                    className="text-xs font-medium text-slate-600 px-2.5 py-1 rounded-md border border-slate-200 hover:bg-slate-50">
                    Include
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pf.uncategorized > 0 && (
        <p className="print-hide text-xs text-slate-400 mt-4">
          {formatWhole(pf.uncategorized)} of uncategorized activity in the trailing 12 months isn’t included. Categorize those transactions to include them.
        </p>
      )}

      {modal?.kind === 'manual' && (
        <ManualLineModal initial={modal.initial} onSave={saveManualLine} onDelete={deleteManualLine} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'rent' && (
        <RentIncreaseModal initial={modal.initial} onSave={saveRentIncrease} onDelete={deleteRentIncrease} onClose={() => setModal(null)} />
      )}
    </div>
  )
}
