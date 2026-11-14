'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { formatCurrency } from '@/lib/reports/pl'
import { fetchAllRows } from '@/lib/fetchAll'
import ExportCsvButton from '@/components/ExportCsvButton'
import AdjustmentModal from '@/components/AdjustmentModal'
import { money, pct, csvFilename } from '@/lib/exportCsv'
import {
  TREATMENTS, UNREVIEWED, treatmentInfo, loadAdjustments, saveAdjustments, removeAdjustments,
  excludedAmount, noiImpact, isPartial, recurringNonRecurring, exclusionShareByCategory, applyAdjustments,
} from '@/lib/reports/adjustments'

const CURRENT_YEAR = new Date().getFullYear()
const PERIODS = [
  { value: 't12', label: 'Trailing 12 months' },
  ...[0, 1, 2, 3].map(i => ({ value: String(CURRENT_YEAR - i), label: String(CURRENT_YEAR - i) })),
  { value: 'all', label: 'All time' },
]
// Share of a category excluded above which a buyer will ask questions
const HIGH_SHARE = 0.25
const isRM = name => /maint|repair/i.test(name || '')

function periodRange(period) {
  if (period === 'all') return [null, null]
  if (period === 't12') {
    const end = new Date()
    end.setDate(0) // last day of previous month
    const start = new Date(end.getFullYear(), end.getMonth() - 11, 1)
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return [iso(start), iso(end)]
  }
  return [`${period}-01-01`, `${period}-12-31`]
}

export default function AdjustmentsPage() {
  const [transactions, setTransactions] = useState([])
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [adjByTx, setAdjByTx] = useState(new Map())
  const [legacy, setLegacy] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)

  const [companyFilter, setCompanyFilter] = useState('all')
  const [period, setPeriod] = useState('t12')
  const [treatmentFilter, setTreatmentFilter] = useState('all')
  const [editing, setEditing] = useState(null) // { transactions, existing }

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [tx, { data: co }, { data: cat }, { data: role }, adj] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*').order('date')),
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('user_roles').select('role').single(),
      loadAdjustments(supabase),
    ])
    setTransactions(tx)
    setCompanies(co || [])
    setCategories(cat || [])
    setIsOwner(role?.role === 'owner')
    setAdjByTx(adj.byTx)
    setLegacy(adj.legacy)
    setLoading(false)
  }

  function setLocal(txs, saved) {
    setAdjByTx(prev => {
      const n = new Map(prev)
      txs.forEach(t => n.delete(t.id))
      saved.forEach(a => n.set(a.transaction_id, a))
      return n
    })
  }

  async function save(values) {
    const { saved, error } = await saveAdjustments(supabase, editing.transactions, values)
    if (error) return error
    setLocal(editing.transactions, saved)
    setEditing(null)
    return null
  }

  async function remove() {
    const { error } = await removeAdjustments(supabase, editing.transactions)
    if (error) return error
    setLocal(editing.transactions, [])
    setEditing(null)
    return null
  }

  function open(t) {
    if (!isOwner || legacy) return
    setEditing({ transactions: [t], existing: adjByTx.get(t.id) || null })
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  const [from, to] = periodRange(period)
  const companyName = Object.fromEntries(companies.map(c => [c.id, c.name]))
  const catById = Object.fromEntries(categories.map(c => [c.id, c]))

  const inEntity = t => companyFilter === 'all' || t.company_id === companyFilter
  const inPeriod = t => (!from || t.date >= from) && (!to || t.date <= to)
  const scoped = transactions.filter(t => inEntity(t) && inPeriod(t))

  const items = scoped
    .filter(t => adjByTx.has(t.id))
    .map(t => {
      const adj = adjByTx.get(t.id)
      return { tx: t, adj, category: catById[t.category_id]?.name || 'Uncategorized', excluded: excludedAmount(t, adj), impact: noiImpact(t, adj) }
    })
  const shown = items.filter(i => treatmentFilter === 'all' || i.adj.treatment === treatmentFilter)

  const groups = [...TREATMENTS, UNREVIEWED]
    .map(t => {
      const rows = shown.filter(i => i.adj.treatment === t.value).sort((a, b) => b.tx.date.localeCompare(a.tx.date))
      return { treatment: t, rows, total: rows.reduce((s, r) => s + r.impact, 0) }
    })
    .filter(g => g.rows.length > 0)

  const totalImpact = items.reduce((s, i) => s + i.impact, 0)
  const unreviewedCount = items.filter(i => i.adj.treatment === 'unreviewed').length

  // Guardrails
  // Repeat "non-recurring" vendors look across all time, not just the period
  const repeats = recurringNonRecurring(
    transactions.filter(t => inEntity(t) && adjByTx.has(t.id)).map(t => ({ tx: t, adj: adjByTx.get(t.id) }))
  )
  const shares = exclusionShareByCategory(scoped, categories, adjByTx)
  const revenue = scoped.reduce((s, t) => s + (catById[t.category_id]?.type === 'income' ? Number(t.amount) : 0), 0)
  const rmTxs = scoped.filter(t => isRM(catById[t.category_id]?.name))
  const rmReported = -rmTxs.reduce((s, t) => s + Number(t.amount), 0)
  const rmAdjusted = -applyAdjustments(rmTxs, adjByTx).reduce((s, t) => s + Number(t.amount), 0)

  const periodLabel = PERIODS.find(p => p.value === period)?.label
  const entityLabel = companyFilter === 'all' ? 'All entities' : companyName[companyFilter]

  function csvRows() {
    const rows = [
      ['NOI Adjustments', `${entityLabel} · ${periodLabel}`],
      [],
      ['Treatment', 'Date', 'Entity', 'Category', 'Description', 'Transaction Amount', 'Excluded', 'NOI Impact', 'Reason'],
    ]
    groups.forEach(g => {
      g.rows.forEach(r => rows.push([
        g.treatment.label, r.tx.date, companyName[r.tx.company_id] || '', r.category, r.tx.description || '',
        money(r.tx.amount), money(r.excluded), money(r.impact), r.adj.reason || '',
      ]))
      rows.push([`${g.treatment.label} total`, '', '', '', '', '', '', money(g.total), ''])
    })
    rows.push(['Total NOI impact', '', '', '', '', '', '', money(groups.reduce((s, g) => s + g.total, 0)), ''])
    return rows
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">NOI Adjustments</h1>
          <p className="text-slate-500 text-sm mt-0.5">Everything taken out of NOI, and why</p>
        </div>
        <div className="flex gap-2">
          <ExportCsvButton filename={() => csvFilename('noi-adjustments', entityLabel, periodLabel)} getRows={csvRows} />
          <button onClick={() => window.print()} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
            Print / PDF
          </button>
        </div>
      </div>

      {legacy && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 text-sm text-amber-800">
          Showing your old exclusions read-only. Run <code className="font-mono text-xs">supabase/migrations/2026-11-14-noi-adjustments.sql</code> in
          the Supabase SQL editor to start recording treatments and reasons.
        </div>
      )}

      <div className="print-hide bg-white rounded-xl border border-slate-200 p-4 mb-6 flex flex-wrap gap-3 items-end">
        <Select label="Entity" value={companyFilter} onChange={setCompanyFilter}
          options={[{ value: 'all', label: 'All entities' }, ...companies.map(c => ({ value: c.id, label: c.name }))]} />
        <Select label="Period" value={period} onChange={setPeriod} options={PERIODS} />
        <Select label="Treatment" value={treatmentFilter} onChange={setTreatmentFilter}
          options={[{ value: 'all', label: 'All' }, ...[...TREATMENTS, UNREVIEWED].map(t => ({ value: t.value, label: t.label }))]} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Stat label="NOI impact" value={`${totalImpact >= 0 ? '+' : ''}${formatCurrency(totalImpact)}`} sub={`${entityLabel} · ${periodLabel}`} />
        <Stat label="Adjustments" value={items.length} sub={`${items.filter(i => isPartial(i.tx, i.adj)).length} partial`} />
        <Stat label="Need a reason" value={unreviewedCount} tone={unreviewedCount > 0 ? 'bad' : 'good'}
          sub={unreviewedCount > 0 ? 'Undocumented add-backs get rejected' : 'Every adjustment is documented'} />
      </div>

      {/* Guardrails */}
      {(repeats.length > 0 || shares.length > 0 || rmReported > 0) && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
          <h2 className="font-semibold text-slate-900 text-sm mb-1">What a buyer or lender will check</h2>
          <p className="text-xs text-slate-500 mb-4">Flags for adjustments that commonly get challenged in underwriting.</p>
          <div className="space-y-5">
            {rmReported > 0 && revenue > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Maintenance &amp; Repairs as % of revenue</p>
                <p className="text-sm text-slate-700">
                  {pct(rmReported / revenue * 100)}% reported → <span className="font-semibold">{pct(rmAdjusted / revenue * 100)}% adjusted</span>
                  <span className="text-slate-400"> · self-storage typically runs about 2–4%</span>
                </p>
                {rmAdjusted / revenue < 0.02 && (
                  <p className="text-xs text-amber-700 mt-1">Adjusted R&amp;M is below the typical range — expect a buyer to add some back.</p>
                )}
              </div>
            )}
            {shares.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Share of each category excluded</p>
                <div className="space-y-1">
                  {shares.map(r => (
                    <div key={r.name} className="flex items-center gap-3 text-sm">
                      <span className="w-48 truncate text-slate-700">{r.name}</span>
                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className={`h-full ${r.share > HIGH_SHARE ? 'bg-amber-500' : 'bg-slate-400'}`}
                          style={{ width: `${Math.min(100, Math.max(0, (r.share || 0) * 100))}%` }} />
                      </div>
                      <span className={`w-40 text-right font-mono text-xs ${r.share > HIGH_SHARE ? 'text-amber-700' : 'text-slate-500'}`}>
                        {r.share == null ? '—' : `${pct(r.share * 100)}%`} of {formatCurrency(r.total)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {repeats.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">&ldquo;Non-recurring&rdquo; in more than one year</p>
                <div className="space-y-1">
                  {repeats.map(v => (
                    <p key={v.key} className="text-sm text-amber-800">
                      <span className="font-medium">{v.label}</span> — {v.count} items, {formatCurrency(v.total)}, in {v.years.join(', ')}
                    </p>
                  ))}
                </div>
                <p className="text-xs text-slate-500 mt-1">If it happens every year, a buyer will treat it as an operating expense.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Adjustments by treatment */}
      {groups.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-400">
          No adjustments for this entity and period. Exclude items from the Bank P&amp;L drill-down or the Transactions page.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(g => (
            <div key={g.treatment.value} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded border ${g.treatment.badge}`}>{g.treatment.label}</span>
                  <span className="text-xs text-slate-500">{g.rows.length} item{g.rows.length !== 1 ? 's' : ''}</span>
                </div>
                <span className="font-mono text-sm font-semibold text-slate-800">{g.total >= 0 ? '+' : ''}{formatCurrency(g.total)}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 text-left">
                      <th className="px-5 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Description</th>
                      <th className="px-3 py-2 font-medium">Category</th>
                      <th className="px-3 py-2 font-medium text-right">Amount</th>
                      <th className="px-3 py-2 font-medium text-right">Excluded</th>
                      <th className="px-5 py-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map(r => (
                      <tr key={r.tx.id} onClick={() => open(r.tx)}
                        className={`border-t border-slate-100 align-top ${isOwner && !legacy ? 'cursor-pointer hover:bg-slate-50' : ''}`}>
                        <td className="px-5 py-2 text-slate-500 whitespace-nowrap">{r.tx.date}</td>
                        <td className="px-3 py-2">
                          <p className="text-slate-700 truncate max-w-xs">{r.tx.description}</p>
                          {companyFilter === 'all' && <p className="text-xs text-slate-400">{companyName[r.tx.company_id]}</p>}
                        </td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.category}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-500 whitespace-nowrap">{formatCurrency(Math.abs(r.tx.amount))}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-800 whitespace-nowrap">
                          {formatCurrency(r.excluded)}
                          {isPartial(r.tx, r.adj) && <span className="block text-[10px] text-slate-400">partial</span>}
                        </td>
                        <td className="px-5 py-2 max-w-sm">
                          {r.adj.reason
                            ? <p className="text-slate-600 whitespace-pre-wrap">{r.adj.reason}</p>
                            : <p className="text-red-500 text-xs">No reason recorded{isOwner && !legacy ? ' — click to add' : ''}</p>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <AdjustmentModal transactions={editing.transactions} existing={editing.existing}
          onSave={save} onRemove={remove} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

function Select({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function Stat({ label, value, sub, tone }) {
  const color = tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : 'text-slate-900'
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  )
}
