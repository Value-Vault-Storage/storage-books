'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import { formatCurrency } from '@/lib/reports/pl'
import PrintHeader from '@/components/PrintHeader'
import ExportCsvButton from '@/components/ExportCsvButton'
import { money, csvFilename } from '@/lib/exportCsv'

// CSV rows for a balance sheet (live entries or a saved snapshot)
function balanceSheetRows(assetRows, liabilityRows, totals) {
  const line = section => e => [section, e.name, money(e.amount), e.notes || '']
  return [
    ['Section', 'Name', 'Amount', 'Notes'],
    ...assetRows.map(line('Assets')),
    ['Assets', 'Total Assets', money(totals.assets), ''],
    ...liabilityRows.map(line('Liabilities')),
    ['Liabilities', 'Total Liabilities', money(totals.liabilities), ''],
    ['Equity', "Owner's Equity (Assets − Liabilities)", money(totals.equity), ''],
  ]
}

export default function BalanceSheetPage() {
  const [entries, setEntries] = useState([])
  const [companies, setCompanies] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [companyFilter, setCompanyFilter] = useState('all')
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10))
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState(null)
  const [reportSettings, setReportSettings] = useState({})

  // Entry form
  const [form, setForm] = useState({ name: '', type: 'asset', amount: '', notes: '' })
  const [editingEntryId, setEditingEntryId] = useState(null)
  const [showForm, setShowForm] = useState(false)

  // Snapshot state
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [snapshotLabel, setSnapshotLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [viewingSnapshot, setViewingSnapshot] = useState(null)

  const printRef = useRef()
  const supabase = createClient()

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: ent }, { data: co }, { data: role }, { data: snaps }, { data: branding }] = await Promise.all([
      supabase.from('balance_sheet_entries').select('*').order('created_at'),
      supabase.from('companies').select('*').order('name'),
      supabase.from('user_roles').select('role').single(),
      supabase.from('balance_sheet_snapshots').select('*').order('created_at', { ascending: false }),
      supabase.from('report_settings').select('*'),
    ])
    setEntries(ent || [])
    setCompanies(co || [])
    setUserRole(role?.role || 'viewer')
    setSnapshots(snaps || [])
    if (branding) setReportSettings(Object.fromEntries(branding.map(r => [r.key, r.value])))
    setLoading(false)
  }

  const isOwner = userRole === 'owner'

  async function saveEntry(e) {
    e.preventDefault()
    const payload = {
      ...form,
      amount: parseFloat(form.amount),
      as_of_date: asOfDate,
      company_id: companyFilter === 'all' ? companies[0]?.id : companyFilter,
    }
    if (editingEntryId) {
      await supabase.from('balance_sheet_entries').update(payload).eq('id', editingEntryId)
    } else {
      await supabase.from('balance_sheet_entries').insert(payload)
    }
    setForm({ name: '', type: 'asset', amount: '', notes: '' })
    setEditingEntryId(null)
    setShowForm(false)
    await loadAll()
  }

  async function deleteEntry(id) {
    if (!confirm('Delete this entry?')) return
    await supabase.from('balance_sheet_entries').delete().eq('id', id)
    await loadAll()
  }

  function startEdit(entry) {
    setForm({ name: entry.name, type: entry.type, amount: entry.amount, notes: entry.notes || '' })
    setEditingEntryId(entry.id)
    setShowForm(true)
  }

  async function saveSnapshot() {
    if (!snapshotLabel.trim()) return
    setSaving(true)
    const companyId = companyFilter === 'all' ? null : companyFilter
    const companyName = companyFilter === 'all' ? 'All Entities' : companies.find(c => c.id === companyFilter)?.name
    await supabase.from('balance_sheet_snapshots').insert({
      label: snapshotLabel.trim(),
      as_of_date: asOfDate,
      company_id: companyId,
      assets: assets.map(e => ({ name: e.name, amount: parseFloat(e.amount), notes: e.notes || '' })),
      liabilities: liabilities.map(e => ({ name: e.name, amount: parseFloat(e.amount), notes: e.notes || '' })),
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      total_equity: totalEquity,
    })
    setSaving(false)
    setShowSaveModal(false)
    setSnapshotLabel('')
    await loadAll()
  }

  async function deleteSnapshot(id) {
    if (!confirm('Delete this saved balance sheet?')) return
    await supabase.from('balance_sheet_snapshots').delete().eq('id', id)
    await loadAll()
  }

  function printSnapshot(snap) {
    setViewingSnapshot(snap)
    setTimeout(() => window.print(), 300)
  }

  // Filtered entries
  const filteredEntries = entries.filter(e =>
    companyFilter === 'all' || e.company_id === companyFilter
  )
  const assets = filteredEntries.filter(e => e.type === 'asset')
  const liabilities = filteredEntries.filter(e => e.type === 'liability')
  const totalAssets = assets.reduce((s, e) => s + parseFloat(e.amount), 0)
  const totalLiabilities = liabilities.reduce((s, e) => s + parseFloat(e.amount), 0)
  const totalEquity = totalAssets - totalLiabilities

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading...</div>

  // Print view — shows the viewed snapshot
  if (viewingSnapshot) {
    const snap = viewingSnapshot
    const snapAssets = snap.assets || []
    const snapLiabilities = snap.liabilities || []
    return (
      <div className="p-8 max-w-2xl">
        <div className="print-hide flex items-center justify-between mb-6">
          <button onClick={() => setViewingSnapshot(null)} className="text-sm text-slate-500 hover:text-slate-800">← Back</button>
          <div className="flex gap-2">
            <ExportCsvButton
              filename={() => csvFilename('balance-sheet', snap.label, snap.as_of_date)}
              getRows={() => balanceSheetRows(snapAssets, snapLiabilities, { assets: snap.total_assets, liabilities: snap.total_liabilities, equity: snap.total_equity })}
            />
            <button onClick={() => window.print()} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">Print / Save PDF</button>
          </div>
        </div>
        <div className="print-area bg-white rounded-xl border border-slate-200 overflow-hidden">
          <PrintHeader
            logoUrl={reportSettings.logo_url}
            reportName={reportSettings.report_name}
            subtitle={reportSettings.report_subtitle}
            title="Balance Sheet"
            dateRange={`As of ${snap.as_of_date}`}
          />
          <div className="px-6 py-4 border-b border-slate-100">
            <h2 className="font-semibold text-slate-900">{snap.label}</h2>
            <p className="text-xs text-slate-400 mt-0.5">Balance Sheet — as of {snap.as_of_date}</p>
          </div>
          <div className="p-6 space-y-6">
            <SnapSection title="Assets" entries={snapAssets} total={snap.total_assets} colorClass="text-emerald-600" />
            <SnapSection title="Liabilities" entries={snapLiabilities} total={snap.total_liabilities} colorClass="text-red-600" />
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Equity</h3>
              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-600">Owner's Equity (Assets − Liabilities)</span>
                <span className={`font-mono ${snap.total_equity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(snap.total_equity)}</span>
              </div>
            </div>
            <div className="rounded-lg p-4 bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex justify-between text-sm font-semibold">
                <span>Total Assets</span>
                <span className="font-mono text-emerald-600">{formatCurrency(snap.total_assets)}</span>
              </div>
              <div className="flex justify-between text-sm font-semibold">
                <span>Total Liabilities</span>
                <span className="font-mono text-red-600">{formatCurrency(snap.total_liabilities)}</span>
              </div>
              <div className="flex justify-between text-sm font-semibold border-t border-slate-200 pt-2">
                <span>Owner's Equity</span>
                <span className={`font-mono font-bold ${snap.total_equity >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{formatCurrency(snap.total_equity)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="print-hide flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-slate-900">Balance Sheet</h1>
        <div className="flex gap-2">
          {isOwner && (
            <button
              onClick={() => { setSnapshotLabel(''); setShowSaveModal(true) }}
              className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800"
            >
              Save Snapshot
            </button>
          )}
          <ExportCsvButton
            filename={() => csvFilename('balance-sheet', companyFilter === 'all' ? 'all-entities' : companies.find(c => c.id === companyFilter)?.name, asOfDate)}
            getRows={() => balanceSheetRows(assets, liabilities, { assets: totalAssets, liabilities: totalLiabilities, equity: totalEquity })}
          />
          <button onClick={() => window.print()} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
            Print / PDF
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="print-hide bg-white rounded-xl border border-slate-200 p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Entity</label>
          <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
            <option value="all">All Entities (Consolidated)</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">As of Date</label>
          <input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
        </div>
        {isOwner && (
          <button onClick={() => { setShowForm(v => !v); setEditingEntryId(null); setForm({ name: '', type: 'asset', amount: '', notes: '' }) }}
            className="px-4 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800">
            + Add Entry
          </button>
        )}
      </div>

      {/* Add/Edit form */}
      {showForm && isOwner && (
        <div className="print-hide bg-white rounded-xl border border-slate-200 p-5 mb-6">
          <h3 className="font-semibold text-sm text-slate-900 mb-4">{editingEntryId ? 'Edit Entry' : 'New Entry'}</h3>
          <form onSubmit={saveEntry} className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required
                placeholder="e.g. Storage Facility Land"
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
              <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="asset">Asset</option>
                <option value="liability">Liability</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Amount ($)</label>
              <input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} required
                placeholder="0.00"
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Notes (optional)</label>
              <input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="Mortgage balance, appraisal value, etc."
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div className="col-span-2 flex gap-2">
              <button type="submit" className="bg-slate-900 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-slate-800">
                {editingEntryId ? 'Save Changes' : 'Add Entry'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="text-sm text-slate-500 px-4 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Live Balance Sheet */}
      <div className="print-area bg-white rounded-xl border border-slate-200 overflow-hidden mb-8">
        <PrintHeader
          logoUrl={reportSettings.logo_url}
          reportName={reportSettings.report_name}
          subtitle={reportSettings.report_subtitle}
          title="Balance Sheet"
          dateRange={`As of ${asOfDate}`}
        />
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Balance Sheet — as of {asOfDate}</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {companyFilter === 'all' ? 'Consolidated (All Entities)' : companies.find(c => c.id === companyFilter)?.name}
          </p>
        </div>
        <div className="p-6 space-y-6">
          <BSSection title="Assets" entries={assets} total={totalAssets} colorClass="text-emerald-600"
            isOwner={isOwner} onEdit={startEdit} onDelete={deleteEntry} />
          <BSSection title="Liabilities" entries={liabilities} total={totalLiabilities} colorClass="text-red-600"
            isOwner={isOwner} onEdit={startEdit} onDelete={deleteEntry} />
          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Equity</h3>
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-600">Owner's Equity (Assets − Liabilities)</span>
              <span className={`font-mono ${totalEquity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(totalEquity)}</span>
            </div>
          </div>
          <div className="rounded-lg p-4 bg-slate-50 border border-slate-200 space-y-2">
            <div className="flex justify-between text-sm font-semibold">
              <span>Total Assets</span>
              <span className="font-mono text-emerald-600">{formatCurrency(totalAssets)}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold">
              <span>Total Liabilities</span>
              <span className="font-mono text-red-600">{formatCurrency(totalLiabilities)}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold border-t border-slate-200 pt-2">
              <span>Owner's Equity</span>
              <span className={`font-mono font-bold ${totalEquity >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{formatCurrency(totalEquity)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Saved Snapshots */}
      {snapshots.length > 0 && (
        <div className="print-hide">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Saved Snapshots</h2>
          <div className="space-y-2">
            {snapshots.map(snap => (
              <div key={snap.id} className="bg-white rounded-xl border border-slate-200 px-5 py-4 flex items-center justify-between group">
                <div>
                  <p className="text-sm font-medium text-slate-900">{snap.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    As of {snap.as_of_date} · Equity {formatCurrency(snap.total_equity)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setViewingSnapshot(snap)}
                    className="text-xs text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50">
                    View
                  </button>
                  <button onClick={() => printSnapshot(snap)}
                    className="text-xs text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50">
                    Print / PDF
                  </button>
                  {isOwner && (
                    <button onClick={() => deleteSnapshot(snap.id)}
                      className="text-xs text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100">
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Save Snapshot Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-1">Save Balance Sheet</h2>
            <p className="text-sm text-slate-500 mb-4">
              Saves the current view as of <strong>{asOfDate}</strong> for{' '}
              <strong>{companyFilter === 'all' ? 'All Entities' : companies.find(c => c.id === companyFilter)?.name}</strong>
            </p>
            <label className="block text-xs font-medium text-slate-500 mb-1">Label</label>
            <input
              autoFocus
              value={snapshotLabel}
              onChange={e => setSnapshotLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveSnapshot()}
              placeholder="e.g. Avon Park Q1 2026"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
            <div className="flex gap-3">
              <button onClick={() => setShowSaveModal(false)}
                className="flex-1 border border-slate-200 text-slate-700 text-sm font-medium py-2 rounded-lg hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={saveSnapshot} disabled={!snapshotLabel.trim() || saving}
                className="flex-1 bg-slate-900 text-white text-sm font-medium py-2 rounded-lg hover:bg-slate-700 disabled:opacity-40">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BSSection({ title, entries, total, colorClass, isOwner, onEdit, onDelete }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-1.5">
        {entries.map(e => (
          <div key={e.id} className="flex justify-between items-center text-sm group">
            <div className="flex items-center gap-2">
              <span className="text-slate-700">{e.name}</span>
              {e.notes && <span className="text-xs text-slate-400">({e.notes})</span>}
            </div>
            <div className="flex items-center gap-3">
              <span className={`font-mono ${colorClass}`}>{formatCurrency(parseFloat(e.amount))}</span>
              {isOwner && (
                <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                  <button onClick={() => onEdit(e)} className="text-xs text-slate-400 hover:text-slate-700">Edit</button>
                  <button onClick={() => onDelete(e.id)} className="text-xs text-slate-400 hover:text-red-500">Delete</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {entries.length === 0 && <p className="text-sm text-slate-400">No entries</p>}
      </div>
      <div className="flex justify-between items-center text-sm font-semibold mt-3 pt-3 border-t border-slate-100">
        <span>Total {title}</span>
        <span className={`font-mono ${colorClass}`}>{formatCurrency(total)}</span>
      </div>
    </div>
  )
}

function SnapSection({ title, entries, total, colorClass }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-1.5">
        {entries.map((e, i) => (
          <div key={i} className="flex justify-between items-center text-sm">
            <div className="flex items-center gap-2">
              <span className="text-slate-700">{e.name}</span>
              {e.notes && <span className="text-xs text-slate-400">({e.notes})</span>}
            </div>
            <span className={`font-mono ${colorClass}`}>{formatCurrency(e.amount)}</span>
          </div>
        ))}
        {entries.length === 0 && <p className="text-sm text-slate-400">No entries</p>}
      </div>
      <div className="flex justify-between items-center text-sm font-semibold mt-3 pt-3 border-t border-slate-100">
        <span>Total {title}</span>
        <span className={`font-mono ${colorClass}`}>{formatCurrency(total)}</span>
      </div>
    </div>
  )
}
