'use client'
import { useState, useEffect, useRef } from 'react'
import Papa from 'papaparse'
import { createClient } from '@/utils/supabase/client'
import { parseChase } from '@/lib/parsers/chase'
import { parseAmex } from '@/lib/parsers/amex'
import { parseSuncoast } from '@/lib/parsers/suncoast'
import { parseGoogleSheet } from '@/lib/parsers/googlesheet'
import { parseEasyStorage } from '@/lib/parsers/easystorage'
import { applyRules } from '@/lib/rules'
import SplitModal from '@/components/SplitModal'
import CategoryCombobox from '@/components/CategoryCombobox'

const PARSERS = {
  chase: parseChase,
  amex: parseAmex,
  suncoast_checking: (rows) => parseSuncoast(rows).map(r => ({ ...r, source: 'Suncoast Checking' })),
  suncoast_savings: (rows) => parseSuncoast(rows).map(r => ({ ...r, source: 'Suncoast Savings' })),
  googlesheet: (rows, categories, sheetType) => parseGoogleSheet(rows, categories, sheetType),
  easystorage: (rows) => parseEasyStorage(rows),
}

const SOURCE_LABELS = {
  chase: 'Chase Credit Card',
  amex: 'American Express',
  suncoast_checking: 'Suncoast Checking',
  suncoast_savings: 'Suncoast Savings',
  googlesheet: 'Google Sheet',
  easystorage: 'Easy Storage Solutions',
}

const SOURCE_DESCRIPTIONS = {
  chase: 'CC line items only — use for detailed P&L. Does not affect bank balance.',
  amex: 'CC line items only — use for detailed P&L. Does not affect bank balance.',
  suncoast_checking: 'Bank transactions — ties to monthly bank balance reconciliation.',
  suncoast_savings: 'Savings account transactions — ties to monthly balance.',
  googlesheet: 'Flexible import from a manually-maintained Google Sheet.',
  easystorage: 'Revenue and tenant data from Easy Storage Solutions.',
}

export default function ImportPage() {
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [rules, setRules] = useState([])
  const [companyId, setCompanyId] = useState('')
  const [source, setSource] = useState('suncoast_checking')
  const [sheetType, setSheetType] = useState('bank') // 'bank' | 'credit_card'
  const [rows, setRows] = useState([])
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [savedCount, setSavedCount] = useState(0)

  // Split state
  const [splittingRow, setSplittingRow] = useState(null)

  // New category modal state
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatType, setNewCatType] = useState('expense')

  // New rule modal state
  const [showAddRule, setShowAddRule] = useState(false)
  const [newRule, setNewRule] = useState({ keyword: '', match_type: 'contains', category_id: '', company_id: '' })

  // Bulk select state
  const [selected, setSelected] = useState(new Set())
  const [bulkCategory, setBulkCategory] = useState('')

  const fileRef = useRef()
  const supabase = createClient()

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const [{ data: co }, { data: cat }, { data: rul }] = await Promise.all([
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('categorization_rules').select('*').order('created_at'),
    ])
    setCompanies(co || [])
    setCategories(cat || [])
    setRules(rul || [])
  }

  async function addCategory(e) {
    e.preventDefault()
    if (!newCatName.trim()) return
    const { data, error } = await supabase.from('categories').insert({
      name: newCatName.trim(),
      type: newCatType,
      sort_order: 50,
    }).select().single()
    if (error) { alert('Error: ' + error.message); return }
    setNewCatName('')
    setShowAddCategory(false)
    await loadData()
    return data
  }

  // Called by CategoryCombobox when user types a name that doesn't exist yet
  // Defaults to 'expense' — user can change in Settings later if needed
  async function createCategoryInline(name) {
    const { data, error } = await supabase.from('categories').insert({
      name: name.trim(),
      type: 'expense',
      sort_order: 50,
    }).select().single()
    if (error) { alert('Error creating category: ' + error.message); return null }
    await loadData()
    return data
  }

  async function addRule(e) {
    e.preventDefault()
    if (!newRule.keyword.trim()) return
    const { error } = await supabase.from('categorization_rules').insert({
      keyword: newRule.keyword.trim(),
      match_type: newRule.match_type,
      category_id: newRule.category_id || null,
      company_id: newRule.company_id || null,
    })
    if (error) { alert('Error: ' + error.message); return }
    // Reload rules and re-apply to current rows
    const { data: updatedRules } = await supabase.from('categorization_rules').select('*').order('created_at')
    setRules(updatedRules || [])
    // Re-apply all rules to unmatched rows
    setRows(prev => applyRules(
      prev.map(r => ({ ...r, auto_matched: false })),
      updatedRules || [],
      companyId
    ))
    setNewRule({ keyword: '', match_type: 'contains', category_id: '', company_id: '' })
    setShowAddRule(false)
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const parser = PARSERS[source]
        if (!parser) return
        const parsed = parser(result.data, categories, sheetType)
        // Apply auto-categorization rules
        const withRules = applyRules(
          parsed.map(r => ({ ...r, skip: false })),
          rules,
          companyId
        )
        setRows(withRules)
        setSelected(new Set())
        setStep(2)
      },
    })
  }

  function updateRow(i, field, value) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }

  function toggleSkip(i) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, skip: !r.skip } : r))
  }

  // --- Selection helpers ---
  function toggleSelect(i) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(rows.map((_, i) => i).filter(i => !rows[i].skip)))
  }

  function selectUncategorized() {
    setSelected(new Set(
      rows.map((r, i) => i).filter(i => !rows[i].skip && !rows[i].category_id)
    ))
  }

  function clearSelection() {
    setSelected(new Set())
  }

  // --- Bulk apply ---
  function applyBulk() {
    if (!bulkCategory) return
    setRows(prev => prev.map((r, i) => {
      if (!selected.has(i)) return r
      return { ...r, category_id: bulkCategory }
    }))
    setSelected(new Set())
    setBulkCategory('')
  }

  async function saveTransactions() {
    if (!companyId) return
    setSaving(true)
    const toSave = rows
      .filter(r => !r.skip)
      .map(({ skip, auto_matched, sheet_category, manual, ...r }) => ({
        ...r,
        company_id: companyId,
        category_id: r.category_id || null,
        amount: r.amount !== '' && r.amount !== null && r.amount !== undefined ? parseFloat(r.amount) : null,
      }))
      .filter(r => r.amount !== null && !isNaN(r.amount))

    const { error } = await supabase.from('transactions').insert(toSave)
    setSaving(false)
    if (!error) {
      setSavedCount(toSave.length)
      setStep(3)
    } else {
      alert('Error saving: ' + error.message)
    }
  }

  function addManualRow() {
    const today = new Date().toISOString().slice(0, 10)
    setRows(prev => [...prev, {
      date: today,
      description: '',
      original_description: '',
      amount: '',
      source: 'manual',
      source_type: 'bank',
      is_autopayment: false,
      category_id: '',
      skip: false,
      manual: true,
    }])
  }

  function handleSplitConfirm(originalIndex, splitRows) {
    setRows(prev => {
      const next = [...prev]
      next.splice(originalIndex, 1, ...splitRows)
      return next
    })
    setSplittingRow(null)
  }

  function reset() {
    setRows([])
    setStep(1)
    setCompanyId('')
    setSavedCount(0)
    setSelected(new Set())
    setSplittingRow(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const incomeCategories = categories.filter(c => c.type === 'income')
  const expenseCategories = categories.filter(c => c.type === 'expense')
  const unskipped = rows.filter(r => !r.skip)
  const autoMatched = rows.filter(r => r.auto_matched && !r.skip).length

  // ── Step 1: Upload ──────────────────────────────────────────────
  if (step === 1) {
    return (
      <div className="p-8 max-w-xl">
        <h1 className="text-xl font-bold text-slate-900 mb-1">Import Transactions</h1>
        <p className="text-slate-500 text-sm mb-6">Upload a CSV from your bank or credit card</p>

        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Entity</label>
            <select
              value={companyId}
              onChange={e => setCompanyId(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <option value="" disabled>Select entity...</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {companies.length > 0 && !companyId && (
              <p className="text-xs text-slate-400 mt-1">Choose an entity before uploading a file.</p>
            )}
            {companies.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">No companies found. Add them in Settings first.</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Source</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(SOURCE_LABELS).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setSource(val)}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium text-left transition-colors ${
                    source === val
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                  }`}
                >
                  <span className="block">{label}</span>
                  {SOURCE_DESCRIPTIONS[val] && (
                    <span className={`block text-xs font-normal mt-0.5 ${source === val ? 'text-slate-300' : 'text-slate-400'}`}>
                      {SOURCE_DESCRIPTIONS[val]}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {source === 'googlesheet' && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-slate-400">Export via File → Download → Comma Separated Values (.csv)</p>
                <div>
                  <p className="text-xs font-medium text-slate-600 mb-1.5">Sheet type</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setSheetType('bank')}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium text-left transition-colors ${
                        sheetType === 'bank'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                      }`}
                    >
                      <span className="block font-semibold">Bank-level</span>
                      <span className={`block mt-0.5 ${sheetType === 'bank' ? 'text-slate-300' : 'text-slate-400'}`}>
                        Cash basis — ties to bank balances. Includes Amex as a lump-sum payment.
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSheetType('credit_card')}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium text-left transition-colors ${
                        sheetType === 'credit_card'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                      }`}
                    >
                      <span className="block font-semibold">CC detail</span>
                      <span className={`block mt-0.5 ${sheetType === 'credit_card' ? 'text-slate-300' : 'text-slate-400'}`}>
                        Accrual basis — individual Amex line items for detailed P&L.
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">CSV File</label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              onChange={handleFile}
              disabled={!companyId}
              className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-slate-900 file:text-white file:text-sm file:cursor-pointer disabled:opacity-50"
            />
          </div>

          {rules.length > 0 && (
            <p className="text-xs text-slate-400">
              {rules.length} auto-categorization rule{rules.length !== 1 ? 's' : ''} will be applied on upload.
            </p>
          )}
        </div>
      </div>
    )
  }

  // ── Step 3: Done ────────────────────────────────────────────────
  if (step === 3) {
    return (
      <div className="p-8 max-w-xl">
        <div className="bg-white rounded-xl border border-emerald-200 p-8 text-center">
          <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-slate-900 mb-1">Import Complete</h2>
          <p className="text-slate-500 text-sm">{savedCount} transactions saved</p>
          <button onClick={reset} className="mt-6 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg hover:bg-slate-800">
            Import another file
          </button>
        </div>
      </div>
    )
  }

  // ── Step 2: Review ──────────────────────────────────────────────
  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Review Transactions</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {unskipped.length} of {rows.length} transactions from {SOURCE_LABELS[source]}
            {' → '}<span className="font-medium text-slate-700">{companies.find(c => c.id === companyId)?.name}</span>
            {autoMatched > 0 && (
              <span className="ml-2 text-emerald-600 font-medium">· {autoMatched} auto-categorized</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={reset} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={saveTransactions}
            disabled={saving || unskipped.length === 0 || !companyId}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? 'Saving...' : `Save ${unskipped.length} transactions`}
          </button>
        </div>
      </div>

      {/* Bulk action toolbar */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-3">
        {/* Add category shortcut */}
        <button
          onClick={() => setShowAddCategory(true)}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700 flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New category
        </button>

        {/* Add rule shortcut */}
        <button
          onClick={() => setShowAddRule(true)}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700 flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New rule
        </button>

        <div className="h-4 w-px bg-slate-200" />

        {/* Selection controls */}
        <div className="flex gap-2">
          <button
            onClick={selectAll}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            Select all
          </button>
          <button
            onClick={selectUncategorized}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            Select uncategorized
          </button>
          {selected.size > 0 && (
            <button
              onClick={clearSelection}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              Clear ({selected.size})
            </button>
          )}
        </div>

        {/* Bulk apply — only visible when rows are selected */}
        {selected.size > 0 && (
          <>
            <div className="h-4 w-px bg-slate-200" />
            <span className="text-xs font-medium text-slate-700">{selected.size} selected —</span>
            <select
              value={bulkCategory}
              onChange={e => setBulkCategory(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900"
            >
              <option value="">Set category...</option>
              <optgroup label="Income">
                {incomeCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
              <optgroup label="Expenses">
                {expenseCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            </select>
            <button
              onClick={applyBulk}
              disabled={!bulkCategory}
              className="text-xs px-3 py-1.5 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40"
            >
              Apply to selected
            </button>
          </>
        )}
      </div>

      {/* Add rule modal */}
      {showAddRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-sm mx-4">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900 text-sm">Add Auto-Categorization Rule</h3>
              <button onClick={() => setShowAddRule(false)} className="text-slate-400 hover:text-slate-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={addRule} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Keyword(s)</label>
                <input
                  autoFocus
                  value={newRule.keyword}
                  onChange={e => setNewRule(p => ({ ...p, keyword: e.target.value }))}
                  placeholder="e.g. MARATHON, CIRCLE K, BP#"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <p className="text-xs text-slate-400 mt-1">Separate multiple keywords with commas</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Match Type</label>
                <select value={newRule.match_type} onChange={e => setNewRule(p => ({ ...p, match_type: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="contains">Contains</option>
                  <option value="starts_with">Starts with</option>
                  <option value="exact">Exact match</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Category (optional)</label>
                <select value={newRule.category_id} onChange={e => setNewRule(p => ({ ...p, category_id: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">— None —</option>
                  <optgroup label="Income">
                    {incomeCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                  <optgroup label="Expenses">
                    {expenseCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Facility (optional)</label>
                <select value={newRule.company_id} onChange={e => setNewRule(p => ({ ...p, company_id: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">All Facilities</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={!newRule.keyword.trim()}
                  className="flex-1 bg-slate-900 text-white text-sm py-2 rounded-lg hover:bg-slate-800 disabled:opacity-40">
                  Save &amp; Apply
                </button>
                <button type="button" onClick={() => setShowAddRule(false)}
                  className="px-4 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add category modal */}
      {showAddCategory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-sm mx-4">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900 text-sm">Add Category</h3>
              <button onClick={() => setShowAddCategory(false)} className="text-slate-400 hover:text-slate-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={addCategory} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Category Name</label>
                <input
                  autoFocus
                  value={newCatName}
                  onChange={e => setNewCatName(e.target.value)}
                  placeholder="e.g. Pest Control"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setNewCatType('expense')}
                    className={`flex-1 py-1.5 text-sm rounded-lg border font-medium transition-colors ${newCatType === 'expense' ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                    Expense
                  </button>
                  <button type="button" onClick={() => setNewCatType('income')}
                    className={`flex-1 py-1.5 text-sm rounded-lg border font-medium transition-colors ${newCatType === 'income' ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                    Income
                  </button>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={!newCatName.trim()}
                  className="flex-1 bg-slate-900 text-white text-sm py-2 rounded-lg hover:bg-slate-800 disabled:opacity-40">
                  Add Category
                </button>
                <button type="button" onClick={() => setShowAddCategory(false)}
                  className="px-4 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Split modal */}
      {splittingRow !== null && (
        <SplitModal
          transaction={rows[splittingRow]}
          categories={categories}
          onConfirm={(splitRows) => handleSplitConfirm(splittingRow, splitRows)}
          onClose={() => setSplittingRow(null)}
        />
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50">
              <th className="px-3 py-2.5 w-8">
                <input
                  type="checkbox"
                  checked={selected.size === unskipped.length && unskipped.length > 0}
                  onChange={e => e.target.checked ? selectAll() : clearSelection()}
                  className="rounded border-slate-300"
                />
              </th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider w-8"></th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Description</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Amount</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Category</th>
              <th className="px-3 py-2.5 w-12"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((row, i) => (
              <tr
                key={i}
                className={`${row.skip ? 'opacity-30' : ''} ${selected.has(i) ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
              >
                {/* Checkbox */}
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    disabled={row.skip}
                    onChange={() => toggleSelect(i)}
                    className="rounded border-slate-300"
                  />
                </td>

                {/* Auto-match badge */}
                <td className="px-1 py-2">
                  {row.auto_matched && !row.skip && (
                    <span title="Auto-categorized by rule" className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">
                      Auto
                    </span>
                  )}
                  {row.is_autopayment && (
                    <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-medium">
                      Pay
                    </span>
                  )}
                </td>

                <td className="px-3 py-2">
                  {row.manual ? (
                    <input
                      type="date"
                      value={row.date}
                      onChange={e => updateRow(i, 'date', e.target.value)}
                      className="border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900"
                    />
                  ) : (
                    <span className="text-slate-600 whitespace-nowrap">{row.date}</span>
                  )}
                </td>
                <td className="px-3 py-2 max-w-xs">
                  {row.manual ? (
                    <input
                      value={row.description}
                      onChange={e => updateRow(i, 'description', e.target.value)}
                      placeholder="Description"
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900"
                    />
                  ) : (
                    <div>
                      <span className="text-slate-800 truncate block">{row.description}</span>
                      {row.sheet_category && row.sheet_category !== row.description && (
                        <span className="text-xs text-slate-400">{row.sheet_category}</span>
                      )}
                    </div>
                  )}
                </td>

                <td className="px-3 py-2 text-right">
                  {row.manual ? (
                    <input
                      type="number"
                      step="0.01"
                      value={row.amount}
                      onChange={e => updateRow(i, 'amount', parseFloat(e.target.value) || '')}
                      placeholder="−0.00"
                      className="w-28 text-right border border-slate-200 rounded px-2 py-1 text-xs font-mono text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900"
                    />
                  ) : (
                    <span className={`font-mono font-medium whitespace-nowrap ${row.amount >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {row.amount >= 0 ? '+' : ''}{row.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                    </span>
                  )}
                </td>

                <td className="px-3 py-2">
                  {row.auto_matched && row.category_id ? (
                    // Auto-matched: show styled badge, still allow override via combobox
                    <div className={`rounded-lg px-1 py-0.5 border border-emerald-300 bg-emerald-50`}>
                      <CategoryCombobox
                        categories={categories}
                        value={row.category_id}
                        onChange={val => updateRow(i, 'category_id', val)}
                        onCreateCategory={createCategoryInline}
                        disabled={row.skip}
                      />
                    </div>
                  ) : (
                    <CategoryCombobox
                      categories={categories}
                      value={row.category_id}
                      onChange={val => updateRow(i, 'category_id', val)}
                      onCreateCategory={createCategoryInline}
                      disabled={row.skip}
                    />
                  )}
                </td>

                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => setSplittingRow(i)}
                      disabled={row.skip}
                      className="text-xs text-blue-500 hover:text-blue-700 transition-colors disabled:opacity-30"
                    >
                      Split
                    </button>
                    <button
                      onClick={() => toggleSkip(i)}
                      className="text-xs text-slate-400 hover:text-red-500 transition-colors"
                    >
                      {row.skip ? 'Include' : 'Skip'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Add manual row */}
        <button
          onClick={addManualRow}
          className="w-full py-2.5 text-sm text-slate-500 hover:text-slate-800 hover:bg-slate-50 border-t border-slate-100 flex items-center justify-center gap-1.5 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add manual entry
        </button>
      </div>
    </div>
  )
}
