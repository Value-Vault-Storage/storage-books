'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import ExportCsvButton from '@/components/ExportCsvButton'
import { money, csvFilename } from '@/lib/exportCsv'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const CURRENT_YEAR = new Date().getFullYear()
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2]

export default function BalancesPage() {
  const [accounts, setAccounts] = useState([])
  const [balances, setBalances] = useState([])
  const [companies, setCompanies] = useState([])
  const [transactions, setTransactions] = useState([])
  const [sources, setSources] = useState([])
  const [companyFilter, setCompanyFilter] = useState('')
  const [year, setYear] = useState(CURRENT_YEAR)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState({})
  const [view, setView] = useState('detail') // 'detail' | 'summary' | 'portfolio'

  // Add account modal
  const [showAddAccount, setShowAddAccount] = useState(false)
  const [newAccount, setNewAccount] = useState({ name: '', source: '', source_type: 'bank', last_four: '' })
  const [addingAccount, setAddingAccount] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const supabase = createClient()

  useEffect(() => { loadAll(true) }, [])

  async function loadAll(isInitial = false) {
    if (isInitial) setLoading(true)
    const [
      { data: acc, error: accErr },
      { data: bal },
      { data: co },
      tx,
      { data: src },
    ] = await Promise.all([
      supabase.from('accounts').select('*').order('created_at'),
      supabase.from('monthly_balances').select('*'),
      supabase.from('companies').select('*').order('name'),
      fetchAllRows(() => supabase.from('transactions').select('date, amount, company_id, source_type, source').order('date')),
      supabase.from('sources').select('*').order('name'),
    ])
    if (accErr) {
      setError(`Could not load accounts: ${accErr.message}. Make sure you have run the accounts table SQL in Supabase.`)
    } else {
      setError(null)
    }
    const loadedCo = co || []
    setAccounts(acc || [])
    setBalances(bal || [])
    setCompanies(loadedCo)
    setTransactions(tx || [])
    setSources(src || [])
    if (isInitial && loadedCo.length > 0) setCompanyFilter(loadedCo[0].id)
    if (isInitial) setLoading(false)
  }

  const entityAccounts = accounts.filter(a => a.company_id === companyFilter)
  const selectedCompany = companies.find(c => c.id === companyFilter)
  const allSources = sources.map(s => s.name)

  // ── Helpers ──────────────────────────────────────────────────────
  function editKey(accountId, balYear, balMonth) {
    return `${accountId}_${balYear}_${balMonth}`
  }

  function getSavedBalance(accountId, balYear, balMonth) {
    const row = balances.find(b =>
      b.account_id === accountId && b.year === balYear && b.month === balMonth
    )
    return row ? parseFloat(row.balance) : null
  }

  async function saveBalance(accountId, balYear, balMonth) {
    const key = editKey(accountId, balYear, balMonth)
    const rawValue = editing[key]
    if (rawValue === undefined) return
    if (rawValue === '') {
      const existing = balances.find(b =>
        b.account_id === accountId && b.year === balYear && b.month === balMonth
      )
      if (existing) {
        setSaving(true)
        await supabase.from('monthly_balances').delete().eq('id', existing.id)
        setEditing(prev => { const n = { ...prev }; delete n[key]; return n })
        await loadAll()
        setSaving(false)
      } else {
        setEditing(prev => { const n = { ...prev }; delete n[key]; return n })
      }
      return
    }
    const value = parseFloat(rawValue)
    if (isNaN(value)) return
    setSaving(true)
    const existing = balances.find(b =>
      b.account_id === accountId && b.year === balYear && b.month === balMonth
    )
    if (existing) {
      await supabase.from('monthly_balances').update({ balance: value }).eq('id', existing.id)
    } else {
      await supabase.from('monthly_balances').insert({
        account_id: accountId,
        company_id: companyFilter,
        account_name: accounts.find(a => a.id === accountId)?.name,
        year: balYear,
        month: balMonth,
        balance: value,
      })
    }
    setEditing(prev => { const n = { ...prev }; delete n[key]; return n })
    await loadAll()
    setSaving(false)
  }

  // Net bank transactions for entity across all accounts for a given month
  function getMonthNet(txYear, txMonth) {
    const prefix = `${txYear}-${String(txMonth).padStart(2, '0')}`
    return transactions
      .filter(t =>
        t.company_id === companyFilter &&
        t.date.startsWith(prefix) &&
        t.source_type === 'bank'
      )
      .reduce((s, t) => s + parseFloat(t.amount), 0)
  }

  // Sum of all accounts' saved balances for a month (null if any are missing)
  function getMonthTotal(balYear, balMonth) {
    if (entityAccounts.length === 0) return null
    let total = 0
    for (const acc of entityAccounts) {
      const b = getSavedBalance(acc.id, balYear, balMonth)
      if (b === null) return null
      total += b
    }
    return total
  }

  // ── Build month sections ─────────────────────────────────────────
  // Each section: { label, isStarting, rowYear, rowMonth, net, prevTotal, expected, monthTotal, variance, isTied }
  function buildSections() {
    const priorYear = year - 1
    const sections = []

    // Dec prior year — starting balance
    const startTotal = getMonthTotal(priorYear, 12)
    sections.push({
      label: `Dec ${priorYear}`,
      isStarting: true,
      rowYear: priorYear,
      rowMonth: 12,
      net: null,
      prevTotal: null,
      expected: null,
      monthTotal: startTotal,
      variance: null,
      isTied: false,
    })

    let prevEffective = startTotal

    for (let m = 1; m <= 12; m++) {
      const net = getMonthNet(year, m)
      const expected = prevEffective !== null ? prevEffective + net : null
      const monthTotal = getMonthTotal(year, m)
      const variance = monthTotal !== null && expected !== null ? monthTotal - expected : null
      const isTied = variance !== null && Math.abs(variance) < 0.01

      sections.push({
        label: `${MONTHS[m - 1]} ${year}`,
        isStarting: false,
        rowYear: year,
        rowMonth: m,
        net,
        prevTotal: prevEffective,
        expected,
        monthTotal,
        variance,
        isTied,
      })

      prevEffective = monthTotal !== null ? monthTotal : expected
    }

    return sections
  }

  const sections = buildSections()
  const anyVariance = sections.slice(1).some(s => s.variance !== null && !s.isTied)
  const allTied = sections.slice(1).some(s => s.variance !== null) &&
    sections.slice(1).filter(s => s.variance !== null).every(s => s.isTied)

  // ── Reusable builder for any company (summary + portfolio) ───────
  function buildCompanySections(companyId) {
    const coAccounts = accounts.filter(a => a.company_id === companyId)

    function coMonthTotal(balYear, balMonth) {
      if (coAccounts.length === 0) return null
      let total = 0
      for (const acc of coAccounts) {
        const b = getSavedBalance(acc.id, balYear, balMonth)
        if (b === null) return null
        total += b
      }
      return total
    }

    function coMonthNet(txYear, txMonth) {
      const prefix = `${txYear}-${String(txMonth).padStart(2, '0')}`
      return transactions
        .filter(t => t.company_id === companyId && t.date.startsWith(prefix) && t.source_type === 'bank')
        .reduce((s, t) => s + parseFloat(t.amount), 0)
    }

    const priorYear = year - 1
    const rows = []
    const startTotal = coMonthTotal(priorYear, 12)
    rows.push({ label: `Dec ${priorYear}`, isStarting: true, rowYear: priorYear, rowMonth: 12, net: null, expected: null, monthTotal: startTotal, variance: null, isTied: false })

    let prev = startTotal
    for (let m = 1; m <= 12; m++) {
      const net = coMonthNet(year, m)
      const expected = prev !== null ? prev + net : null
      const monthTotal = coMonthTotal(year, m)
      const variance = monthTotal !== null && expected !== null ? monthTotal - expected : null
      const isTied = variance !== null && Math.abs(variance) < 0.01
      rows.push({ label: `${MONTHS[m - 1]} ${year}`, isStarting: false, rowYear: year, rowMonth: m, net, expected, monthTotal, variance, isTied })
      prev = monthTotal !== null ? monthTotal : expected
    }
    return rows
  }

  // Portfolio: sections per company + combined totals
  function buildPortfolioSections() {
    const allCo = companies.map(co => ({
      company: co,
      rows: buildCompanySections(co.id),
    }))

    // 13 rows: Dec prior + Jan-Dec current
    return Array.from({ length: 13 }, (_, i) => {
      const entityCells = allCo.map(({ company, rows }) => ({ company, row: rows[i] }))
      const label = allCo[0]?.rows[i]?.label ?? ''
      const isStarting = i === 0

      // Portfolio totals: only sum if ALL entities have a value
      const totals = entityCells.map(c => c.row.monthTotal)
      const portfolioTotal = totals.every(t => t !== null) ? totals.reduce((s, t) => s + t, 0) : null

      // Portfolio net: sum of all entity nets
      const nets = entityCells.map(c => c.row.net)
      const portfolioNet = isStarting ? null : nets.reduce((s, n) => s + (n || 0), 0)

      // Portfolio expected: sum of all entity expecteds (only if all have one)
      const expecteds = entityCells.map(c => c.row.expected)
      const portfolioExpected = isStarting ? null :
        expecteds.every(e => e !== null) ? expecteds.reduce((s, e) => s + e, 0) : null

      const portfolioVariance = portfolioTotal !== null && portfolioExpected !== null
        ? portfolioTotal - portfolioExpected : null
      const portfolioTied = portfolioVariance !== null && Math.abs(portfolioVariance) < 0.01

      return { label, isStarting, entityCells, portfolioTotal, portfolioNet, portfolioExpected, portfolioVariance, portfolioTied }
    })
  }

  // ── Account management ───────────────────────────────────────────
  async function addAccount() {
    if (!newAccount.name.trim() || !newAccount.source) return
    setAddingAccount(true)
    const { error: insertErr } = await supabase.from('accounts').insert({
      company_id: companyFilter,
      name: newAccount.name.trim(),
      source: newAccount.source,
      source_type: newAccount.source_type,
      last_four: newAccount.last_four.trim() || null,
    })
    if (insertErr) {
      setError(`Failed to add account: ${insertErr.message}`)
      setAddingAccount(false)
      return
    }
    setNewAccount({ name: '', source: '', source_type: 'bank', last_four: '' })
    setShowAddAccount(false)
    setAddingAccount(false)
    await loadAll()
  }

  async function deleteAccount(id) {
    await supabase.from('monthly_balances').delete().eq('account_id', id)
    await supabase.from('accounts').delete().eq('id', id)
    setConfirmDelete(null)
    await loadAll()
  }

  const isPortfolio = companyFilter === '__portfolio__'

  // ── Summary view data ────────────────────────────────────────────
  const summarySections = !isPortfolio ? buildCompanySections(companyFilter) : []

  // ── Portfolio view data ───────────────────────────────────────────
  const portfolioRows = buildPortfolioSections()

  // CSV export: portfolio reconciliation by entity, or one entity's accounts by month
  function csvRows() {
    const status = (variance, tied) => (variance === null ? '' : tied ? 'Tied' : 'Variance')
    if (isPortfolio) {
      return [
        ['Month', ...companies.map(c => c.name), 'Portfolio Total', 'Net Transactions', 'Expected', 'Variance', 'Status'],
        ...portfolioRows.map(r => [
          r.label,
          ...r.entityCells.map(c => money(c.row.monthTotal)),
          money(r.portfolioTotal), money(r.portfolioNet), money(r.portfolioExpected), money(r.portfolioVariance),
          status(r.portfolioVariance, r.portfolioTied),
        ]),
      ]
    }
    return [
      ['Month', ...entityAccounts.map(a => (a.last_four ? `${a.name} (${a.last_four})` : a.name)), 'Net Transactions', 'Expected', 'Statement Total', 'Variance', 'Status'],
      ...sections.map(s => [
        s.label,
        ...entityAccounts.map(a => money(getSavedBalance(a.id, s.rowYear, s.rowMonth))),
        money(s.net), money(s.expected), money(s.monthTotal), money(s.variance),
        status(s.variance, s.isTied),
      ]),
    ]
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  return (
    <div className={`p-8 ${isPortfolio ? 'max-w-6xl' : 'max-w-3xl'}`}>
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-sm text-red-700">
          <span className="font-semibold">Error: </span>{error}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Monthly Balances</h1>
          <p className="text-slate-500 text-sm mt-0.5">Enter statement balances to reconcile against imported transactions</p>
        </div>
        <ExportCsvButton
          filename={() => csvFilename('monthly-balances', isPortfolio ? 'portfolio' : selectedCompany?.name, year)}
          getRows={csvRows}
        />
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Entity</label>
          <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option disabled>──────────</option>
            <option value="__portfolio__">All Entities (Portfolio)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Year</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* View toggle — only shown for a real entity */}
        {!isPortfolio && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">View</label>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
              {[['detail','Detail'],['summary','Summary']].map(([v, label]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    view === v
                      ? 'bg-slate-900 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isPortfolio && view === 'detail' && (
          <div className="ml-auto">
            <button onClick={() => setShowAddAccount(true)}
              className="px-4 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium">
              + Add Account
            </button>
          </div>
        )}
      </div>

      {/* ── DETAIL VIEW ─────────────────────────────────────────────── */}
      {!isPortfolio && view === 'detail' && (
        <>
          {entityAccounts.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
              <p className="text-slate-500 text-sm mb-1">No accounts set up for <span className="font-medium">{selectedCompany?.name}</span></p>
              <p className="text-slate-400 text-xs mb-4">Add your bank and credit card accounts to start reconciling</p>
              <button onClick={() => setShowAddAccount(true)}
                className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium">
                + Add First Account
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              {/* Card header */}
              <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold text-sm text-slate-900">{selectedCompany?.name}</h2>
                  <div className="flex items-center gap-1.5">
                    {entityAccounts.map(acc => (
                      <span key={acc.id} className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        {acc.name}{acc.last_four ? ` ••${acc.last_four}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {anyVariance && <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-medium">⚠ Variance</span>}
                  {allTied && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">✓ All Tied</span>}
                  <button onClick={() => setShowAddAccount(true)}
                    className="text-xs text-slate-400 hover:text-slate-700 underline">
                    + Account
                  </button>
                </div>
              </div>

              {/* Month sections */}
              <div className="divide-y divide-slate-100">
                {sections.map((section) => (
                  <div key={`${section.rowYear}-${section.rowMonth}`}
                    className={`px-5 py-4 ${section.isStarting ? 'bg-slate-50/60' : ''}`}>

                    {/* Month header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold text-sm ${section.isStarting ? 'text-slate-500' : 'text-slate-900'}`}>
                          {section.label}
                        </span>
                        {section.isStarting && (
                          <span className="text-xs text-slate-400">— Starting Balance</span>
                        )}
                      </div>
                      {!section.isStarting && section.variance !== null && (
                        section.isTied
                          ? <span className="text-xs font-semibold text-emerald-600">✓ Tied</span>
                          : <span className="text-xs font-semibold text-red-600">
                              {section.variance > 0 ? '+' : ''}{formatCurrency(section.variance)}
                            </span>
                      )}
                    </div>

                    {!section.isStarting && (
                      <div className="mb-3 space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-400 text-xs">Net Gain / Loss from Transactions</span>
                          <span className={`font-mono text-xs font-medium ${
                            section.net > 0 ? 'text-emerald-600' :
                            section.net < 0 ? 'text-red-500' :
                            'text-slate-400'
                          }`}>
                            {section.net === 0 ? '—' : (section.net > 0 ? '+' : '') + formatCurrency(section.net)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-400 text-xs">Expected Balance</span>
                          <span className="font-mono text-xs text-slate-500">
                            {section.expected !== null ? formatCurrency(section.expected) : '—'}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Account balance inputs */}
                    <div className="space-y-2">
                      {entityAccounts.map(acc => {
                        const key = editKey(acc.id, section.rowYear, section.rowMonth)
                        const editVal = editing[key]
                        const saved = getSavedBalance(acc.id, section.rowYear, section.rowMonth)
                        const displayVal = editVal !== undefined ? editVal : (saved !== null ? saved : '')
                        return (
                          <div key={acc.id} className="flex items-center justify-between">
                            <span className="text-sm text-slate-500 pl-3 border-l-2 border-slate-200">
                              {acc.name}
                              {acc.last_four && <span className="text-xs text-slate-400 ml-1">••{acc.last_four}</span>}
                            </span>
                            <input
                              type="number"
                              step="0.01"
                              value={displayVal}
                              onChange={e => setEditing(prev => ({ ...prev, [key]: e.target.value }))}
                              onBlur={() => saveBalance(acc.id, section.rowYear, section.rowMonth)}
                              onKeyDown={e => e.key === 'Enter' && saveBalance(acc.id, section.rowYear, section.rowMonth)}
                              placeholder="Enter balance"
                              className="w-40 text-right border border-slate-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-slate-900 bg-white"
                            />
                          </div>
                        )
                      })}
                    </div>

                    {entityAccounts.length > 1 && (
                      <div className={`flex items-center justify-between mt-3 pt-2.5 border-t ${
                        section.variance !== null && !section.isTied ? 'border-red-100' : 'border-slate-100'
                      }`}>
                        <span className="text-xs font-semibold text-slate-600">
                          {section.isStarting ? 'Total Starting Balance' : 'Total Statement Balance'}
                        </span>
                        <span className={`font-mono text-sm font-semibold ${
                          section.monthTotal !== null ? 'text-slate-900' : 'text-slate-300'
                        }`}>
                          {section.monthTotal !== null ? formatCurrency(section.monthTotal) : '—'}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── SUMMARY VIEW ────────────────────────────────────────────── */}
      {!isPortfolio && view === 'summary' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold text-sm text-slate-900">{selectedCompany?.name}</h2>
              <span className="text-xs text-slate-400">{year} Summary</span>
            </div>
            {summarySections.slice(1).some(s => s.variance !== null && !s.isTied) && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-medium">⚠ Variance</span>
            )}
            {summarySections.slice(1).some(s => s.variance !== null) &&
             summarySections.slice(1).filter(s => s.variance !== null).every(s => s.isTied) && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">✓ All Tied</span>
            )}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/40">
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500">Month</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500">Net Transactions</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500">Expected</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500">Statement Total</th>
                <th className="text-right px-5 py-2.5 text-xs font-semibold text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {summarySections.map((row) => (
                <tr key={`${row.rowYear}-${row.rowMonth}`}
                  className={row.isStarting ? 'bg-slate-50/60' : 'hover:bg-slate-50/30'}>
                  <td className="px-5 py-3 font-medium text-slate-700">
                    {row.label}
                    {row.isStarting && <span className="ml-2 text-xs text-slate-400 font-normal">Starting</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {row.isStarting || row.net === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <span className={row.net > 0 ? 'text-emerald-600' : 'text-red-500'}>
                        {row.net > 0 ? '+' : ''}{formatCurrency(row.net)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-slate-500">
                    {row.expected !== null ? formatCurrency(row.expected) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-slate-900">
                    {row.monthTotal !== null ? formatCurrency(row.monthTotal) : <span className="font-normal text-slate-300">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {row.isStarting ? null : row.variance === null ? (
                      <span className="text-xs text-slate-300">Not entered</span>
                    ) : row.isTied ? (
                      <span className="text-xs font-semibold text-emerald-600">✓ Tied</span>
                    ) : (
                      <span className="text-xs font-semibold text-red-600">
                        {row.variance > 0 ? '+' : ''}{formatCurrency(row.variance)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── PORTFOLIO VIEW ───────────────────────────────────────────── */}
      {isPortfolio && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold text-sm text-slate-900">All Entities — Portfolio View</h2>
              <span className="text-xs text-slate-400">{year}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-500">Read-only</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-max">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/40">
                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500 sticky left-0 bg-white z-10 border-r border-slate-100">Month</th>
                  {companies.map(co => (
                    <th key={co.id} className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 whitespace-nowrap">
                      {co.name}
                    </th>
                  ))}
                  <th className="text-right px-5 py-2.5 text-xs font-semibold text-slate-700 whitespace-nowrap">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {portfolioRows.map((row) => (
                  <tr key={row.label}
                    className={row.isStarting ? 'bg-slate-50/60' : 'hover:bg-slate-50/30'}>
                    <td className="px-5 py-3 font-medium text-slate-700 sticky left-0 bg-inherit z-10 border-r border-slate-100 whitespace-nowrap">
                      {row.label}
                      {row.isStarting && <span className="ml-2 text-xs text-slate-400 font-normal">Starting</span>}
                    </td>
                    {row.entityCells.map(({ company, row: er }) => (
                      <td key={company.id} className="px-4 py-3 text-right whitespace-nowrap">
                        {er.monthTotal !== null ? (
                          <div>
                            <div className="font-mono text-xs font-semibold text-slate-900">{formatCurrency(er.monthTotal)}</div>
                            {!er.isStarting && er.variance !== null && (
                              <div className={`text-xs font-semibold mt-0.5 ${er.isTied ? 'text-emerald-600' : 'text-red-500'}`}>
                                {er.isTied ? '✓' : (er.variance > 0 ? '+' : '') + formatCurrency(er.variance)}
                              </div>
                            )}
                            {!er.isStarting && er.variance === null && er.expected !== null && (
                              <div className="text-xs text-slate-400 mt-0.5 font-mono">{formatCurrency(er.expected)} exp.</div>
                            )}
                          </div>
                        ) : !er.isStarting && er.expected !== null ? (
                          <div>
                            <div className="font-mono text-xs text-slate-400">{formatCurrency(er.expected)}</div>
                            <div className="text-xs text-slate-300 mt-0.5">expected</div>
                          </div>
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>
                    ))}
                    {/* Portfolio total column */}
                    <td className="px-5 py-3 text-right whitespace-nowrap border-l border-slate-100">
                      {row.portfolioTotal !== null ? (
                        <div>
                          <div className="font-mono text-sm font-bold text-slate-900">{formatCurrency(row.portfolioTotal)}</div>
                          {!row.isStarting && row.portfolioVariance !== null && (
                            <div className={`text-xs font-semibold mt-0.5 ${row.portfolioTied ? 'text-emerald-600' : 'text-red-500'}`}>
                              {row.portfolioTied ? '✓ Tied' : (row.portfolioVariance > 0 ? '+' : '') + formatCurrency(row.portfolioVariance)}
                            </div>
                          )}
                        </div>
                      ) : !row.isStarting && row.portfolioExpected !== null ? (
                        <div>
                          <div className="font-mono text-sm text-slate-400">{formatCurrency(row.portfolioExpected)}</div>
                          <div className="text-xs text-slate-300 mt-0.5">expected</div>
                        </div>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/40 text-xs text-slate-400">
            Statement totals pulled from entity Detail views. Update an entity's balances to reflect here automatically.
          </div>
        </div>
      )}

      {/* Add Account Modal */}
      {showAddAccount && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-bold text-slate-900 mb-4">Add Account</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Account Name</label>
                <input type="text" value={newAccount.name}
                  onChange={e => setNewAccount(a => ({ ...a, name: e.target.value }))}
                  placeholder="e.g. Suncoast Business Checking"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Source</label>
                  <select value={newAccount.source}
                    onChange={e => setNewAccount(a => ({ ...a, source: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                    <option value="">Select source...</option>
                    {allSources.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Account Type</label>
                  <select value={newAccount.source_type}
                    onChange={e => setNewAccount(a => ({ ...a, source_type: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                    <option value="bank">Bank</option>
                    <option value="credit_card">Credit Card</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Last 4 Digits <span className="text-slate-400 font-normal">(optional)</span></label>
                <input type="text" maxLength={4} value={newAccount.last_four}
                  onChange={e => setNewAccount(a => ({ ...a, last_four: e.target.value.replace(/\D/g, '') }))}
                  placeholder="1234"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
                <strong>Source</strong> must match the source on your imported transactions so net transactions calculate correctly.
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowAddAccount(false); setNewAccount({ name: '', source: '', source_type: 'bank', last_four: '' }) }}
                className="flex-1 px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={addAccount}
                disabled={!newAccount.name.trim() || !newAccount.source || addingAccount}
                className="flex-1 px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium disabled:opacity-40">
                {addingAccount ? 'Adding...' : 'Add Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-bold text-slate-900 mb-2">Remove Account?</h2>
            <p className="text-sm text-slate-500 mb-1">
              This will remove <span className="font-medium text-slate-700">{confirmDelete.name}</span> and all saved balances for this account.
            </p>
            <p className="text-xs text-slate-400 mb-5">Imported transactions are not affected.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={() => deleteAccount(confirmDelete.id)}
                className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium">
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {saving && (
        <div className="fixed bottom-4 right-4 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
          Saving...
        </div>
      )}
    </div>
  )
}
