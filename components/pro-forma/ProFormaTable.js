'use client'
import { useState, useRef } from 'react'
import { MONTHS, formatAccounting } from '@/lib/reports/proforma'
import { Icon } from '@/components/pro-forma/ui'

const num = 'px-3 py-2 text-right tabular-nums whitespace-nowrap'
const stickyCol = 'sticky left-0 z-10'
const TX_PREVIEW = 8

// The pro forma statement: revenue and operating expense sections, each
// category expandable into vendors and then transactions.
export default function ProFormaTable({
  pf, view, year, readOnly,
  onOverride, onExcludeCategory, onToggleVendor, onEditRow, onAdd,
}) {
  const [expanded, setExpanded] = useState(new Set())
  const [expandedVendors, setExpandedVendors] = useState(new Set())
  const monthly = view === 'monthly'
  const colCount = monthly ? 15 : 5
  const t = pf.totals

  const toggle = (setter, key) => setter(prev => {
    const n = new Set(prev)
    n.has(key) ? n.delete(key) : n.add(key)
    return n
  })

  function section(rows, type) {
    return rows.map(row => {
      const isOpen = expanded.has(row.key)
      return [
        <LineRow key={row.key} row={row} monthly={monthly} readOnly={readOnly} revenueTotal={t.revenueTotal}
          expandable={row.kind === 'category'} expanded={isOpen}
          onToggle={() => toggle(setExpanded, row.key)}
          onOverride={onOverride} onExclude={onExcludeCategory} onEdit={onEditRow} />,
        ...(isOpen ? row.vendors.flatMap(v => {
          const vKey = `${row.key}|${v.key}`
          const vOpen = expandedVendors.has(vKey)
          return [
            <VendorRow key={vKey} vendor={v} monthly={monthly} readOnly={readOnly} revenueTotal={t.revenueTotal}
              expanded={vOpen} onToggle={() => toggle(setExpandedVendors, vKey)}
              onToggleExcluded={() => onToggleVendor(row.name, v.key)} />,
            vOpen && <TransactionsRow key={`${vKey}|tx`} vendor={v} colCount={colCount} />,
          ]
        }) : []),
      ]
    }).flat().filter(Boolean).concat(
      rows.length === 0
        ? [<tr key={`${type}-empty`}><td colSpan={colCount} className="px-5 py-3 text-sm text-slate-400">No {type === 'income' ? 'revenue' : 'expenses'} in the averaging window.</td></tr>]
        : []
    )
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-auto max-h-[calc(100vh-7rem)] print:max-h-none print:overflow-visible print:shadow-none">
      <table className="w-full text-[13px] border-separate border-spacing-0">
        <thead>
          <tr className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <th className={`${stickyCol} top-0 z-30 bg-slate-50 border-b border-slate-200 text-left px-5 py-3 min-w-[18rem]`}>
              FY {year}
            </th>
            {monthly ? (
              <>
                <HeadCell>Avg / Mo</HeadCell>
                {MONTHS.map(m => <HeadCell key={m}>{m}</HeadCell>)}
                <HeadCell strong>Total</HeadCell>
              </>
            ) : (
              <>
                <HeadCell>Trailing Avg / Mo</HeadCell>
                <HeadCell>Forecast / Mo</HeadCell>
                <HeadCell strong>FY {year}</HeadCell>
                <HeadCell>% of Revenue</HeadCell>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          <SectionHeader label="Revenue" colCount={colCount} />
          {section(pf.income, 'income')}
          {!readOnly && (
            <AddRow colCount={colCount} actions={[
              { label: 'Add revenue line', onClick: () => onAdd('income') },
              { label: 'Add rent increase', onClick: () => onAdd('rent') },
            ]} />
          )}
          <TotalRow label="Total Revenue" values={t.revenue} total={t.revenueTotal} avg={t.trailingRevenueAvg}
            monthly={monthly} revenueTotal={t.revenueTotal} />

          <SectionHeader label="Operating Expenses" colCount={colCount} />
          {section(pf.expenses, 'expense')}
          {!readOnly && (
            <AddRow colCount={colCount} actions={[{ label: 'Add expense line', onClick: () => onAdd('expense') }]} />
          )}
          <TotalRow label="Total Operating Expenses" values={t.expenses} total={t.expenseTotal} avg={t.trailingExpenseAvg}
            monthly={monthly} revenueTotal={t.revenueTotal} />

          <TotalRow label="Net Operating Income" values={t.noi} total={t.noiTotal}
            avg={t.trailingRevenueAvg - t.trailingExpenseAvg} monthly={monthly} revenueTotal={t.revenueTotal} emphasis />
          <MarginRow t={t} monthly={monthly} />
        </tbody>
      </table>
    </div>
  )
}

function HeadCell({ children, strong }) {
  return (
    <th className={`sticky top-0 z-20 bg-slate-50 border-b border-slate-200 px-3 py-3 text-right whitespace-nowrap ${strong ? 'text-slate-700' : ''}`}>
      {children}
    </th>
  )
}

function SectionHeader({ label, colCount }) {
  return (
    <tr>
      <td colSpan={colCount} className="pt-5 pb-2 px-5 text-[11px] font-semibold uppercase tracking-wider text-slate-900 border-b border-slate-200">
        {label}
      </td>
    </tr>
  )
}

function RowActions({ children }) {
  return (
    <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity print:hidden">
      {children}
    </span>
  )
}

function ActionButton({ icon, label, onClick, danger }) {
  return (
    <button type="button" onClick={e => { e.stopPropagation(); onClick() }} title={label} aria-label={label}
      className={`p-1 rounded-md text-slate-400 ${danger ? 'hover:text-red-600 hover:bg-red-50' : 'hover:text-slate-800 hover:bg-slate-100'}`}>
      <Icon name={icon} className="w-3.5 h-3.5" />
    </button>
  )
}

function pctOf(value, total) {
  if (!total) return '–'
  return `${(value / total * 100).toFixed(1)}%`
}

function LineRow({ row, monthly, readOnly, revenueTotal, expandable, expanded, onToggle, onOverride, onExclude, onEdit }) {
  const badge = row.kind === 'rent' ? 'Rent' : row.kind === 'manual' ? 'Manual' : null
  const cellsEditable = !readOnly && row.kind !== 'rent'
  return (
    <tr className="group">
      <td className={`${stickyCol} bg-white group-hover:bg-slate-50 border-b border-slate-100 px-5 py-2`}>
        <div className="flex items-center gap-1.5 min-w-0">
          {expandable ? (
            <button type="button" onClick={onToggle} aria-expanded={expanded}
              className="-ml-1.5 p-0.5 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-200/60 print:hidden">
              <Icon name="chevron" className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>
          ) : <span className="w-3 print:hidden" />}
          <button type="button" onClick={expandable ? onToggle : undefined}
            className={`truncate text-left text-slate-800 ${expandable ? 'hover:text-slate-950' : 'cursor-default'}`}>
            {row.name}
          </button>
          {badge && (
            <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
              row.kind === 'rent' ? 'bg-emerald-50 text-emerald-700' : 'bg-indigo-50 text-indigo-700'
            }`}>{badge}</span>
          )}
          {row.detail && <span className="shrink-0 text-xs text-slate-400 truncate">{row.detail}</span>}
          {!readOnly && (
            <RowActions>
              {row.kind === 'category' && <ActionButton icon="eyeOff" label="Exclude from forecast" onClick={() => onExclude(row.name)} />}
              {row.kind !== 'category' && <ActionButton icon="pencil" label="Edit" onClick={() => onEdit(row)} />}
            </RowActions>
          )}
        </div>
      </td>
      {monthly ? (
        <>
          <td className={`${num} border-b border-slate-100 text-slate-400 group-hover:bg-slate-50`}>{row.avg === null ? '' : formatAccounting(row.avg)}</td>
          {row.values.map((v, i) => (
            <EditableCell key={i} value={v} computed={row.computed[i]} overridden={row.overridden[i]}
              editable={cellsEditable} onCommit={amt => onOverride(row.key, i + 1, amt)} />
          ))}
          <td className={`${num} border-b border-slate-100 font-medium text-slate-900 group-hover:bg-slate-50`}>{formatAccounting(row.total)}</td>
        </>
      ) : (
        <>
          <td className={`${num} border-b border-slate-100 text-slate-400 group-hover:bg-slate-50`}>{row.avg === null ? '' : formatAccounting(row.avg)}</td>
          <td className={`${num} border-b border-slate-100 text-slate-700 group-hover:bg-slate-50`}>{formatAccounting(row.total / 12)}</td>
          <td className={`${num} border-b border-slate-100 font-medium text-slate-900 group-hover:bg-slate-50`}>{formatAccounting(row.total)}</td>
          <td className={`${num} border-b border-slate-100 text-slate-400 group-hover:bg-slate-50`}>{pctOf(row.total, revenueTotal)}</td>
        </>
      )}
    </tr>
  )
}

function VendorRow({ vendor, monthly, readOnly, revenueTotal, expanded, onToggle, onToggleExcluded }) {
  const muted = vendor.excluded ? 'text-slate-300 line-through' : 'text-slate-500'
  return (
    <tr className="group bg-slate-50/60">
      <td className={`${stickyCol} bg-slate-50 group-hover:bg-slate-100 border-b border-slate-100 pl-12 pr-5 py-1.5`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <button type="button" onClick={onToggle} aria-expanded={expanded}
            className="-ml-5 p-0.5 rounded text-slate-400 hover:text-slate-800 print:hidden">
            <Icon name="chevron" className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
          <button type="button" onClick={onToggle} className={`truncate text-left text-[12.5px] ${muted}`}>{vendor.label}</button>
          <span className="shrink-0 text-[11px] text-slate-400">{vendor.txs.length} txn{vendor.txs.length === 1 ? '' : 's'}</span>
          {vendor.excluded && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 rounded px-1.5 py-px">Excluded</span>}
          {!readOnly && (
            <RowActions>
              <ActionButton icon={vendor.excluded ? 'eye' : 'eyeOff'}
                label={vendor.excluded ? 'Include in average' : 'Exclude from average (one-off)'} onClick={onToggleExcluded} />
            </RowActions>
          )}
        </div>
      </td>
      {monthly ? (
        <>
          <td className={`${num} py-1.5 border-b border-slate-100 text-[12.5px] ${muted}`}>{formatAccounting(vendor.avg)}</td>
          {MONTHS.map(m => (
            <td key={m} className={`${num} py-1.5 border-b border-slate-100 text-[12.5px] ${vendor.excluded ? 'text-slate-300' : 'text-slate-400'}`}>
              {vendor.excluded ? '–' : formatAccounting(vendor.avg)}
            </td>
          ))}
          <td className={`${num} py-1.5 border-b border-slate-100 text-[12.5px] ${muted}`}>{vendor.excluded ? '–' : formatAccounting(vendor.avg * 12)}</td>
        </>
      ) : (
        <>
          <td className={`${num} py-1.5 border-b border-slate-100 text-[12.5px] ${muted}`}>{formatAccounting(vendor.avg)}</td>
          <td className={`${num} py-1.5 border-b border-slate-100 text-[12.5px] ${muted}`}>{vendor.excluded ? '–' : formatAccounting(vendor.avg)}</td>
          <td className={`${num} py-1.5 border-b border-slate-100 text-[12.5px] ${muted}`}>{vendor.excluded ? '–' : formatAccounting(vendor.avg * 12)}</td>
          <td className={`${num} py-1.5 border-b border-slate-100 text-[12.5px] text-slate-300`}>{vendor.excluded ? '–' : pctOf(vendor.avg * 12, revenueTotal)}</td>
        </>
      )}
    </tr>
  )
}

function TransactionsRow({ vendor, colCount }) {
  const [showAll, setShowAll] = useState(false)
  const txs = showAll ? vendor.txs : vendor.txs.slice(0, TX_PREVIEW)
  return (
    <tr>
      <td colSpan={colCount} className="bg-slate-50 border-b border-slate-100 p-0">
        <div className="sticky left-0 w-[40rem] max-w-[calc(100vw-20rem)] pl-16 pr-5 py-2">
          <table className="w-full text-xs">
            <tbody>
              {txs.map(tx => (
                <tr key={tx.id} className="text-slate-500">
                  <td className="py-1 pr-4 tabular-nums whitespace-nowrap text-slate-400">{tx.date}</td>
                  <td className="py-1 pr-4 truncate max-w-[24rem]" title={tx.description}>{tx.description}</td>
                  <td className="py-1 text-right tabular-nums whitespace-nowrap">{formatAccounting(tx.amount, { dollar: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {vendor.txs.length > TX_PREVIEW && (
            <button type="button" onClick={() => setShowAll(v => !v)} className="mt-1 text-xs font-medium text-slate-500 hover:text-slate-900">
              {showAll ? 'Show fewer' : `Show all ${vendor.txs.length} transactions`}
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

function AddRow({ colCount, actions }) {
  return (
    <tr className="print:hidden">
      <td colSpan={colCount} className="border-b border-slate-100 px-5 py-1.5">
        <div className="sticky left-5 inline-flex gap-4">
          {actions.map(a => (
            <button key={a.label} type="button" onClick={a.onClick}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-900">
              <Icon name="plus" className="w-3.5 h-3.5" />{a.label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}

function TotalRow({ label, values, total, avg, monthly, revenueTotal, emphasis }) {
  const bg = emphasis ? 'bg-slate-900 text-white' : 'bg-white text-slate-900'
  const border = emphasis ? '' : 'border-t border-slate-300 border-b border-slate-200'
  const neg = v => (emphasis ? (v < 0 ? 'text-red-300' : '') : v < 0 ? 'text-red-600' : '')
  return (
    <tr className={`font-semibold ${bg}`}>
      <td className={`${stickyCol} ${bg} ${border} px-5 py-2.5`}>{label}</td>
      {monthly ? (
        <>
          <td className={`${num} ${border} py-2.5 font-normal ${emphasis ? 'text-slate-400' : 'text-slate-400'}`}>{formatAccounting(avg)}</td>
          {values.map((v, i) => <td key={i} className={`${num} ${border} py-2.5 ${neg(v)}`}>{formatAccounting(v)}</td>)}
          <td className={`${num} ${border} py-2.5 ${neg(total)}`}>{formatAccounting(total, { dollar: true })}</td>
        </>
      ) : (
        <>
          <td className={`${num} ${border} py-2.5 font-normal text-slate-400`}>{formatAccounting(avg)}</td>
          <td className={`${num} ${border} py-2.5 ${neg(total)}`}>{formatAccounting(total / 12)}</td>
          <td className={`${num} ${border} py-2.5 ${neg(total)}`}>{formatAccounting(total, { dollar: true })}</td>
          <td className={`${num} ${border} py-2.5 font-normal ${emphasis ? 'text-slate-300' : 'text-slate-500'}`}>{pctOf(total, revenueTotal)}</td>
        </>
      )}
    </tr>
  )
}

function MarginRow({ t, monthly }) {
  const margin = (noi, rev) => (rev ? `${(noi / rev * 100).toFixed(1)}%` : '–')
  const cell = `${num} py-2 text-xs text-slate-500`
  return (
    <tr>
      <td className={`${stickyCol} bg-white px-5 py-2 text-xs text-slate-500`}>NOI margin</td>
      {monthly ? (
        <>
          <td className={cell}>{margin(t.trailingRevenueAvg - t.trailingExpenseAvg, t.trailingRevenueAvg)}</td>
          {t.noi.map((v, i) => <td key={i} className={cell}>{margin(v, t.revenue[i])}</td>)}
          <td className={`${cell} font-medium text-slate-700`}>{margin(t.noiTotal, t.revenueTotal)}</td>
        </>
      ) : (
        <>
          <td className={cell}>{margin(t.trailingRevenueAvg - t.trailingExpenseAvg, t.trailingRevenueAvg)}</td>
          <td className={cell}>{margin(t.noiTotal, t.revenueTotal)}</td>
          <td className={`${cell} font-medium text-slate-700`}>{margin(t.noiTotal, t.revenueTotal)}</td>
          <td className={cell} />
        </>
      )}
    </tr>
  )
}

// A month cell that edits in place. Entering a value different from the
// calculated one stores an override; clearing the cell restores it.
function EditableCell({ value, computed, overridden, editable, onCommit }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const cancelled = useRef(false)
  const base = 'border-b border-slate-100 group-hover:bg-slate-50'

  if (!editable) {
    return <td className={`${num} ${base} text-slate-700`}>{formatAccounting(value)}</td>
  }

  function commit() {
    setEditing(false)
    if (cancelled.current) { cancelled.current = false; return }
    const raw = text.trim().replace(/[$,\s()]/g, '')
    if (raw === '') {
      if (overridden) onCommit(null)
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || Math.abs(n - value) < 0.005) return
    // Typing the calculated amount back in is the same as resetting
    onCommit(Math.abs(n - computed) < 0.005 ? null : n)
  }

  return (
    <td className={`relative p-0 ${base} ${overridden ? 'bg-amber-50/70' : ''}`}
      title={overridden ? `Edited — calculated value ${formatAccounting(computed)}. Clear to reset.` : undefined}>
      {overridden && <span className="absolute top-0 right-0 w-0 h-0 border-t-[6px] border-l-[6px] border-t-amber-400 border-l-transparent" />}
      <input
        value={editing ? text : formatAccounting(value)}
        onFocus={e => {
          setText(value ? String(Math.round(value * 100) / 100) : '')
          setEditing(true)
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
        }}
        className={`w-[5.5rem] bg-transparent px-3 py-2 text-right tabular-nums rounded-sm outline-none cursor-text hover:bg-slate-100 focus:bg-white focus:ring-2 focus:ring-slate-900/20 ${
          overridden ? 'text-amber-800 font-medium' : 'text-slate-700'
        }`}
      />
    </td>
  )
}
