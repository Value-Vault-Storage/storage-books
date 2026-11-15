'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import NoiCategoriesPanel from '@/components/settings/NoiCategoriesPanel'
import AccountMapPanel from '@/components/settings/AccountMapPanel'

const MATCH_TYPE_LABELS = { contains: 'Contains', starts_with: 'Starts with', exact: 'Exact match' }

const TABS = [
  { id: 'accounts', label: 'Chart of Accounts' },
  { id: 'noi', label: 'What Counts in NOI' },
  { id: 'map', label: 'Where Categories Go' },
  { id: 'rules', label: 'Auto-Categorization' },
  { id: 'sources', label: 'Transaction Sources' },
  { id: 'entities', label: 'Companies / Entities' },
  { id: 'branding', label: 'Report Branding' },
  { id: 'account', label: 'Account' },
]

export default function SettingsPage() {
  const [companies, setCompanies] = useState([])
  const [categories, setCategories] = useState([])
  const [rules, setRules] = useState([])
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState(null)
  const [currentUser, setCurrentUser] = useState(null)
  const [activeTab, setActiveTab] = useState('accounts')

  const [newCompany, setNewCompany] = useState('')
  const [newCategory, setNewCategory] = useState({ name: '', type: 'expense' })
  const [newRule, setNewRule] = useState({ keyword: '', category_id: '', match_type: 'contains', company_id: '' })
  const [editingRuleId, setEditingRuleId] = useState(null)
  const [editingRule, setEditingRule] = useState(null)

  // Sources state
  const [newSource, setNewSource] = useState('')
  const [renamingSourceId, setRenamingSourceId] = useState(null)
  const [renameValue, setRenameValue] = useState('')

  // Report branding
  const [reportName, setReportName] = useState('')
  const [reportSubtitle, setReportSubtitle] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [brandingSaved, setBrandingSaved] = useState(false)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState(null)

  const supabase = createClient()

  useEffect(() => {
    loadAll()
    // Deep link: /settings?tab=noi
    const tab = new URLSearchParams(window.location.search).get('tab')
    if (TABS.some(t => t.id === tab)) setActiveTab(tab)
  }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: co }, { data: cat }, { data: rul }, { data: src }, { data: role }, { data: { user } }, { data: branding }] = await Promise.all([
      supabase.from('companies').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('categorization_rules').select('*, categories(name)').order('created_at'),
      supabase.from('sources').select('*').order('name'),
      supabase.from('user_roles').select('role').single(),
      supabase.auth.getUser(),
      supabase.from('report_settings').select('*'),
    ])
    setCompanies(co || [])
    setCategories(cat || [])
    setRules(rul || [])
    setSources(src || [])
    setUserRole(role?.role || null)
    setCurrentUser(user)
    if (branding) {
      const kv = Object.fromEntries(branding.map(r => [r.key, r.value]))
      setReportName(kv.report_name || '')
      setReportSubtitle(kv.report_subtitle || '')
      setLogoUrl(kv.logo_url || '')
    }
    setLoading(false)
  }

  // ── Sources ──────────────────────────────────────────────────────
  async function addSource(e) {
    e.preventDefault()
    if (!newSource.trim()) return
    const { error } = await supabase.from('sources').insert({ name: newSource.trim() })
    if (error) { alert('Error: ' + error.message); return }
    setNewSource('')
    await loadAll()
  }

  async function renameSource(id, oldName) {
    const trimmed = renameValue.trim()
    if (!trimmed || trimmed === oldName) { setRenamingSourceId(null); return }
    // Update source record
    const { error } = await supabase.from('sources').update({ name: trimmed }).eq('id', id)
    if (error) { alert('Error: ' + error.message); return }
    // Cascade rename to transactions and accounts
    await Promise.all([
      supabase.from('transactions').update({ source: trimmed }).eq('source', oldName),
      supabase.from('accounts').update({ source: trimmed }).eq('source', oldName),
    ])
    setRenamingSourceId(null)
    await loadAll()
  }

  async function deleteSource(id, name) {
    // Check if in use
    const [{ count: txCount }, { count: accCount }] = await Promise.all([
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('source', name),
      supabase.from('accounts').select('id', { count: 'exact', head: true }).eq('source', name),
    ])
    const total = (txCount || 0) + (accCount || 0)
    const warning = total > 0
      ? `\n\nWarning: ${txCount || 0} transaction(s) and ${accCount || 0} account(s) use this source. They will keep the source name but it won't appear in dropdowns.`
      : ''
    if (!confirm(`Delete source "${name}"?${warning}`)) return
    await supabase.from('sources').delete().eq('id', id)
    await loadAll()
  }

  // ── Report Branding ──────────────────────────────────────────────
  async function saveBrandingField(key, value) {
    const { error } = await supabase
      .from('report_settings')
      .upsert({ key, value }, { onConflict: 'key' })
    if (error) throw error
  }

  async function saveBranding(e) {
    e.preventDefault()
    try {
      await Promise.all([
        saveBrandingField('report_name', reportName),
        saveBrandingField('report_subtitle', reportSubtitle),
      ])
      setBrandingSaved(true)
      setTimeout(() => setBrandingSaved(false), 2500)
    } catch (err) {
      alert('Error saving: ' + err.message)
    }
  }

  async function uploadLogo(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoUploading(true)
    setLogoError(null)
    const ext = file.name.split('.').pop()
    const path = `logo.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('report-assets')
      .upload(path, file, { upsert: true, contentType: file.type })
    if (uploadError) {
      setLogoError(uploadError.message)
      setLogoUploading(false)
      return
    }
    const { data: { publicUrl } } = supabase.storage.from('report-assets').getPublicUrl(path)
    // Append cache-bust to force image refresh
    const urlWithBust = `${publicUrl}?t=${Date.now()}`
    await saveBrandingField('logo_url', publicUrl)
    setLogoUrl(urlWithBust)
    setLogoUploading(false)
  }

  async function removeLogo() {
    await saveBrandingField('logo_url', '')
    setLogoUrl('')
  }

  const isOwner = userRole === 'owner'

  async function addCompany(e) {
    e.preventDefault()
    if (!newCompany.trim()) return
    const { error } = await supabase.from('companies').insert({ name: newCompany.trim() })
    if (error) { alert('Error adding entity: ' + error.message); return }
    setNewCompany('')
    await loadAll()
  }

  async function deleteCompany(id) {
    if (!confirm('Delete this company? All associated transactions will also be deleted.')) return
    const { error } = await supabase.from('companies').delete().eq('id', id)
    if (error) { alert('Error deleting entity: ' + error.message); return }
    await loadAll()
  }

  async function addCategory(e) {
    e.preventDefault()
    if (!newCategory.name.trim()) return
    const { error } = await supabase.from('categories').insert({ name: newCategory.name.trim(), type: newCategory.type, sort_order: 50 })
    if (error) {
      alert(error.code === '23505'
        ? `A category named "${newCategory.name.trim()}" already exists.`
        : 'Error adding category: ' + error.message)
      return
    }
    setNewCategory({ name: '', type: 'expense' })
    await loadAll()
  }

  async function deleteCategory(id) {
    if (!confirm('Delete this category?')) return
    const { error } = await supabase.from('categories').delete().eq('id', id)
    if (error) {
      alert(error.code === '23503'
        ? 'This category is still assigned to transactions and can’t be deleted. Reassign those transactions first.'
        : 'Error deleting category: ' + error.message)
      return
    }
    await loadAll()
  }

  // Reclassify a category between income and expense (moves it on the P&L).
  async function setCategoryType(id, type) {
    const { error } = await supabase.from('categories').update({ type }).eq('id', id)
    if (error) { alert('Error updating category: ' + error.message); return }
    await loadAll()
  }

  async function addRule(e) {
    e.preventDefault()
    if (!newRule.keyword.trim()) return
    const { error } = await supabase.from('categorization_rules').insert({
      keyword: newRule.keyword.trim(),
      category_id: newRule.category_id || null,
      match_type: newRule.match_type,
      company_id: newRule.company_id || null,
    })
    if (error) { alert('Error: ' + error.message); return }
    setNewRule({ keyword: '', category_id: '', match_type: 'contains', company_id: '' })
    await loadAll()
  }

  async function deleteRule(id) {
    await supabase.from('categorization_rules').delete().eq('id', id)
    await loadAll()
  }

  function startEditRule(r) {
    setEditingRuleId(r.id)
    setEditingRule({
      keyword: r.keyword,
      match_type: r.match_type,
      category_id: r.category_id || '',
      company_id: r.company_id || '',
    })
  }

  async function saveEditRule(e) {
    e.preventDefault()
    const { error } = await supabase.from('categorization_rules').update({
      keyword: editingRule.keyword.trim(),
      match_type: editingRule.match_type,
      category_id: editingRule.category_id || null,
      company_id: editingRule.company_id || null,
    }).eq('id', editingRuleId)
    if (error) { alert('Error: ' + error.message); return }
    setEditingRuleId(null)
    setEditingRule(null)
    await loadAll()
  }

  async function claimOwner() {
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('user_roles').upsert({ user_id: user.id, role: 'owner' }, { onConflict: 'user_id' })
    if (error) { alert('Error claiming owner: ' + error.message); return }
    await loadAll()
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  const incomeCategories = categories.filter(c => c.type === 'income')
  const expenseCategories = categories.filter(c => c.type === 'expense')

  // Category dropdown options, reused in the rule builder + rule editor
  const categoryOptions = (
    <>
      <option value="">— None —</option>
      <optgroup label="Income">
        {incomeCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </optgroup>
      <optgroup label="Expenses">
        {expenseCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </optgroup>
    </>
  )

  const selectCls = 'border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900'

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-xl font-bold text-slate-900 mb-6">Settings</h1>

      {/* Role setup */}
      {!userRole && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-6">
          <h3 className="font-semibold text-amber-900 mb-1">First-time setup</h3>
          <p className="text-sm text-amber-700 mb-3">No role assigned. Claim owner access to manage this workspace.</p>
          <button onClick={claimOwner} className="bg-amber-700 text-white text-sm px-4 py-2 rounded-lg hover:bg-amber-800">
            Claim Owner Access
          </button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-6 items-start">
        {/* Tab navigation */}
        <nav className="sm:w-56 flex-shrink-0 w-full">
          <div className="flex sm:flex-col gap-1 overflow-x-auto sm:sticky sm:top-8">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`text-left px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  activeTab === t.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Active panel */}
        <div className="flex-1 min-w-0 w-full">

          {/* ── Chart of Accounts ─────────────────────────────────── */}
          {activeTab === 'accounts' && (
            <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="font-semibold text-slate-900">Chart of Accounts</h2>
                <p className="text-xs text-slate-500 mt-0.5">Income and expense categories used across the app</p>
              </div>
              <div className="p-5 space-y-5">
                {isOwner && (
                  <form onSubmit={addCategory} className="flex flex-wrap items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden bg-white">
                      {['income', 'expense'].map(t => (
                        <button
                          type="button"
                          key={t}
                          onClick={() => setNewCategory(p => ({ ...p, type: t }))}
                          className={`px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                            newCategory.type === t
                              ? (t === 'income' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-white')
                              : 'text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <input
                      value={newCategory.name}
                      onChange={e => setNewCategory(p => ({ ...p, name: e.target.value }))}
                      placeholder="New category name"
                      className="flex-1 min-w-[12rem] border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                    <button type="submit" className="bg-slate-900 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-slate-800">Add</button>
                  </form>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <CategoryColumn title="Income" items={incomeCategories} isOwner={isOwner} onDelete={deleteCategory} onSetType={setCategoryType} />
                  <CategoryColumn title="Expenses" items={expenseCategories} isOwner={isOwner} onDelete={deleteCategory} onSetType={setCategoryType} />
                </div>
              </div>
            </section>
          )}

          {activeTab === 'noi' && (
            <NoiCategoriesPanel companies={companies} categories={categories} isOwner={isOwner} />
          )}

          {activeTab === 'map' && (
            <AccountMapPanel categories={categories} isOwner={isOwner} />
          )}

          {/* ── Auto-Categorization Rules ─────────────────────────── */}
          {activeTab === 'rules' && (
            <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="font-semibold text-slate-900">Auto-Categorization Rules</h2>
                <p className="text-xs text-slate-500 mt-0.5">Automatically categorize transactions on import by matching description keywords</p>
              </div>
              <div className="p-5 space-y-4">
                {isOwner && (
                  <form onSubmit={addRule} className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">New rule</p>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 leading-8">
                      <span>When a description</span>
                      <select value={newRule.match_type} onChange={e => setNewRule(p => ({ ...p, match_type: e.target.value }))} className={selectCls}>
                        <option value="contains">contains</option>
                        <option value="starts_with">starts with</option>
                        <option value="exact">exactly matches</option>
                      </select>
                      <input
                        value={newRule.keyword}
                        onChange={e => setNewRule(p => ({ ...p, keyword: e.target.value }))}
                        placeholder="e.g. PAYABLI"
                        className="min-w-[9rem] border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white font-mono focus:outline-none focus:ring-2 focus:ring-slate-900"
                      />
                      <span>for</span>
                      <select value={newRule.company_id} onChange={e => setNewRule(p => ({ ...p, company_id: e.target.value }))} className={selectCls}>
                        <option value="">all facilities</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <span>categorize as</span>
                      <select value={newRule.category_id} onChange={e => setNewRule(p => ({ ...p, category_id: e.target.value }))} className={selectCls}>
                        {categoryOptions}
                      </select>
                      <button type="submit" disabled={!newRule.keyword.trim()}
                        className="bg-slate-900 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-slate-800 disabled:opacity-40">
                        Add rule
                      </button>
                    </div>
                  </form>
                )}

                <div>
                  {rules.length === 0 && <p className="text-sm text-slate-400">No rules yet. Add one above.</p>}
                  <div className="divide-y divide-slate-50">
                    {rules.map(r => {
                      const scopedCompany = companies.find(c => c.id === r.company_id)
                      const isEditing = editingRuleId === r.id

                      if (isEditing && editingRule) {
                        return (
                          <form key={r.id} onSubmit={saveEditRule} className="bg-slate-50 rounded-lg p-4 my-2 border border-slate-200">
                            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 leading-8">
                              <span>When a description</span>
                              <select value={editingRule.match_type} onChange={e => setEditingRule(p => ({ ...p, match_type: e.target.value }))} className={selectCls}>
                                <option value="contains">contains</option>
                                <option value="starts_with">starts with</option>
                                <option value="exact">exactly matches</option>
                              </select>
                              <input
                                value={editingRule.keyword}
                                onChange={e => setEditingRule(p => ({ ...p, keyword: e.target.value }))}
                                className="min-w-[9rem] border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white font-mono focus:outline-none focus:ring-2 focus:ring-slate-900"
                              />
                              <span>for</span>
                              <select value={editingRule.company_id} onChange={e => setEditingRule(p => ({ ...p, company_id: e.target.value }))} className={selectCls}>
                                <option value="">all facilities</option>
                                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </select>
                              <span>categorize as</span>
                              <select value={editingRule.category_id} onChange={e => setEditingRule(p => ({ ...p, category_id: e.target.value }))} className={selectCls}>
                                {categoryOptions}
                              </select>
                            </div>
                            <div className="flex gap-2 mt-3">
                              <button type="submit" className="bg-slate-900 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800">Save</button>
                              <button type="button" onClick={() => { setEditingRuleId(null); setEditingRule(null) }}
                                className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
                            </div>
                          </form>
                        )
                      }

                      return (
                        <div key={r.id} className="flex items-center justify-between py-2 group">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-mono">{r.keyword}</span>
                            <span className="text-xs text-slate-400">{MATCH_TYPE_LABELS[r.match_type]}</span>
                            <span className="text-xs text-slate-300">→</span>
                            {r.categories
                              ? <span className="text-xs text-slate-700 font-medium">{r.categories.name}</span>
                              : <span className="text-xs text-slate-400 italic">no category</span>}
                            {scopedCompany ? (
                              <span className="text-xs bg-violet-50 text-violet-700 border border-violet-200 px-1.5 py-0.5 rounded font-medium">
                                {scopedCompany.name}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400 italic">All facilities</span>
                            )}
                          </div>
                          {isOwner && (
                            <div className="flex gap-3 ml-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => startEditRule(r)} className="text-xs text-slate-400 hover:text-slate-700">Edit</button>
                              <button onClick={() => deleteRule(r.id)} className="text-xs text-slate-400 hover:text-red-500">Delete</button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── Transaction Sources ───────────────────────────────── */}
          {activeTab === 'sources' && (
            <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="font-semibold text-slate-900">Transaction Sources</h2>
                <p className="text-xs text-slate-500 mt-0.5">Bank and credit card sources used across transactions, imports, and account reconciliation</p>
              </div>
              <div className="p-5 space-y-2">
                {sources.length === 0 && <p className="text-sm text-slate-400">No sources yet.</p>}
                {sources.map(s => (
                  <div key={s.id} className="flex items-center justify-between py-1 group">
                    {renamingSourceId === s.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={() => renameSource(s.id, s.name)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') renameSource(s.id, s.name)
                          if (e.key === 'Escape') setRenamingSourceId(null)
                        }}
                        className="flex-1 border border-slate-300 rounded-lg px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 mr-3"
                      />
                    ) : (
                      <span className="text-sm text-slate-700 font-mono bg-slate-50 px-2 py-0.5 rounded">{s.name}</span>
                    )}
                    {isOwner && renamingSourceId !== s.id && (
                      <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => { setRenamingSourceId(s.id); setRenameValue(s.name) }}
                          className="text-xs text-slate-400 hover:text-slate-700"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => deleteSource(s.id, s.name)}
                          className="text-xs text-slate-400 hover:text-red-500"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {isOwner && (
                  <form onSubmit={addSource} className="flex gap-2 pt-2 border-t border-slate-100 mt-2">
                    <input
                      value={newSource}
                      onChange={e => setNewSource(e.target.value)}
                      placeholder="e.g. Chase Business Checking"
                      className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                    <button type="submit" className="bg-slate-900 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-slate-800">
                      Add
                    </button>
                  </form>
                )}
              </div>
            </section>
          )}

          {/* ── Companies / Entities ──────────────────────────────── */}
          {activeTab === 'entities' && (
            <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="font-semibold text-slate-900">Companies / Entities</h2>
                <p className="text-xs text-slate-500 mt-0.5">Your LLC entities</p>
              </div>
              <div className="p-5 space-y-3">
                {companies.map(c => (
                  <div key={c.id} className="flex items-center justify-between group">
                    <span className="text-sm text-slate-800">{c.name}</span>
                    {isOwner && <button onClick={() => deleteCompany(c.id)} className="text-xs text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">Delete</button>}
                  </div>
                ))}
                {companies.length === 0 && <p className="text-sm text-slate-400">No companies yet.</p>}
                {isOwner && (
                  <form onSubmit={addCompany} className="flex gap-2 pt-2 border-t border-slate-100 mt-2">
                    <input value={newCompany} onChange={e => setNewCompany(e.target.value)} placeholder="e.g. Sunshine Storage LLC"
                      className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
                    <button type="submit" className="bg-slate-900 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-slate-800">Add</button>
                  </form>
                )}
              </div>
            </section>
          )}

          {/* ── Report Branding ───────────────────────────────────── */}
          {activeTab === 'branding' && (
            <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="font-semibold text-slate-900">Report Branding</h2>
                <p className="text-xs text-slate-500 mt-0.5">Logo and name shown on printed P&L and Balance Sheet exports</p>
              </div>
              <div className="p-5 space-y-5">
                {/* Logo */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-2">Company Logo</label>
                  <div className="flex items-start gap-4">
                    {logoUrl ? (
                      <div className="relative flex-shrink-0">
                        <img src={logoUrl} alt="Logo preview" className="h-16 w-auto object-contain border border-slate-200 rounded-lg p-1 bg-white" />
                        <button
                          onClick={removeLogo}
                          className="absolute -top-1.5 -right-1.5 bg-white border border-slate-200 rounded-full w-5 h-5 flex items-center justify-center text-slate-400 hover:text-red-500 text-xs leading-none"
                          title="Remove logo"
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <div className="h-16 w-28 border-2 border-dashed border-slate-200 rounded-lg flex items-center justify-center flex-shrink-0">
                        <span className="text-xs text-slate-400">No logo</span>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <label className="block">
                        <span className="inline-flex items-center gap-2 bg-slate-900 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800 cursor-pointer">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                          {logoUrl ? 'Replace logo' : 'Upload logo'}
                        </span>
                        <input type="file" accept="image/*" onChange={uploadLogo} className="sr-only" disabled={logoUploading} />
                      </label>
                      {logoUploading && <p className="text-xs text-slate-400">Uploading...</p>}
                      {logoError && <p className="text-xs text-red-500">{logoError}</p>}
                      <p className="text-xs text-slate-400">PNG, JPG, or SVG. Recommended height: 80–160px.</p>
                    </div>
                  </div>
                </div>

                {/* Name + Subtitle */}
                <form onSubmit={saveBranding} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Company / Report Name</label>
                    <input
                      value={reportName}
                      onChange={e => setReportName(e.target.value)}
                      placeholder="e.g. Sunshine Storage Holdings"
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Subtitle (optional)</label>
                    <input
                      value={reportSubtitle}
                      onChange={e => setReportSubtitle(e.target.value)}
                      placeholder="e.g. Confidential — For Internal Use Only"
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="submit" className="bg-slate-900 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-slate-800">
                      Save Branding
                    </button>
                    {brandingSaved && <span className="text-xs text-emerald-600 font-medium">Saved</span>}
                  </div>
                </form>
              </div>
            </section>
          )}

          {/* ── Account ───────────────────────────────────────────── */}
          {activeTab === 'account' && (
            <section className="bg-white rounded-xl border border-slate-200 p-5">
              <h2 className="font-semibold text-slate-900 mb-3">Account</h2>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Email</span>
                  <span className="text-slate-800">{currentUser?.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Role</span>
                  <span className={`font-medium ${userRole === 'owner' ? 'text-slate-900' : 'text-slate-600'}`}>
                    {userRole || 'No role assigned'}
                  </span>
                </div>
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  )
}

// Single scrollable column of categories (Income or Expenses)
function CategoryColumn({ title, items, isOwner, onDelete, onSetType }) {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{title}</span>
        <span className="text-xs text-slate-400">{items.length}</span>
      </div>
      <div className="divide-y divide-slate-50 max-h-96 overflow-y-auto">
        {items.length === 0 && <p className="text-sm text-slate-400 px-3 py-2">None yet.</p>}
        {items.map(c => {
          const target = c.type === 'income' ? 'expense' : 'income'
          const targetLabel = target === 'income' ? 'Income' : 'Expenses'
          return (
            <div key={c.id} className="flex items-center justify-between px-3 py-1.5 group hover:bg-slate-50">
              <span className="text-sm text-slate-700">{c.name}</span>
              {isOwner && (
                <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => onSetType(c.id, target)}
                    className="text-xs text-slate-400 hover:text-slate-700 whitespace-nowrap"
                    title={`Move to ${targetLabel}`}>
                    → {targetLabel}
                  </button>
                  <button onClick={() => onDelete(c.id)} className="text-xs text-slate-400 hover:text-red-500">
                    Delete
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
