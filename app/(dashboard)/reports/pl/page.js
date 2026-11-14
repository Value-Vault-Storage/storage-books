'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { fetchAllRows } from '@/lib/fetchAll'
import PrintHeader from '@/components/PrintHeader'
import ExportCsvButton from '@/components/ExportCsvButton'
import AdjustmentModal from '@/components/AdjustmentModal'
import { money, pct as csvPct, csvFilename } from '@/lib/exportCsv'
import {
  loadAdjustments, saveAdjustments, removeAdjustments,
  treatmentInfo, excludedAmount, isPartial,
} from '@/lib/reports/adjustments'
import {
  classify, buildStatement, statementRows, activityTest, variance, drillItems,
  groupNoiConfig, periodFor, priorPeriod, periodTitle, periodShort, periodRange, inPeriod,
  monthLabel, bankTieOut, monthRuns, belowLineFor, acct, acctPct,
} from '@/lib/reports/statement'

const PERIODS = [
  { value: 'month', label: 'Month' },
  { value: 'ytd', label: 'YTD' },
  { value: 't12', label: 'T12' },
]
const LAYOUTS = [
  { value: 'compare', label: 'vs prior year' },
  { value: 'months', label: 'By month' },
  { value: 'entities', label: 'By entity' },
]
// Variance swings worse than this are highlighted
const FLAG_AT = -0.15
// Rows where % of EGI isn't meaningful
const NO_PCT = new Set(['capex', 'interest', 'principal', 'cfads'])

function nowKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function PLPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [transactions, setTransactions] = useState([])
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [noiConfig, setNoiConfig] = useState({ cats: new Map(), portfolioCats: new Set() })
  const [accounts, setAccounts] = useState([])
  const [balances, setBalances] = useState([])
  const [loans, setLoans] = useState([])
  const [reportSettings, setReportSettings] = useState({})
  const [isOwner, setIsOwner] = useState(false)

  const [adjByTx, setAdjByTx] = useState(new Map())
  const [adjLegacy, setAdjLegacy] = useState(false)
  const [adjEditing, setAdjEditing] = useState(null) // { transactions, existing }

  const [entity, setEntity] = useState('all')
  const [periodKind, setPeriodKind] = useState('t12')
  const [asOf, setAsOf] = useState(null)
  const [layout, setLayout] = useState('compare')
  const [drawer, setDrawer] = useState(null) // { title, subtitle, items }

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [tx, { data: co }, { data: cat }, { data: cfg }, { data: acc }, { data: bal }, { data: lo }, { data: branding }, { data: role }, adj] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*').order('date')),
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('bank_pl_categories').select('category_id, company_id'),
      supabase.from('accounts').select('*'),
      supabase.from('monthly_balances').select('*'),
      supabase.from('loans').select('*'),
      supabase.from('report_settings').select('*'),
      supabase.from('user_roles').select('role').maybeSingle(),
      loadAdjustments(supabase),
    ])
    setTransactions(tx || [])
    setCompanies(co || [])
    setCategories(cat || [])
    setNoiConfig(groupNoiConfig(cfg))
    setAccounts(acc || [])
    setBalances(bal || [])
    setLoans(lo || [])
    if (branding) setReportSettings(Object.fromEntries(branding.map(r => [r.key, r.value])))
    setIsOwner(role?.role === 'owner')
    setAdjByTx(adj.byTx)
    setAdjLegacy(adj.legacy)
    setLoading(false)
  }

  // ── Periods ──────────────────────────────────────────────────────
  // "As of" choices: months with data up to this month, newest first.
  // Default to the latest one (this month may have nothing yet).
  const monthOptions = useMemo(() => {
    const now = nowKey()
    const keys = [...new Set(transactions.map(t => t.date.slice(0, 7)))].filter(k => k <= now).sort().reverse()
    return keys.length ? keys : [now]
  }, [transactions])
  const end = asOf && monthOptions.includes(asOf) ? asOf : monthOptions[0]
  const cur = periodFor(periodKind, end)
  const prior = priorPeriod(cur)

  // ── Statement data ───────────────────────────────────────────────
  const classified = useMemo(
    () => classify(transactions, categories, noiConfig),
    [transactions, categories, noiConfig],
  )
  const inEntity = i => entity === 'all' || i.t.company_id === entity
  const scope = (p, companyId) => classified.filter(i =>
    inPeriod(i.t, p) && (companyId ? i.t.company_id === companyId : inEntity(i)))

  // Months in the period that come before the books start (no data at all
  // for this scope) don't count: a "T12" with 10 months of history is a
  // 10-month statement, and DSCR / tie-out must say so.
  const firstDataKey = useMemo(() => {
    const keys = transactions.filter(t => entity === 'all' || t.company_id === entity).map(t => t.date.slice(0, 7))
    return keys.length ? keys.reduce((a, b) => (a < b ? a : b)) : null
  }, [transactions, entity])
  const covered = p => (firstDataKey ? p.months.filter(k => k >= firstDataKey) : [])
  const curCovered = covered(cur)
  const priorCovered = covered(prior)

  const entityName = entity === 'all' ? 'All entities' : companies.find(c => c.id === entity)?.name || ''
  const curItems = scope(cur)
  const curStmt = buildStatement(curItems, adjByTx)
  const priorStmt = buildStatement(scope(prior), adjByTx)

  // Columns for the chosen layout. Each: { key, label, items, stmt, drillLabel }
  let columns
  if (layout === 'months') {
    columns = (curCovered.length ? curCovered : cur.months).map(k => {
      const p = periodFor('month', k)
      const items = scope(p)
      return { key: k, label: monthLabel(k), items, stmt: buildStatement(items, adjByTx), drillLabel: monthLabel(k) }
    })
    if (columns.length > 1) columns.push({ key: 'total', label: 'Total', items: curItems, stmt: curStmt, drillLabel: periodRange(cur), total: true })
  } else if (layout === 'entities' && entity === 'all') {
    columns = companies.map(c => {
      const items = scope(cur, c.id)
      return { key: c.id, label: c.name, items, stmt: buildStatement(items, adjByTx), drillLabel: `${c.name}, ${periodRange(cur)}` }
    })
    columns.push({ key: 'total', label: 'Total', items: curItems, stmt: curStmt, drillLabel: periodRange(cur), total: true })
  } else {
    columns = [
      { key: 'cur', label: periodShort(cur), items: curItems, stmt: curStmt, drillLabel: periodRange(cur) },
      { key: 'prior', label: periodShort(prior), items: scope(prior), stmt: priorStmt, drillLabel: periodRange(prior) },
    ]
  }
  const effectiveLayout = layout === 'entities' && entity !== 'all' ? 'compare' : layout
  const rows = statementRows(activityTest(columns.map(c => c.stmt)))

  // ── Key numbers ──────────────────────────────────────────────────
  const monthlyDebt = loans
    .filter(l => entity === 'all' || l.company_id === entity)
    .reduce((s, l) => s + (parseFloat(l.monthly_payment) || 0), 0)
  const periodDebt = monthlyDebt * curCovered.length
  const dscr = periodDebt > 0 ? curStmt.adjustedNoi / periodDebt : null
  const egiChange = priorCovered.length > 0 && priorStmt.egi ? (curStmt.egi - priorStmt.egi) / Math.abs(priorStmt.egi) : null

  // ── Data health ──────────────────────────────────────────────────
  const scopeIds = entity === 'all' ? companies.map(c => c.id) : [entity]
  const tieOut = bankTieOut({ months: curCovered, companyIds: scopeIds, accounts, balances, transactions })
  const tied = tieOut?.filter(m => m.status === 'tied').map(m => m.key) || []
  const untied = tieOut?.filter(m => m.status !== 'tied').map(m => m.key) || []
  const unreviewed = curStmt.adjustments.unreviewed.count
  const nonOperatingInNoi = [...new Set(curItems
    .filter(i => i.place === 'noi' && (belowLineFor(i.cat) || /depreciation|amortization/i.test(i.cat.name)))
    .map(i => i.cat.name))]
  const noConfig = noiConfig.portfolioCats.size === 0 && noiConfig.cats.size === 0

  // ── Drill-down & adjustments ─────────────────────────────────────
  function openDrill(row, col) {
    const items = drillItems(col.items, row.drill, adjByTx)
    setDrawer({ title: row.label, subtitle: col.drillLabel, items })
  }
  function openList(title, items) {
    setDrawer({ title, subtitle: `${periodRange(cur)} · ${entityName}`, items })
  }

  function editAdjustment(t) {
    if (adjLegacy) {
      alert('Run supabase/migrations/2026-11-14-noi-adjustments.sql in Supabase to start recording NOI adjustments.')
      return
    }
    setAdjEditing({ transactions: [t], existing: adjByTx.get(t.id) || null })
  }
  function applyLocal(txs, saved) {
    setAdjByTx(prev => {
      const n = new Map(prev)
      txs.forEach(t => n.delete(t.id))
      saved.forEach(a => n.set(a.transaction_id, a))
      return n
    })
  }
  async function saveAdjustment(values) {
    const txs = adjEditing.transactions
    const { saved, error } = await saveAdjustments(supabase, txs, values)
    if (error) return error
    applyLocal(txs, saved)
    setAdjEditing(null)
    return null
  }
  async function removeAdjustment() {
    const txs = adjEditing.transactions
    const { error } = await removeAdjustments(supabase, txs)
    if (error) return error
    applyLocal(txs, [])
    setAdjEditing(null)
    return null
  }

  // ── CSV mirrors the table on screen ──────────────────────────────
  function csvRows() {
    const compare = effectiveLayout === 'compare'
    const head = compare
      ? ['Line', columns[0].label, '% of EGI', columns[1].label, 'Variance $', 'Variance %']
      : ['Line', ...columns.map(c => c.label), '% of EGI']
    const out = [[`${periodTitle(cur)} · ${entityName} · Operating, cash basis, unaudited`], head]
    const base = compare ? columns[0] : columns[columns.length - 1]
    rows.forEach(r => {
      if (r.kind === 'header') { out.push([r.label]); return }
      const pctEgi = NO_PCT.has(r.key) || r.key.startsWith('adj_') || !base.stmt.egi ? '' : csvPct(r.get(base.stmt) / base.stmt.egi * 100)
      if (compare) {
        const v = variance(r.get(columns[0].stmt), r.get(columns[1].stmt), r.cost)
        const noPrior = priorCovered.length === 0
        out.push([r.label, money(r.get(columns[0].stmt)), pctEgi, noPrior ? '' : money(r.get(columns[1].stmt)),
          noPrior ? '' : money(v.diff), noPrior || v.pct === null ? '' : csvPct(v.pct * 100)])
      } else {
        out.push([r.label, ...columns.map(c => money(r.get(c.stmt))), pctEgi])
      }
    })
    return out
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  const segBtn = on => `px-3 py-1.5 text-sm ${on ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`

  return (
    <div className="p-8">
      <div className="print-hide flex items-start justify-between mb-5 gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">P&L Statement</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {periodTitle(cur)} · {entityName}
            <span className="ml-2 text-xs px-1.5 py-0.5 rounded border border-slate-200 text-slate-500">Operating · Cash basis</span>
          </p>
        </div>
        <div className="flex gap-2">
          <ExportCsvButton
            filename={() => csvFilename('pl', entityName, periodShort(cur))}
            getRows={csvRows}
          />
          <button onClick={() => window.print()}
            className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
            Print / PDF
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="print-hide flex flex-wrap items-center gap-3 mb-5">
        <select value={entity} onChange={e => setEntity(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900">
          <option value="all">All entities</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden bg-white">
          {PERIODS.map(p => (
            <button key={p.value} onClick={() => setPeriodKind(p.value)} className={segBtn(periodKind === p.value)}>{p.label}</button>
          ))}
        </div>
        <label className="text-xs text-slate-500 flex items-center gap-2">
          {periodKind === 'month' ? 'Month' : 'Through'}
          <select value={end} onChange={e => setAsOf(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900">
            {monthOptions.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
          </select>
        </label>
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden bg-white">
          {LAYOUTS.filter(l => l.value !== 'entities' || (entity === 'all' && companies.length > 1)).map(l => (
            <button key={l.value} onClick={() => setLayout(l.value)} className={segBtn(effectiveLayout === l.value)}>{l.label}</button>
          ))}
        </div>
      </div>

      {noConfig && (
        <div className="print-hide bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-5 text-sm text-amber-800">
          Nothing is counted in NOI yet. <Link href="/settings?tab=noi" className="underline">Choose what counts in NOI</Link> to build the statement.
        </div>
      )}

      {curCovered.length > 0 && curCovered.length < cur.months.length && (
        <div className="bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 mb-5 text-sm text-sky-800">
          Only {curCovered.length} of {cur.months.length} months have data (books start {monthLabel(firstDataKey)}).
          Totals cover {periodRange({ from: curCovered[0], to: cur.to })}; DSCR uses the same {curCovered.length} months of debt service.
        </div>
      )}

      {/* Key numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <Kpi label="Effective gross income" value={acct(curStmt.egi, { dollar: true })}
          sub={egiChange === null ? 'No prior-year data' : `${egiChange >= 0 ? '+' : '−'}${Math.abs(egiChange * 100).toFixed(1)}% vs ${periodShort(prior)}`}
          tone={egiChange === null ? null : egiChange >= 0 ? 'good' : 'bad'} />
        <Kpi label="Expense ratio" value={curStmt.expenseRatio === null ? '—' : acctPct(curStmt.expenseRatio)}
          sub={priorCovered.length === 0 || priorStmt.expenseRatio === null ? 'Opex ÷ EGI' : `${acctPct(priorStmt.expenseRatio)} prior year`} />
        <Kpi label="Adjusted NOI" value={acct(curStmt.adjustedNoi, { dollar: true })}
          sub={curStmt.totalAdjustments ? `Reported ${acct(curStmt.noi, { dollar: true })}` : 'No adjustments'} />
        <Kpi label="DSCR" value={dscr === null ? '—' : `${dscr.toFixed(2)}x`}
          sub={dscr === null
            ? <Link href="/debt-equity" className="underline print-hide">Add loans in Debt &amp; Equity</Link>
            : `Adjusted NOI ÷ ${acct(periodDebt, { dollar: true })} scheduled debt service`}
          tone={dscr === null ? null : dscr >= 1.25 ? null : 'bad'} />
      </div>

      {/* Data health */}
      <div className="print-hide flex flex-wrap gap-2 mb-5">
        {curStmt.uncategorized > 0 && (
          <Chip tone="warn" onClick={() => openList('Uncategorized transactions', curItems.filter(i => i.place === 'uncategorized'))}>
            {curStmt.uncategorized} uncategorized
          </Chip>
        )}
        {tieOut === null ? (
          <Chip tone="muted" href="/balances">No bank accounts set up for reconciliation</Chip>
        ) : (
          <>
            {untied.length > 0 && <Chip tone="warn" href="/balances">{monthRuns(untied)} not tied to bank</Chip>}
            {tied.length > 0 && <Chip tone="good" href="/balances">{monthRuns(tied)} tied to bank</Chip>}
          </>
        )}
        {unreviewed > 0 && (
          <Chip tone="bad" href="/adjustments">{unreviewed} adjustment{unreviewed !== 1 ? 's' : ''} need{unreviewed === 1 ? 's' : ''} a reason</Chip>
        )}
        {nonOperatingInNoi.length > 0 && (
          <Chip tone="warn" href="/settings?tab=noi" title={nonOperatingInNoi.join(', ')}>
            {nonOperatingInNoi.length === 1 ? nonOperatingInNoi[0] : `${nonOperatingInNoi.length} non-operating categories`} counted in NOI
          </Chip>
        )}
        {curStmt.uncategorized === 0 && untied.length === 0 && unreviewed === 0 && nonOperatingInNoi.length === 0 && tieOut !== null && (
          <Chip tone="good">Books complete for this period</Chip>
        )}
      </div>

      {/* Statement */}
      <div className="print-area">
        <PrintHeader
          logoUrl={reportSettings.logo_url}
          reportName={reportSettings.report_name}
          subtitle={reportSettings.report_subtitle}
          title={`Operating Statement · ${entityName}`}
          dateRange={periodTitle(cur)}
        />
        <StatementTable rows={rows} columns={columns} layout={effectiveLayout} onDrill={openDrill} priorEmpty={priorCovered.length === 0} />
        <p className="text-xs text-slate-400 mt-2 px-1">
          Cash basis, unaudited. Operating lens: NOI includes the categories chosen in{' '}
          <Link href="/settings?tab=noi" className="underline">What counts in NOI</Link>.
          Cash flow after debt service starts from reported NOI.
          <span className="print-hide"> Click any amount to see its transactions.</span>
        </p>

        {curStmt.off.length > 0 && (
          <div className="print-hide mt-4 bg-white rounded-xl border border-slate-200 px-4 py-3">
            <p className="text-xs font-medium text-slate-500 mb-2">Not on this statement ({periodShort(cur)})</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {curStmt.off.map(o => (
                <button key={o.name} className="text-xs text-slate-500 hover:text-slate-900 tabular-nums"
                  onClick={() => openList(o.name, drillItems(curItems, { place: 'off', category: o.name }, adjByTx))}>
                  {o.name} <span className="text-slate-400">{acct(o.amount)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {drawer && (
        <TransactionDrawer
          {...drawer}
          companies={companies}
          showEntity={entity === 'all'}
          adjByTx={adjByTx}
          canAdjust={isOwner}
          onAdjust={editAdjustment}
          onClose={() => setDrawer(null)}
        />
      )}

      {adjEditing && (
        <AdjustmentModal
          transactions={adjEditing.transactions}
          existing={adjEditing.existing}
          onSave={saveAdjustment}
          onRemove={removeAdjustment}
          onClose={() => setAdjEditing(null)}
        />
      )}
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────

function Kpi({ label, value, sub, tone }) {
  const subCls = tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-amber-700' : 'text-slate-500'
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-xl font-semibold text-slate-900 tabular-nums mt-0.5">{value}</p>
      <p className={`text-xs mt-0.5 ${subCls}`}>{sub}</p>
    </div>
  )
}

const CHIP_TONES = {
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  muted: 'bg-slate-50 text-slate-500 border-slate-200',
}
function Chip({ tone, href, onClick, title, children }) {
  const cls = `text-xs px-2 py-1 rounded-md border ${CHIP_TONES[tone]} ${href || onClick ? 'hover:brightness-95' : ''}`
  if (href) return <Link href={href} className={cls} title={title}>{children}</Link>
  if (onClick) return <button onClick={onClick} className={cls} title={title}>{children}</button>
  return <span className={cls} title={title}>{children}</span>
}

// The statement itself: accounting typography, fixed line order, sticky
// first column and header.
function StatementTable({ rows, columns, layout, onDrill, priorEmpty }) {
  const compare = layout === 'compare'
  const pctCol = compare ? columns[0] : columns[columns.length - 1]
  const [curCol, priorCol] = columns

  const head = compare
    ? [curCol.label, '% EGI', priorCol.label, 'Var $', 'Var %']
    : [...columns.map(c => c.label), '% EGI']

  const pctOf = (r, col) => {
    if (r.kind === 'header' || NO_PCT.has(r.key) || r.key.startsWith('adj_') || !col.stmt.egi) return ''
    return acctPct(r.get(col.stmt) / col.stmt.egi)
  }

  function rowCls(r) {
    if (r.kind === 'header') return 'text-[11px] font-semibold uppercase tracking-wider text-slate-400'
    if (r.kind === 'noi') return 'font-semibold text-slate-900'
    if (r.kind === 'subtotal') return 'font-semibold text-slate-900'
    return 'text-slate-800'
  }
  // Rules: single above subtotals, single above + double below NOI
  function cellBorder(r) {
    if (r.kind === 'noi') return 'border-t border-slate-400 border-b-[3px] border-b-slate-400 border-double'
    if (r.kind === 'subtotal') return 'border-t border-slate-300'
    return ''
  }

  function amountCell(r, col) {
    const text = acct(r.get(col.stmt))
    const cls = `px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${cellBorder(r)}`
    if (r.drill && text !== '–' && text !== '') {
      return (
        <td key={col.key} className={cls}>
          <button onClick={() => onDrill(r, col)} className="hover:underline decoration-slate-300 underline-offset-2">{text}</button>
        </td>
      )
    }
    return <td key={col.key} className={`${cls} ${text === '–' ? 'text-slate-300' : ''}`}>{text}</td>
  }

  return (
    <div className="statement-scroll bg-white rounded-xl border border-slate-200 overflow-auto max-h-[78vh]">
      <table className="w-full text-sm border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-30 bg-white border-b border-slate-200 px-4 py-2.5 text-left min-w-[15rem]" />
            {head.map((h, i) => (
              <th key={i} className={`sticky top-0 z-20 bg-white border-b border-slate-200 px-3 py-2.5 text-right text-xs font-medium whitespace-nowrap ${
                (compare && i > 0) || (!compare && i === head.length - 1) ? 'text-slate-400' : 'text-slate-600'}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            if (r.kind === 'header') {
              return (
                <tr key={r.key} className={rowCls(r)}>
                  <td className="sticky left-0 z-10 bg-white px-4 pt-4 pb-1">{r.label}</td>
                  <td colSpan={head.length} className="pt-4 pb-1" />
                </tr>
              )
            }
            const indent = r.kind === 'line'
            const adjCount = r.adjCount ? Math.max(...columns.map(c => r.adjCount(c.stmt))) : 0
            let varCells = null
            if (compare && priorEmpty) {
              varCells = (
                <>
                  <td className={cellBorder(r)} />
                  <td className={cellBorder(r)} />
                </>
              )
            } else if (compare) {
              const v = variance(r.get(curCol.stmt), r.get(priorCol.stmt), r.cost)
              const flag = v.pct !== null && v.pct < FLAG_AT && Math.round(r.get(curCol.stmt)) !== 0
              varCells = (
                <>
                  <td className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap text-slate-500 ${cellBorder(r)}`}>{acct(v.diff)}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${flag ? 'text-amber-700 font-medium' : 'text-slate-500'} ${cellBorder(r)}`}>
                    {v.pct === null ? '' : acctPct(v.pct)}
                  </td>
                </>
              )
            }
            return (
              <tr key={r.key} className={`${rowCls(r)} hover:bg-slate-50/60`}>
                <td className={`sticky left-0 z-10 bg-white py-1.5 pr-3 whitespace-nowrap ${indent ? 'pl-8 text-slate-600' : 'pl-4'} ${cellBorder(r)}`}>
                  {r.label}
                  {adjCount > 0 && <span className="ml-1.5 text-[11px] text-sky-700">· {adjCount} adj.</span>}
                  {r.note && <span className="ml-1.5 text-[11px] font-normal text-slate-400">{r.note}</span>}
                </td>
                {compare ? (
                  <>
                    {amountCell(r, curCol)}
                    <td className={`px-3 py-1.5 text-right tabular-nums text-slate-500 ${cellBorder(r)}`}>{pctOf(r, curCol)}</td>
                    {amountCell(r, priorCol)}
                    {varCells}
                  </>
                ) : (
                  <>
                    {columns.map(c => amountCell(r, c))}
                    <td className={`px-3 py-1.5 text-right tabular-nums text-slate-500 ${cellBorder(r)}`}>{pctOf(r, pctCol)}</td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const SOURCE_LABEL = { bank: 'Bank', credit_card: 'Card' }

// Slide-over listing the transactions behind a number, with their NOI
// adjustments. This is where items get tagged in or out of NOI.
function TransactionDrawer({ title, subtitle, items, companies, showEntity, adjByTx, canAdjust, onAdjust, onClose }) {
  const coName = Object.fromEntries(companies.map(c => [c.id, c.name]))
  const sorted = [...items].sort((a, b) => b.t.date.localeCompare(a.t.date))
  const total = items.reduce((s, i) => s + (Number(i.t.amount) || 0), 0)

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="print-hide fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} />
      <aside className="relative w-full max-w-xl h-full bg-white shadow-xl flex flex-col">
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-900">{title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {subtitle} · {items.length} transaction{items.length !== 1 ? 's' : ''} · net {acct(total, { dollar: true, cents: true })} as booked
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none" aria-label="Close">×</button>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {sorted.length === 0 && <p className="text-sm text-slate-400 px-5 py-6">No transactions.</p>}
          {sorted.map(({ t, cat, place }) => {
            const adj = adjByTx.get(t.id)
            const info = adj ? treatmentInfo(adj.treatment) : null
            const partial = isPartial(t, adj)
            const adjustable = place === 'noi'
            return (
              <div key={t.id} className="px-5 py-2.5 flex gap-3">
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${adj && !partial ? 'text-slate-400 line-through' : 'text-slate-800'}`} title={t.description}>
                    {t.description || '(no description)'}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {t.date}
                    {showEntity && coName[t.company_id] ? ` · ${coName[t.company_id]}` : ''}
                    {cat ? ` · ${cat.name}` : ''}
                    {t.source_type ? ` · ${SOURCE_LABEL[t.source_type] || t.source_type}${t.source ? ` (${t.source})` : ''}` : ''}
                    {t.is_autopayment ? ' · autopay' : ''}
                  </p>
                  {adj && (
                    <button onClick={() => canAdjust && onAdjust(t)} className="block text-left mt-1" disabled={!canAdjust}>
                      <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${info.badge}`}>
                        {info.short} · {acct(excludedAmount(t, adj), { dollar: true, cents: true })} out of NOI
                      </span>
                      {adj.reason
                        ? <span className="block text-xs text-slate-500 italic mt-0.5">{adj.reason}</span>
                        : <span className="block text-xs text-red-600 mt-0.5">Add a reason</span>}
                    </button>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm tabular-nums text-slate-900">{acct(Number(t.amount), { cents: true })}</p>
                  {adjustable && canAdjust && !adj && (
                    <button onClick={() => onAdjust(t)} className="text-xs text-slate-400 hover:text-slate-800 mt-0.5">Adjust</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
