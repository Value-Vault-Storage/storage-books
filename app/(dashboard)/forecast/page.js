'use client'
import { useState, useEffect, useCallback, Fragment } from 'react'
import { createClient } from '@/utils/supabase/client'
import { filterTransactions, buildPL, formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import ExportCsvButton from '@/components/ExportCsvButton'
import { money, csvFilename } from '@/lib/exportCsv'

const CURRENT_YEAR = new Date().getFullYear()
const CURRENT_MONTH = new Date().getMonth() + 1

function addMonths(year, month, n) {
  let m = month + n
  let y = year
  while (m > 12) { m -= 12; y++ }
  while (m < 1)  { m += 12; y-- }
  return { year: y, month: m }
}

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' })
}

function monthShort(year, month) {
  return new Date(year, month - 1, 1).toLocaleString('default', { month: 'short' })
}

function monthPrefix(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`
}

export default function ForecastPage() {
  const [transactions, setTransactions] = useState([])
  const [categories, setCategories] = useState([])
  const [companies, setCompanies] = useState([])
  const [accounts, setAccounts] = useState([])
  const [balances, setBalances] = useState([])
  const [forecastItems, setForecastItems] = useState([])
  const [loading, setLoading] = useState(true)

  // Forecast configuration
  const [baselinePeriod, setBaselinePeriod] = useState('last3')

  // Persisted exclusions (by ID, backed by DB)
  const [excludedCatIds, setExcludedCatIds] = useState(new Set())
  const [excludedTxIds, setExcludedTxIds] = useState(new Set())

  // UI-only expand state
  const [expandedCats, setExpandedCats] = useState(new Set())

  // Add item modal
  const [showAdd, setShowAdd] = useState(false)
  const [newItem, setNewItem] = useState({ description: '', amount: '', due_date: '', company_id: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [
      tx,
      { data: cat },
      { data: co },
      { data: acc },
      { data: bal },
      { data: fi },
      { data: catExcl },
      { data: txExcl },
    ] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date')),
      supabase.from('categories').select('*'),
      supabase.from('companies').select('*').order('name'),
      supabase.from('accounts').select('*'),
      supabase.from('monthly_balances').select('*'),
      supabase.from('forecast_items').select('*, companies(name), categories(name)').order('due_date'),
      supabase.from('forecast_category_exclusions').select('category_id'),
      supabase.from('forecast_transaction_exclusions').select('transaction_id'),
    ])
    setTransactions(tx)
    setCategories(cat || [])
    setCompanies(co || [])
    setAccounts(acc || [])
    setBalances(bal || [])
    setForecastItems(fi || [])
    setExcludedCatIds(new Set((catExcl || []).map(r => r.category_id)))
    setExcludedTxIds(new Set((txExcl || []).map(r => r.transaction_id)))
    setLoading(false)
  }

  // ── Cash position ────────────────────────────────────────────────
  const totalCash = accounts.reduce((sum, acc) => {
    const acctBalances = balances
      .filter(b => b.account_id === acc.id)
      .sort((a, b) => (b.year * 100 + b.month) - (a.year * 100 + a.month))
    const latest = acctBalances[0]
    return sum + (latest ? parseFloat(latest.balance) : 0)
  }, 0)

  const cashAsOf = (() => {
    const allDated = balances
      .filter(b => accounts.some(a => a.id === b.account_id))
      .map(b => ({ year: b.year, month: b.month }))
      .sort((a, b) => (b.year * 100 + b.month) - (a.year * 100 + a.month))
    if (!allDated.length) return null
    return monthLabel(allDated[0].year, allDated[0].month)
  })()

  // ── Baseline month sets ──────────────────────────────────────────
  const last3Months = [-3, -2, -1].map(n => addMonths(CURRENT_YEAR, CURRENT_MONTH, n))

  const ytdMonths = (() => {
    const months = []
    for (let m = 1; m < CURRENT_MONTH; m++) months.push({ year: CURRENT_YEAR, month: m })
    return months.length > 0 ? months : last3Months
  })()

  const baselineMonths = baselinePeriod === 'ytd' ? ytdMonths : last3Months
  const baselineCount = baselineMonths.length

  const baselineLabel = baselinePeriod === 'ytd'
    ? `${monthShort(CURRENT_YEAR, 1)}–${monthShort(CURRENT_YEAR, CURRENT_MONTH - 1)} ${CURRENT_YEAR} YTD (${baselineCount} months)`
    : `${baselineMonths.map(m => monthShort(m.year, m.month)).join(', ')} averages`

  // ── Transaction helpers ──────────────────────────────────────────
  function txForMonth(year, month) {
    return filterTransactions(
      transactions.filter(t =>
        t.date.startsWith(monthPrefix(year, month)) &&
        !excludedTxIds.has(t.id)
      ),
      'detailed'
    )
  }

  // All detailed transactions for a category across baseline months
  function txsForCategory(catId) {
    return baselineMonths.flatMap(({ year, month }) =>
      transactions.filter(t =>
        t.date.startsWith(monthPrefix(year, month)) &&
        t.category_id === catId &&
        t.source_type !== 'bank'
      )
    ).sort((a, b) => a.date.localeCompare(b.date))
  }

  // ── Build baseline P&Ls ──────────────────────────────────────────
  const baselinePLs = baselineMonths.map(({ year, month }) =>
    buildPL(txForMonth(year, month), categories)
  )

  // ── Full category breakdowns (all categories, for config UI) ─────
  const incomeBreakdown = (() => {
    const totals = {}
    baselinePLs.forEach(pl => {
      pl.income.forEach(([name, amt]) => { totals[name] = (totals[name] || 0) + amt })
    })
    return Object.entries(totals)
      .map(([name, total]) => ({
        name,
        catId: categories.find(c => c.name === name)?.id,
        avg: total / baselineCount,
      }))
      .filter(x => x.catId)
      .sort((a, b) => b.avg - a.avg)
  })()

  const expenseBreakdown = (() => {
    const totals = {}
    baselinePLs.forEach(pl => {
      pl.expenses.forEach(([name, amt]) => { totals[name] = (totals[name] || 0) + amt })
    })
    return Object.entries(totals)
      .map(([name, total]) => ({
        name,
        catId: categories.find(c => c.name === name)?.id,
        avg: total / baselineCount,
      }))
      .filter(x => x.catId)
      .sort((a, b) => b.avg - a.avg)
  })()

  // ── Filtered averages (only included categories + transactions) ──
  const avgIncome = incomeBreakdown
    .filter(({ catId }) => !excludedCatIds.has(catId))
    .reduce((s, { avg }) => s + avg, 0)

  const avgExpenses = expenseBreakdown
    .filter(({ catId }) => !excludedCatIds.has(catId))
    .reduce((s, { avg }) => s + avg, 0)

  const avgNOI = avgIncome - avgExpenses

  // ── Category toggle (persisted) ──────────────────────────────────
  async function toggleCategory(catId) {
    if (excludedCatIds.has(catId)) {
      await supabase.from('forecast_category_exclusions').delete().eq('category_id', catId)
      setExcludedCatIds(prev => { const n = new Set(prev); n.delete(catId); return n })
    } else {
      await supabase.from('forecast_category_exclusions').upsert({ category_id: catId }, { onConflict: 'category_id', ignoreDuplicates: true })
      setExcludedCatIds(prev => new Set([...prev, catId]))
    }
  }

  // ── Transaction toggle (persisted) ───────────────────────────────
  async function toggleTransaction(txId) {
    if (excludedTxIds.has(txId)) {
      await supabase.from('forecast_transaction_exclusions').delete().eq('transaction_id', txId)
      setExcludedTxIds(prev => { const n = new Set(prev); n.delete(txId); return n })
    } else {
      await supabase.from('forecast_transaction_exclusions').upsert({ transaction_id: txId }, { onConflict: 'transaction_id', ignoreDuplicates: true })
      setExcludedTxIds(prev => new Set([...prev, txId]))
    }
  }

  // ── Expand/collapse category drilldown ───────────────────────────
  function toggleExpandCat(catId) {
    setExpandedCats(prev => {
      const n = new Set(prev)
      n.has(catId) ? n.delete(catId) : n.add(catId)
      return n
    })
  }

  // ── Select / deselect all (persisted) ────────────────────────────
  async function selectAllIncome() {
    const ids = incomeBreakdown.map(x => x.catId)
    await supabase.from('forecast_category_exclusions').delete().in('category_id', ids)
    setExcludedCatIds(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n })
  }
  async function deselectAllIncome() {
    const rows = incomeBreakdown.map(x => ({ category_id: x.catId }))
    if (rows.length) await supabase.from('forecast_category_exclusions').upsert(rows, { onConflict: 'category_id', ignoreDuplicates: true })
    setExcludedCatIds(prev => new Set([...prev, ...incomeBreakdown.map(x => x.catId)]))
  }
  async function selectAllExpenses() {
    const ids = expenseBreakdown.map(x => x.catId)
    await supabase.from('forecast_category_exclusions').delete().in('category_id', ids)
    setExcludedCatIds(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n })
  }
  async function deselectAllExpenses() {
    const rows = expenseBreakdown.map(x => ({ category_id: x.catId }))
    if (rows.length) await supabase.from('forecast_category_exclusions').upsert(rows, { onConflict: 'category_id', ignoreDuplicates: true })
    setExcludedCatIds(prev => new Set([...prev, ...expenseBreakdown.map(x => x.catId)]))
  }

  // ── Historical rows (Jan → last completed month) ─────────────────
  const historicalRows = (() => {
    const rows = []
    for (let m = 1; m < CURRENT_MONTH; m++) {
      const pl = buildPL(txForMonth(CURRENT_YEAR, m), categories)
      const income = pl.income
        .filter(([name]) => {
          const cat = categories.find(c => c.name === name)
          return cat && !excludedCatIds.has(cat.id)
        })
        .reduce((s, [, amt]) => s + amt, 0)
      const expenses = pl.expenses
        .filter(([name]) => {
          const cat = categories.find(c => c.name === name)
          return cat && !excludedCatIds.has(cat.id)
        })
        .reduce((s, [, amt]) => s + amt, 0)
      const monthBals = balances.filter(b => b.year === CURRENT_YEAR && b.month === m)
      const savedBalance = monthBals.length > 0
        ? monthBals.reduce((s, b) => s + parseFloat(b.balance), 0)
        : null
      rows.push({
        year: CURRENT_YEAR, month: m,
        isActual: true,
        income, expenses,
        net: income - expenses,
        items: [], itemsTotal: 0,
        balance: savedBalance,
      })
    }
    return rows
  })()

  // ── Year-end forward projection (current month → Dec) ───────────
  const forecastMonths = Array.from(
    { length: 12 - CURRENT_MONTH + 1 },
    (_, i) => ({ year: CURRENT_YEAR, month: CURRENT_MONTH + i })
  )

  function forecastItemsForMonth(year, month) {
    const prefix = monthPrefix(year, month)
    return forecastItems.filter(item => item.due_date.startsWith(prefix))
  }

  const projection = forecastMonths.reduce((acc, { year, month }, i) => {
    const startBalance = i === 0 ? totalCash : acc[i - 1].endBalance
    const items = forecastItemsForMonth(year, month)
    const itemsTotal = items.reduce((s, item) => s + parseFloat(item.amount), 0)
    const net = avgIncome - avgExpenses + itemsTotal
    const endBalance = startBalance + net
    acc.push({ year, month, isActual: false, startBalance, avgIncome, avgExpenses, net, itemsTotal, items, endBalance, balance: endBalance })
    return acc
  }, [])

  const allRows = [...historicalRows, ...projection]

  // ── Manual item CRUD ─────────────────────────────────────────────
  async function addItem() {
    if (!newItem.description || !newItem.amount || !newItem.due_date) return
    setSaving(true)
    await supabase.from('forecast_items').insert({
      description: newItem.description,
      amount: parseFloat(newItem.amount),
      due_date: newItem.due_date,
      company_id: newItem.company_id || null,
      notes: newItem.notes || null,
    })
    setNewItem({ description: '', amount: '', due_date: '', company_id: '', notes: '' })
    setShowAdd(false)
    setSaving(false)
    await loadAll()
  }

  async function deleteItem(id) {
    setDeletingId(id)
    await supabase.from('forecast_items').delete().eq('id', id)
    setDeletingId(null)
    await loadAll()
  }

  // CSV export: the month-by-month table, then the upcoming one-time items
  function csvRows() {
    return [
      ['Month', 'Type', 'Income', 'Expenses', 'Net', 'One-Time Items', 'Cash Balance'],
      ...allRows.map(row => [
        monthLabel(row.year, row.month),
        row.isActual ? 'Actual' : 'Forecast',
        money(row.isActual ? row.income : row.avgIncome),
        money(row.isActual ? row.expenses : row.avgExpenses),
        money(row.net),
        money(row.itemsTotal),
        money(row.balance),
      ]),
      [],
      ['Upcoming Items'],
      ['Date', 'Description', 'Entity', 'Notes', 'Amount'],
      ...forecastItems.map(item => [
        item.due_date, item.description, item.companies?.name || 'All Entities', item.notes || '', money(parseFloat(item.amount)),
      ]),
    ]
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  const incomeExcludedCount = incomeBreakdown.filter(x => excludedCatIds.has(x.catId)).length
  const expensesExcludedCount = expenseBreakdown.filter(x => excludedCatIds.has(x.catId)).length

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Cash Flow Forecast</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {monthLabel(CURRENT_YEAR, CURRENT_MONTH)} → Dec {CURRENT_YEAR} · {baselineLabel}
          </p>
        </div>
        <div className="flex gap-2">
          <ExportCsvButton filename={() => csvFilename('cash-flow-forecast', CURRENT_YEAR)} getRows={csvRows} />
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium"
          >
            + Add Upcoming Item
          </button>
        </div>
      </div>

      {/* Starting cash banner */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6 flex flex-wrap items-center gap-6">
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Current Cash Position</p>
          <p className={`text-3xl font-bold font-mono ${totalCash >= 0 ? 'text-slate-900' : 'text-red-600'}`}>{formatCurrency(totalCash)}</p>
          {cashAsOf && <p className="text-xs text-slate-400 mt-1">As of {cashAsOf} statement balances</p>}
          {!cashAsOf && <p className="text-xs text-amber-500 mt-1">No balances logged — go to Monthly Balances to add them</p>}
        </div>
        <div className="h-12 w-px bg-slate-200 hidden sm:block" />
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Avg Monthly Income</p>
          <p className="text-xl font-bold font-mono text-emerald-600">{formatCurrency(avgIncome)}</p>
          <p className="text-xs text-slate-400 mt-1">
            {incomeExcludedCount > 0
              ? `${incomeBreakdown.length - incomeExcludedCount} of ${incomeBreakdown.length} categories`
              : 'All categories included'}
          </p>
        </div>
        <div className="h-12 w-px bg-slate-200 hidden sm:block" />
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Avg Monthly Expenses</p>
          <p className="text-xl font-bold font-mono text-red-500">{formatCurrency(avgExpenses)}</p>
          <p className="text-xs text-slate-400 mt-1">
            {expensesExcludedCount > 0
              ? `${expenseBreakdown.length - expensesExcludedCount} of ${expenseBreakdown.length} categories`
              : 'All categories included'}
          </p>
        </div>
        <div className="h-12 w-px bg-slate-200 hidden sm:block" />
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Avg Monthly NOI</p>
          <p className={`text-xl font-bold font-mono ${avgNOI >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{formatCurrency(avgNOI)}</p>
          <p className="text-xs text-slate-400 mt-1">{baselinePeriod === 'ytd' ? 'YTD average' : '3-month average'}</p>
        </div>
      </div>

      {/* ── Forecast Inputs ───────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-sm text-slate-900">Forecast Inputs</h2>
            <p className="text-xs text-slate-400 mt-0.5">Selections are saved automatically · expand a category to exclude individual transactions</p>
          </div>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            <button
              onClick={() => setBaselinePeriod('last3')}
              className={`px-3 py-1.5 font-medium transition-colors ${baselinePeriod === 'last3' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              Last 3 Months
            </button>
            <button
              onClick={() => setBaselinePeriod('ytd')}
              disabled={CURRENT_MONTH === 1}
              className={`px-3 py-1.5 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${baselinePeriod === 'ytd' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              Year to Date
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-slate-100">
          {/* Income categories */}
          <div className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Income</span>
              <div className="flex gap-2 text-xs">
                <button onClick={selectAllIncome} className="text-slate-400 hover:text-slate-700 underline">All</button>
                <button onClick={deselectAllIncome} className="text-slate-400 hover:text-slate-700 underline">None</button>
              </div>
            </div>
            {incomeBreakdown.length === 0 ? (
              <p className="text-sm text-slate-400">No income data for this period</p>
            ) : (
              <div className="space-y-0.5">
                {incomeBreakdown.map(({ name, catId, avg }) => {
                  const included = !excludedCatIds.has(catId)
                  const expanded = expandedCats.has(catId)
                  const txs = txsForCategory(catId)
                  const excludedTxCount = txs.filter(t => excludedTxIds.has(t.id)).length
                  return (
                    <div key={catId}>
                      <div className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${included ? 'hover:bg-emerald-50/50' : 'hover:bg-slate-50'}`}>
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => toggleCategory(catId)}
                          className="accent-emerald-600 w-3.5 h-3.5 flex-shrink-0"
                        />
                        <span className={`flex-1 text-sm truncate ${included ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                          {name}
                        </span>
                        <span className={`font-mono text-xs font-medium flex-shrink-0 ${included ? 'text-emerald-600' : 'text-slate-300'}`}>
                          {formatCurrency(avg)}
                        </span>
                        {txs.length > 0 && (
                          <button
                            onClick={() => toggleExpandCat(catId)}
                            className="flex-shrink-0 text-xs text-slate-400 hover:text-slate-700 ml-1 flex items-center gap-1"
                            title="Expand to exclude individual transactions"
                          >
                            {excludedTxCount > 0 && (
                              <span className="text-orange-500 font-medium">{excludedTxCount}</span>
                            )}
                            <span>{expanded ? '▾' : '▸'}</span>
                          </button>
                        )}
                      </div>
                      {/* Transaction drilldown */}
                      {expanded && txs.length > 0 && (
                        <div className="ml-5 mt-0.5 mb-1 border-l-2 border-slate-100 pl-3 space-y-0.5">
                          {txs.map(t => {
                            const txExcluded = excludedTxIds.has(t.id)
                            return (
                              <div key={t.id} className="flex items-start gap-2 py-1 rounded hover:bg-slate-50 px-1">
                                <input
                                  type="checkbox"
                                  checked={!txExcluded}
                                  onChange={() => toggleTransaction(t.id)}
                                  className="mt-0.5 accent-emerald-600 w-3 h-3 flex-shrink-0"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className={`text-xs truncate ${txExcluded ? 'text-slate-300 line-through' : 'text-slate-600'}`}>
                                    {t.description || '(no description)'}
                                  </p>
                                  <p className="text-xs text-slate-400">{t.date} · {formatCurrency(Math.abs(t.amount))}</p>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
                <div className="flex items-center justify-between pt-2 mt-1 border-t border-slate-100 px-2">
                  <span className="text-xs font-semibold text-slate-600">Included Total</span>
                  <span className="font-mono text-sm font-bold text-emerald-600">{formatCurrency(avgIncome)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Expense categories */}
          <div className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Expenses</span>
              <div className="flex gap-2 text-xs">
                <button onClick={selectAllExpenses} className="text-slate-400 hover:text-slate-700 underline">All</button>
                <button onClick={deselectAllExpenses} className="text-slate-400 hover:text-slate-700 underline">None</button>
              </div>
            </div>
            {expenseBreakdown.length === 0 ? (
              <p className="text-sm text-slate-400">No expense data for this period</p>
            ) : (
              <div className="space-y-0.5">
                {expenseBreakdown.map(({ name, catId, avg }) => {
                  const included = !excludedCatIds.has(catId)
                  const expanded = expandedCats.has(catId)
                  const txs = txsForCategory(catId)
                  const excludedTxCount = txs.filter(t => excludedTxIds.has(t.id)).length
                  return (
                    <div key={catId}>
                      <div className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${included ? 'hover:bg-red-50/40' : 'hover:bg-slate-50'}`}>
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => toggleCategory(catId)}
                          className="accent-red-500 w-3.5 h-3.5 flex-shrink-0"
                        />
                        <span className={`flex-1 text-sm truncate ${included ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                          {name}
                        </span>
                        <span className={`font-mono text-xs font-medium flex-shrink-0 ${included ? 'text-red-500' : 'text-slate-300'}`}>
                          {formatCurrency(avg)}
                        </span>
                        {txs.length > 0 && (
                          <button
                            onClick={() => toggleExpandCat(catId)}
                            className="flex-shrink-0 text-xs text-slate-400 hover:text-slate-700 ml-1 flex items-center gap-1"
                            title="Expand to exclude individual transactions"
                          >
                            {excludedTxCount > 0 && (
                              <span className="text-orange-500 font-medium">{excludedTxCount}</span>
                            )}
                            <span>{expanded ? '▾' : '▸'}</span>
                          </button>
                        )}
                      </div>
                      {/* Transaction drilldown */}
                      {expanded && txs.length > 0 && (
                        <div className="ml-5 mt-0.5 mb-1 border-l-2 border-slate-100 pl-3 space-y-0.5">
                          {txs.map(t => {
                            const txExcluded = excludedTxIds.has(t.id)
                            return (
                              <div key={t.id} className="flex items-start gap-2 py-1 rounded hover:bg-slate-50 px-1">
                                <input
                                  type="checkbox"
                                  checked={!txExcluded}
                                  onChange={() => toggleTransaction(t.id)}
                                  className="mt-0.5 accent-red-500 w-3 h-3 flex-shrink-0"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className={`text-xs truncate ${txExcluded ? 'text-slate-300 line-through' : 'text-slate-600'}`}>
                                    {t.description || '(no description)'}
                                  </p>
                                  <p className="text-xs text-slate-400">{t.date} · {formatCurrency(Math.abs(t.amount))}</p>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
                <div className="flex items-center justify-between pt-2 mt-1 border-t border-slate-100 px-2">
                  <span className="text-xs font-semibold text-slate-600">Included Total</span>
                  <span className="font-mono text-sm font-bold text-red-500">{formatCurrency(avgExpenses)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Full Year Cash Flow ───────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-sm text-slate-900">Full Year Cash Flow</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Actual Jan–{monthShort(CURRENT_YEAR, CURRENT_MONTH - 1 || 1)} · Forecast {monthShort(CURRENT_YEAR, CURRENT_MONTH)}–Dec
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-slate-100 border border-slate-300 inline-block" />
              Actual
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-blue-50 border border-blue-200 inline-block" />
              Forecast
            </span>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/40">
              <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500">Month</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500">Income</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500">Expenses</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500">Net</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500">One-Time</th>
              <th className="text-right px-5 py-2.5 text-xs font-semibold text-slate-700">Cash Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {allRows.map((row) => {
              const { year, month, isActual, income, expenses, net, items, itemsTotal, balance } = row
              const isCurrentMonth = month === CURRENT_MONTH
              const rowIncome = isActual ? income : row.avgIncome
              const rowExpenses = isActual ? expenses : row.avgExpenses
              return (
                <Fragment key={`${year}-${month}`}>
                  {isCurrentMonth && CURRENT_MONTH > 1 && (
                    <tr key="divider" className="bg-blue-50/20">
                      <td colSpan={6} className="px-5 py-1.5 text-xs text-blue-500 font-semibold tracking-wide border-t-2 border-blue-200">
                        ↓ Forecast begins
                      </td>
                    </tr>
                  )}
                  <tr className={`${isActual ? 'hover:bg-slate-50/60' : isCurrentMonth ? 'bg-blue-50/50 hover:bg-blue-50/70' : 'bg-blue-50/20 hover:bg-blue-50/40'}`}>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <span className={`font-medium ${isActual ? 'text-slate-700' : 'text-slate-600'}`}>
                        {monthLabel(year, month)}
                      </span>
                      {isCurrentMonth && (
                        <span className="ml-2 text-xs bg-blue-200 text-blue-800 px-1.5 py-0.5 rounded font-medium">Current</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-emerald-600">
                      {rowIncome > 0 ? formatCurrency(rowIncome) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-red-500">
                      {rowExpenses > 0 ? formatCurrency(rowExpenses) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                      {net === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <span className={net > 0 ? 'text-emerald-600' : 'text-red-500'}>
                          {net > 0 ? '+' : '−'}{formatCurrency(Math.abs(net))}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {itemsTotal === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <span className={itemsTotal < 0 ? 'text-orange-600' : 'text-emerald-600'}>
                          {itemsTotal > 0 ? '+' : '−'}{formatCurrency(Math.abs(itemsTotal))}
                        </span>
                      )}
                    </td>
                    <td className={`px-5 py-3 text-right font-mono font-bold ${
                      balance === null ? 'text-slate-300' :
                      balance >= 0 ? 'text-slate-900' : 'text-red-600'
                    }`}>
                      {balance !== null ? formatCurrency(balance) : '—'}
                    </td>
                  </tr>
                  {!isActual && items.length > 0 && items.map(item => {
                    const amt = parseFloat(item.amount)
                    return (
                      <tr key={`item-${item.id}`} className={isCurrentMonth ? 'bg-blue-50/40' : 'bg-blue-50/10'}>
                        <td colSpan={4} className="pl-10 pr-4 py-1.5">
                          <span className={`text-xs ${amt < 0 ? 'text-orange-500' : 'text-emerald-600'}`}>
                            {amt < 0 ? '↓' : '↑'} {item.description}
                            {item.companies?.name && <span className="text-slate-400 ml-1">· {item.companies.name}</span>}
                          </span>
                        </td>
                        <td className="px-4 py-1.5 text-right font-mono text-xs">
                          <span className={amt < 0 ? 'text-orange-500' : 'text-emerald-600'}>
                            {amt < 0 ? '−' : '+'}{formatCurrency(Math.abs(amt))}
                          </span>
                        </td>
                        <td className="px-5 py-1.5" />
                      </tr>
                    )
                  })}
                </Fragment>
              )
            })}
          </tbody>
          {projection.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td className="px-5 py-3 text-xs font-semibold text-slate-600">Dec {CURRENT_YEAR} Year-End</td>
                <td colSpan={4} />
                <td className={`px-5 py-3 text-right font-mono font-bold text-base ${
                  projection[projection.length - 1].endBalance >= 0 ? 'text-slate-900' : 'text-red-600'
                }`}>
                  {formatCurrency(projection[projection.length - 1].endBalance)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ── Scheduled one-time items ──────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-sm text-slate-900">Scheduled One-Time Items</h2>
            <p className="text-xs text-slate-400 mt-0.5">Manually added upcoming expenses or receipts</p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
          >
            + Add Item
          </button>
        </div>
        {forecastItems.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-slate-400 text-sm">No upcoming items scheduled</p>
            <p className="text-slate-300 text-xs mt-1">Add known one-time expenses like insurance renewals, repairs, or tax payments</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500 uppercase">Date</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Description</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Entity</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Notes</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Amount</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {forecastItems.map(item => {
                const amt = parseFloat(item.amount)
                const isPast = item.due_date < new Date().toISOString().slice(0, 10)
                return (
                  <tr key={item.id} className={`hover:bg-slate-50 ${isPast ? 'opacity-50' : ''}`}>
                    <td className="px-5 py-2.5 text-slate-500 font-mono text-xs whitespace-nowrap">
                      {item.due_date}
                      {isPast && <span className="ml-1.5 text-xs text-slate-300">(past)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700 font-medium">{item.description}</td>
                    <td className="px-4 py-2.5 text-slate-500 text-xs">{item.companies?.name || 'All Entities'}</td>
                    <td className="px-4 py-2.5 text-slate-400 text-xs max-w-xs truncate">{item.notes || '—'}</td>
                    <td className={`px-4 py-2.5 text-right font-mono font-semibold ${amt < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                      {amt < 0 ? '−' : '+'}{formatCurrency(Math.abs(amt))}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        onClick={() => deleteItem(item.id)}
                        disabled={deletingId === item.id}
                        className="text-xs text-slate-300 hover:text-red-500 disabled:opacity-50"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Item Modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-bold text-slate-900 mb-4">Add Upcoming Item</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
                <input
                  type="text"
                  value={newItem.description}
                  onChange={e => setNewItem(n => ({ ...n, description: e.target.value }))}
                  placeholder="e.g. Roof repair deposit, Insurance renewal"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Amount</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-slate-400 text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      value={newItem.amount}
                      onChange={e => setNewItem(n => ({ ...n, amount: e.target.value }))}
                      placeholder="0.00"
                      className="w-full border border-slate-200 rounded-lg pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                  </div>
                  <p className="text-xs text-slate-400 mt-1">Negative = outflow, positive = inflow</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Date</label>
                  <input
                    type="date"
                    value={newItem.due_date}
                    onChange={e => setNewItem(n => ({ ...n, due_date: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Entity <span className="text-slate-400 font-normal">(optional)</span></label>
                <select
                  value={newItem.company_id}
                  onChange={e => setNewItem(n => ({ ...n, company_id: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value="">All Entities</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notes <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={newItem.notes}
                  onChange={e => setNewItem(n => ({ ...n, notes: e.target.value }))}
                  placeholder="e.g. Quote from ABC Roofing, need to confirm"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setShowAdd(false); setNewItem({ description: '', amount: '', due_date: '', company_id: '', notes: '' }) }}
                className="flex-1 px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={addItem}
                disabled={!newItem.description || !newItem.amount || !newItem.due_date || saving}
                className="flex-1 px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium disabled:opacity-40"
              >
                {saving ? 'Adding...' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
