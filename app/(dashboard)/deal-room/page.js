'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import { buildPL, formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import ExportCsvButton from '@/components/ExportCsvButton'
import { plRows, money, pct, csvFilename } from '@/lib/exportCsv'

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2]

export default function DealRoomPage() {
  const [transactions, setTransactions] = useState([])
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [bankIncludedCats, setBankIncludedCats] = useState(new Set())
  const [bankExcludedTxs, setBankExcludedTxs] = useState(new Set())

  const [companyFilter, setCompanyFilter] = useState('all')
  const [year, setYear] = useState(CURRENT_YEAR)
  const [capRate, setCapRate] = useState('')
  const [propertyValue, setPropertyValue] = useState('')
  const [annualize, setAnnualize] = useState(true)

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [tx, { data: co }, { data: cat }] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date')),
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
    ])
    setTransactions(tx)
    setCompanies(co || [])
    setCategories(cat || [])
    setLoading(false)
  }

  // Load the Bank P&L config for the selected entity ('all' = portfolio/null),
  // mirroring the Bank P&L report so the two screens stay in sync.
  const loadBankConfig = useCallback(async (entityId) => {
    const isPortfolio = entityId === 'all'
    const [{ data: cats }, { data: excl }] = await Promise.all([
      isPortfolio
        ? supabase.from('bank_pl_categories').select('category_id').is('company_id', null)
        : supabase.from('bank_pl_categories').select('category_id').eq('company_id', entityId),
      isPortfolio
        ? supabase.from('bank_pl_exclusions').select('transaction_id').is('company_id', null)
        : supabase.from('bank_pl_exclusions').select('transaction_id').eq('company_id', entityId),
    ])
    setBankIncludedCats(new Set((cats || []).map(c => c.category_id)))
    setBankExcludedTxs(new Set((excl || []).map(e => e.transaction_id)))
  }, [])

  useEffect(() => { loadBankConfig(companyFilter) }, [companyFilter, loadBankConfig])

  const dateFrom = `${year}-01-01`
  const dateTo = `${year}-12-31`

  let filtered = transactions.filter(t => {
    if (t.date < dateFrom || t.date > dateTo) return false
    if (companyFilter !== 'all' && t.company_id !== companyFilter) return false
    return true
  })

  // Deal room = Bank P&L checked items only (raw transactions, no source
  // filter) — identical to the Bank P&L report / Overview NOI.
  const detailedFiltered = filtered.filter(t =>
    bankIncludedCats.has(t.category_id) && !bankExcludedTxs.has(t.id)
  )

  const pl = buildPL(detailedFiltered, categories)

  // Annualization: count distinct months with data, scale to 12
  const monthsWithData = new Set(detailedFiltered.map(t => t.date.slice(0, 7))).size || 1
  const annFactor = annualize && monthsWithData < 12 ? 12 / monthsWithData : 1
  const isAnnualized = annFactor > 1

  function ann(val) { return val * annFactor }

  // Annualized P&L figures
  const annIncome = pl.income.map(([name, amt]) => [name, ann(amt)])
  const annExpenses = pl.expenses.map(([name, amt]) => [name, ann(amt)])
  const annTotalIncome = ann(pl.totalIncome)
  const annTotalExpenses = ann(pl.totalExpenses)
  const normalizedNOI = annTotalIncome - annTotalExpenses

  const impliedValue = capRate ? (normalizedNOI / (parseFloat(capRate) / 100)) : null
  const capRateFromValue = propertyValue ? (normalizedNOI / parseFloat(propertyValue) * 100) : null

  // CSV export: the normalized P&L as shown, plus the valuation inputs
  function csvRows() {
    const entity = companyFilter === 'all' ? 'All Entities' : companies.find(c => c.id === companyFilter)?.name
    const label = `${entity} ${year}${isAnnualized ? ` (annualized from ${monthsWithData} months)` : ''}`
    const rows = plRows([{
      label,
      pl: { income: annIncome, expenses: annExpenses, totalIncome: annTotalIncome, totalExpenses: annTotalExpenses, noi: normalizedNOI },
    }])
    if (capRate) rows.push(['Cap Rate %', pct(parseFloat(capRate), 2)], ['Implied Value', money(impliedValue)])
    if (propertyValue) rows.push(['Property Value', money(parseFloat(propertyValue))], ['Cap Rate at Value %', pct(capRateFromValue, 2)])
    return rows
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Deal Room</h1>
          <p className="text-slate-500 text-sm mt-0.5">Normalized P&L for bank submissions and sale underwriting</p>
        </div>
        <div className="flex gap-2">
          <ExportCsvButton
            filename={() => csvFilename('deal-room', companyFilter === 'all' ? 'all-entities' : companies.find(c => c.id === companyFilter)?.name, year)}
            getRows={csvRows}
          />
          <button onClick={() => window.print()} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
            Print / PDF
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Entity</label>
          <select
            value={companyFilter}
            onChange={e => setCompanyFilter(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            <option value="all">All Entities (Consolidated)</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Year</label>
          <select
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Cap Rate (%)</label>
          <input
            type="number"
            step="0.1"
            value={capRate}
            onChange={e => setCapRate(e.target.value)}
            placeholder="e.g. 6.5"
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-28"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Property Value ($)</label>
          <input
            type="number"
            value={propertyValue}
            onChange={e => setPropertyValue(e.target.value)}
            placeholder="e.g. 2000000"
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-36"
          />
        </div>
        <div className="flex items-end pb-0.5">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <div
              onClick={() => setAnnualize(a => !a)}
              className={`relative w-9 h-5 rounded-full transition-colors ${annualize ? 'bg-blue-600' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${annualize ? 'translate-x-4' : ''}`} />
            </div>
            <span className="text-sm text-slate-600 font-medium">Annualize</span>
          </label>
        </div>
      </div>
      {isAnnualized && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 mb-4 text-sm text-blue-700 flex items-center gap-2">
          <span className="font-semibold">Annualized</span>
          <span className="text-blue-500">—</span>
          <span>{monthsWithData} month{monthsWithData !== 1 ? 's' : ''} of data scaled to 12 months ({annFactor.toFixed(2)}× factor). All figures below reflect a full-year run rate.</span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wider mb-1">
            Gross Revenue{isAnnualized ? ' (Ann.)' : ''}
          </p>
          <p className="text-2xl font-bold text-emerald-700">{formatCurrency(annTotalIncome)}</p>
          {isAnnualized && <p className="text-xs text-emerald-600 mt-1">Actual: {formatCurrency(pl.totalIncome)}</p>}
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-1">
            Operating Expenses{isAnnualized ? ' (Ann.)' : ''}
          </p>
          <p className="text-2xl font-bold text-red-700">{formatCurrency(annTotalExpenses)}</p>
          {isAnnualized && <p className="text-xs text-red-600 mt-1">Actual: {formatCurrency(pl.totalExpenses)}</p>}
        </div>
        <div className={`border rounded-xl p-4 ${normalizedNOI >= 0 ? 'bg-blue-50 border-blue-200' : 'bg-red-50 border-red-200'}`}>
          <p className={`text-xs font-semibold uppercase tracking-wider mb-1 ${normalizedNOI >= 0 ? 'text-blue-700' : 'text-red-700'}`}>
            Normalized NOI{isAnnualized ? ' (Ann.)' : ''}
          </p>
          <p className={`text-2xl font-bold ${normalizedNOI >= 0 ? 'text-blue-700' : 'text-red-700'}`}>{formatCurrency(normalizedNOI)}</p>
          {isAnnualized && <p className={`text-xs mt-1 ${normalizedNOI >= 0 ? 'text-blue-600' : 'text-red-600'}`}>Actual: {formatCurrency(pl.noi)}</p>}
        </div>
      </div>

      {/* Valuation */}
      {(impliedValue || capRateFromValue) && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-slate-900">Valuation</h3>
            <span className="text-xs text-slate-400">
              Based on {isAnnualized ? `annualized NOI (${monthsWithData}mo × ${annFactor.toFixed(2)})` : 'full-year NOI'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {impliedValue && (
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500 mb-1">Implied Value at {capRate}% cap rate</p>
                <p className="text-xl font-bold text-slate-900">{formatCurrency(impliedValue)}</p>
                <p className="text-xs text-slate-400 mt-1">NOI {formatCurrency(normalizedNOI)} ÷ {capRate}%</p>
              </div>
            )}
            {capRateFromValue && (
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500 mb-1">Cap Rate at {formatCurrency(parseFloat(propertyValue))} value</p>
                <p className="text-xl font-bold text-slate-900">{capRateFromValue.toFixed(2)}%</p>
                <p className="text-xs text-slate-400 mt-1">NOI {formatCurrency(normalizedNOI)} ÷ {formatCurrency(parseFloat(propertyValue))}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
          <h2 className="font-semibold text-slate-900 text-sm">P&L Statement</h2>
          <p className="text-xs text-slate-500 mt-0.5">Detailed accrual view — for bank & buyer review</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Revenue</p>
            {annIncome.map(([name, amt]) => (
              <div key={name} className="flex justify-between text-sm py-0.5">
                <span className="text-slate-600">{name}</span>
                <span className="font-mono text-emerald-600">{formatCurrency(amt)}</span>
              </div>
            ))}
            <div className="flex justify-between text-sm font-semibold pt-2 border-t border-slate-100 mt-2">
              <span>Total Revenue</span>
              <span className="font-mono text-emerald-600">{formatCurrency(annTotalIncome)}</span>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Expenses</p>
            {annExpenses.map(([name, amt]) => (
              <div key={name} className="flex justify-between text-sm py-0.5">
                <span className="text-slate-600">{name}</span>
                <span className="font-mono text-red-500">{formatCurrency(amt)}</span>
              </div>
            ))}
            <div className="flex justify-between text-sm font-semibold pt-2 border-t border-slate-100 mt-2">
              <span>Total Expenses</span>
              <span className="font-mono text-red-500">{formatCurrency(annTotalExpenses)}</span>
            </div>
          </div>
          <div className={`rounded-lg p-3 ${normalizedNOI >= 0 ? 'bg-blue-50 border border-blue-200' : 'bg-red-50 border border-red-200'}`}>
            <div className="flex justify-between font-bold text-sm">
              <span>NOI{isAnnualized ? ' (Annualized)' : ''}</span>
              <span className={`font-mono ${normalizedNOI >= 0 ? 'text-blue-700' : 'text-red-700'}`}>{formatCurrency(normalizedNOI)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
