'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { buildPL, formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import ExportCsvButton from '@/components/ExportCsvButton'
import { money, pct as csvPct, csvFilename } from '@/lib/exportCsv'

const CURRENT_YEAR = new Date().getFullYear()
const CURRENT_MONTH = new Date().getMonth() + 1

function fmt(n) { return formatCurrency(n || 0) }
function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—' }

const EMPTY_LOAN = {
  company_id: '',
  lender_name: '',
  original_balance: '',
  current_balance: '',
  interest_rate: '',
  monthly_payment: '',
  property_value: '',
  maturity_date: '',
  notes: '',
}

export default function DebtEquityPage() {
  const [loans, setLoans] = useState([])
  const [companies, setCompanies] = useState([])
  const [transactions, setTransactions] = useState([])
  const [categories, setCategories] = useState([])
  const [bankConfig, setBankConfig] = useState({ cats: new Map(), excl: new Map(), portfolioCats: new Set(), portfolioExcl: new Set() })
  const [loading, setLoading] = useState(true)

  const [showModal, setShowModal] = useState(false)
  const [editingLoan, setEditingLoan] = useState(null) // null = add, obj = edit
  const [form, setForm] = useState(EMPTY_LOAN)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: lo }, { data: co }, tx, { data: cat }, { data: bankCats }, { data: bankExcl }] = await Promise.all([
      supabase.from('loans').select('*').order('created_at'),
      supabase.from('companies').select('*').order('name'),
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date')),
      supabase.from('categories').select('*'),
      supabase.from('bank_pl_categories').select('category_id, company_id'),
      supabase.from('bank_pl_exclusions').select('transaction_id, company_id'),
    ])
    setLoans(lo || [])
    setCompanies(co || [])
    setTransactions(tx || [])
    setCategories(cat || [])

    // Group Bank P&L config by entity (company_id null = portfolio-level)
    const cats = new Map(), excl = new Map()
    const portfolioCats = new Set(), portfolioExcl = new Set()
    ;(bankCats || []).forEach(r => {
      if (r.company_id == null) { portfolioCats.add(r.category_id); return }
      if (!cats.has(r.company_id)) cats.set(r.company_id, new Set())
      cats.get(r.company_id).add(r.category_id)
    })
    ;(bankExcl || []).forEach(r => {
      if (r.company_id == null) { portfolioExcl.add(r.transaction_id); return }
      if (!excl.has(r.company_id)) excl.set(r.company_id, new Set())
      excl.get(r.company_id).add(r.transaction_id)
    })
    setBankConfig({ cats, excl, portfolioCats, portfolioExcl })

    setLoading(false)
  }

  // ── Per-entity NOI (YTD, Bank P&L only) for DSCR ─────────────────
  // Uses the entity's own Bank P&L selections, falling back to the
  // portfolio-level config when the entity has none — matching the
  // Deal Room / Bank P&L report so debt service & non-opex are excluded.
  function entityNOI(companyId) {
    const from = `${CURRENT_YEAR}-01-01`
    const to   = `${CURRENT_YEAR}-${String(CURRENT_MONTH).padStart(2, '0')}-31`
    // Use the entity's own config when it has one; otherwise fall back to
    // portfolio-level — decided atomically so cats & exclusions stay paired.
    const hasOwnConfig = bankConfig.cats.has(companyId)
    const includedCats = hasOwnConfig ? bankConfig.cats.get(companyId) : bankConfig.portfolioCats
    const excludedTxs  = hasOwnConfig ? (bankConfig.excl.get(companyId) || new Set()) : bankConfig.portfolioExcl
    // Raw transactions filtered to Bank P&L checked items (no source
    // filter) — identical to the Bank P&L report / Deal Room / Overview.
    const filtered = transactions.filter(t =>
      t.company_id === companyId && t.date >= from && t.date <= to &&
      includedCats.has(t.category_id) && !excludedTxs.has(t.id)
    )
    const pl = buildPL(filtered, categories)
    // Annualize YTD
    return CURRENT_MONTH > 0 ? (pl.noi / CURRENT_MONTH) * 12 : pl.noi
  }

  // ── Actual loan service from transactions (YTD) ──────────────────
  function actualLoanService(companyId) {
    const loanCatIds = categories
      .filter(c => c.name.toLowerCase().includes('loan') || c.name.toLowerCase().includes('mortgage') || c.name.toLowerCase().includes('debt service'))
      .map(c => c.id)
    if (loanCatIds.length === 0) return null

    const from = `${CURRENT_YEAR}-01-01`
    const to   = `${CURRENT_YEAR}-${String(CURRENT_MONTH).padStart(2, '0')}-31`
    const total = transactions
      .filter(t =>
        t.company_id === companyId &&
        t.date >= from && t.date <= to &&
        loanCatIds.includes(t.category_id) &&
        t.amount < 0
      )
      .reduce((s, t) => s + Math.abs(parseFloat(t.amount)), 0)
    return total > 0 ? total : null
  }

  // ── Derived loan metrics ─────────────────────────────────────────
  function loanMetrics(loan) {
    const balance = parseFloat(loan.current_balance) || 0
    const rate    = parseFloat(loan.interest_rate) || 0
    const payment = parseFloat(loan.monthly_payment) || 0
    const propVal = parseFloat(loan.property_value) || 0

    const monthlyInterest  = balance * (rate / 100) / 12
    const monthlyPrincipal = Math.max(0, payment - monthlyInterest)
    const equity           = propVal - balance
    const ltv              = balance > 0 && propVal > 0 ? balance / propVal * 100 : null
    const annualDebtService = payment * 12

    return { monthlyInterest, monthlyPrincipal, equity, ltv, annualDebtService }
  }

  // ── Portfolio totals ─────────────────────────────────────────────
  const portfolioDebt   = loans.reduce((s, l) => s + (parseFloat(l.current_balance) || 0), 0)
  const portfolioEquity = loans.reduce((s, l) => s + ((parseFloat(l.property_value) || 0) - (parseFloat(l.current_balance) || 0)), 0)
  const portfolioValue  = loans.reduce((s, l) => s + (parseFloat(l.property_value) || 0), 0)
  const portfolioLTV    = portfolioValue > 0 ? portfolioDebt / portfolioValue * 100 : null
  const portfolioMonthlyService = loans.reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0), 0)

  // ── Modal helpers ────────────────────────────────────────────────
  function openAdd(companyId) {
    setEditingLoan(null)
    setForm({ ...EMPTY_LOAN, company_id: companyId || '' })
    setShowModal(true)
  }

  function openEdit(loan) {
    setEditingLoan(loan)
    setForm({
      company_id:       loan.company_id || '',
      lender_name:      loan.lender_name || '',
      original_balance: loan.original_balance ?? '',
      current_balance:  loan.current_balance ?? '',
      interest_rate:    loan.interest_rate ?? '',
      monthly_payment:  loan.monthly_payment ?? '',
      property_value:   loan.property_value ?? '',
      maturity_date:    loan.maturity_date || '',
      notes:            loan.notes || '',
    })
    setShowModal(true)
  }

  async function saveForm() {
    if (!form.lender_name.trim() || !form.company_id) return
    setSaving(true)
    const payload = {
      company_id:       form.company_id,
      lender_name:      form.lender_name.trim(),
      original_balance: parseFloat(form.original_balance) || 0,
      current_balance:  parseFloat(form.current_balance) || 0,
      interest_rate:    parseFloat(form.interest_rate) || 0,
      monthly_payment:  parseFloat(form.monthly_payment) || 0,
      property_value:   parseFloat(form.property_value) || 0,
      maturity_date:    form.maturity_date || null,
      notes:            form.notes.trim() || null,
    }
    if (editingLoan) {
      await supabase.from('loans').update(payload).eq('id', editingLoan.id)
    } else {
      await supabase.from('loans').insert(payload)
    }
    setShowModal(false)
    setForm(EMPTY_LOAN)
    setEditingLoan(null)
    setSaving(false)
    await loadAll()
  }

  async function deleteLoan(id) {
    await supabase.from('loans').delete().eq('id', id)
    setConfirmDelete(null)
    await loadAll()
  }

  // CSV export: one row per loan, then portfolio totals
  function csvRows() {
    const num = v => (v === null || v === undefined || v === '' ? '' : money(parseFloat(v)))
    const rows = [[
      'Entity', 'Lender', 'Original Balance', 'Current Balance', 'Rate %', 'Monthly Payment',
      'Monthly Principal', 'Monthly Interest', 'Property Value', 'Equity', 'LTV %',
      'Annual Debt Service', 'Entity DSCR', 'Maturity Date', 'Notes',
    ]]
    companies.forEach(company => {
      const coLoans = loans.filter(l => l.company_id === company.id)
      const coAnnualDebt = coLoans.reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0) * 12, 0)
      const dscr = coAnnualDebt > 0 ? Number((entityNOI(company.id) / coAnnualDebt).toFixed(2)) : ''
      coLoans.forEach(loan => {
        const m = loanMetrics(loan)
        rows.push([
          company.name, loan.lender_name, num(loan.original_balance), num(loan.current_balance),
          loan.interest_rate ? csvPct(parseFloat(loan.interest_rate), 3) : '', num(loan.monthly_payment),
          loan.monthly_payment ? money(m.monthlyPrincipal) : '', loan.monthly_payment ? money(m.monthlyInterest) : '',
          num(loan.property_value), loan.property_value ? money(m.equity) : '', m.ltv === null ? '' : csvPct(m.ltv),
          money(m.annualDebtService), dscr, loan.maturity_date || '', loan.notes || '',
        ])
      })
    })
    rows.push([
      'Portfolio', `${loans.length} loan${loans.length !== 1 ? 's' : ''}`, '', money(portfolioDebt), '', money(portfolioMonthlyService),
      '', '', money(portfolioValue), money(portfolioEquity), portfolioLTV === null ? '' : csvPct(portfolioLTV),
      money(portfolioMonthlyService * 12), '', '', '',
    ])
    return rows
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Debt & Equity</h1>
          <p className="text-slate-500 text-sm mt-0.5">Loan balances, P&I breakdown, and equity position per entity</p>
        </div>
        <div className="flex gap-2">
          <ExportCsvButton filename={() => csvFilename('debt-equity', new Date().toISOString().slice(0, 10))} getRows={csvRows} />
          <button onClick={() => openAdd('')}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium">
            + Add Loan
          </button>
        </div>
      </div>

      {/* Portfolio summary */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Debt</p>
          <p className="text-2xl font-bold font-mono text-slate-900">{fmt(portfolioDebt)}</p>
          <p className="text-xs text-slate-400 mt-1">{loans.length} loan{loans.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Equity</p>
          <p className={`text-2xl font-bold font-mono ${portfolioEquity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmt(portfolioEquity)}</p>
          <p className="text-xs text-slate-400 mt-1">Est. property value − debt</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Blended LTV</p>
          <p className={`text-2xl font-bold font-mono ${portfolioLTV === null ? 'text-slate-300' : portfolioLTV <= 65 ? 'text-emerald-600' : portfolioLTV <= 80 ? 'text-amber-600' : 'text-red-600'}`}>
            {portfolioLTV !== null ? `${portfolioLTV.toFixed(1)}%` : '—'}
          </p>
          <p className="text-xs text-slate-400 mt-1">{fmt(portfolioDebt)} / {fmt(portfolioValue)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Monthly Service</p>
          <p className="text-2xl font-bold font-mono text-slate-900">{fmt(portfolioMonthlyService)}</p>
          <p className="text-xs text-slate-400 mt-1">{fmt(portfolioMonthlyService * 12)} / year</p>
        </div>
      </div>

      {/* Per-entity sections */}
      {companies.map(company => {
        const coLoans = loans.filter(l => l.company_id === company.id)
        const annualNOI = entityNOI(company.id)
        const coAnnualDebt = coLoans.reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0) * 12, 0)
        const dscr = coAnnualDebt > 0 ? annualNOI / coAnnualDebt : null
        const coActualService = actualLoanService(company.id)
        const coEquity = coLoans.reduce((s, l) => s + ((parseFloat(l.property_value) || 0) - (parseFloat(l.current_balance) || 0)), 0)
        const coDebt = coLoans.reduce((s, l) => s + (parseFloat(l.current_balance) || 0), 0)

        return (
          <div key={company.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-5">
            {/* Entity header */}
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h2 className="font-semibold text-slate-900">{company.name}</h2>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-slate-500">Debt: <span className="font-semibold text-slate-800 font-mono">{fmt(coDebt)}</span></span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Equity: <span className={`font-semibold font-mono ${coEquity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmt(coEquity)}</span></span>
                  {dscr !== null && (
                    <>
                      <span className="text-slate-300">·</span>
                      <span className="text-slate-500">DSCR: <span className={`font-semibold ${dscr >= 1.25 ? 'text-emerald-600' : dscr >= 1.0 ? 'text-amber-600' : 'text-red-600'}`}>{dscr.toFixed(2)}x</span></span>
                    </>
                  )}
                </div>
              </div>
              <button onClick={() => openAdd(company.id)}
                className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-white font-medium">
                + Add Loan
              </button>
            </div>

            {coLoans.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-slate-400 text-sm">No loans recorded for this entity</p>
                <button onClick={() => openAdd(company.id)}
                  className="mt-3 text-xs text-slate-500 hover:text-slate-800 underline">
                  Add first loan
                </button>
              </div>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/40 text-xs font-semibold text-slate-500">
                      <th className="text-left px-5 py-2.5">Lender</th>
                      <th className="text-right px-4 py-2.5">Original Balance</th>
                      <th className="text-right px-4 py-2.5">Current Balance</th>
                      <th className="text-right px-4 py-2.5">Rate</th>
                      <th className="text-right px-4 py-2.5">Mo. Payment</th>
                      <th className="text-right px-4 py-2.5">Principal</th>
                      <th className="text-right px-4 py-2.5">Interest</th>
                      <th className="text-right px-4 py-2.5">Property Value</th>
                      <th className="text-right px-4 py-2.5">Equity</th>
                      <th className="text-right px-4 py-2.5">LTV</th>
                      <th className="px-5 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {coLoans.map(loan => {
                      const { monthlyInterest, monthlyPrincipal, equity, ltv, annualDebtService } = loanMetrics(loan)
                      return (
                        <tr key={loan.id} className="hover:bg-slate-50/40">
                          <td className="px-5 py-3">
                            <p className="font-medium text-slate-800">{loan.lender_name}</p>
                            {loan.maturity_date && (
                              <p className="text-xs text-slate-400 mt-0.5">Matures {loan.maturity_date}</p>
                            )}
                            {loan.notes && (
                              <p className="text-xs text-slate-400 mt-0.5 truncate max-w-36">{loan.notes}</p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-slate-500">
                            {loan.original_balance ? fmt(parseFloat(loan.original_balance)) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-slate-900">
                            {fmt(parseFloat(loan.current_balance) || 0)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-slate-600">
                            {loan.interest_rate ? `${parseFloat(loan.interest_rate).toFixed(3)}%` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-slate-700">
                            {loan.monthly_payment ? fmt(parseFloat(loan.monthly_payment)) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-blue-600">
                            {loan.monthly_payment ? fmt(monthlyPrincipal) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-orange-500">
                            {loan.monthly_payment ? fmt(monthlyInterest) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-slate-600">
                            {loan.property_value ? fmt(parseFloat(loan.property_value)) : '—'}
                          </td>
                          <td className={`px-4 py-3 text-right font-mono text-xs font-semibold ${equity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {loan.property_value ? fmt(equity) : '—'}
                          </td>
                          <td className={`px-4 py-3 text-right font-mono text-xs font-semibold ${
                            ltv === null ? 'text-slate-300' : ltv <= 65 ? 'text-emerald-600' : ltv <= 80 ? 'text-amber-600' : 'text-red-600'
                          }`}>
                            {ltv !== null ? `${ltv.toFixed(1)}%` : '—'}
                          </td>
                          <td className="px-5 py-3 text-right whitespace-nowrap">
                            <button onClick={() => openEdit(loan)}
                              className="text-xs text-slate-400 hover:text-slate-700 mr-3">Edit</button>
                            <button onClick={() => setConfirmDelete(loan)}
                              className="text-xs text-slate-300 hover:text-red-500">✕</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  {coLoans.length > 1 && (
                    <tfoot>
                      <tr className="border-t-2 border-slate-200 bg-slate-50">
                        <td className="px-5 py-3 text-xs font-semibold text-slate-600">Entity Total</td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-slate-500">
                          {fmt(coLoans.reduce((s, l) => s + (parseFloat(l.original_balance) || 0), 0))}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm font-bold text-slate-900">
                          {fmt(coDebt)}
                        </td>
                        <td className="px-4 py-3" />
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-slate-700">
                          {fmt(coLoans.reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0), 0))}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-blue-600">
                          {fmt(coLoans.reduce((s, l) => s + loanMetrics(l).monthlyPrincipal, 0))}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-orange-500">
                          {fmt(coLoans.reduce((s, l) => s + loanMetrics(l).monthlyInterest, 0))}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-slate-600">
                          {fmt(coLoans.reduce((s, l) => s + (parseFloat(l.property_value) || 0), 0))}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono text-sm font-bold ${coEquity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {fmt(coEquity)}
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  )}
                </table>

                {/* Actual vs. Scheduled loan service */}
                {coActualService !== null && (
                  <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/40 flex items-center gap-6 text-xs text-slate-500">
                    <span className="font-semibold text-slate-600">YTD Loan Service (from transactions)</span>
                    <span className="font-mono font-semibold text-slate-800">{fmt(coActualService)}</span>
                    <span className="text-slate-400">vs. {fmt(coLoans.reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0), 0) * CURRENT_MONTH)} scheduled</span>
                    {coAnnualDebt > 0 && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span>DSCR based on annualized {CURRENT_MONTH}-month NOI</span>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}

      {/* Add / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-base font-bold text-slate-900 mb-4">{editingLoan ? 'Edit Loan' : 'Add Loan'}</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Entity</label>
                  <select value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                    <option value="">Select entity...</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Lender Name</label>
                  <input type="text" value={form.lender_name}
                    onChange={e => setForm(f => ({ ...f, lender_name: e.target.value }))}
                    placeholder="e.g. Suncoast Bank"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    autoFocus />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Original Balance</label>
                  <input type="number" step="0.01" value={form.original_balance}
                    onChange={e => setForm(f => ({ ...f, original_balance: e.target.value }))}
                    placeholder="0.00"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Current Balance</label>
                  <input type="number" step="0.01" value={form.current_balance}
                    onChange={e => setForm(f => ({ ...f, current_balance: e.target.value }))}
                    placeholder="0.00"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Interest Rate (%)</label>
                  <input type="number" step="0.001" value={form.interest_rate}
                    onChange={e => setForm(f => ({ ...f, interest_rate: e.target.value }))}
                    placeholder="e.g. 6.500"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Monthly Payment</label>
                  <input type="number" step="0.01" value={form.monthly_payment}
                    onChange={e => setForm(f => ({ ...f, monthly_payment: e.target.value }))}
                    placeholder="0.00"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Est. Property Value</label>
                  <input type="number" step="0.01" value={form.property_value}
                    onChange={e => setForm(f => ({ ...f, property_value: e.target.value }))}
                    placeholder="0.00"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Maturity Date <span className="text-slate-400 font-normal">(optional)</span></label>
                  <input type="date" value={form.maturity_date}
                    onChange={e => setForm(f => ({ ...f, maturity_date: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notes <span className="text-slate-400 font-normal">(optional)</span></label>
                <input type="text" value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. 20-year fixed, cross-collateralized"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>
              {/* Live P&I preview */}
              {form.current_balance && form.interest_rate && form.monthly_payment && (
                <div className="bg-slate-50 rounded-lg px-4 py-3 grid grid-cols-3 gap-4 text-center">
                  {(() => {
                    const bal = parseFloat(form.current_balance) || 0
                    const rate = parseFloat(form.interest_rate) || 0
                    const pmt = parseFloat(form.monthly_payment) || 0
                    const interest = bal * (rate / 100) / 12
                    const principal = Math.max(0, pmt - interest)
                    return (
                      <>
                        <div>
                          <p className="text-xs text-slate-500 mb-0.5">Principal</p>
                          <p className="font-mono text-sm font-bold text-blue-600">{fmt(principal)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 mb-0.5">Interest</p>
                          <p className="font-mono text-sm font-bold text-orange-500">{fmt(interest)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 mb-0.5">Equity</p>
                          <p className={`font-mono text-sm font-bold ${(parseFloat(form.property_value) || 0) - bal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {fmt((parseFloat(form.property_value) || 0) - bal)}
                          </p>
                        </div>
                      </>
                    )
                  })()}
                </div>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowModal(false); setEditingLoan(null); setForm(EMPTY_LOAN) }}
                className="flex-1 px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={saveForm}
                disabled={!form.lender_name.trim() || !form.company_id || saving}
                className="flex-1 px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium disabled:opacity-40">
                {saving ? 'Saving...' : editingLoan ? 'Save Changes' : 'Add Loan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-bold text-slate-900 mb-2">Remove Loan?</h2>
            <p className="text-sm text-slate-500 mb-5">
              Remove <span className="font-medium text-slate-700">{confirmDelete.lender_name}</span> from {companies.find(c => c.id === confirmDelete.company_id)?.name}?
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={() => deleteLoan(confirmDelete.id)}
                className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium">
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
