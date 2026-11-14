'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Papa from 'papaparse'
import { createClient } from '@/utils/supabase/client'
import { parseEasyStorageFees } from '@/lib/parsers/easystorage'
import { groupNoiConfig, noiCatsFor } from '@/lib/reports/statement'
import {
  PROCESSORS, processorInfo, ORIGINS, REVENUE_CATEGORY, FEE_CATEGORY,
  loadProcessorSettings, saveProcessorSettings, loadProcessorFees, setProcessorFee, feeCategories,
  entitySetting, parseFacilities,
} from '@/lib/reports/processorFees'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NOW = new Date()
const CURRENT_YEAR = NOW.getFullYear()
const NOW_KEY = `${CURRENT_YEAR}-${String(NOW.getMonth() + 1).padStart(2, '0')}`
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2]

const fmt = n => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ProcessorFeesPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [noiConfig, setNoiConfig] = useState({ cats: new Map(), portfolioCats: new Set() })
  const [isOwner, setIsOwner] = useState(false)
  const [settings, setSettings] = useState({})
  const [fees, setFees] = useState(new Map())
  const [year, setYear] = useState(CURRENT_YEAR)
  const [drafts, setDrafts] = useState({}) // `${companyId}|${facility}|${month}` → text
  const [saving, setSaving] = useState(null) // cell key being saved
  const [error, setError] = useState('')

  // Easy Storage import
  const [importCo, setImportCo] = useState('')
  const [importFac, setImportFac] = useState('')
  const [preview, setPreview] = useState(null) // { files, months: [{ month, fee, deposits }] }
  const [applying, setApplying] = useState(false)

  // Latest settings and a save queue, so changing two entities quickly
  // can't let an older save overwrite a newer one
  const settingsRef = useRef({})
  const saveChain = useRef(Promise.resolve())

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: co }, { data: cat }, { data: cfg }, { data: role }, s, f] = await Promise.all([
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('bank_pl_categories').select('category_id, company_id'),
      supabase.from('user_roles').select('role').maybeSingle(),
      loadProcessorSettings(supabase),
      loadProcessorFees(supabase),
    ])
    setCompanies(co || [])
    setCategories(cat || [])
    setNoiConfig(groupNoiConfig(cfg))
    setIsOwner(role?.role === 'owner')
    setSettings(s)
    settingsRef.current = s
    setFees(f.fees)
    if (f.error) setError(f.error)
    setLoading(false)
  }

  async function reloadFees() {
    const f = await loadProcessorFees(supabase)
    setFees(f.fees)
    if (f.error) setError(f.error)
  }

  // patch: { processor } and/or { facilities }
  function updateEntity(companyId, patch) {
    const next = { ...settingsRef.current, [companyId]: { ...entitySetting(settingsRef.current, companyId), ...patch } }
    settingsRef.current = next
    setSettings(next)
    saveChain.current = saveChain.current.then(async () => {
      const err = await saveProcessorSettings(supabase, settingsRef.current)
      if (err) setError(err)
    })
  }

  const cats = feeCategories(categories)
  // Grossing up only nets to zero in NOI when both legs count in NOI
  function noiProblem(companyId) {
    const inNoi = noiCatsFor(noiConfig, companyId)
    const missing = []
    if (!cats.revenue) missing.push(`a "${REVENUE_CATEGORY}" category`)
    else if (!inNoi.has(cats.revenue.id)) missing.push(REVENUE_CATEGORY)
    if (!cats.fee) missing.push(`a "${FEE_CATEGORY}" category`)
    else if (!inNoi.has(cats.fee.id)) missing.push(FEE_CATEGORY)
    return missing
  }

  const setting = companyId => entitySetting(settings, companyId)
  const labelFor = companyId => processorInfo(setting(companyId).processor)?.label
  const withholding = companies.filter(c => processorInfo(setting(c.id).processor)?.withholds)
  const months = MONTHS.map((_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  const saved = (companyId, facility, month) => fees.get(companyId)?.get(facility)?.get(month) || null

  // Grid rows: one per facility when the entity is split, else one for the
  // entity. Entity-level entries made before a split stay visible.
  const rows = withholding.flatMap(c => {
    const { facilities } = setting(c.id)
    if (facilities.length === 0) return [{ company: c, facility: '' }]
    const list = facilities.map(f => ({ company: c, facility: f }))
    if (fees.get(c.id)?.get('')?.size) list.push({ company: c, facility: '', unassigned: true })
    return list
  })

  async function saveCell(company, facility, month) {
    const key = `${company.id}|${facility}|${month}`
    if (!(key in drafts)) return
    const text = drafts[key].trim().replace(/[$,]/g, '')
    const value = text === '' ? 0 : Number(text)
    if (!Number.isFinite(value) || value < 0) { setError('Enter the fee as a positive dollar amount.'); return }
    const current = saved(company.id, facility, month)?.fee || 0
    if (Math.abs(value - current) < 0.005) {
      setDrafts(d => { const n = { ...d }; delete n[key]; return n })
      return
    }
    setSaving(key)
    setError('')
    const err = await setProcessorFee(supabase, {
      companyId: company.id, facility, month, fee: value, origin: 'manual',
      processorLabel: labelFor(company.id), categories,
    })
    if (err) setError(err)
    await reloadFees()
    setDrafts(d => { const n = { ...d }; delete n[key]; return n })
    setSaving(null)
  }

  function readFiles(fileList) {
    const files = [...fileList]
    if (files.length === 0) return
    Promise.all(files.map(file => new Promise(resolve => {
      Papa.parse(file, { header: true, skipEmptyLines: true, complete: r => resolve(parseEasyStorageFees(r.data)) })
    }))).then(results => {
      const byMonth = new Map()
      results.flat().forEach(m => {
        const cur = byMonth.get(m.month) || { month: m.month, fee: 0, deposits: 0 }
        cur.fee = Math.round((cur.fee + m.fee) * 100) / 100
        cur.deposits += m.deposits
        byMonth.set(m.month, cur)
      })
      const list = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
      setPreview({ files: files.map(f => f.name), months: list })
      if (list.length === 0) setError('No processed deposits with a Fees column were found in that file.')
    })
  }

  async function applyImport() {
    const company = companies.find(c => c.id === importCo)
    if (!company || !preview) return
    setApplying(true)
    setError('')
    for (const m of preview.months) {
      const err = await setProcessorFee(supabase, {
        companyId: company.id, facility: importFac, month: m.month, fee: m.fee, origin: 'easystorage',
        processorLabel: labelFor(company.id) || 'Easy Storage', categories,
      })
      if (err) { setError(err); break }
    }
    await reloadFees()
    setPreview(null)
    setApplying(false)
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  const inputCls = 'w-full border border-slate-200 rounded px-1.5 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-300'
  const importProblems = importCo ? noiProblem(importCo) : []
  const importFacilities = importCo ? setting(importCo).facilities : []
  const importReady = !!importCo && importProblems.length === 0 && (importFacilities.length === 0 || !!importFac)

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Processor Fees</h1>
        <p className="text-sm text-slate-500 mt-0.5 max-w-3xl">
          Easy Storage and WebSelfStorage deposit rent after taking out card fees, so the bank shows less than tenants paid.
          Enter each month&apos;s fees here and the books show revenue at the gross amount, with the fees as a Payment Processing expense.
          The two entries cancel out, so NOI and the bank tie-out don&apos;t change.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 mb-4 text-sm text-red-700 flex justify-between gap-4">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-700">×</button>
        </div>
      )}

      {/* Processor per entity */}
      <section className="bg-white rounded-xl border border-slate-200 mb-6">
        <div className="px-5 py-3 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900 text-sm">Processor by entity</h2>
        </div>
        <div className="divide-y divide-slate-50">
          {companies.map(c => {
            const { processor, facilities } = setting(c.id)
            const info = processorInfo(processor)
            return (
              <div key={c.id} className="px-5 py-2.5 flex flex-wrap items-center gap-3">
                <span className="text-sm text-slate-800 w-64">{c.name}</span>
                <select value={processor} disabled={!isOwner} onChange={e => updateEntity(c.id, { processor: e.target.value })}
                  className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">Not set</option>
                  {PROCESSORS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <span className="text-xs text-slate-500">
                  {!info ? '' : info.withholds ? 'Fees withheld from deposits: enter them below' : 'Fees billed separately: already in the books, nothing to enter'}
                </span>
                {info?.withholds && (
                  <label className="basis-full sm:basis-auto sm:ml-auto flex items-center gap-2 text-xs text-slate-500">
                    Split by facility
                    <input
                      key={facilities.join('|')}
                      defaultValue={facilities.join(', ')}
                      disabled={!isOwner}
                      placeholder="e.g. Fort Meade, Bowling Green"
                      onBlur={e => {
                        const next = parseFacilities(e.target.value)
                        if (next.join('|') !== facilities.join('|')) updateEntity(c.id, { facilities: next })
                      }}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                      className="w-64 border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                  </label>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Monthly grid */}
      <section className="bg-white rounded-xl border border-slate-200 mb-6 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-900 text-sm">Fees withheld by month</h2>
            <p className="text-xs text-slate-500 mt-0.5">Type the total from the processor&apos;s monthly statement. Clear a cell to remove it.</p>
          </div>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900">
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {withholding.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-400">Set a processor that withholds fees for at least one entity above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="text-left font-medium px-5 py-2 min-w-[14rem]">Entity</th>
                  {MONTHS.map(m => <th key={m} className="text-right font-medium px-1.5 py-2 w-24">{m}</th>)}
                  <th className="text-right font-medium px-4 py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ company: c, facility, unassigned }, i) => {
                  const problems = noiProblem(c.id)
                  const blocked = problems.length > 0 || !isOwner
                  const total = months.reduce((s, m) => s + (saved(c.id, facility, m)?.fee || 0), 0)
                  const firstOfEntity = i === 0 || rows[i - 1].company.id !== c.id
                  return (
                    <tr key={`${c.id}|${facility}`} className={`${firstOfEntity ? 'border-t border-slate-200' : 'border-t border-slate-50'} align-top`}>
                      <td className="px-5 py-2">
                        {facility || unassigned ? (
                          <>
                            {firstOfEntity && <p className="text-xs text-slate-400">{c.name}</p>}
                            <p className={unassigned ? 'text-slate-400 italic' : 'text-slate-800'}>
                              {unassigned ? 'Not split (entered before the split)' : facility}
                            </p>
                          </>
                        ) : (
                          <p className="text-slate-800">{c.name}</p>
                        )}
                        {firstOfEntity && <p className="text-xs text-slate-400">{labelFor(c.id)}</p>}
                        {firstOfEntity && problems.length > 0 && (
                          <p className="text-xs text-amber-700 mt-1 max-w-[14rem]">
                            {problems.join(' and ')} {problems.length === 1 ? "isn't" : "aren't"} counted in NOI for this entity, so a gross-up would change NOI.{' '}
                            <Link href="/settings?tab=noi" className="underline">Fix in What Counts in NOI</Link>
                          </p>
                        )}
                      </td>
                      {months.map(m => {
                        const key = `${c.id}|${facility}|${m}`
                        const s = saved(c.id, facility, m)
                        const future = m > NOW_KEY
                        return (
                          <td key={m} className="px-1.5 py-2">
                            <input
                              inputMode="decimal"
                              disabled={blocked || future || saving === key}
                              value={key in drafts ? drafts[key] : s ? fmt(s.fee) : ''}
                              onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                              onBlur={() => saveCell(c, facility, m)}
                              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                              title={s ? ORIGINS[s.origin] || s.origin : ''}
                              className={`${inputCls} ${s?.origin === 'easystorage' && !(key in drafts) ? 'text-sky-700' : ''}`}
                            />
                          </td>
                        )
                      })}
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">{total ? fmt(total) : '–'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="px-5 py-2 text-xs text-slate-400 border-t border-slate-100">
              <span className="text-sky-700">Blue</span> amounts came from an Easy Storage report; typing over one replaces it.
              Each month posts on its last day as two entries: + Rental Income and − Payment Processing.
            </p>
          </div>
        )}
      </section>

      {/* Easy Storage import */}
      {isOwner && (
        <section className="bg-white rounded-xl border border-slate-200 mb-6">
          <div className="px-5 py-3 border-b border-slate-100">
            <h2 className="font-semibold text-slate-900 text-sm">Import from Easy Storage</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Upload the deposit summary CSV (Date, Processed, Adjustments, Fees, Net Amount, Status). The Fees column is
              totaled by month and fills the grid. For an entity split by facility, import each facility&apos;s report to its own row.
            </p>
          </div>
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <select value={importCo} onChange={e => { setImportCo(e.target.value); setImportFac(''); setPreview(null) }}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Choose entity…</option>
                {withholding.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {importFacilities.length > 0 && (
                <select value={importFac} onChange={e => { setImportFac(e.target.value); setPreview(null) }}
                  className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">Choose facility…</option>
                  {importFacilities.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              )}
              <input type="file" accept=".csv" multiple disabled={!importReady}
                onChange={e => { readFiles(e.target.files); e.target.value = '' }}
                className="text-sm text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-slate-200 file:bg-white file:text-sm" />
            </div>
            {importProblems.length > 0 && (
              <p className="text-xs text-amber-700">Fix What Counts in NOI for this entity first (see the grid above).</p>
            )}
            {preview && preview.months.length > 0 && (
              <div>
                <p className="text-xs text-slate-500 mb-2">{preview.files.join(', ')}</p>
                <table className="text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500">
                      <th className="text-left font-medium pr-6 py-1">Month</th>
                      <th className="text-right font-medium pr-6 py-1">Deposits</th>
                      <th className="text-right font-medium pr-6 py-1">Fees in report</th>
                      <th className="text-right font-medium py-1">Currently entered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.months.map(m => {
                      const cur = saved(importCo, importFac, m.month)
                      return (
                        <tr key={m.month} className="border-t border-slate-100">
                          <td className="pr-6 py-1 text-slate-700">{MONTHS[Number(m.month.slice(5, 7)) - 1]} {m.month.slice(0, 4)}</td>
                          <td className="pr-6 py-1 text-right tabular-nums text-slate-500">{m.deposits}</td>
                          <td className="pr-6 py-1 text-right tabular-nums text-slate-900">{fmt(m.fee)}</td>
                          <td className={`py-1 text-right tabular-nums ${cur && Math.abs(cur.fee - m.fee) >= 0.005 ? 'text-amber-700' : 'text-slate-400'}`}>
                            {cur ? fmt(cur.fee) : '–'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="flex gap-2 mt-3">
                  <button onClick={applyImport} disabled={applying}
                    className="bg-slate-900 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-slate-800 disabled:opacity-50">
                    {applying ? 'Saving…' : `Use these ${preview.months.length} month${preview.months.length !== 1 ? 's' : ''}`}
                  </button>
                  <button onClick={() => setPreview(null)} className="text-sm px-4 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                    Cancel
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-2">Months already entered are replaced by the report&apos;s total.</p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
