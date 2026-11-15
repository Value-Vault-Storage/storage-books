'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { fetchAllRows } from '@/lib/fetchAll'
import {
  ACCOUNTS, ACCOUNT_GROUPS, accountInfo, accountFor, noiCategoryIdsFrom,
  loadAccountMap, saveAccountMap, totalsByAccount,
} from '@/lib/reports/accounts'
import { acct } from '@/lib/reports/statement'

// "Where each category goes": every category on either the income statement
// or a balance-sheet account. Nothing here edits transactions, and categories
// counted in NOI stay on the income statement, so existing reports don't move.
export default function AccountMapPanel({ categories, isOwner }) {
  const supabase = createClient()
  const [map, setMap] = useState({})
  const [noiIds, setNoiIds] = useState(new Set())
  const [txs, setTxs] = useState([])
  const [year, setYear] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showNoi, setShowNoi] = useState(false)
  const mapRef = useRef({})
  const saveChain = useRef(Promise.resolve())

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [m, { data: noiRows }, rows] = await Promise.all([
      loadAccountMap(supabase),
      supabase.from('bank_pl_categories').select('category_id'),
      fetchAllRows(() => supabase.from('transactions').select('id, category_id, amount, date').order('id')),
    ])
    mapRef.current = m
    setMap(m)
    setNoiIds(noiCategoryIdsFrom(noiRows))
    const latest = rows.reduce((y, t) => (t.date?.slice(0, 4) > y ? t.date.slice(0, 4) : y), '')
    setYear(latest || null)
    setTxs(rows)
    setLoading(false)
  }

  // Queue saves so two quick changes can't overwrite each other
  function choose(categoryId, account) {
    if (!isOwner) return
    const next = { ...mapRef.current, [categoryId]: account }
    mapRef.current = next
    setMap(next)
    setError('')
    saveChain.current = saveChain.current.then(async () => {
      const err = await saveAccountMap(supabase, mapRef.current)
      if (err) setError(err)
    })
  }

  const yearTxs = useMemo(() => (year ? txs.filter(t => t.date?.startsWith(year)) : []), [txs, year])
  const netByCat = useMemo(() => {
    const m = new Map()
    yearTxs.forEach(t => { if (t.category_id) m.set(t.category_id, (m.get(t.category_id) || 0) + (Number(t.amount) || 0)) })
    return m
  }, [yearTxs])
  const totals = useMemo(() => totalsByAccount(yearTxs, categories, map, noiIds), [yearTxs, categories, map, noiIds])
  const uncategorized = useMemo(() => {
    const u = yearTxs.filter(t => !t.category_id)
    return { count: u.length, net: u.reduce((s, t) => s + (Number(t.amount) || 0), 0) }
  }, [yearTxs])

  const rows = categories.map(c => ({ cat: c, ...accountFor(c, map, noiIds), net: netByCat.get(c.id) || 0 }))
  const noiRows = rows.filter(r => r.source === 'noi')
  const otherRows = rows.filter(r => r.source !== 'noi')
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.cat.name.localeCompare(b.cat.name))
  const suspense = totals.get('suspense')
  const toReview = otherRows.filter(r => r.account === 'suspense').length

  return (
    <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h2 className="font-semibold text-slate-900">Where each category goes</h2>
        <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
          For the balance sheet and cash flow statement, every category goes either to the income statement or to a
          balance-sheet account. Loan proceeds raise the loan, principal lowers it, a purchase adds to property, a
          payment to investors is a distribution. This doesn&apos;t change any transaction, and categories counted
          in <Link href="/settings?tab=noi" className="underline hover:text-slate-700">NOI</Link> always stay on the
          income statement, so the P&amp;L and NOI don&apos;t move.
        </p>
      </div>

      <div className="p-5 space-y-5">
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            <Summary totals={totals} year={year} />

            {(suspense?.count > 0) && (
              <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
                <strong>{acct(Math.abs(suspense.net), { dollar: true })}</strong> net across {suspense.count} transactions in {year} still needs classifying
                {toReview > 0 && <> ({toReview} {toReview === 1 ? 'category' : 'categories'} below)</>}
                {uncategorized.count > 0 && <>, including {uncategorized.count} uncategorized transactions</>}.
                The balance sheet can only tie once this is zero.
              </div>
            )}
            {error && <p className="text-xs text-red-600">Couldn&apos;t save: {error}</p>}

            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm table-fixed">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Category</th>
                    <th className="text-right font-medium px-3 py-2 w-32">Net cash {year}</th>
                    <th className="text-left font-medium px-3 py-2 w-72">Goes to</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {otherRows.map(r => (
                    <tr key={r.cat.id} className={r.account === 'suspense' ? 'bg-amber-50/40' : ''}>
                      <td className="px-3 py-1.5">
                        <div className="text-slate-800">{r.cat.name}</div>
                        <div className="text-xs text-slate-400">
                          {r.cat.type === 'income' ? 'Income' : 'Expense'} category
                          {r.source === 'default' && ' · suggested'}
                          {r.why && <span className="text-amber-700"> · {r.why}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{acct(r.net)}</td>
                      <td className="px-3 py-1.5">
                        <select value={r.account} disabled={!isOwner} onChange={e => choose(r.cat.id, e.target.value)}
                          className={`w-full border rounded-lg px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 ${r.source === 'default' ? 'border-dashed border-slate-300 text-slate-600' : 'border-slate-200 text-slate-900'}`}>
                          {ACCOUNT_GROUPS.map(g => (
                            <optgroup key={g} label={g}>
                              {ACCOUNTS.filter(a => a.group === g).map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <button onClick={() => setShowNoi(v => !v)} className="text-xs text-slate-500 hover:text-slate-800 underline">
                {showNoi ? 'Hide' : 'Show'} the {noiRows.length} categories counted in NOI (always on the income statement)
              </button>
              {showNoi && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-6 text-sm">
                  {noiRows.map(r => (
                    <div key={r.cat.id} className="flex justify-between py-1 border-b border-slate-50">
                      <span className="text-slate-600">{r.cat.name}</span>
                      <span className="tabular-nums text-slate-400">{acct(r.net)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="text-xs text-slate-400">
              Dashed boxes are suggestions; picking an account saves it. Amounts are cash in (+) and out (−) for {year}, all entities.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

function Summary({ totals, year }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      {ACCOUNT_GROUPS.map(g => {
        const keys = ACCOUNTS.filter(a => a.group === g).map(a => a.key)
        const items = keys.map(k => ({ k, t: totals.get(k) })).filter(x => x.t)
        const net = items.reduce((s, x) => s + x.t.net, 0)
        const warn = g === 'Needs classifying' && items.length > 0
        return (
          <div key={g} className={`rounded-lg border px-3 py-2 ${warn ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
            <div className="text-xs text-slate-500">{g}</div>
            <div className={`text-lg font-semibold tabular-nums ${warn ? 'text-amber-800' : 'text-slate-900'}`}>{acct(net, { dollar: true })}</div>
            <div className="text-xs text-slate-400">
              {items.length === 0 ? `Nothing in ${year}` : items.map(x => `${accountInfo(x.k).label.split(',')[0]} ${acct(x.t.net)}`).join(' · ')}
            </div>
          </div>
        )
      })}
    </div>
  )
}
