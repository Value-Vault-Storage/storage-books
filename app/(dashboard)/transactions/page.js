'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import ExportCsvButton from '@/components/ExportCsvButton'
import { money, csvFilename } from '@/lib/exportCsv'
import CommentPanel from '@/components/CommentPanel'
import SplitModal from '@/components/SplitModal'
import { fetchAllRows } from '@/lib/fetchAll'


export default function TransactionsPage() {
  const [transactions, setTransactions] = useState([])
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [companyFilter, setCompanyFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Selection
  const [selected, setSelected] = useState(new Set())
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkCompany, setBulkCompany] = useState('')
  const [bulkSource, setBulkSource] = useState('')
  const [customBulkSource, setCustomBulkSource] = useState('')

  // Edit / comment state
  const [editingId, setEditingId] = useState(null)
  const [commentTxId, setCommentTxId] = useState(null)
  const [splittingTx, setSplittingTx] = useState(null)
  const [userRole, setUserRole] = useState(null)

  // Add transaction modal
  const [showAddModal, setShowAddModal] = useState(false)
  const [newTx, setNewTx] = useState({ date: '', description: '', amount: '', txType: 'expense', category_id: '', company_id: '', source: 'manual' })

  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [tx, { data: co }, { data: cat }, { data: src }, { data: roleData }] = await Promise.all([
      fetchAllRows(() => supabase.from('transactions').select('*, categories(name, type)').order('date', { ascending: false })),
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('sources').select('*').order('name'),
      supabase.from('user_roles').select('role').single(),
    ])
    setTransactions(tx)
    setCompanies(co || [])
    setCategories(cat || [])
    setSources(src || [])
    setUserRole(roleData?.role || 'viewer')
    setSelected(new Set())
    setLoading(false)
  }

  async function updateTransaction(id, updates) {
    await supabase.from('transactions').update(updates).eq('id', id)
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t))
  }

  async function deleteTransaction(id) {
    if (!confirm('Delete this transaction?')) return
    await supabase.from('transactions').delete().eq('id', id)
    setTransactions(prev => prev.filter(t => t.id !== id))
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  // ── Bulk actions ────────────────────────────────────────────────
  function toggleSelect(id) {
    setSelected(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  function selectAll() {
    setSelected(new Set(filtered.map(t => t.id)))
  }

  function clearSelection() {
    setSelected(new Set())
  }

  async function handleSplitConfirm(original, splitRows) {
    // Delete original, insert splits
    await supabase.from('transactions').delete().eq('id', original.id)
    const toInsert = splitRows.map(({ id, categories, auto_matched, ...r }) => r)
    await supabase.from('transactions').insert(toInsert)
    setSplittingTx(null)
    await loadAll()
  }

  async function bulkDelete() {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} transaction${selected.size !== 1 ? 's' : ''}? This cannot be undone.`)) return
    const ids = [...selected]
    await supabase.from('transactions').delete().in('id', ids)
    setTransactions(prev => prev.filter(t => !ids.includes(t.id)))
    setSelected(new Set())
  }

  async function bulkApply() {
    const resolvedSource = bulkSource === '__custom__' ? customBulkSource.trim() : bulkSource
    if (selected.size === 0 || (!bulkCategory && !resolvedSource && !bulkCompany)) return

    // Reassigning entity moves transactions across every report — confirm first
    if (bulkCompany) {
      const target = companies.find(c => c.id === bulkCompany)?.name || 'the selected entity'
      if (!confirm(`Move ${selected.size} transaction${selected.size !== 1 ? 's' : ''} to ${target}?`)) return
    }

    const ids = [...selected]
    const updates = {}
    if (bulkCategory) updates.category_id = bulkCategory
    if (resolvedSource) updates.source = resolvedSource
    if (bulkCompany) updates.company_id = bulkCompany

    const { error } = await supabase.from('transactions').update(updates).in('id', ids)
    if (error) { alert('Error applying changes: ' + error.message); return }

    setSelected(new Set())
    setBulkCategory('')
    setBulkCompany('')
    setBulkSource('')
    setCustomBulkSource('')
    await loadAll()
  }

  async function saveNewTransaction() {
    if (!newTx.date || !newTx.description || !newTx.amount || !newTx.company_id) return
    const amount = newTx.txType === 'expense'
      ? -Math.abs(parseFloat(newTx.amount))
      : Math.abs(parseFloat(newTx.amount))
    const { error } = await supabase.from('transactions').insert({
      date: newTx.date,
      description: newTx.description,
      original_description: newTx.description,
      amount,
      source: newTx.source || 'manual',
      source_type: 'bank',
      is_autopayment: false,
      category_id: newTx.category_id || null,
      company_id: newTx.company_id,
    })
    if (error) { alert('Error: ' + error.message); return }
    setShowAddModal(false)
    setNewTx({ date: '', description: '', amount: '', txType: 'expense', category_id: '', company_id: '', source: 'manual' })
    await loadAll()
  }

  const uncategorizedCount = transactions.filter(t => !t.category_id).length

  const filtered = transactions.filter(t => {
    if (companyFilter !== 'all' && t.company_id !== companyFilter) return false
    if (sourceFilter !== 'all' && t.source !== sourceFilter) return false
    if (categoryFilter === '__uncategorized__') { if (t.category_id) return false }
    else if (categoryFilter !== 'all' && t.category_id !== categoryFilter) return false
    if (dateFrom && t.date < dateFrom) return false
    if (dateTo && t.date > dateTo) return false
    if (search && !t.description?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const isOwner = userRole === 'owner'
  const incomeCategories = categories.filter(c => c.type === 'income')
  const expenseCategories = categories.filter(c => c.type === 'expense')
  const allSelected = filtered.length > 0 && filtered.every(t => selected.has(t.id))

  // Sources from DB — managed in Settings
  const allSources = sources.map(s => s.name)

  const resolvedBulkSource = bulkSource === '__custom__' ? customBulkSource.trim() : bulkSource
  const canApplyBulk = selected.size > 0 && (!!bulkCategory || !!resolvedBulkSource || !!bulkCompany)

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-slate-900">Transactions</h1>
        <div className="flex items-center gap-3">
          {uncategorizedCount > 0 && (
            <button
              onClick={() => setCategoryFilter(categoryFilter === '__uncategorized__' ? 'all' : '__uncategorized__')}
              className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                categoryFilter === '__uncategorized__'
                  ? 'bg-amber-500 text-white border-amber-500'
                  : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${categoryFilter === '__uncategorized__' ? 'bg-white' : 'bg-amber-500'}`} />
              {uncategorizedCount} uncategorized
            </button>
          )}
          <span className="text-sm text-slate-500">{filtered.length} transactions</span>
          <ExportCsvButton
            filename={() => csvFilename('transactions', dateFrom, dateTo, new Date().toISOString().slice(0, 10))}
            getRows={() => [
              ['Date', 'Description', 'Entity', 'Category', 'Category Type', 'Source', 'Source Type', 'Expense Type', 'Amount', 'Notes'],
              ...filtered.map(t => [
                t.date, t.description || '', companies.find(c => c.id === t.company_id)?.name || '',
                t.categories?.name || 'Uncategorized', t.categories?.type || '', t.source || '', t.source_type || '',
                t.expense_type || '', money(t.amount), t.notes || '',
              ]),
            ]}
          />
          {isOwner && (
            <button onClick={() => { setNewTx(p => ({ ...p, company_id: companies[0]?.id || '' })); setShowAddModal(true) }}
              className="bg-slate-900 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-slate-700">
              + Add Transaction
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3 flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search description..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-48"
        />
        <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
          <option value="all">All Entities</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
          <option value="all">All Sources</option>
          {allSources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
          <option value="all">All Categories</option>
          <option value="__uncategorized__">⚠ Uncategorized only</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
        <span className="self-center text-slate-400 text-sm">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
        {(companyFilter !== 'all' || sourceFilter !== 'all' || categoryFilter !== 'all' || search || dateFrom || dateTo) && (
          <button onClick={() => { setCompanyFilter('all'); setSourceFilter('all'); setCategoryFilter('all'); setSearch(''); setDateFrom(''); setDateTo('') }}
            className="text-sm text-slate-500 hover:text-slate-800 underline">
            Clear filters
          </button>
        )}
        {categoryFilter === '__uncategorized__' && (
          <span className="text-xs text-amber-600 font-medium">Showing {filtered.length} uncategorized</span>
        )}
      </div>

      {/* Bulk action bar */}
      {isOwner && (
        <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-2">
            <button onClick={allSelected ? clearSelection : selectAll}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
            {selected.size > 0 && (
              <button onClick={clearSelection}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
                Clear ({selected.size})
              </button>
            )}
          </div>

          {selected.size > 0 && (
            <>
              <div className="h-4 w-px bg-slate-200" />
              <span className="text-xs font-medium text-slate-700">{selected.size} selected —</span>

              {/* Bulk reassign entity */}
              <select value={bulkCompany} onChange={e => setBulkCompany(e.target.value)}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900">
                <option value="">Move to entity...</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>

              {/* Bulk categorize */}
              <select value={bulkCategory} onChange={e => setBulkCategory(e.target.value)}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900">
                <option value="">Set category...</option>
                <optgroup label="Income">
                  {incomeCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
                <optgroup label="Expenses">
                  {expenseCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              </select>
              {/* Bulk source */}
              <select value={bulkSource} onChange={e => { setBulkSource(e.target.value); setCustomBulkSource('') }}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900">
                <option value="">Set source...</option>
                {allSources.map(s => <option key={s} value={s}>{s}</option>)}
                <option value="__custom__">+ New source...</option>
              </select>
              {bulkSource === '__custom__' && (
                <input
                  type="text"
                  value={customBulkSource}
                  onChange={e => setCustomBulkSource(e.target.value)}
                  placeholder="Enter source name"
                  autoFocus
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900 w-36"
                />
              )}

              <button onClick={bulkApply} disabled={!canApplyBulk}
                className="text-xs px-3 py-1.5 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40">
                Apply
              </button>

              <div className="h-4 w-px bg-slate-200" />

              {/* Bulk delete */}
              <button onClick={bulkDelete}
                className="text-xs px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700">
                Delete {selected.size}
              </button>
            </>
          )}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-slate-400 text-sm">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-400 text-sm">No transactions found</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-2.5 w-8">
                  <input type="checkbox" checked={allSelected} onChange={e => e.target.checked ? selectAll() : clearSelection()}
                    className="rounded border-slate-300" />
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Description</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Entity</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Category</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Source</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Amount</th>
                <th className="px-4 py-2.5 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map(t => {
                const company = companies.find(c => c.id === t.company_id)
                const editing = editingId === t.id
                const isSelected = selected.has(t.id)
                return (
                  <tr key={t.id} className={`group ${isSelected ? 'bg-blue-50' : !t.category_id ? 'bg-amber-50/40 hover:bg-amber-50' : 'hover:bg-slate-50'}`}>
                    <td className="px-4 py-2.5">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(t.id)}
                        className="rounded border-slate-300" />
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{t.date}</td>
                    <td className="px-4 py-2.5 text-slate-800 max-w-xs">
                      {editing ? (
                        <input defaultValue={t.description}
                          onBlur={e => updateTransaction(t.id, { description: e.target.value })}
                          autoFocus
                          className="border border-slate-300 rounded px-2 py-0.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-slate-900" />
                      ) : (
                        <span className="truncate block max-w-xs">{t.description}</span>
                      )}
                      {t.is_autopayment && <span className="text-xs text-slate-400 ml-1">(autopay)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 text-xs">{company?.name || '—'}</td>
                    <td className="px-4 py-2.5">
                      {isOwner ? (
                        <select value={t.category_id || ''} onChange={e => updateTransaction(t.id, { category_id: e.target.value || null })}
                          className="border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900 max-w-40">
                          <option value="">Uncategorized</option>
                          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      ) : (
                        <span className="text-xs text-slate-600">{t.categories?.name || 'Uncategorized'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded capitalize">
                        {t.source || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {editing ? (
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={parseFloat(t.amount)}
                          onBlur={e => {
                            const val = parseFloat(e.target.value)
                            if (!isNaN(val)) updateTransaction(t.id, { amount: val })
                          }}
                          className="border border-slate-300 rounded px-2 py-0.5 text-sm w-28 text-right font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                        />
                      ) : (
                        <span className={`font-mono font-medium whitespace-nowrap ${parseFloat(t.amount) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {parseFloat(t.amount) >= 0 ? '+' : ''}{parseFloat(t.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setCommentTxId(t.id)} className="p-1 text-slate-400 hover:text-slate-700 rounded" title="Comments">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                        </button>
                        {isOwner && (
                          <>
                            <button onClick={() => setSplittingTx(t)} className="p-1 text-slate-400 hover:text-blue-500 rounded" title="Split">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                              </svg>
                            </button>
                        <button onClick={() => setEditingId(editing ? null : t.id)} className="p-1 text-slate-400 hover:text-slate-700 rounded" title="Edit">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button onClick={() => deleteTransaction(t.id)} className="p-1 text-slate-400 hover:text-red-500 rounded" title="Delete">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {commentTxId && <CommentPanel transactionId={commentTxId} onClose={() => setCommentTxId(null)} />}

      {splittingTx && (
        <SplitModal
          transaction={splittingTx}
          categories={categories}
          onConfirm={(splitRows) => handleSplitConfirm(splittingTx, splitRows)}
          onClose={() => setSplittingTx(null)}
        />
      )}

      {/* Add Transaction Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-5">Add Transaction</h2>

            {/* Income / Expense toggle */}
            <div className="flex rounded-lg border border-slate-200 overflow-hidden mb-4">
              {['expense', 'income'].map(type => (
                <button key={type} onClick={() => setNewTx(p => ({ ...p, txType: type, category_id: '' }))}
                  className={`flex-1 py-2 text-sm font-medium capitalize ${newTx.txType === type ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                  {type}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Date</label>
                  <input type="date" value={newTx.date} onChange={e => setNewTx(p => ({ ...p, date: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Amount ($)</label>
                  <input type="number" min="0" step="0.01" placeholder="0.00" value={newTx.amount}
                    onChange={e => setNewTx(p => ({ ...p, amount: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                <input type="text" placeholder="e.g. Office supplies" value={newTx.description}
                  onChange={e => setNewTx(p => ({ ...p, description: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Entity</label>
                <select value={newTx.company_id} onChange={e => setNewTx(p => ({ ...p, company_id: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">Select entity...</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Category</label>
                <select value={newTx.category_id} onChange={e => setNewTx(p => ({ ...p, category_id: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">No category</option>
                  {(newTx.txType === 'income' ? incomeCategories : expenseCategories).map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Source</label>
                <select value={newTx.source} onChange={e => setNewTx(p => ({ ...p, source: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  {allSources.map(s => <option key={s} value={s}>{s}</option>)}
                  <option value="__custom__">+ New source...</option>
                </select>
                {newTx.source === '__custom__' && (
                  <input
                    type="text"
                    placeholder="Enter source name"
                    autoFocus
                    onChange={e => setNewTx(p => ({ ...p, source: e.target.value }))}
                    className="w-full mt-2 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                )}
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowAddModal(false)}
                className="flex-1 border border-slate-200 text-slate-700 text-sm font-medium py-2 rounded-lg hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={saveNewTransaction}
                disabled={!newTx.date || !newTx.description || !newTx.amount || !newTx.company_id}
                className="flex-1 bg-slate-900 text-white text-sm font-medium py-2 rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed">
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
