'use client'
import { downloadCSV } from '@/lib/exportCsv'

// Downloads the current report as CSV. `getRows` is called on click so the
// export always reflects the filters and view on screen.
export default function ExportCsvButton({ filename, getRows, className, label = 'Export CSV' }) {
  return (
    <button
      type="button"
      onClick={() => downloadCSV(typeof filename === 'function' ? filename() : filename, getRows())}
      className={className || 'px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50'}
    >
      {label}
    </button>
  )
}
