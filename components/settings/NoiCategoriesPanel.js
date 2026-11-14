'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { fetchAllRows } from '@/lib/fetchAll'
import { loadAdjustments } from '@/lib/reports/adjustments'
import { noiLineFor, belowLineFor, lineInfo } from '@/lib/reports/statement'

// "What counts in NOI": the one-time setup that used to be the Bank P&L
// mode's checkbox panel. Stored in bank_pl_categories (company_id null =
// portfolio default; an entity with its own rows uses those instead).
// Overview, the P&L statement, Deal Room, Debt & Equity and Pro Forma all
// read it.
export default function NoiCategoriesPanel({ companies, categories, isOwner }) {
  const supabase = createClient()
  const [entity, setEntity] = useState('portfolio')
  const [included, setIncluded] = useState(new Set())
  const [entitiesWithOwn, setEntitiesWithOwn] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null) // category id being saved
  const [error, setError] = useState('')

  useEffect(() => { load(entity) }, [entity])

  async function load(entityId) {
    setLoading(true)
    const { data } = await supabase.from('bank_pl_categories').select('category_id, company_id')
    const rows = data || []
    setEntitiesWithOwn(new Set(rows.filter(r => r.company_id).map(r => r.company_id)))
    const mine = rows.filter(r => (entityId === 'portfolio' ? r.company_id == null : r.company_id === entityId))
    setIncluded(new Set(mine.map(r => r.category_id)))
    setLoading(false)
  }

  // Same side effects the Bank P&L checkboxes had: keep transactions'
  // expense_type (used by Pro Forma) in step with NOI. Transactions with a
  // documented NOI adjustment keep their treatment.
  async function toggle(cat) {
    if (!isOwner || busy) return
    setBusy(cat.id)
    setError('')
    const companyId = entity === 'portfolio' ? null : entity
    const adding = !included.has(cat.id)
    try {
      if (adding) {
        const { error: e } = await supabase.from('bank_pl_categories').insert({ category_id: cat.id, company_id: companyId })
        if (e) throw e
      } else {
        const q = supabase.from('bank_pl_categories').delete().eq('category_id', cat.id)
        const { error: e } = await (companyId ? q.eq('company_id', companyId) : q.is('company_id', null))
        if (e) throw e
      }
      setIncluded(prev => {
        const n = new Set(prev)
        adding ? n.add(cat.id) : n.delete(cat.id)
        return n
      })

      if (cat.type === 'expense') {
        const [txs, adj] = await Promise.all([
          fetchAllRows(() => {
            let q = supabase.from('transactions').select('id, amount, company_id').eq('category_id', cat.id)
            if (companyId) q = q.eq('company_id', companyId)
            return q
          }),
          loadAdjustments(supabase),
        ])
        const ids = txs
          .filter(t => !adj.byTx.has(t.id) && (!adding || Number(t.amount) < 0))
          .map(t => t.id)
        for (let i = 0; i < ids.length; i += 500) {
          await supabase.from('transactions')
            .update({ expense_type: adding ? 'opex' : null })
            .in('id', ids.slice(i, i + 500))
        }
      }
    } catch (e) {
      setError(e.message || String(e))
    }
    setBusy(null)
  }

  const income = categories.filter(c => c.type === 'income')
  const expense = categories.filter(c => c.type === 'expense')
  const usingFallback = entity !== 'portfolio' && !entitiesWithOwn.has(entity) && included.size === 0

  return (
    <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h2 className="font-semibold text-slate-900">What counts in NOI</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Checked categories are operating income and expenses. Everything else is below the line or off the
          statement. Overview, the P&L, Deal Room, Debt &amp; Equity and Pro Forma all use this.
        </p>
      </div>
      <div className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium text-slate-500">Set up for</label>
          <select value={entity} onChange={e => setEntity(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900">
            <option value="portfolio">Portfolio default</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name}{entitiesWithOwn.has(c.id) ? ' (own selection)' : ''}</option>
            ))}
          </select>
          <span className="text-xs text-slate-400">{included.size} selected</span>
        </div>
        {usingFallback && (
          <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            This entity uses the portfolio default. Checking a category here gives it its own selection.
          </p>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CategoryList title="Income" items={income} included={included} busy={busy} isOwner={isOwner} onToggle={toggle} />
            <CategoryList title="Expenses" items={expense} included={included} busy={busy} isOwner={isOwner} onToggle={toggle} />
          </div>
        )}
        <p className="text-xs text-slate-400">
          To take a single transaction out of NOI, click its amount on the <Link href="/reports/pl" className="underline hover:text-slate-600">P&amp;L</Link> and record an adjustment with a reason.
        </p>
      </div>
    </section>
  )
}

function CategoryList({ title, items, included, busy, isOwner, onToggle }) {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{title}</span>
        <span className="text-xs text-slate-400">Statement line</span>
      </div>
      <div className="divide-y divide-slate-50">
        {items.map(c => {
          const on = included.has(c.id)
          const lineKey = on ? noiLineFor(c) : belowLineFor(c)
          const where = lineKey ? lineInfo(lineKey).label : 'Not on statement'
          return (
            <label key={c.id} className={`flex items-center gap-2 px-3 py-1.5 ${isOwner ? 'cursor-pointer hover:bg-slate-50' : ''}`}>
              <input type="checkbox" checked={on} disabled={!isOwner || busy === c.id} onChange={() => onToggle(c)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900" />
              <span className={`flex-1 text-sm ${on ? 'text-slate-800' : 'text-slate-400'}`}>{c.name}</span>
              <span className={`text-xs ${on ? 'text-slate-500' : lineKey ? 'text-slate-400 italic' : 'text-slate-300 italic'}`}>
                {where}{!on && lineKey ? ' (below NOI)' : ''}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
