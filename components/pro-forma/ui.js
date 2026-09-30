'use client'
import { useState, useEffect } from 'react'
import { MONTHS } from '@/lib/reports/proforma'

// Small shared UI pieces for the Pro Forma page

export function Icon({ name, className = 'w-4 h-4' }) {
  const paths = {
    chevron: 'M9 5l7 7-7 7',
    pencil: 'M15.232 5.232l3.536 3.536M4 20h4L18.5 9.5a2.5 2.5 0 00-3.536-3.536L4.5 16.5 4 20z',
    trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16',
    eyeOff: 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21',
    eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
    plus: 'M12 4v16m8-8H4',
    close: 'M6 18L18 6M6 6l12 12',
    printer: 'M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z',
    check: 'M5 13l4 4L19 7',
    reset: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  }
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={paths[name]} />
    </svg>
  )
}

export function Segmented({ options, value, onChange, size = 'md' }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`${size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'} rounded-md font-medium transition-colors ${
            value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400 mt-1">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400'

// Numeric input that keeps its own text while typing (so "1." or "-" aren't clobbered)
export function NumberInput({ value, onChange, prefix, suffix, autoFocus }) {
  const [text, setText] = useState(value ? String(value) : '')
  const [focused, setFocused] = useState(false)
  const shown = focused ? text : (value ? String(value) : '')
  return (
    <div className="flex items-center border border-slate-200 rounded-lg bg-white focus-within:ring-2 focus-within:ring-slate-900/10 focus-within:border-slate-400">
      {prefix && <span className="pl-3 text-sm text-slate-400">{prefix}</span>}
      <input
        inputMode="decimal"
        autoFocus={autoFocus}
        value={shown}
        placeholder="0"
        onFocus={() => { setText(value ? String(value) : ''); setFocused(true) }}
        onBlur={() => setFocused(false)}
        onChange={e => {
          setText(e.target.value)
          const n = Number(e.target.value.replace(/[$,%\s]/g, ''))
          if (e.target.value.trim() === '') onChange(0)
          else if (Number.isFinite(n)) onChange(n)
        }}
        className="w-full min-w-0 bg-transparent px-3 py-2 text-sm text-right tabular-nums focus:outline-none"
      />
      {suffix && <span className="pr-3 text-sm text-slate-400">{suffix}</span>}
    </div>
  )
}

export function MonthPicker({ months, onChange }) {
  const selected = new Set(months)
  function toggle(m) {
    const next = new Set(selected)
    next.has(m) ? next.delete(m) : next.add(m)
    onChange([...next].sort((a, b) => a - b))
  }
  return (
    <div className="grid grid-cols-6 gap-1.5">
      {MONTHS.map((label, i) => (
        <button
          key={label}
          type="button"
          onClick={() => toggle(i + 1)}
          className={`py-1.5 rounded-md text-xs font-medium border transition-colors ${
            selected.has(i + 1)
              ? 'bg-slate-900 border-slate-900 text-white'
              : 'bg-white border-slate-200 text-slate-600 hover:border-slate-400'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function Modal({ title, subtitle, onClose, children, footer }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="relative w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200">
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-1 -mr-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl flex items-center gap-2">{footer}</div>}
      </div>
    </div>
  )
}

export function KpiCard({ label, value, sub, tone = 'default' }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-5 py-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums tracking-tight ${tone === 'negative' ? 'text-red-600' : 'text-slate-900'}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

// Percent change; `invert` for costs, where an increase is bad
export function Delta({ current, previous, invert }) {
  if (!previous) return null
  const pct = (current - previous) / Math.abs(previous) * 100
  if (!Number.isFinite(pct)) return null
  const up = pct >= 0
  const good = invert ? !up : up
  return (
    <span className={`font-medium ${Math.abs(pct) < 0.05 ? 'text-slate-500' : good ? 'text-emerald-600' : 'text-red-600'}`}>
      {up ? '+' : ''}{pct.toFixed(1)}%
    </span>
  )
}
