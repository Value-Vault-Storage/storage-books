'use client'
import { useState } from 'react'
import { MONTHS, RENT_INCREASE_TYPES } from '@/lib/reports/proforma'
import { Modal, Field, NumberInput, MonthPicker, Segmented, inputCls } from '@/components/pro-forma/ui'

const SECTION_LABELS = { income: 'Revenue', expense: 'Expense', debt: 'Debt service' }
const PLACEHOLDERS = {
  income: 'e.g. Tenant insurance program',
  expense: 'e.g. Property tax',
  debt: 'e.g. Loan interest',
}

// Add / edit a manual revenue, expense, or debt service line
export function ManualLineModal({ initial, onSave, onDelete, onClose }) {
  const [line, setLine] = useState(() => ({
    id: crypto.randomUUID(),
    name: '',
    type: 'expense',
    frequency: 'monthly',
    amount: 0,
    months: [],
    ...initial,
  }))
  const isNew = !initial?.id
  const set = patch => setLine(l => ({ ...l, ...patch }))
  const perPayment = line.frequency === 'scheduled' && line.months.length > 0
    ? (Number(line.amount) || 0) / line.months.length
    : null
  const valid = line.name.trim() && (line.frequency === 'monthly' || line.months.length > 0)

  return (
    <Modal
      title={isNew ? `Add ${SECTION_LABELS[line.type].toLowerCase()} line` : 'Edit line'}
      subtitle={line.type === 'debt'
        ? 'Debt service is reported below NOI and reduces cash flow, not NOI.'
        : 'Manual lines are added on top of the trailing averages.'}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button onClick={() => onDelete(line.id)} className="px-3 py-2 text-sm font-medium text-red-600 rounded-lg hover:bg-red-50">
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 rounded-lg hover:bg-slate-100">Cancel</button>
          <button
            onClick={() => onSave({ ...line, name: line.name.trim() })}
            disabled={!valid}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isNew ? 'Add line' : 'Save changes'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input autoFocus value={line.name} onChange={e => set({ name: e.target.value })}
          placeholder={PLACEHOLDERS[line.type]} className={inputCls} />
      </Field>
      <Field label="Section">
        <Segmented size="sm" value={line.type} onChange={type => set({ type })}
          options={Object.entries(SECTION_LABELS).map(([value, label]) => ({ value, label }))} />
      </Field>
      <Field label="Timing">
        <Segmented size="sm" value={line.frequency} onChange={frequency => set({ frequency })}
          options={[{ value: 'monthly', label: 'Every month' }, { value: 'scheduled', label: 'Specific months' }]} />
      </Field>
      <Field
        label={line.frequency === 'monthly' ? 'Amount per month' : 'Annual amount'}
        hint={perPayment !== null && line.months.length > 1
          ? `Split evenly: $${Math.round(perPayment).toLocaleString()} in each selected month`
          : line.frequency === 'monthly' ? `$${Math.round((Number(line.amount) || 0) * 12).toLocaleString()} per year` : null}
      >
        <NumberInput value={line.amount} onChange={amount => set({ amount })} prefix="$" />
      </Field>
      {line.frequency === 'scheduled' && (
        <Field label="Paid in" hint={line.months.length === 0 ? 'Select at least one month.' : null}>
          <MonthPicker months={line.months} onChange={months => set({ months })} />
        </Field>
      )}
    </Modal>
  )
}

// Add / edit a rent increase
export function RentIncreaseModal({ initial, onSave, onDelete, onClose }) {
  const [inc, setInc] = useState(() => ({
    id: crypto.randomUUID(),
    month: 1,
    type: 'pct',
    value: 0,
    units: 0,
    ...initial,
  }))
  const isNew = !initial?.id
  const set = patch => setInc(i => ({ ...i, ...patch }))

  return (
    <Modal
      title={isNew ? 'Add rent increase' : 'Edit rent increase'}
      subtitle="Applied to rental income from the effective month onward."
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button onClick={() => onDelete(inc.id)} className="px-3 py-2 text-sm font-medium text-red-600 rounded-lg hover:bg-red-50">
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 rounded-lg hover:bg-slate-100">Cancel</button>
          <button onClick={() => onSave(inc)} className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-700">
            {isNew ? 'Add increase' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Effective">
          <select value={inc.month} onChange={e => set({ month: Number(e.target.value) })} className={inputCls}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={inc.type} onChange={e => set({ type: e.target.value })} className={inputCls}>
            {RENT_INCREASE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={inc.type === 'pct' ? 'Increase' : inc.type === 'per_unit' ? 'Per unit / month' : 'Per month'}>
          <NumberInput autoFocus value={inc.value} onChange={value => set({ value })}
            prefix={inc.type === 'pct' ? null : '$'} suffix={inc.type === 'pct' ? '%' : null} />
        </Field>
        {inc.type === 'per_unit' && (
          <Field label="Occupied units">
            <NumberInput value={inc.units} onChange={units => set({ units })} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

// Choose how a category is forecast: trailing average, an annual payment, or a fixed monthly amount
export function LineMethodModal({ row, windowLabel, onSave, onClose }) {
  const current = row.methodConfig || { method: 'average' }
  const defaultMonths = row.paidMonths?.length ? row.paidMonths : [1]
  const [method, setMethod] = useState(current.method || 'average')
  const [annualAmount, setAnnualAmount] = useState(
    current.method === 'annual' && current.amount !== null && current.amount !== undefined ? Number(current.amount) : Math.round(row.trailing12)
  )
  const [timing, setTiming] = useState(current.timing || 'spread')
  const [months, setMonths] = useState(current.months?.length ? current.months : defaultMonths)
  const [fixedAmount, setFixedAmount] = useState(
    current.method === 'fixed' ? Number(current.amount) || 0 : Math.round(row.avg)
  )
  const paidLabel = (row.paidMonths || []).map(m => MONTHS[m - 1]).join(', ')
  const valid = method !== 'annual' || timing === 'spread' || months.length > 0

  function save() {
    if (method === 'average') return onSave(null)
    if (method === 'fixed') return onSave({ method, amount: fixedAmount })
    // Keep tracking actuals when the amount is left at the trailing-12 total
    const amount = Math.round(annualAmount) === Math.round(row.trailing12) ? null : annualAmount
    onSave({ method, amount, timing, months: timing === 'months' ? months : [] })
  }

  return (
    <Modal
      title={`Forecast method · ${row.name}`}
      subtitle="Choose how this line is projected for the year."
      onClose={onClose}
      footer={
        <>
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 rounded-lg hover:bg-slate-100">Cancel</button>
          <button onClick={save} disabled={!valid}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed">
            Save
          </button>
        </>
      }
    >
      <Segmented size="sm" value={method} onChange={setMethod}
        options={[
          { value: 'average', label: 'Trailing average' },
          { value: 'annual', label: 'Annual payment' },
          { value: 'fixed', label: 'Fixed amount' },
        ]} />

      {method === 'average' && (
        <p className="text-sm text-slate-600">
          Uses the average over {windowLabel}: <span className="font-medium tabular-nums">${Math.round(row.avg).toLocaleString()}/mo</span>.
          Best for costs that recur every month.
        </p>
      )}

      {method === 'annual' && (
        <>
          <p className="text-sm text-slate-600">
            For costs paid once or a few times a year, like insurance premiums or property tax, so a single payment isn’t averaged into every month.
          </p>
          <Field label="Annual amount"
            hint={row.trailing12 > 0
              ? `Paid $${Math.round(row.trailing12).toLocaleString()} in the last 12 months${paidLabel ? ` (${paidLabel})` : ''}.`
              : 'Nothing paid in the last 12 months — enter the expected amount.'}>
            <NumberInput value={annualAmount} onChange={setAnnualAmount} prefix="$" />
          </Field>
          <Field label="Timing">
            <Segmented size="sm" value={timing} onChange={setTiming}
              options={[{ value: 'spread', label: 'Spread evenly' }, { value: 'months', label: 'In specific months' }]} />
          </Field>
          {timing === 'spread' ? (
            <p className="text-xs text-slate-500">
              <span className="tabular-nums">${Math.round((Number(annualAmount) || 0) / 12).toLocaleString()}</span> per month.
            </p>
          ) : (
            <Field label="Paid in" hint={months.length === 0 ? 'Select at least one month.' : months.length > 1
              ? `Split evenly: $${Math.round((Number(annualAmount) || 0) / months.length).toLocaleString()} per payment` : null}>
              <MonthPicker months={months} onChange={setMonths} />
            </Field>
          )}
        </>
      )}

      {method === 'fixed' && (
        <Field label="Amount per month" hint={`Trailing average is $${Math.round(row.avg).toLocaleString()}/mo.`}>
          <NumberInput value={fixedAmount} onChange={setFixedAmount} prefix="$" />
        </Field>
      )}
    </Modal>
  )
}
