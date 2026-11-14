'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { buildPL, formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import ExportCsvButton from '@/components/ExportCsvButton'
import { plRows, money, pct, csvFilename } from '@/lib/exportCsv'
import { loadAdjustments, buildNoiWalk } from '@/lib/reports/adjustments'
import Link from 'next/link'
import { groupNoiConfig, inNoi, firstDataMonth, t12Window, monthLabel, periodRange, addMonths } from '@/lib/reports/statement'

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2]
const NOW_KEY = `${CURRENT_YEAR}-${String(new Date().getMonth() + 1).padStart(2, '0')}`

export default function DealRoomPage() {
  const [transactions, setTransactions] = useState([])
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [noiConfig, setNoiConfig] = useState({ cats: new Map(), portfolioCats: new Set() })
  const [adjByTx, setAdjByTx] = useState(new Map())
  const [expandedSteps, setExpandedSteps] = useState(new Set())

  const [companyFilter, setCompanyFilter] = useState('all')
  const [period, setPeriod] = useState('t12') // 't12' | calendar year
  const [capRate, setCapRate] = useState('')
  const [propertyValue, setPropertyValue] = useState('')
  const [annualize, setAnnualize] = useState(true)

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [tx, { data: co }, { data: cat }, { data: cfg }, adj] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date')),
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('bank_pl_categories').select('category_id, company_id'),
      loadAdjustments(supabase),
    ])
    setAdjByTx(adj.byTx)
    setTransactions(tx)
    setCompanies(co || [])
    setCategories(cat || [])
    setNoiConfig(groupNoiConfig(cfg))
    setLoading(false)
  }

  // Period: T12 through the latest month with data (what lenders
  // underwrite), or a calendar year. Either way only months since the books
  // start count, so a partial history is labeled and annualized honestly.
  const scopeCo = companyFilter === 'all' ? null : companyFilter
  const firstKey = firstDataMonth(transactions, scopeCo)
  const latestKey = transactions.reduce((m, t) => {
    const k = t.date.slice(0, 7)
    return k <= NOW_KEY && (!m || k > m) ? k : m
  }, null) || NOW_KEY
  let months
  if (period === 't12') {
    months = t12Window(latestKey, firstKey).months
  } else {
    months = []
    for (let k = `${period}-01`; k <= `${period}-12`; k = addMonths(k, 1)) {
      if (firstKey && k >= firstKey && k <= latestKey) months.push(k)
    }
  }
  const monthSet = new Set(months)
  const periodLabel = months.length ? periodRange({ from: months[0], to: months[months.length - 1] }) : 'No data'

  const filtered = transactions.filter(t =>
    monthSet.has(t.date.slice(0, 7)) && (!scopeCo || t.company_id === scopeCo))

  // Deal room = the NOI rule used everywhere (each entity's own "What counts
  // in NOI" selection, else the portfolio default; all sources), net of
  // documented NOI adjustments. The walk shows reported → adjusted.
  const reportedTxs = filtered.filter(t => inNoi(noiConfig, t))
  const walk = buildNoiWalk(reportedTxs, categories, adjByTx)
  const pl = walk.adjusted
  const unreviewedCount = walk.steps.find(s => s.treatment.value === 'unreviewed')?.items.length || 0

  // Annualization: months covered by the books in this period, scaled to 12
  const monthsWithData = months.length || 1
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
    const label = `${entity} ${periodLabel}${isAnnualized ? ` (annualized from ${monthsWithData} months)` : ''}`
    const rows = plRows([{
      label,
      pl: { income: annIncome, expenses: annExpenses, totalIncome: annTotalIncome, totalExpenses: annTotalExpenses, noi: normalizedNOI },
    }])
    if (walk.steps.length > 0) {
      rows.push([], ['NOI Walk', label], ['Reported NOI', money(ann(walk.reported.noi))])
      walk.steps.forEach(step => {
        rows.push([`${step.treatment.label} (${step.items.length})`, money(ann(step.total))])
        step.items.forEach(i => rows.push([`  ${i.tx.date} ${i.tx.description || ''} — ${i.adj.reason || 'no reason recorded'}`, money(ann(i.impact))]))
      })
      rows.push(['Adjusted NOI', money(normalizedNOI)])
    }
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
          <p className="text-slate-500 text-sm mt-0.5">Normalized P&L for bank submissions and sale underwriting · {periodLabel}</p>
        </div>
        <div className="flex gap-2">
          <ExportCsvButton
            filename={() => csvFilename('deal-room', companyFilter === 'all' ? 'all-entities' : companies.find(c => c.id === companyFilter)?.name, period === 't12' ? `t12-${latestKey}` : period)}
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
          <label className="block text-xs font-medium text-slate-500 mb-1">Period</label>
          <select
            value={period}
            onChange={e => setPeriod(e.target.value === 't12' ? 't12' : Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            <option value="t12">T12 through {monthLabel(latestKey)}</option>
            {YEARS.map(y => <option key={y} value={y}>Calendar {y}</option>)}
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
          <span>
            {monthsWithData} month{monthsWithData !== 1 ? 's' : ''} of data ({periodLabel}) scaled to 12 months ({annFactor.toFixed(2)}× factor).
            Annual bills paid outside these months (property tax, insurance renewals) aren&apos;t captured, so check them before sharing a run rate.
          </span>
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
            Adjusted NOI{isAnnualized ? ' (Ann.)' : ''}
          </p>
          <p className={`text-2xl font-bold ${normalizedNOI >= 0 ? 'text-blue-700' : 'text-red-700'}`}>{formatCurrency(normalizedNOI)}</p>
          {isAnnualized && <p className={`text-xs mt-1 ${normalizedNOI >= 0 ? 'text-blue-600' : 'text-red-600'}`}>Actual: {formatCurrency(pl.noi)}</p>}
        </div>
      </div>

      {/* Reported → adjusted NOI walk */}
      {walk.steps.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-slate-900">NOI Walk</h3>
            <Link href="/adjustments" className="print-hide text-xs text-slate-500 hover:text-slate-900 underline">Edit adjustments →</Link>
          </div>
          {unreviewedCount > 0 && (
            <p className="print-hide text-xs text-red-600 mb-3">
              {unreviewedCount} adjustment{unreviewedCount !== 1 ? 's have' : ' has'} no reason. Lenders and buyers usually reject undocumented add-backs.
            </p>
          )}
          <div className="text-sm">
            <div className="flex justify-between py-1">
              <span className="text-slate-700">Reported NOI{isAnnualized ? ' (Ann.)' : ''}</span>
              <span className="font-mono">{formatCurrency(ann(walk.reported.noi))}</span>
            </div>
            {walk.steps.map(step => {
              const open = expandedSteps.has(step.treatment.value)
              return (
                <div key={step.treatment.value} className="border-t border-slate-100">
                  <button
                    onClick={() => setExpandedSteps(prev => { const n = new Set(prev); n.has(step.treatment.value) ? n.delete(step.treatment.value) : n.add(step.treatment.value); return n })}
                    className="w-full flex justify-between py-1.5 text-left hover:bg-slate-50">
                    <span className="text-slate-600">
                      <span className="print-hide text-xs text-slate-400 mr-1">{open ? '▼' : '▶'}</span>
                      {step.treatment.label} <span className="text-slate-400">({step.items.length})</span>
                    </span>
                    <span className="font-mono text-slate-700">{step.total >= 0 ? '+' : ''}{formatCurrency(ann(step.total))}</span>
                  </button>
                  {open && (
                    <div className="pl-5 pb-2 space-y-1.5">
                      {step.items.map(i => (
                        <div key={i.tx.id} className="flex justify-between gap-4 text-xs">
                          <div className="min-w-0">
                            <p className="text-slate-600 truncate">{i.tx.date} · {i.tx.description} <span className="text-slate-400">· {i.category}</span></p>
                            <p className={i.adj.reason ? 'text-slate-500 italic' : 'text-red-500'}>{i.adj.reason || 'No reason recorded'}</p>
                          </div>
                          <span className="font-mono text-slate-600 whitespace-nowrap">{i.impact >= 0 ? '+' : ''}{formatCurrency(i.impact)}</span>
                        </div>
                      ))}
                      {isAnnualized && <p className="text-[11px] text-slate-400">Items shown at actual amounts; the group total is annualized.</p>}
                    </div>
                  )}
                </div>
              )
            })}
            <div className="flex justify-between py-1.5 border-t-2 border-slate-200 font-semibold">
              <span>Adjusted NOI{isAnnualized ? ' (Ann.)' : ''}</span>
              <span className="font-mono">{formatCurrency(normalizedNOI)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Valuation */}
      {(impliedValue || capRateFromValue) && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-slate-900">Valuation</h3>
            <span className="text-xs text-slate-400">
              Based on {isAnnualized ? `annualized NOI (${monthsWithData}mo × ${annFactor.toFixed(2)})` : `NOI for ${periodLabel}`}
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
          <p className="text-xs text-slate-500 mt-0.5">Cash basis, net of documented NOI adjustments — for bank & buyer review</p>
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
