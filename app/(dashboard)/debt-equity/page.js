'use client'
import { useState, useEffect, Fragment } from 'react'
import { createClient } from '@/utils/supabase/client'
import { buildPL, formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import { loadAdjustments, applyAdjustments } from '@/lib/reports/adjustments'
import { inNoi, firstDataMonth, t12Window } from '@/lib/reports/statement'
import { loadLoanAnchors, saveLoanAnchor, rollForward, isPrincipalCategory } from '@/lib/reports/loans'
import ExportCsvButton from '@/components/ExportCsvButton'
import { money, pct as csvPct, csvFilename } from '@/lib/exportCsv'

const CURRENT_YEAR = new Date().getFullYear()
const CURRENT_MONTH = new Date().getMonth() + 1
const NOW_KEY = `${CURRENT_YEAR}-${String(CURRENT_MONTH).padStart(2, '0')}`

function fmt(n) { return formatCurrency(n || 0) }
function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—' }

const EMPTY_LOAN = {
  company_id: '',
  lender_name: '',
  original_balance: '',
  current_balance: '',
  balance_as_of: '',
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
  const [bankConfig, setBankConfig] = useState({ cats: new Map(), portfolioCats: new Set(), adjByTx: new Map() })
  const [loading, setLoading] = useState(true)
  const [anchors, setAnchors] = useState({}) // loanId → statement date
  const [saveError, setSaveError] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [editingLoan, setEditingLoan] = useState(null) // null = add, obj = edit
  const [form, setForm] = useState(EMPTY_LOAN)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [expanded, setExpanded] = useState(new Set()) // loan ids open in the schedule

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: lo }, { data: co }, tx, { data: cat }, { data: bankCats }, adj, anc] = await Promise.all([
      supabase.from('loans').select('*').order('created_at'),
      supabase.from('companies').select('*').order('name'),
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date')),
      supabase.from('categories').select('*'),
      supabase.from('bank_pl_categories').select('category_id, company_id'),
      loadAdjustments(supabase),
      loadLoanAnchors(supabase),
    ])
    setAnchors(anc)
    setLoans(lo || [])
    setCompanies(co || [])
    setTransactions(tx || [])
    setCategories(cat || [])

    // Group Bank P&L config by entity (company_id null = portfolio-level)
    const cats = new Map()
    const portfolioCats = new Set()
    ;(bankCats || []).forEach(r => {
      if (r.company_id == null) { portfolioCats.add(r.category_id); return }
      if (!cats.has(r.company_id)) cats.set(r.company_id, new Set())
      cats.get(r.company_id).add(r.category_id)
    })
    setBankConfig({ cats, portfolioCats, adjByTx: adj.byTx })

    setLoading(false)
  }

  // Latest month with transactions (this month may have none yet)
  const latestKey = transactions.reduce((m, t) => {
    const k = t.date.slice(0, 7)
    return k <= NOW_KEY && (!m || k > m) ? k : m
  }, null) || NOW_KEY

  // ── Per-entity NOI for DSCR: T12, annual-equivalent ───────────────
  // Same NOI rule as every other screen (the entity's own "What counts in
  // NOI" selection, else the portfolio default; net of NOI adjustments),
  // over the trailing 12 months through the latest month with data. With
  // less than 12 months of history it scales the months it has, so DSCR is
  // N months of NOI against N months of payments.
  function entityNOI(companyId) {
    const window = t12Window(latestKey, firstDataMonth(transactions, companyId))
    if (window.months.length === 0) return 0
    const keys = new Set(window.months)
    const filtered = transactions.filter(t =>
      t.company_id === companyId && keys.has(t.date.slice(0, 7)) && inNoi(bankConfig, t))
    const pl = buildPL(applyAdjustments(filtered, bankConfig.adjByTx), categories)
    return pl.noi / window.months.length * 12
  }
  // Months of this year's books for an entity (Jan, or the first month with
  // data, through the latest month with data)
  function ytdMonths(companyId) {
    const first = firstDataMonth(transactions, companyId)
    if (!first || latestKey.slice(0, 4) !== String(CURRENT_YEAR)) return 0
    const start = first > `${CURRENT_YEAR}-01` ? first : `${CURRENT_YEAR}-01`
    if (start > latestKey) return 0
    return Number(latestKey.slice(5, 7)) - Number(start.slice(5, 7)) + 1
  }

  // ── Balance roll-forward: statement balance − principal paid since ──
  function balanceOf(loan) {
    return rollForward({
      loan,
      asOf: anchors[loan.id],
      loansInEntity: loans.filter(l => l.company_id === loan.company_id).length,
      transactions,
      categories,
    })
  }

  // ── Derived loan metrics ─────────────────────────────────────────
  function loanMetrics(loan) {
    const balance = balanceOf(loan).balance
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
  const portfolioDebt   = loans.reduce((s, l) => s + balanceOf(l).balance, 0)
  const portfolioEquity = loans.reduce((s, l) => s + ((parseFloat(l.property_value) || 0) - balanceOf(l).balance), 0)
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
      balance_as_of:    anchors[loan.id] || '',
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
    setSaveError('')
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
    let loanId = editingLoan?.id
    if (editingLoan) {
      const { error } = await supabase.from('loans').update(payload).eq('id', editingLoan.id)
      if (error) { setSaveError(error.message); setSaving(false); return }
    } else {
      const { data, error } = await supabase.from('loans').insert(payload).select('id').single()
      if (error) { setSaveError(error.message); setSaving(false); return }
      loanId = data?.id
    }
    if (loanId && (form.balance_as_of || '') !== (anchors[loanId] || '')) {
      const err = await saveLoanAnchor(supabase, loanId, form.balance_as_of || null)
      if (err) { setSaveError(err); setSaving(false); return }
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
      'Entity', 'Lender', 'Original Balance', 'Current Balance', 'Statement Balance', 'Statement Date',
      'Principal Paid Since', 'Rate %', 'Monthly Payment',
      'Monthly Principal', 'Monthly Interest', 'Property Value', 'Equity', 'LTV %',
      'Annual Debt Service', 'Entity DSCR', 'Maturity Date', 'Notes', 'Principal Paid YTD', 'Interest Paid YTD',
    ]]
    companies.forEach(company => {
      const coLoans = loans.filter(l => l.company_id === company.id)
      const coAnnualDebt = coLoans.reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0) * 12, 0)
      const dscr = coAnnualDebt > 0 ? Number((entityNOI(company.id) / coAnnualDebt).toFixed(2)) : ''
      coLoans.forEach(loan => {
        const m = loanMetrics(loan)
        rows.push([
          company.name, loan.lender_name, num(loan.original_balance), money(balanceOf(loan).balance),
          num(loan.current_balance), anchors[loan.id] || '', balanceOf(loan).status === 'ok' ? money(balanceOf(loan).principalSince) : '',
          loan.interest_rate ? csvPct(parseFloat(loan.interest_rate), 3) : '', num(loan.monthly_payment),
          loan.monthly_payment ? money(m.monthlyPrincipal) : '', loan.monthly_payment ? money(m.monthlyInterest) : '',
          num(loan.property_value), loan.property_value ? money(m.equity) : '', m.ltv === null ? '' : csvPct(m.ltv),
          money(m.annualDebtService), dscr, loan.maturity_date || '', loan.notes || '',
          // Paid this year is per entity; shown on the entity's first loan only
          ...(coLoans[0] === loan ? [money(paidThisYear(company.id).principal), money(paidThisYear(company.id).interest)] : ['', '']),
        ])
      })
    })
    rows.push([
      'Portfolio', `${loans.length} loan${loans.length !== 1 ? 's' : ''}`, '', money(portfolioDebt), '', '', '', '', money(portfolioMonthlyService),
      '', '', money(portfolioValue), money(portfolioEquity), portfolioLTV === null ? '' : csvPct(portfolioLTV),
      money(portfolioMonthlyService * 12), '', '', '', money(portfolioPaid.principal), money(portfolioPaid.interest),
    ])
    return rows
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  // ── Portfolio view model (CRE / lender lens) ─────────────────────
  const yearKey = latestKey.slice(0, 4)
  const yearMonths = Array.from({ length: Number(latestKey.slice(5, 7)) }, (_, i) => `${yearKey}-${String(i + 1).padStart(2, '0')}`)
  const principalCatIds = new Set(categories.filter(isPrincipalCategory).map(c => c.id))
  const interestCatIds = new Set(categories.filter(c => c.type === 'expense' && /interest/i.test(c.name) && !isPrincipalCategory(c)).map(c => c.id))
  // Principal and interest paid this year, from recorded transactions
  function paidThisYear(companyId) {
    const byMonth = Object.fromEntries(yearMonths.map(k => [k, { principal: 0, interest: 0 }]))
    let principal = 0, interest = 0
    transactions.forEach(t => {
      if (companyId && t.company_id !== companyId) return
      const k = t.date.slice(0, 7)
      if (!byMonth[k]) return
      const amt = -(Number(t.amount) || 0)
      if (principalCatIds.has(t.category_id)) { principal += amt; byMonth[k].principal += amt }
      else if (interestCatIds.has(t.category_id)) { interest += amt; byMonth[k].interest += amt }
    })
    return { principal, interest, byMonth }
  }
  const portfolioPaid = paidThisYear(null)
  const loanCompanyIds = [...new Set(loans.map(l => l.company_id))]
  const noiByCo = Object.fromEntries(loanCompanyIds.map(id => [id, entityNOI(id)]))
  const paidByCo = Object.fromEntries(companies.map(c => [c.id, paidThisYear(c.id)]))
  const portfolioNOI = loanCompanyIds.reduce((s, id) => s + noiByCo[id], 0)
  const portfolioDebtYield = portfolioDebt > 0 ? portfolioNOI / portfolioDebt : null
  const portfolioDSCR = portfolioMonthlyService > 0 ? portfolioNOI / (portfolioMonthlyService * 12) : null
  const weightedRate = portfolioDebt > 0
    ? loans.reduce((s, l) => s + balanceOf(l).balance * (parseFloat(l.interest_rate) || 0), 0) / portfolioDebt
    : null
  const yearPrincipalShare = portfolioPaid.principal + portfolioPaid.interest > 0
    ? portfolioPaid.principal / (portfolioPaid.principal + portfolioPaid.interest) : null
  const monthsLabel = yearMonths.length ? `Jan–${new Date(2000, yearMonths.length - 1).toLocaleString('en-US', { month: 'short' })} ${yearKey}` : yearKey
  const fmt0 = n => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n || 0)).toLocaleString('en-US')}`
  const short = n => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : fmt0(n))
  const pctTxt = (x, d = 1) => (x === null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`)
  const toggleRow = id => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="p-8 w-full max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Debt & Equity</h1>
          <p className="text-slate-500 text-sm mt-0.5">Equity built through paydown, and the debt schedule a lender reads</p>
        </div>
        <div className="flex gap-2">
          <ExportCsvButton filename={() => csvFilename('debt-equity', new Date().toISOString().slice(0, 10))} getRows={csvRows} />
          <button onClick={() => openAdd('')}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 font-medium">
            + Add Loan
          </button>
        </div>
      </div>

      {/* Tiles: total value (debt + equity), LTV, principal paid, debt yield */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500">Total value</p>
          <p className="text-2xl font-semibold text-slate-900 tabular-nums mt-0.5">{fmt0(portfolioValue)}</p>
          {portfolioValue > 0 && (
            <div className="flex h-1.5 rounded-full overflow-hidden mt-2 bg-slate-100" aria-hidden="true">
              <div className="bg-slate-400" style={{ width: `${Math.min(100, portfolioDebt / portfolioValue * 100)}%` }} />
              <div className="bg-emerald-500" style={{ width: `${Math.max(0, portfolioEquity / portfolioValue * 100)}%` }} />
            </div>
          )}
          <div className="mt-2 space-y-0.5 text-xs">
            <div className="flex justify-between"><span className="text-slate-500 flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-slate-400" />Debt</span><span className="tabular-nums text-slate-800">{fmt0(portfolioDebt)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500 flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-emerald-500" />Equity</span><span className="tabular-nums text-emerald-700 font-medium">{fmt0(portfolioEquity)}</span></div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500">Blended LTV</p>
          <p className={`text-2xl font-semibold tabular-nums mt-0.5 ${portfolioLTV === null ? 'text-slate-300' : portfolioLTV <= 65 ? 'text-slate-900' : portfolioLTV <= 75 ? 'text-amber-600' : 'text-red-600'}`}>
            {portfolioLTV !== null ? `${portfolioLTV.toFixed(1)}%` : '—'}
          </p>
          <p className="text-xs text-slate-500 mt-1">Weighted rate {weightedRate === null ? '—' : `${weightedRate.toFixed(2)}%`}</p>
          <p className="text-xs text-slate-400">{loans.length} loan{loans.length !== 1 ? 's' : ''} · {fmt0(portfolioMonthlyService)}/mo service</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500">Principal paid {yearKey}</p>
          <p className="text-2xl font-semibold text-emerald-700 tabular-nums mt-0.5">{fmt0(portfolioPaid.principal)}</p>
          <p className="text-xs text-slate-500 mt-1">Equity built from paydown, {monthsLabel}</p>
          <p className="text-xs text-slate-400">{pctTxt(yearPrincipalShare, 0)} of {fmt0(portfolioPaid.principal + portfolioPaid.interest)} paid to lenders</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500">Debt yield</p>
          <p className="text-2xl font-semibold text-slate-900 tabular-nums mt-0.5">{pctTxt(portfolioDebtYield)}</p>
          <p className="text-xs text-slate-500 mt-1">T12 NOI ÷ debt · DSCR {portfolioDSCR === null ? '—' : `${portfolioDSCR.toFixed(2)}x`}</p>
          <p className="text-xs text-slate-400">Lenders usually want 9–10%+</p>
        </div>
      </div>

      {/* Principal vs interest by month */}
      <PaymentChart months={yearMonths} byMonth={portfolioPaid.byMonth} principal={portfolioPaid.principal} interest={portfolioPaid.interest} fmt0={fmt0} />

      {/* Debt schedule */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-5">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 text-sm">Debt schedule</h2>
          <span className="text-xs text-slate-400">Click a loan for details. Principal and interest are {monthsLabel}.</span>
        </div>
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col style={{ width: '22%' }} /><col style={{ width: '9%' }} /><col style={{ width: '14%' }} /><col style={{ width: '12%' }} />
            <col style={{ width: '12%' }} /><col style={{ width: '9%' }} /><col style={{ width: '8%' }} /><col style={{ width: '10%' }} /><col style={{ width: '4%' }} />
          </colgroup>
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-100">
              <th className="text-left font-medium px-5 py-2">Entity</th>
              <th className="text-right font-medium px-3 py-2">Rate</th>
              <th className="text-right font-medium px-3 py-2">Balance</th>
              <th className="text-right font-medium px-3 py-2">Principal</th>
              <th className="text-right font-medium px-3 py-2">Interest</th>
              <th className="text-right font-medium px-3 py-2">LTV</th>
              <th className="text-right font-medium px-3 py-2">DSCR</th>
              <th className="text-right font-medium px-3 py-2">Debt yield</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {companies.map(company => {
              const coLoans = loans.filter(l => l.company_id === company.id)
              if (coLoans.length === 0) {
                return (
                  <tr key={company.id} className="border-b border-slate-50">
                    <td className="px-5 py-3 text-slate-800">{company.name}</td>
                    <td colSpan={7} className="px-3 py-3 text-xs text-slate-400">No loan recorded</td>
                    <td className="pr-4 text-right"><button onClick={() => openAdd(company.id)} className="text-xs text-slate-500 hover:text-slate-900 underline">Add</button></td>
                  </tr>
                )
              }
              const paid = paidByCo[company.id]
              const coAnnualDebt = coLoans.reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0) * 12, 0)
              const noi = noiByCo[company.id]
              const coBalance = coLoans.reduce((s, l) => s + balanceOf(l).balance, 0)
              const dscr = coAnnualDebt > 0 ? noi / coAnnualDebt : null
              const debtYield = coBalance > 0 ? noi / coBalance : null
              return coLoans.map((loan, idx) => {
                const b = balanceOf(loan)
                const m = loanMetrics(loan)
                const open = expanded.has(loan.id)
                const first = idx === 0
                return (
                  <Fragment key={loan.id}>
                    <tr onClick={() => toggleRow(loan.id)} className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50/70 ${open ? 'bg-slate-50/70' : ''}`}>
                      <td className="px-5 py-3">
                        <p className="text-slate-900 font-medium truncate">{company.name}</p>
                        <p className="text-xs text-slate-400 truncate">{loan.lender_name}{b.status === 'no_date' ? ' · needs statement date' : ''}</p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-600">{loan.interest_rate ? `${parseFloat(loan.interest_rate).toFixed(3)}%` : '—'}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-900 font-medium">{fmt0(b.balance)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-emerald-700">{first ? fmt0(paid.principal) : ''}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-600">{first ? fmt0(paid.interest) : ''}</td>
                      <td className={`px-3 py-3 text-right tabular-nums ${m.ltv === null ? 'text-slate-300' : m.ltv <= 65 ? 'text-slate-700' : m.ltv <= 75 ? 'text-amber-600' : 'text-red-600'}`}>{m.ltv === null ? '—' : `${m.ltv.toFixed(1)}%`}</td>
                      <td className={`px-3 py-3 text-right tabular-nums ${dscr === null ? 'text-slate-300' : dscr >= 1.25 ? 'text-slate-700' : 'text-red-600'}`}>{first && dscr !== null ? `${dscr.toFixed(2)}x` : first ? '—' : ''}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-700">{first ? pctTxt(debtYield) : ''}</td>
                      <td className="pr-4 text-right text-slate-400 text-xs">{open ? '▾' : '▸'}</td>
                    </tr>
                    {open && (
                      <tr className="border-b border-slate-100 bg-slate-50/50">
                        <td colSpan={9} className="px-5 py-4">
                          <LoanDetail
                            loan={loan} b={b} m={m} fmt0={fmt0}
                            paid={paid} ytdScheduled={(parseFloat(loan.monthly_payment) || 0) * ytdMonths(company.id)} ytdMonthCount={ytdMonths(company.id)}
                            onEdit={() => openEdit(loan)} onDelete={() => setConfirmDelete(loan)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
              <td className="px-5 py-3">Portfolio</td>
              <td className="px-3 py-3 text-right tabular-nums">{weightedRate === null ? '—' : `${weightedRate.toFixed(2)}%`}</td>
              <td className="px-3 py-3 text-right tabular-nums">{fmt0(portfolioDebt)}</td>
              <td className="px-3 py-3 text-right tabular-nums text-emerald-700">{fmt0(portfolioPaid.principal)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{fmt0(portfolioPaid.interest)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{portfolioLTV !== null ? `${portfolioLTV.toFixed(1)}%` : '—'}</td>
              <td className="px-3 py-3 text-right tabular-nums">{portfolioDSCR === null ? '—' : `${portfolioDSCR.toFixed(2)}x`}</td>
              <td className="px-3 py-3 text-right tabular-nums">{pctTxt(portfolioDebtYield)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Debt roll-forward and equity */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-2">
        <div className="bg-slate-100/70 rounded-lg px-4 py-3">
          <p className="text-xs text-slate-500">Debt at start of {yearKey} or funding</p>
          <p className="text-lg font-semibold tabular-nums text-slate-900">{fmt0(portfolioDebt + portfolioPaid.principal)}</p>
        </div>
        <div className="bg-slate-100/70 rounded-lg px-4 py-3">
          <p className="text-xs text-slate-500">− Principal paid</p>
          <p className="text-lg font-semibold tabular-nums text-emerald-700">{fmt0(portfolioPaid.principal)}</p>
        </div>
        <div className="bg-slate-100/70 rounded-lg px-4 py-3">
          <p className="text-xs text-slate-500">= Debt today</p>
          <p className="text-lg font-semibold tabular-nums text-slate-900">{fmt0(portfolioDebt)}</p>
        </div>
        <div className="bg-slate-100/70 rounded-lg px-4 py-3">
          <p className="text-xs text-slate-500">Equity today (value − debt)</p>
          <p className="text-lg font-semibold tabular-nums text-emerald-700">{fmt0(portfolioEquity)}</p>
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-6">
        Balances roll forward from each loan&apos;s statement balance by the principal recorded since its statement date.
        Property values are your estimates. DSCR and debt yield use T12 NOI (scaled to 12 months while history is shorter).
      </p>

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
                  <label className="block text-xs font-medium text-slate-600 mb-1">Statement Balance</label>
                  <input type="number" step="0.01" value={form.current_balance}
                    onChange={e => setForm(f => ({ ...f, current_balance: e.target.value }))}
                    placeholder="0.00"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Balance As Of</label>
                  <input type="date" value={form.balance_as_of}
                    onChange={e => setForm(f => ({ ...f, balance_as_of: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
                <p className="text-xs text-slate-400 self-end pb-1">
                  The lender statement date for that balance (for a new loan, its funding date). Principal payments recorded after it reduce the balance automatically.
                </p>
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
            {saveError && <p className="text-xs text-red-600 mt-3">{saveError}</p>}
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowModal(false); setEditingLoan(null); setForm(EMPTY_LOAN); setSaveError('') }}
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

// Monthly loan payments this year, principal (equity built) under interest
function PaymentChart({ months, byMonth, principal, interest, fmt0 }) {
  const max = Math.max(1, ...months.map(k => byMonth[k].principal + byMonth[k].interest))
  const total = principal + interest
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 mb-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-semibold text-slate-900 text-sm">Where each loan payment went</h2>
        <div className="flex gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />Principal {fmt0(principal)}{total ? ` (${Math.round(principal / total * 100)}%)` : ''}</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-slate-300" />Interest {fmt0(interest)}{total ? ` (${Math.round(interest / total * 100)}%)` : ''}</span>
        </div>
      </div>
      {months.length === 0 || total === 0 ? (
        <p className="text-sm text-slate-400">No loan payments recorded this year.</p>
      ) : (
        <div className="flex items-end gap-2 h-36" role="img" aria-label="Monthly loan payments split into principal and interest">
          {months.map(k => {
            const { principal: p, interest: i } = byMonth[k]
            const label = new Date(2000, Number(k.slice(5, 7)) - 1).toLocaleString('en-US', { month: 'short' })
            return (
              <div key={k} className="flex-1 flex flex-col items-center gap-1 h-full justify-end" title={`${label}: principal ${fmt0(p)}, interest ${fmt0(i)}`}>
                <div className="w-full max-w-[28px] flex flex-col justify-end" style={{ height: `${(p + i) / max * 100}%` }}>
                  <div className="bg-slate-300 rounded-t" style={{ height: `${(p + i) ? i / (p + i) * 100 : 0}%` }} />
                  <div className="bg-emerald-500 border-t-2 border-white" style={{ height: `${(p + i) ? p / (p + i) * 100 : 0}%` }} />
                </div>
                <span className="text-[11px] text-slate-400">{label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Everything about one loan, shown when its schedule row is opened
function LoanDetail({ loan, b, m, fmt0, paid, ytdScheduled, ytdMonthCount, onEdit, onDelete }) {
  const original = parseFloat(loan.original_balance) || 0
  const paidDown = original > 0 ? original - b.balance : null
  const value = parseFloat(loan.property_value) || 0
  const cell = (label, value, sub) => (
    <div>
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="text-sm text-slate-900 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  )
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cell('Monthly payment', loan.monthly_payment ? fmt0(parseFloat(loan.monthly_payment)) : '—',
          loan.monthly_payment ? `${fmt0(m.monthlyPrincipal)} principal · ${fmt0(m.monthlyInterest)} interest now` : null)}
        {cell('Property value', value ? fmt0(value) : '—', value ? `Equity ${fmt0(m.equity)}` : 'Add an estimate')}
        {cell('Maturity', loan.maturity_date || 'Not set', loan.notes || null)}
        {cell(`Loan service ${ytdMonthCount ? `(${ytdMonthCount} mo)` : ''}`, fmt0(paid.principal + paid.interest), `vs ${fmt0(ytdScheduled)} scheduled`)}
      </div>

      {paidDown !== null && (
        <div>
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Paid down since funding: <span className="text-emerald-700 font-medium tabular-nums">{fmt0(paidDown)}</span> of {fmt0(original)}</span>
            <span className="tabular-nums">{(paidDown / original * 100).toFixed(1)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, paidDown / original * 100))}%` }} /></div>
        </div>
      )}

      <div className="text-xs text-slate-500 space-y-1">
        {b.status === 'ok' && (
          <p>Balance: {fmt0(b.statement)} on {b.asOf} − {fmt0(b.principalSince)} principal recorded since = <span className="text-slate-900 font-medium">{fmt0(b.balance)}</span></p>
        )}
        {b.status === 'no_date' && <p className="text-amber-700">Add the statement date for this balance so it updates from principal payments.</p>}
        {b.status === 'multi_loan' && <p>This entity has more than one loan, so the balance stays at the statement figure.</p>}
        {b.status === 'ok' && b.expectedPrincipal !== null && b.months > 0 && (
          <p className={b.flag ? 'text-amber-700' : ''}>
            Principal since {b.asOf}: recorded {fmt0(b.principalSince)} in {b.payments} payment{b.payments !== 1 ? 's' : ''}, expected {fmt0(b.expectedPrincipal)} over {b.months} month{b.months !== 1 ? 's' : ''}.{' '}
            {b.flag ? `Off by ${fmt0(Math.abs(b.gap))}: check for a missed payment or a wrong interest/principal split.` : <span className="text-emerald-700">In line with the amortization.</span>}
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <button onClick={onEdit} className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-700 hover:bg-white">Edit loan</button>
        <button onClick={onDelete} className="text-xs px-3 py-1.5 text-slate-400 hover:text-red-600">Delete</button>
      </div>
    </div>
  )
}
