import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'

const STATUS_LABEL = { pending: 'Pending', done: 'Done', cancelled: 'Cancelled', overdue: 'Overdue' }

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TODAY = todayISO()
const TODAY_MS = Date.parse(TODAY)

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
function fmtAmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function derive(row) {
  const dayDiff = row.due_date ? Math.round((Date.parse(row.due_date) - TODAY_MS) / 86400000) : null
  const overdue = row.status === 'pending' && dayDiff !== null && dayDiff < 0
  return { ...row, dayDiff, overdue, effStatus: overdue ? 'overdue' : row.status }
}

const EMPTY_FORM = {
  date_sent: TODAY, vendor: '', vendor_full: '', description: '', entity: '', entity_full: '',
  amount: '', currency: 'SGD', method: 'PayNow', due_date: TODAY, email_url: '',
}

export default function Tracker() {
  const { user, signOut } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState('due_date')
  const [sortDir, setSortDir] = useState(1)
  const [openId, setOpenId] = useState(null)
  const [edit, setEdit] = useState(null) // { status, notes, ref, payment_date }
  const [saving, setSaving] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('payment_requests').select('*').order('due_date', { ascending: true })
    if (error) setErr(error.message)
    else setRows(data.map(derive))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    let list = rows
    if (status !== 'all') list = list.filter((r) => r.effStatus === status)
    if (q.trim()) {
      const needle = q.trim().toLowerCase()
      list = list.filter((r) =>
        [r.vendor, r.vendor_full, r.description, r.entity, r.ref].some((v) => v && v.toLowerCase().includes(needle))
      )
    }
    const dir = sortDir
    return [...list].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return av > bv ? dir : av < bv ? -dir : 0
    })
  }, [rows, status, q, sortKey, sortDir])

  const counts = useMemo(() => {
    const c = { all: rows.length, pending: 0, overdue: 0, done: 0, cancelled: 0 }
    rows.forEach((r) => { c[r.effStatus] = (c[r.effStatus] || 0) + 1 })
    return c
  }, [rows])

  const outstanding = useMemo(() => {
    const t = {}
    rows.forEach((r) => { if (r.status === 'pending') t[r.currency] = (t[r.currency] || 0) + Number(r.amount) })
    return Object.keys(t).sort().map((c) => `${c} ${fmtAmt(t[c])}`).join('  ·  ') || '—'
  }, [rows])

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => -d)
    else { setSortKey(key); setSortDir(1) }
  }

  function openRow(row) {
    if (openId === row.id) { setOpenId(null); setEdit(null); return }
    setOpenId(row.id)
    setEdit({ status: row.status, notes: row.notes || '', ref: row.ref || '', payment_date: row.payment_date || '' })
  }

  async function saveEdit(row) {
    setSaving(true)
    const patch = {
      status: edit.status,
      notes: edit.notes,
      ref: edit.ref || null,
      payment_date: edit.payment_date || null,
    }
    const { error } = await supabase.from('payment_requests').update(patch).eq('id', row.id)
    if (error) { setErr(error.message) } else { await load() }
    setSaving(false)
  }

  async function submitAdd(e) {
    e.preventDefault()
    setSaving(true)
    const syntheticId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { error } = await supabase.from('payment_requests').insert({
      request_message_id: syntheticId,
      request_thread_id: syntheticId,
      date_sent: form.date_sent,
      vendor: form.vendor,
      vendor_full: form.vendor_full || form.vendor,
      description: form.description,
      entity: form.entity,
      entity_full: form.entity_full || form.entity,
      amount: Number(form.amount),
      currency: form.currency,
      method: form.method,
      due_date: form.due_date,
      email_url: form.email_url || null,
      notes: 'Added manually.',
    })
    setSaving(false)
    if (error) { setErr(error.message); return }
    setShowAdd(false)
    setForm(EMPTY_FORM)
    await load()
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-9">
      <div className="flex justify-between items-start gap-6 flex-wrap">
        <div>
          <p className="font-mono text-xs tracking-widest uppercase mb-2" style={{ color: 'var(--accent)' }}>Accounts Payable</p>
          <h1 className="text-3xl font-semibold">Payment Request Tracker</h1>
          <p className="mt-2 text-sm max-w-prose" style={{ color: 'var(--text-muted)' }}>
            Synced automatically from Gmail every 30 minutes.{' '}
            <b style={{ color: 'var(--text-2)' }}>Outstanding: {outstanding}</b>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{user?.email}</span>
          <button onClick={() => load()} className="rounded-full border px-4 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-2)' }}>
            Refresh
          </button>
          <button onClick={() => setShowAdd(true)} className="rounded-full px-4 py-2 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
            + Add request
          </button>
          <button onClick={signOut} className="rounded-full border px-4 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-2)' }}>
            Sign out
          </button>
        </div>
      </div>

      {err && (
        <p className="mt-4 text-sm rounded-lg px-3 py-2" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{err}</p>
      )}

      <div className="mt-7 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        {['all', 'pending', 'overdue', 'done', 'cancelled'].map((k) => (
          <button
            key={k}
            onClick={() => setStatus(k)}
            className="text-left rounded-2xl border p-4"
            style={{
              background: 'var(--surface)',
              borderColor: status === k ? 'var(--accent)' : 'var(--border)',
              boxShadow: status === k ? 'inset 0 0 0 1px var(--accent)' : 'none',
            }}
          >
            <div className="font-display text-2xl font-semibold tabular">{counts[k] || 0}</div>
            <div className="mt-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              {k === 'all' ? 'All requests' : STATUS_LABEL[k]}
            </div>
          </button>
        ))}
      </div>

      <div className="mt-7 flex items-end gap-4 flex-wrap pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Search
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Vendor, entity, ref…"
            className="rounded-lg border px-3 py-2 text-sm font-normal normal-case tracking-normal min-w-56"
            style={{ borderColor: 'var(--border-2)', background: 'var(--surface)', color: 'var(--text)' }}
          />
        </label>
        <span className="ml-auto text-sm" style={{ color: 'var(--text-muted)' }}>
          <b style={{ color: 'var(--text-2)' }}>{filtered.length}</b> of {rows.length}
        </span>
      </div>

      <div className="mt-4 rounded-2xl border overflow-x-auto" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            <tr style={{ background: 'var(--surface-alt)' }}>
              {[
                ['vendor', 'Vendor'], ['entity', 'Entity'], ['amount', 'Amount'],
                ['due_date', 'Due'], ['status', 'Status'], ['payment_date', 'Settled'],
              ].map(([key, label]) => (
                <th
                  key={key}
                  onClick={() => toggleSort(key)}
                  className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide cursor-pointer whitespace-nowrap"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {label} {sortKey === key ? (sortDir === 1 ? '↑' : '↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-10 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center" style={{ color: 'var(--text-muted)' }}>No requests match.</td></tr>
            )}
            {!loading && filtered.map((r) => (
              <RowGroup key={r.id} row={r} open={openId === r.id} onToggle={() => openRow(r)}
                edit={edit} setEdit={setEdit} onSave={() => saveEdit(r)} saving={saving} />
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddModal form={form} setForm={setForm} onClose={() => setShowAdd(false)} onSubmit={submitAdd} saving={saving} />
      )}
    </div>
  )
}

function RowGroup({ row: r, open, onToggle, edit, setEdit, onSave, saving }) {
  const pillColor = {
    done: ['var(--good-soft)', 'var(--good)'],
    pending: ['var(--warn-soft)', 'var(--warn)'],
    overdue: ['var(--critical-soft)', 'var(--critical)'],
    cancelled: ['var(--mute-soft)', 'var(--mute)'],
  }[r.effStatus]

  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer" style={{ borderTop: '1px solid var(--border)' }}>
        <td className="px-4 py-3">
          <div className="font-semibold">{r.vendor}</div>
          <div className="text-xs mt-0.5 max-w-[28ch] truncate" style={{ color: 'var(--text-muted)' }}>{r.description}</div>
        </td>
        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-2)' }}>{r.entity}</td>
        <td className="px-4 py-3 font-mono whitespace-nowrap">
          {r.currency} {fmtAmt(r.amount)}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          {fmtDate(r.due_date)}
          {r.status === 'pending' && (
            <div className="text-xs font-mono mt-0.5" style={{ color: r.overdue ? 'var(--critical)' : 'var(--text-muted)' }}>
              {r.overdue ? `${Math.abs(r.dayDiff)}d overdue` : `in ${r.dayDiff}d`}
            </div>
          )}
        </td>
        <td className="px-4 py-3">
          <span className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: pillColor[0], color: pillColor[1] }}>
            {STATUS_LABEL[r.effStatus]}
          </span>
        </td>
        <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-2)' }}>
          {r.payment_date ? fmtDate(r.payment_date) : '—'}
          {r.ref && <div style={{ color: 'var(--text-muted)' }}>{r.ref}</div>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="px-6 py-5" style={{ background: 'var(--surface-alt)', borderBottom: '1px solid var(--border-2)' }}>
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
              <Field k="Full vendor" v={r.vendor_full} />
              <Field k="Full entity" v={r.entity_full} />
              <Field k="Date sent" v={fmtDate(r.date_sent)} />
              <Field k="Method" v={r.method} />
              <Field k="Request email" v={r.email_url ? <a href={r.email_url} target="_blank" rel="noreferrer" className="underline">Open in Gmail</a> : '—'} />
              <Field k="Settlement email" v={r.slip_url ? <a href={r.slip_url} target="_blank" rel="noreferrer" className="underline">Open in Gmail</a> : '—'} />
            </div>

            {edit && (
              <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Status
                  <select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}
                    className="rounded-lg border px-2 py-2 text-sm font-normal normal-case" style={{ borderColor: 'var(--border-2)', background: 'var(--surface)', color: 'var(--text)' }}>
                    <option value="pending">Pending</option>
                    <option value="done">Done</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Payment date
                  <input type="date" value={edit.payment_date} onChange={(e) => setEdit({ ...edit, payment_date: e.target.value })}
                    className="rounded-lg border px-2 py-2 text-sm font-normal normal-case" style={{ borderColor: 'var(--border-2)', background: 'var(--surface)', color: 'var(--text)' }} />
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Reference
                  <input value={edit.ref} onChange={(e) => setEdit({ ...edit, ref: e.target.value })}
                    className="rounded-lg border px-2 py-2 text-sm font-normal normal-case" style={{ borderColor: 'var(--border-2)', background: 'var(--surface)', color: 'var(--text)' }} />
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide col-span-full" style={{ color: 'var(--text-muted)' }}>
                  Notes
                  <textarea value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} rows={2}
                    className="rounded-lg border px-2 py-2 text-sm font-normal normal-case" style={{ borderColor: 'var(--border-2)', background: 'var(--surface)', color: 'var(--text)' }} />
                </label>
                <div>
                  <button onClick={onSave} disabled={saving}
                    className="rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-60"
                    style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function Field({ k, v }) {
  return (
    <div>
      <div className="text-[.66rem] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{k}</div>
      <div className="mt-0.5 text-sm" style={{ color: 'var(--text-2)' }}>{v}</div>
    </div>
  )
}

function AddModal({ form, setForm, onClose, onSubmit, saving }) {
  function upd(k) { return (e) => setForm({ ...form, [k]: e.target.value }) }
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(12,18,26,.5)' }} />
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        className="relative mx-auto mt-[8vh] w-[calc(100%-2.5rem)] max-w-lg rounded-2xl p-6 max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--surface)', border: '1px solid var(--border-2)' }}
      >
        <h3 className="text-lg font-semibold mb-1">Add payment request</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
          For requests the Gmail sync missed. It won't be re-matched against settlement emails automatically until the next sync run inspects it.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <L label="Vendor"><input required value={form.vendor} onChange={upd('vendor')} className="in" /></L>
          <L label="Full vendor name"><input value={form.vendor_full} onChange={upd('vendor_full')} className="in" /></L>
          <L label="Description" full><input required value={form.description} onChange={upd('description')} className="in" /></L>
          <L label="Entity"><input required value={form.entity} onChange={upd('entity')} className="in" /></L>
          <L label="Full entity name"><input value={form.entity_full} onChange={upd('entity_full')} className="in" /></L>
          <L label="Amount"><input required type="number" step="0.01" value={form.amount} onChange={upd('amount')} className="in" /></L>
          <L label="Currency">
            <select value={form.currency} onChange={upd('currency')} className="in">
              <option>SGD</option><option>USD</option><option>CNY</option><option>MYR</option>
            </select>
          </L>
          <L label="Method">
            <select value={form.method} onChange={upd('method')} className="in">
              <option>PayNow</option><option>T/T</option><option>Bank Transfer</option>
            </select>
          </L>
          <L label="Date sent"><input required type="date" value={form.date_sent} onChange={upd('date_sent')} className="in" /></L>
          <L label="Due date"><input required type="date" value={form.due_date} onChange={upd('due_date')} className="in" /></L>
          <L label="Request email URL" full><input value={form.email_url} onChange={upd('email_url')} placeholder="https://mail.google.com/mail/u/0/#all/…" className="in" /></L>
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <button type="button" onClick={onClose} className="rounded-full border px-4 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-2)' }}>Cancel</button>
          <button type="submit" disabled={saving} className="rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
            {saving ? 'Adding…' : 'Add request'}
          </button>
        </div>
        <style>{`.in{font:inherit;font-size:.875rem;color:var(--text);background:var(--bg);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;width:100%}`}</style>
      </form>
    </div>
  )
}

function L({ label, full, children }) {
  return (
    <label className={`flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide ${full ? 'col-span-2' : ''}`} style={{ color: 'var(--text-muted)' }}>
      {label}
      {children}
    </label>
  )
}
