'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { filterTransactions, buildPL, formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import ExportCsvButton from '@/components/ExportCsvButton'
import { plRows, csvFilename } from '@/lib/exportCsv'

const CURRENT_YEAR = new Date().getFullYear()
const CURRENT_MONTH = new Date().getMonth() + 1
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2]
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function EntityComparisonPage() {
  const [transactions, setTransactions] = useState([])
  const [categories, setCategories] = useState([])
  const [companies, setCompanies] = useState([])
  const [year, setYear] = useState(CURRENT_YEAR)
  const [monthFrom, setMonthFrom] = useState(1)
  const [monthTo, setMonthTo] = useState(CURRENT_MONTH)
  const [showPct, setShowPct] = useState(false)
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [tx, { data: cat }, { data: co }] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date')),
      supabase.from('categories').select('*'),
      supabase.from('companies').select('*').order('name'),
    ])
    setTransactions(tx)
    setCategories(cat || [])
    setCompanies(co || [])
    setLoading(false)
  }

  // ── P&L per company ──────────────────────────────────────────────
  function filteredTx(companyId) {
    const from = `${year}-${String(monthFrom).padStart(2, '0')}-01`
    const to   = `${year}-${String(monthTo).padStart(2, '0')}-31`
    const base = transactions.filter(t =>
      (companyId ? t.company_id === companyId : true) &&
      t.date >= from && t.date <= to
    )
    return filterTransactions(base, 'detailed')
  }

  const entityPLs = companies.map(co => ({ company: co, pl: buildPL(filteredTx(co.id), categories) }))
  const portfolioPL = buildPL(filteredTx(null), categories)

  // ── All unique category names (sorted by portfolio total) ────────
  const allIncomeNames = [...new Set(entityPLs.flatMap(e => e.pl.income.map(([n]) => n)))]
    .sort((a, b) => {
      const aAmt = portfolioPL.income.find(([n]) => n === a)?.[1] || 0
      const bAmt = portfolioPL.income.find(([n]) => n === b)?.[1] || 0
      return bAmt - aAmt
    })

  const allExpenseNames = [...new Set(entityPLs.flatMap(e => e.pl.expenses.map(([n]) => n)))]
    .sort((a, b) => {
      const aAmt = portfolioPL.expenses.find(([n]) => n === a)?.[1] || 0
      const bAmt = portfolioPL.expenses.find(([n]) => n === b)?.[1] || 0
      return bAmt - aAmt
    })

  function getIncome(pl, name) { return pl.income.find(([n]) => n === name)?.[1] || 0 }
  function getExpense(pl, name) { return pl.expenses.find(([n]) => n === name)?.[1] || 0 }
  function margin(pl) { return pl.totalIncome > 0 ? (pl.noi / pl.totalIncome) * 100 : null }
  function pctStr(amt, base) { return base > 0 ? `${((amt / base) * 100).toFixed(1)}%` : '—' }

  // ── Underperformer detection ─────────────────────────────────────
  const margins = entityPLs
    .map(e => ({ company: e.company, pl: e.pl, margin: margin(e.pl) }))
    .filter(e => e.margin !== null)

  const underperformer = companies.length > 1 && margins.length > 0
    ? margins.reduce((a, b) => a.margin < b.margin ? a : b)
    : null

  const avgMargin = margins.length > 0 ? margins.reduce((s, e) => s + e.margin, 0) / margins.length : null

  // Why is the underperformer underperforming?
  const insights = (() => {
    if (!underperformer) return []
    const ue = underperformer
    const others = entityPLs.filter(e => e.company.id !== ue.company.id)
    if (others.length === 0) return []
    const avgRevenue = entityPLs.reduce((s, e) => s + e.pl.totalIncome, 0) / entityPLs.length
    const list = []

    if (ue.pl.totalIncome < avgRevenue * 0.9) {
      list.push({ type: 'revenue', msg: `Revenue ${formatCurrency(ue.pl.totalIncome)} is ${formatCurrency(avgRevenue - ue.pl.totalIncome)} below portfolio average` })
    }

    allExpenseNames.forEach(name => {
      const uePct = ue.pl.totalIncome > 0 ? getExpense(ue.pl, name) / ue.pl.totalIncome * 100 : 0
      const avgPct = entityPLs.reduce((s, e) => s + (e.pl.totalIncome > 0 ? getExpense(e.pl, name) / e.pl.totalIncome * 100 : 0), 0) / entityPLs.length
      if (uePct > avgPct + 5 && getExpense(ue.pl, name) > 500) {
        list.push({ type: 'expense', msg: `${name} is ${uePct.toFixed(1)}% of revenue vs ${avgPct.toFixed(1)}% portfolio average` })
      }
    })

    return list
  })()

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  const numCols = companies.length + 1 // entities + total

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Entity Comparison</h1>
          <p className="text-slate-500 text-sm mt-0.5">Side-by-side P&L across all entities</p>
        </div>
        <ExportCsvButton
          filename={() => csvFilename('entity-comparison', year, MONTHS[monthFrom - 1], MONTHS[monthTo - 1])}
          getRows={() => plRows(
            [...entityPLs.map(e => ({ label: e.company.name, pl: e.pl })), { label: 'Portfolio', pl: portfolioPL }],
            { total: false }
          )}
        />
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Year</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">From</label>
          <select value={monthFrom} onChange={e => setMonthFrom(Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">To</label>
          <select value={monthTo} onChange={e => setMonthTo(Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div className="ml-auto flex items-end">
          <button onClick={() => setShowPct(v => !v)}
            className={`px-3 py-1.5 text-sm rounded-lg border font-medium transition-colors ${
              showPct ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}>
            % of Revenue
          </button>
        </div>
      </div>

      {/* NOI summary cards */}
      <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: `repeat(${numCols}, minmax(0, 1fr))` }}>
        {entityPLs.map(({ company, pl }) => {
          const m = margin(pl)
          const isUnder = underperformer?.company.id === company.id
          return (
            <div key={company.id} className={`bg-white rounded-xl border p-4 ${isUnder ? 'border-amber-300 ring-1 ring-amber-200' : 'border-slate-200'}`}>
              <div className="flex items-center justify-between mb-2 gap-1">
                <p className="text-xs font-semibold text-slate-500 truncate">{company.name}</p>
                {isUnder && <span className="text-xs text-amber-600 font-medium flex-shrink-0">⚠ Low</span>}
              </div>
              <p className={`text-2xl font-bold font-mono ${pl.noi >= 0 ? 'text-slate-900' : 'text-red-600'}`}>
                {formatCurrency(pl.noi)}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">NOI</p>
              {m !== null && (
                <p className={`text-sm font-bold mt-2 ${m >= 30 ? 'text-emerald-600' : m >= 15 ? 'text-amber-600' : 'text-red-600'}`}>
                  {m.toFixed(1)}% margin
                </p>
              )}
            </div>
          )
        })}
        <div className="bg-slate-900 rounded-xl p-4 text-white">
          <p className="text-xs font-semibold text-slate-400 mb-2">Portfolio Total</p>
          <p className="text-2xl font-bold font-mono">{formatCurrency(portfolioPL.noi)}</p>
          <p className="text-xs text-slate-400 mt-0.5">NOI</p>
          {portfolioPL.totalIncome > 0 && (
            <p className="text-sm font-bold mt-2 text-slate-300">
              {((portfolioPL.noi / portfolioPL.totalIncome) * 100).toFixed(1)}% margin
            </p>
          )}
        </div>
      </div>

      {/* Main comparison table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 w-44 sticky left-0 bg-slate-50">Category</th>
                {entityPLs.map(({ company }) => (
                  <th key={company.id} className="text-right px-4 py-3 text-xs font-semibold text-slate-700 whitespace-nowrap">
                    {company.name}
                  </th>
                ))}
                <th className="text-right px-5 py-3 text-xs font-semibold text-slate-900 border-l border-slate-100">Total</th>
              </tr>
            </thead>
            <tbody>
              {/* ── Revenue ── */}
              <tr className="bg-slate-50/70 border-y border-slate-100">
                <td colSpan={numCols + 1} className="px-5 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">Revenue</td>
              </tr>
              {allIncomeNames.map(name => (
                <tr key={name} className="border-b border-slate-50 hover:bg-slate-50/40">
                  <td className="px-5 py-2.5 text-slate-600 pl-8 sticky left-0 bg-white">{name}</td>
                  {entityPLs.map(({ company, pl }) => {
                    const amt = getIncome(pl, name)
                    return (
                      <td key={company.id} className="px-4 py-2.5 text-right font-mono text-xs">
                        {amt > 0
                          ? <span className="text-slate-700">{showPct ? pctStr(amt, pl.totalIncome) : formatCurrency(amt)}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                    )
                  })}
                  <td className="px-5 py-2.5 text-right font-mono text-xs text-slate-600 border-l border-slate-100">
                    {(() => { const a = portfolioPL.income.find(([n]) => n === name)?.[1] || 0; return a > 0 ? (showPct ? pctStr(a, portfolioPL.totalIncome) : formatCurrency(a)) : <span className="text-slate-300">—</span> })()}
                  </td>
                </tr>
              ))}
              <tr className="border-b border-slate-200 bg-emerald-50/40">
                <td className="px-5 py-3 font-semibold text-slate-800 sticky left-0 bg-emerald-50/40">Total Revenue</td>
                {entityPLs.map(({ company, pl }) => (
                  <td key={company.id} className="px-4 py-3 text-right font-mono text-sm font-semibold text-emerald-700">
                    {formatCurrency(pl.totalIncome)}
                  </td>
                ))}
                <td className="px-5 py-3 text-right font-mono text-sm font-semibold text-emerald-700 border-l border-slate-100">
                  {formatCurrency(portfolioPL.totalIncome)}
                </td>
              </tr>

              {/* ── Expenses ── */}
              <tr className="bg-slate-50/70 border-y border-slate-100">
                <td colSpan={numCols + 1} className="px-5 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Expenses
                </td>
              </tr>
              {allExpenseNames.map(name => {
                // Flag entities spending notably more on this category (% of revenue) than average
                const entityPcts = entityPLs.map(e => ({
                  id: e.company.id,
                  pct: e.pl.totalIncome > 0 ? getExpense(e.pl, name) / e.pl.totalIncome * 100 : 0,
                }))
                const avgPct = entityPcts.reduce((s, e) => s + e.pct, 0) / (entityPcts.length || 1)
                const maxPct = Math.max(...entityPcts.map(e => e.pct))
                return (
                  <tr key={name} className="border-b border-slate-50 hover:bg-slate-50/40">
                    <td className="px-5 py-2.5 text-slate-600 pl-8 sticky left-0 bg-white">{name}</td>
                    {entityPLs.map(({ company, pl }) => {
                      const amt = getExpense(pl, name)
                      const thisPct = pl.totalIncome > 0 ? amt / pl.totalIncome * 100 : 0
                      const isHigh = companies.length > 1 && thisPct === maxPct && thisPct > avgPct + 5 && amt > 500
                      return (
                        <td key={company.id} className={`px-4 py-2.5 text-right font-mono text-xs ${isHigh ? 'text-red-600 font-semibold' : 'text-slate-700'}`}>
                          {amt > 0 ? (
                            <>
                              {showPct ? pctStr(amt, pl.totalIncome) : formatCurrency(amt)}
                              {isHigh && <span className="ml-1 text-red-400" title="Above average spend">↑</span>}
                            </>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                      )
                    })}
                    <td className="px-5 py-2.5 text-right font-mono text-xs text-slate-600 border-l border-slate-100">
                      {(() => { const a = portfolioPL.expenses.find(([n]) => n === name)?.[1] || 0; return a > 0 ? (showPct ? pctStr(a, portfolioPL.totalIncome) : formatCurrency(a)) : <span className="text-slate-300">—</span> })()}
                    </td>
                  </tr>
                )
              })}
              <tr className="border-b border-slate-200 bg-red-50/30">
                <td className="px-5 py-3 font-semibold text-slate-800 sticky left-0 bg-red-50/30">
                  Total Expenses
                </td>
                {entityPLs.map(({ company, pl }) => (
                  <td key={company.id} className="px-4 py-3 text-right font-mono text-sm font-semibold text-red-600">
                    {formatCurrency(pl.totalExpenses)}
                  </td>
                ))}
                <td className="px-5 py-3 text-right font-mono text-sm font-semibold text-red-600 border-l border-slate-100">
                  {formatCurrency(portfolioPL.totalExpenses)}
                </td>
              </tr>

              {/* ── NOI ── */}
              <tr className="border-b border-slate-100">
                <td className="px-5 py-3 font-bold text-slate-900 sticky left-0 bg-white">NOI</td>
                {entityPLs.map(({ company, pl }) => (
                  <td key={company.id} className={`px-4 py-3 text-right font-mono text-sm font-bold ${pl.noi >= 0 ? 'text-slate-900' : 'text-red-600'}`}>
                    {formatCurrency(pl.noi)}
                  </td>
                ))}
                <td className={`px-5 py-3 text-right font-mono text-sm font-bold border-l border-slate-100 ${portfolioPL.noi >= 0 ? 'text-slate-900' : 'text-red-600'}`}>
                  {formatCurrency(portfolioPL.noi)}
                </td>
              </tr>
              <tr className="bg-slate-50/40">
                <td className="px-5 py-3 text-xs font-semibold text-slate-500 sticky left-0 bg-slate-50/40">NOI Margin</td>
                {entityPLs.map(({ company, pl }) => {
                  const m = margin(pl)
                  const isUnder = underperformer?.company.id === company.id
                  return (
                    <td key={company.id} className={`px-4 py-3 text-right text-sm font-bold ${
                      m === null ? 'text-slate-300' : m >= 30 ? 'text-emerald-600' : m >= 15 ? 'text-amber-600' : 'text-red-600'
                    }`}>
                      {m !== null ? `${m.toFixed(1)}%` : '—'}
                      {isUnder && <span className="ml-1 text-amber-500">⚠</span>}
                    </td>
                  )
                })}
                <td className="px-5 py-3 text-right text-sm font-bold text-slate-700 border-l border-slate-100">
                  {portfolioPL.totalIncome > 0 ? `${((portfolioPL.noi / portfolioPL.totalIncome) * 100).toFixed(1)}%` : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Underperformer insights */}
      {underperformer && insights.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-500 text-base">⚠</span>
            <h3 className="font-semibold text-sm text-amber-900">
              {underperformer.company.name} is underperforming
            </h3>
            <span className="text-xs text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded font-medium">
              {underperformer.margin.toFixed(1)}% vs {avgMargin?.toFixed(1)}% avg
            </span>
          </div>
          <ul className="space-y-1.5">
            {insights.map((insight, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-amber-800">
                <span className="flex-shrink-0 font-bold">{insight.type === 'revenue' ? '↓' : '↑'}</span>
                {insight.msg}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
