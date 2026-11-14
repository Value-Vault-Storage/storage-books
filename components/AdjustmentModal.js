'use client'
import { useState } from 'react'
import { TREATMENTS, excludedAmount } from '@/lib/reports/adjustments'
import { formatCurrency } from '@/lib/reports/pl'

// Exclude one or more transactions from NOI with a treatment and a reason.
// `existing` is the current adjustment when editing a single transaction.
export default function AdjustmentModal({ transactions, existing, onSave, onRemove, onClose }) {
  const single = transactions.length === 1 ? transactions[0] : null
  const fullTotal = transactions.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)

  const [treatment, setTreatment] = useState(
    existing && existing.treatment !== 'unreviewed' ? existing.treatment : ''
  )
  const [partial, setPartial] = useState(!!(single && existing?.amount != null && excludedAmount(single, existing) < fullTotal))
  const [amount, setAmount] = useState(existing?.amount != null ? String(existing.amount) : '')
  const [reason, setReason] = useState(existing?.reason || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const partialValue = Number(amount)
  const partialInvalid = partial && (!(partialValue > 0) || partialValue >= fullTotal)
  const canSave = treatment && reason.trim() && !partialInvalid && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError('')
    const err = await onSave({ treatment, amount: partial ? partialValue : null, reason })
    setSaving(false)
    if (err) setError(err)
  }

  async function remove() {
    setSaving(true)
    const err = await onRemove()
    setSaving(false)
    if (err) setError(err)
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{existing ? 'Edit NOI adjustment' : 'Exclude from NOI'}</h2>
          {single ? (
            <div className="mt-1 text-sm text-slate-500">
              <p className="truncate">{single.description}</p>
              <p className="text-xs text-slate-400">{single.date} · {formatCurrency(Math.abs(single.amount))}</p>
            </div>
          ) : (
            <p className="mt-1 text-sm text-slate-500">
              {transactions.length} transactions · {formatCurrency(fullTotal)}
            </p>
          )}
        </div>

        <div className="px-6 py-4 space-y-4">
          <div>
            <p className="text-xs font-medium text-slate-500 mb-2">Why is it out of NOI?</p>
            <div className="space-y-2">
              {TREATMENTS.map(t => (
                <label key={t.value}
                  className={`flex gap-3 items-start border rounded-lg px-3 py-2 cursor-pointer ${treatment === t.value ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <input type="radio" name="treatment" value={t.value} checked={treatment === t.value}
                    onChange={() => setTreatment(t.value)} className="mt-1" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">{t.label}</span>
                    <span className="block text-xs text-slate-500">{t.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {single && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-2">How much?</p>
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={!partial} onChange={() => setPartial(false)} />
                  Whole transaction ({formatCurrency(fullTotal)})
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={partial} onChange={() => setPartial(true)} />
                  Part of it:
                  <input type="number" step="0.01" min="0" value={amount}
                    onFocus={() => setPartial(true)}
                    onChange={e => { setAmount(e.target.value); setPartial(true) }}
                    placeholder="0.00"
                    className="w-32 border border-slate-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
                </label>
                {partial && partialValue > 0 && !partialInvalid && (
                  <p className="text-xs text-slate-500 ml-6">
                    {formatCurrency(partialValue)} excluded · {formatCurrency(fullTotal - partialValue)} stays in NOI
                  </p>
                )}
                {partial && amount !== '' && partialInvalid && (
                  <p className="text-xs text-red-600 ml-6">Enter an amount between $0 and {formatCurrency(fullTotal)}.</p>
                )}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Reason <span className="text-red-500">*</span>
            </label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
              placeholder="e.g. Replaced 14 roll-up doors in building C; invoice #2231. Not a repair."
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            <p className="text-xs text-slate-400 mt-1">Shown on the adjustments page and in the Deal Room NOI walk.</p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-2">
          <div>
            {existing && onRemove && (
              <button onClick={remove} disabled={saving}
                className="text-sm text-slate-500 hover:text-slate-900 disabled:opacity-50">
                Include in NOI again
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
              Cancel
            </button>
            <button onClick={save} disabled={!canSave}
              className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40">
              {saving ? 'Saving…' : existing ? 'Save' : 'Exclude'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
