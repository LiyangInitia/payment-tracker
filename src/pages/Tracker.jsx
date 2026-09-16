import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'

const ACCOUNTS_EMAIL = 'accounts@initia.sg'
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ---------- icons (ported verbatim from the original artifact) ----------
const IconMail = (p) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
  </svg>
)
const IconDoc = (p) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M14 3v5h5" /><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M9 13h6M9 17h4" />
  </svg>
)
const IconChat = (p) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20.5l1.6-5.2A8.5 8.5 0 1 1 21 11.5z" />
  </svg>
)
const IconSearch = (p) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" {...p}>
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
)

// ---------- helpers (ported from the original artifact's JS) ----------
function pad(n) { return n < 10 ? '0' + n : '' + n }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const TODAY = todayISO()
const TODAY_MS = Date.parse(TODAY)

function fmtDate(iso) {
  if (!iso) return '—'
  const p = iso.split('-')
  return `${parseInt(p[2], 10)} ${MON[parseInt(p[1], 10) - 1]} ${p[0]}`
}
function fmtAmt(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function monthKey(iso) { return iso ? iso.slice(0, 7) : '' }
function monthLabel(k) { const p = k.split('-'); return `${MON[parseInt(p[1], 10) - 1]} ${p[0]}` }

function derive(r) {
  const dayDiff = r.due_date ? Math.round((Date.parse(r.due_date) - TODAY_MS) / 86400000) : null
  const overdue = r.status === 'pending' && dayDiff !== null && dayDiff < 0
  return { ...r, dayDiff, overdue, effStatus: overdue ? 'overdue' : r.status }
}
function currencyTotals(rows, pred) {
  const t = {}
  rows.forEach((r) => { if (pred(r)) t[r.currency] = (t[r.currency] || 0) + Number(r.amount) })
  return Object.keys(t).sort().map((c) => `${c} ${fmtAmt(t[c])}`).join('  ·  ')
}

function gmailSearch(q) { return 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(q) }
function amtVariants(r) {
  const n = Number(r.amount)
  return `("${n.toFixed(2)}" OR "${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}")`
}
function emailLink(r) {
  if (r.email_url) return { url: r.email_url, stored: true }
  return { url: gmailSearch(`in:sent to:${ACCOUNTS_EMAIL} "${r.vendor}" ${amtVariants(r)}`), stored: false }
}
function slipLink(r) {
  if (r.slip_url) return { url: r.slip_url, stored: true }
  if (r.ref) return { url: gmailSearch(`("${r.ref}") (subject:"details of a transaction" OR "payment slip")`), stored: false }
  if (r.status !== 'done') return null
  return { url: gmailSearch(`(subject:"details of a transaction" OR "payment slip") "${r.vendor}" ${amtVariants(r)}`), stored: false }
}
function waMessage(r) { return `Hi Accounts team, may I check on this payment to ${r.vendor_full} for ${r.description} for ${r.entity_full}? Thank you` }
function waLink(msg) { return 'https://wa.me/?text=' + encodeURIComponent(msg) }

function dueTag(r) {
  if (r.status === 'done' || r.status === 'cancelled' || r.dayDiff === null) return null
  if (r.dayDiff < 0) return { cls: 'crit', text: `${Math.abs(r.dayDiff)}d overdue` }
  if (r.dayDiff === 0) return { cls: 'warn', text: 'due today' }
  if (r.dayDiff <= 3) return { cls: 'warn', text: `in ${r.dayDiff}d` }
  return { cls: 'calm', text: `in ${r.dayDiff}d` }
}
const dueTagColor = { crit: 'var(--critical)', warn: 'var(--warn)', calm: 'var(--text-muted)' }

// ---------- theme (light / dark / system, ported from the original) ----------
function useTheme() {
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('ptracker-theme') } catch { return null } })
  useEffect(() => {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode)
    else document.documentElement.removeAttribute('data-theme')
  }, [mode])
  function toggle() {
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const next = mode ? (mode === 'dark' ? 'light' : 'dark') : (sysDark ? 'light' : 'dark')
    setMode(next)
    try { localStorage.setItem('ptracker-theme', next) } catch { /* private-window etc — theme just won't persist */ }
  }
  const dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return { dark, toggle }
}

// ---------- "payment confirmed" notification dot (per-browser, localStorage) ----------
const ACK_KEY = 'ptracker-ack-v1'
function ackSig(r) { return `${r.payment_date || ''}|${r.ref || ''}` }
function useAckMap(rows) {
  const [ackMap, setAckMap] = useState(() => {
    try {
      const raw = localStorage.getItem(ACK_KEY)
      if (raw !== null) return JSON.parse(raw) || {}
    } catch { /* fall through to baseline */ }
    return null // null = "not yet baselined"; baselined once rows are known
  })
  useEffect(() => {
    if (ackMap !== null || !rows.length) return
    // First time this feature has run in this browser: baseline every already-done
    // row as acknowledged, so existing history doesn't retroactively light up.
    const baseline = {}
    rows.forEach((r) => { if (r.status === 'done') baseline[r.id] = ackSig(r) })
    setAckMap(baseline)
    try { localStorage.setItem(ACK_KEY, JSON.stringify(baseline)) } catch { /* ignore */ }
  }, [rows, ackMap])
  function acknowledge(row) {
    setAckMap((prev) => {
      const next = { ...prev, [row.id]: ackSig(row) }
      try { localStorage.setItem(ACK_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  function isUnseenDone(r) { return r.status === 'done' && (ackMap || {})[r.id] !== ackSig(r) }
  return { isUnseenDone, acknowledge }
}

const EMPTY_ADD = {
  vendor: '', description: '', entity: '', amount: '', currency: 'SGD', method: 'PayNow',
  date_sent: TODAY, due_date: '', email_url: '',
}

export default function Tracker() {
  const { user, signOut } = useAuth()
  const { dark, toggle: toggleTheme } = useTheme()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [toastMsg, setToastMsg] = useState(null)

  const [status, setStatus] = useState('all')
  const [month, setMonth] = useState('all')
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState('date_sent')
  const [sortDir, setSortDir] = useState(-1)

  const [openId, setOpenId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_ADD)
  const [reminderList, setReminderList] = useState(null) // array of rows, or null
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [busy, setBusy] = useState(false)

  const { isUnseenDone, acknowledge } = useAckMap(rows)

  function toast(msg) { setToastMsg(msg); clearTimeout(toast._t); toast._t = setTimeout(() => setToastMsg(null), 3200) }

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('payment_requests').select('*').eq('dismissed', false)
    if (error) toast(error.message)
    else setRows(data.map(derive))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const months = useMemo(() => {
    const keys = new Set(rows.map((r) => monthKey(r.date_sent)).filter(Boolean))
    return [...keys].sort().reverse()
  }, [rows])

  const visibleRows = useMemo(() => {
    return rows.filter((r) => {
      if (status === 'pending' && r.status !== 'pending') return false
      if (status === 'overdue' && !r.overdue) return false
      if (status === 'cancelled' && r.status !== 'cancelled') return false
      if (status === 'done' && r.status !== 'done') return false
      if (month !== 'all' && monthKey(r.date_sent) !== month) return false
      if (q.trim()) {
        const hay = `${r.vendor_full} ${r.vendor} ${r.description} ${r.entity_full} ${r.ref || ''} ${r.method}`.toLowerCase()
        if (!hay.includes(q.trim().toLowerCase())) return false
      }
      return true
    })
  }, [rows, status, month, q])

  const STATUS_RANK = { overdue: 0, pending: 1, cancelled: 2, done: 3 }
  function sortVal(r, key) {
    if (key === 'effStatus') return STATUS_RANK[r.effStatus]
    if (key === 'vendor') return r.vendor_full.toLowerCase()
    if (key === 'entity') return r.entity_full.toLowerCase()
    if (key === 'amount') return Number(r.amount)
    if (key === 'id') return r.id
    if (key === 'payment_date') return r.payment_date ? Date.parse(r.payment_date) : 0
    return Date.parse(r[key])
  }
  const sortedRows = useMemo(() => {
    return [...visibleRows].sort((a, b) => {
      const va = sortVal(a, sortKey), vb = sortVal(b, sortKey)
      if (va < vb) return -1 * sortDir
      if (va > vb) return 1 * sortDir
      return (a.id - b.id) * sortDir
    })
  }, [visibleRows, sortKey, sortDir])

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => -d)
    else { setSortKey(key); setSortDir(key === 'amount' || key === 'date_sent' || key === 'payment_date' ? -1 : 1) }
  }

  const counts = useMemo(() => {
    const c = { all: rows.length, done: 0, pending: 0, overdue: 0, cancelled: 0 }
    let unseen = 0
    rows.forEach((r) => {
      if (r.status === 'done') c.done++
      else if (r.status === 'cancelled') c.cancelled++
      else if (r.status === 'pending') { c.pending++; if (r.overdue) c.overdue++ }
      if (isUnseenDone(r)) unseen++
    })
    return { ...c, unseen }
  }, [rows, isUnseenDone])

  const outstanding = currencyTotals(rows, (r) => r.status === 'pending')
  const overdueTotal = currencyTotals(rows, (r) => r.overdue)
  const overdueVisible = visibleRows.filter((r) => r.overdue)
  const dirty = status !== 'all' || month !== 'all' || q !== ''

  function openRow(row) {
    if (isUnseenDone(row)) acknowledge(row)
    if (openId === row.id) { setOpenId(null); setEditingId(null); return }
    setOpenId(row.id)
    setEditingId(null)
  }

  async function patchRow(id, patch) {
    setBusy(true)
    const { error } = await supabase.from('payment_requests').update(patch).eq('id', id)
    setBusy(false)
    if (error) { toast(error.message); return false }
    await load()
    return true
  }

  async function markPaid(row) {
    const paymentDate = row.payment_date || TODAY
    if (await patchRow(row.id, { status: 'done', payment_date: paymentDate })) {
      acknowledge({ ...row, payment_date: paymentDate })
      toast(`Marked as paid on ${fmtDate(paymentDate)} — use Edit details to add the OCBC reference.`)
    }
  }
  async function setStatusQuick(row, s) {
    const patch = { status: s }
    if (s === 'pending') patch.payment_date = null
    if (await patchRow(row.id, patch)) toast(s === 'cancelled' ? 'Request cancelled.' : 'Reopened as pending.')
  }

  async function saveEdit(row, form) {
    const patch = {
      vendor: form.vendor_full, vendor_full: form.vendor_full,
      entity: form.entity_full, entity_full: form.entity_full,
      description: form.description, amount: parseFloat(form.amount) || 0, currency: form.currency,
      method: form.method, date_sent: form.date_sent, due_date: form.due_date,
      status: form.status, payment_date: form.status === 'pending' ? null : (form.payment_date || null),
      ref: form.ref || null, email_url: form.email_url || null, slip_url: form.slip_url || null,
      notes: form.notes,
    }
    if (await patchRow(row.id, patch)) {
      if (form.status === 'done') acknowledge({ ...row, ...patch })
      setEditingId(null)
      toast('Changes saved.')
    }
  }

  async function confirmDelete(row) {
    setBusy(true)
    const { error } = await supabase.from('payment_requests').update({ dismissed: true }).eq('id', row.id)
    setBusy(false)
    setDeleteTarget(null)
    if (error) { toast(error.message); return }
    if (openId === row.id) setOpenId(null)
    toast(`Request #${row.id} deleted — the sync won't re-add it.`)
    await load()
  }

  async function submitAdd(e) {
    e.preventDefault()
    if (!addForm.vendor || !addForm.description) { toast('Supplier name and item details are required.'); return }
    const synthetic = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setBusy(true)
    const { data, error } = await supabase.from('payment_requests').insert({
      request_message_id: synthetic, request_thread_id: synthetic,
      date_sent: addForm.date_sent || TODAY,
      vendor: addForm.vendor, vendor_full: addForm.vendor,
      description: addForm.description,
      entity: addForm.entity || '—', entity_full: addForm.entity || '—',
      amount: parseFloat(addForm.amount) || 0, currency: addForm.currency || 'SGD',
      method: addForm.method || 'PayNow',
      due_date: addForm.due_date || addForm.date_sent || TODAY,
      email_url: addForm.email_url || null,
      notes: `Added manually on ${fmtDate(TODAY)}.`,
    }).select().single()
    setBusy(false)
    if (error) { toast(error.message); return }
    setShowAdd(false)
    setAddForm(EMPTY_ADD)
    setStatus('all'); setMonth('all'); setQ('')
    toast(`Request #${data.id} added.`)
    await load()
    setOpenId(data.id)
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-9">
      {/* ---------- masthead ---------- */}
      <div className="flex justify-between items-start gap-6 flex-wrap">
        <div>
          <p className="font-mono text-xs tracking-widest uppercase mb-2" style={{ color: 'var(--accent)' }}>
            Accounts Payable · Initia International
          </p>
          <h1 className="text-3xl font-semibold">Payment Request Tracker</h1>
          <p className="mt-3 text-sm max-w-prose" style={{ color: 'var(--text-muted)' }}>
            A running record of payment requests sent to {ACCOUNTS_EMAIL}, cross-checked against OCBC
            transaction advices. Synced automatically from Gmail every 30 minutes; filter by status or month to
            reconcile against the bank.
          </p>
          <p className="mt-3.5 font-mono text-sm" style={{ color: 'var(--text-2)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Outstanding (pending):</span> {outstanding || '—'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs mr-1" style={{ color: 'var(--text-muted)' }}>{user?.email}</span>
          <button onClick={() => setShowAdd(true)} className="rounded-full px-4 py-2 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
            + Add request
          </button>
          <button onClick={toggleTheme} className="rounded-full border px-4 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-2)' }}>
            {dark ? '☀ Light' : '☽ Dark'}
          </button>
          <button onClick={signOut} className="rounded-full border px-4 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-2)' }}>
            Sign out
          </button>
        </div>
      </div>

      {/* ---------- KPI tiles ---------- */}
      <div className="mt-7 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {[
          ['all', 'All requests', null],
          ['done', 'Payment done', counts.unseen ? counts.unseen : null],
          ['pending', 'Pending', null],
          ['overdue', 'Overdue', null],
          ['cancelled', 'Cancelled', null],
        ].map(([k, label, badge]) => (
          <button
            key={k}
            onClick={() => setStatus((s) => (s === k && k !== 'all' ? 'all' : k))}
            className="relative text-left rounded-2xl border p-4"
            style={{ background: 'var(--surface)', borderColor: status === k ? 'var(--accent)' : 'var(--border)', boxShadow: status === k ? 'inset 0 0 0 1px var(--accent)' : 'none' }}
          >
            {badge ? (
              <span className="absolute -top-2 -right-2 min-w-[19px] h-[19px] px-1 rounded-full text-white text-[.7rem] font-bold flex items-center justify-center" style={{ background: 'var(--critical)', boxShadow: '0 0 0 2px var(--surface)' }}>
                {badge}
              </span>
            ) : null}
            <div className="font-display text-2xl font-semibold tabular">{counts[k] ?? 0}</div>
            <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Dot k={k} /> {label}
            </div>
            <div className="mt-1.5 font-mono text-[.7rem] min-h-[1em]" style={{ color: 'var(--text-muted)' }}>
              {k === 'overdue' ? overdueTotal : k === 'pending' && counts.overdue ? `incl. ${counts.overdue} overdue` : ''}
            </div>
          </button>
        ))}
      </div>

      {/* ---------- filter bar ---------- */}
      <div className="mt-7 flex items-end gap-4 flex-wrap pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="ctl">
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="overdue">Overdue</option>
            <option value="cancelled">Cancelled</option>
            <option value="done">Payment done</option>
          </select>
        </Field>
        <Field label="Month sent">
          <select value={month} onChange={(e) => setMonth(e.target.value)} className="ctl">
            <option value="all">All months</option>
            {months.map((k) => <option key={k} value={k}>{monthLabel(k)}</option>)}
          </select>
        </Field>
        <Field label="Search">
          <div className="relative">
            <IconSearch style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-muted)' }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vendor, item, entity, reference…" className="ctl pl-8 min-w-[220px]" />
          </div>
        </Field>
        <div className="ml-auto flex items-center gap-3">
          {overdueVisible.length >= 2 && (
            <button onClick={() => setReminderList(overdueVisible)} className="rounded-full px-3.5 py-2 text-xs font-semibold text-white" style={{ background: 'var(--wa, #1f7a4d)' }}>
              Draft reminders · {overdueVisible.length} overdue
            </button>
          )}
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Showing <b style={{ color: 'var(--text-2)' }}>{sortedRows.length}</b> of {rows.length}
          </span>
          {dirty && (
            <button onClick={() => { setStatus('all'); setMonth('all'); setQ('') }} className="rounded-lg border px-3 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-2)', color: 'var(--text-muted)' }}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ---------- legend ---------- */}
      <div className="flex gap-4 flex-wrap my-3.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span className="inline-flex items-center gap-1.5"><Dot k="done" /> Payment done</span>
        <span className="inline-flex items-center gap-1.5"><Dot k="pending" /> Pending</span>
        <span className="inline-flex items-center gap-1.5"><Dot k="overdue" /> Overdue</span>
        <span className="inline-flex items-center gap-1.5"><Dot k="cancelled" /> Cancelled</span>
      </div>

      {/* ---------- table ---------- */}
      <div className="rounded-2xl border overflow-x-auto" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <table className="w-full min-w-[1000px] border-collapse text-sm">
          <thead>
            <tr style={{ background: 'var(--surface-alt)' }}>
              {[
                ['id', '#'], ['date_sent', 'Sent'], ['vendor', 'Vendor / item'], ['entity', 'Entity'],
                ['amount', 'Amount'], ['due_date', 'Due'], ['effStatus', 'Status'], ['payment_date', 'Settled'], [null, 'Links & actions'],
              ].map(([key, label]) => (
                <th
                  key={label}
                  onClick={key ? () => toggleSort(key) : undefined}
                  className={`text-left px-3.5 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${key ? 'cursor-pointer' : ''}`}
                  style={{ color: 'var(--text-muted)' }}
                >
                  {label} {sortKey === key ? <span style={{ color: 'var(--accent)' }}>{sortDir === 1 ? '▲' : '▼'}</span> : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="px-4 py-10 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</td></tr>}
            {!loading && sortedRows.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center" style={{ color: 'var(--text-muted)' }}>No requests match these filters.</td></tr>}
            {!loading && sortedRows.map((r) => (
              <RowGroup
                key={r.id} row={r} open={openId === r.id} editing={editingId === r.id}
                unseenDone={isUnseenDone(r)} busy={busy}
                onToggle={() => openRow(r)}
                onEdit={() => setEditingId(r.id)} onCancelEdit={() => setEditingId(null)}
                onSave={(form) => saveEdit(r, form)}
                onMarkPaid={() => markPaid(r)}
                onCancelRequest={() => setStatusQuick(r, 'cancelled')}
                onReopen={() => setStatusQuick(r, 'pending')}
                onDelete={() => setDeleteTarget(r)}
                onRemind={() => setReminderList([r])}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------- footer ---------- */}
      <footer className="mt-9 pt-5 border-t text-sm leading-relaxed" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
        <p className="max-w-prose mb-2">
          <b style={{ color: 'var(--text-2)' }}>Cross-checking:</b> the mail and slip icons on each row open Gmail — a
          saved link when one exists, otherwise a Gmail search for the sent request or the OCBC advice. A blank
          Settled column means no advice has been recorded, not necessarily that payment did not occur.
        </p>
        <p className="max-w-prose mb-2">
          Overdue rows carry a WhatsApp button that drafts a reminder to the Accounts team. Currency totals are kept
          separate; amount-sort orders by numeric value across both currencies.
        </p>
        <p className="max-w-prose mb-2">
          A red dot marks a request that just turned Payment done since you last looked, with a count on the Payment
          done tile above — click the row to acknowledge it and clear the dot.
        </p>
        <p className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
          Live view · {rows.length} requests · as of {fmtDate(TODAY)} · changes saved to Supabase
        </p>
      </footer>

      {showAdd && <AddModal form={addForm} setForm={setAddForm} onClose={() => setShowAdd(false)} onSubmit={submitAdd} busy={busy} />}
      {reminderList && <ReminderModal list={reminderList} onClose={() => setReminderList(null)} onToast={toast} />}
      {deleteTarget && <DeleteModal row={deleteTarget} busy={busy} onCancel={() => setDeleteTarget(null)} onConfirm={() => confirmDelete(deleteTarget)} />}
      {toastMsg && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-7 px-4.5 py-2.5 rounded-full text-sm font-medium z-50" style={{ background: 'var(--text)', color: 'var(--bg)' }}>
          {toastMsg}
        </div>
      )}

      <style>{`
        .ctl { font: inherit; font-size: .88rem; color: var(--text); background: var(--surface); border: 1px solid var(--border-2); border-radius: 9px; padding: 9px 12px; min-width: 160px; }
        .ctl:focus-visible { outline: none; border-color: var(--accent); }
      `}</style>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1.5 text-[.68rem] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
      {label}
      {children}
    </label>
  )
}

function Dot({ k }) {
  const color = { all: 'var(--accent)', done: 'var(--good)', pending: 'var(--warn)', overdue: 'var(--critical)', cancelled: 'var(--mute)' }[k]
  return <span className="inline-block w-2 h-2 rounded-full flex-none" style={{ background: color }} />
}

function StatusPill({ effStatus }) {
  const map = {
    done: ['var(--good-soft)', 'var(--good)', 'Done'],
    pending: ['var(--warn-soft)', 'var(--warn)', 'Pending'],
    overdue: ['var(--critical-soft)', 'var(--critical)', 'Overdue'],
    cancelled: ['var(--mute-soft)', 'var(--mute)', 'Cancelled'],
  }
  const [bg, fg, label] = map[effStatus]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: bg, color: fg }}>
      <Dot k={effStatus} /> {label}
    </span>
  )
}

function RowGroup({ row: r, open, editing, unseenDone, busy, onToggle, onEdit, onCancelEdit, onSave, onMarkPaid, onCancelRequest, onReopen, onDelete, onRemind }) {
  const em = emailLink(r), sl = slipLink(r)
  const dt = dueTag(r)
  const stripeColor = r.overdue ? 'var(--critical)' : unseenDone ? 'var(--critical)' : 'transparent'

  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer group" style={{ borderTop: '1px solid var(--border)', boxShadow: `inset 3px 0 0 ${stripeColor}` }}>
        <td className="px-3.5 py-3 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="inline-block mr-1.5 transition-transform" style={{ transform: open ? 'rotate(90deg)' : 'none', color: open ? 'var(--accent)' : 'var(--text-muted)' }}>›</span>
          {r.id}
        </td>
        <td className="px-3.5 py-3 whitespace-nowrap">{fmtDate(r.date_sent)}</td>
        <td className="px-3.5 py-3">
          <div className="font-semibold flex items-center gap-1.5">
            {unseenDone && <span className="inline-block w-2 h-2 rounded-full flex-none" style={{ background: 'var(--critical)', boxShadow: '0 0 0 2px var(--critical-soft)' }} title="Payment confirmed — click to acknowledge" />}
            {r.vendor}
          </div>
          <div className="text-xs mt-0.5 max-w-[32ch] truncate" style={{ color: 'var(--text-muted)' }}>{r.description}</div>
        </td>
        <td className="px-3.5 py-3">
          <span className="text-xs inline-block px-1.5 py-0.5 rounded-md border whitespace-nowrap" style={{ color: 'var(--text-2)', background: 'var(--surface-alt)', borderColor: 'var(--border)' }}>{r.entity}</span>
        </td>
        <td className="px-3.5 py-3 font-mono whitespace-nowrap">
          <span style={{ color: 'var(--text-muted)', fontSize: '.76rem' }}>{r.currency}</span> {fmtAmt(r.amount)}
        </td>
        <td className="px-3.5 py-3 whitespace-nowrap">
          {fmtDate(r.due_date)}
          {dt && <span className="block mt-0.5 font-mono text-[.7rem] font-medium" style={{ color: dueTagColor[dt.cls] }}>{dt.text}</span>}
        </td>
        <td className="px-3.5 py-3"><StatusPill effStatus={r.effStatus} /></td>
        <td className="px-3.5 py-3 font-mono text-xs whitespace-nowrap" style={{ color: r.payment_date ? 'var(--text-2)' : 'var(--text-muted)' }}>
          {r.payment_date ? <>{fmtDate(r.payment_date)}<span className="block" style={{ color: 'var(--text-muted)' }}>{r.ref}</span></> : '—'}
        </td>
        <td className="px-3.5 py-3">
          <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
            <a href={em.url} target="_blank" rel="noreferrer" title={em.stored ? 'Open the saved request email in Gmail' : 'Search Gmail for the sent request email'} className="iconbtn"><IconMail /></a>
            {sl ? (
              <a href={sl.url} target="_blank" rel="noreferrer" title={sl.stored ? 'Open the saved OCBC slip in Gmail' : 'Search Gmail for the OCBC advice'} className="iconbtn"><IconDoc /></a>
            ) : (
              <span className="iconbtn opacity-30 pointer-events-none" title="No reference recorded yet"><IconDoc /></span>
            )}
            {r.overdue && <button type="button" onClick={onRemind} title="Draft a WhatsApp reminder to Accounts" className="iconbtn" style={{ ['--hover']: 'var(--wa)' }}><IconChat /></button>}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} className="p-0" style={{ background: 'var(--surface-alt)', borderBottom: '1px solid var(--border-2)' }}>
            <div className="px-5 py-5 pl-10">
              {editing ? (
                <EditForm row={r} onCancel={onCancelEdit} onSave={onSave} busy={busy} />
              ) : (
                <>
                  <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
                    <Field2 k="Payee (full)" v={r.vendor_full} />
                    <Field2 k="Billing entity" v={r.entity_full} />
                    <Field2 k="Method" v={r.method} />
                    <Field2 k="Date sent" v={fmtDate(r.date_sent)} />
                    <Field2 k="Due date" v={fmtDate(r.due_date)} />
                    <Field2 k="Amount" v={`${r.currency} ${fmtAmt(r.amount)}`} />
                    <Field2 k="Payment date" v={r.payment_date ? fmtDate(r.payment_date) : '—'} />
                    <Field2 k="OCBC reference" v={r.ref || '—'} mono />
                    <Field2 k="Request email" v={<a href={em.url} target="_blank" rel="noreferrer" className="underline">{em.stored ? 'Saved link' : 'Gmail search'}</a>} />
                    <Field2 k="OCBC slip" v={sl ? <a href={sl.url} target="_blank" rel="noreferrer" className="underline">{sl.stored ? 'Saved link' : 'Gmail search'}</a> : '—'} />
                    <div className="col-span-full">
                      <Field2 k="Notes" v={r.notes || '—'} />
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2.5 flex-wrap">
                    <SmBtn onClick={onEdit}>Edit details</SmBtn>
                    {r.status === 'pending' ? (
                      <>
                        <SmBtn onClick={onMarkPaid} disabled={busy}>Mark as paid</SmBtn>
                        <SmBtn ghost onClick={onCancelRequest} disabled={busy}>Cancel request</SmBtn>
                      </>
                    ) : (
                      <SmBtn ghost onClick={onReopen} disabled={busy}>Reopen as pending</SmBtn>
                    )}
                    {r.overdue && <SmBtn wa onClick={onRemind}>WhatsApp reminder</SmBtn>}
                    <SmBtn danger onClick={onDelete}>Delete request</SmBtn>
                  </div>
                </>
              )}
            </div>
          </td>
        </tr>
      )}
      <style>{`
        .iconbtn { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border:1px solid var(--border-2); border-radius:8px; background:var(--surface); color:var(--text-muted); text-decoration:none; flex:0 0 auto; }
        .iconbtn:hover { border-color: var(--hover, var(--accent)); color: var(--hover, var(--accent)); }
      `}</style>
    </>
  )
}

function Field2({ k, v, mono }) {
  return (
    <div>
      <div className="text-[.66rem] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{k}</div>
      <div className={`mt-0.5 text-sm ${mono ? 'font-mono break-all' : ''}`} style={{ color: 'var(--text-2)' }}>{v}</div>
    </div>
  )
}

function SmBtn({ children, onClick, ghost, danger, wa, disabled }) {
  const style = danger
    ? { color: 'var(--critical)', borderColor: 'var(--critical)', background: 'transparent' }
    : wa
    ? { background: 'var(--wa, #1f7a4d)', borderColor: 'var(--wa, #1f7a4d)', color: '#fff' }
    : ghost
    ? { background: 'transparent', borderColor: 'transparent', color: 'var(--text-2)' }
    : { background: 'var(--surface)', borderColor: 'var(--border-2)', color: 'var(--text-2)' }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-full border px-3.5 py-1.5 text-xs font-semibold disabled:opacity-50" style={style}>
      {children}
    </button>
  )
}

function EditForm({ row: r, onCancel, onSave, busy }) {
  const [form, setForm] = useState({
    vendor_full: r.vendor_full, entity_full: r.entity_full, description: r.description,
    amount: r.amount, currency: r.currency, method: r.method,
    date_sent: r.date_sent, due_date: r.due_date, status: r.status,
    payment_date: r.payment_date || '', ref: r.ref || '',
    email_url: r.email_url || '', slip_url: r.slip_url || '', notes: r.notes || '',
  })
  function upd(k) { return (e) => setForm({ ...form, [k]: e.target.value }) }
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <L label="Supplier name"><input value={form.vendor_full} onChange={upd('vendor_full')} className="in" /></L>
        <L label="Billing entity"><input value={form.entity_full} onChange={upd('entity_full')} className="in" /></L>
        <L label="Item details" full><input value={form.description} onChange={upd('description')} className="in" /></L>
        <L label="Amount"><input type="number" step="0.01" value={form.amount} onChange={upd('amount')} className="in" /></L>
        <L label="Currency"><input value={form.currency} onChange={upd('currency')} className="in" /></L>
        <L label="Method"><input value={form.method} onChange={upd('method')} className="in" /></L>
        <L label="Date sent"><input type="date" value={form.date_sent} onChange={upd('date_sent')} className="in" /></L>
        <L label="Due date"><input type="date" value={form.due_date} onChange={upd('due_date')} className="in" /></L>
        <L label="Status">
          <select value={form.status} onChange={upd('status')} className="in">
            <option value="pending">Pending</option><option value="done">Payment done</option><option value="cancelled">Cancelled</option>
          </select>
        </L>
        <L label="Payment date"><input type="date" value={form.payment_date} onChange={upd('payment_date')} className="in" /></L>
        <L label="OCBC reference"><input value={form.ref} onChange={upd('ref')} className="in" /></L>
        <L label="Request email link" full><input value={form.email_url} onChange={upd('email_url')} placeholder="https://mail.google.com/…" className="in" /></L>
        <L label="OCBC slip link" full><input value={form.slip_url} onChange={upd('slip_url')} placeholder="https://mail.google.com/…" className="in" /></L>
        <L label="Notes" full><textarea value={form.notes} onChange={upd('notes')} rows={3} className="in" /></L>
      </div>
      <div className="flex justify-end gap-2.5 mt-4 flex-wrap">
        <SmBtn ghost onClick={onCancel}>Cancel</SmBtn>
        <button type="button" disabled={busy} onClick={() => onSave(form)} className="rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      <style>{`.in{font:inherit;font-size:.875rem;color:var(--text);background:var(--surface);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;width:100%}`}</style>
    </div>
  )
}

function L({ label, full, children }) {
  return (
    <label className={`flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide ${full ? 'col-span-2' : ''}`} style={{ color: 'var(--text-muted)' }}>
      {label}{children}
    </label>
  )
}

function ModalShell({ onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(12,18,26,.5)' }} />
      <div onClick={(e) => e.stopPropagation()} className={`relative mx-auto mt-[8vh] w-[calc(100%-2.5rem)] ${wide ? 'max-w-xl' : 'max-w-lg'} rounded-2xl p-6 max-h-[80vh] overflow-y-auto`} style={{ background: 'var(--surface)', border: '1px solid var(--border-2)' }}>
        <button type="button" onClick={onClose} className="absolute top-3.5 right-3.5 w-7 h-7 rounded-md" style={{ color: 'var(--text-muted)' }}>×</button>
        {children}
      </div>
    </div>
  )
}

function AddModal({ form, setForm, onClose, onSubmit, busy }) {
  function upd(k) { return (e) => setForm({ ...form, [k]: e.target.value }) }
  return (
    <ModalShell onClose={onClose}>
      <form onSubmit={onSubmit}>
        <h3 className="text-lg font-semibold mb-1">Add payment request</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>Log a request the moment it goes to {ACCOUNTS_EMAIL}. It starts as Pending.</p>
        <div className="grid grid-cols-2 gap-3">
          <L label="Supplier name" full><input required value={form.vendor} onChange={upd('vendor')} placeholder="e.g. Sia Huat Pte Ltd" className="in" /></L>
          <L label="Item details" full><input required value={form.description} onChange={upd('description')} placeholder="e.g. Kitchenware for SGO CTP" className="in" /></L>
          <L label="Billing entity" full><input value={form.entity} onChange={upd('entity')} placeholder="e.g. SGO CTP Pte Ltd" className="in" /></L>
          <L label="Amount"><input type="number" step="0.01" value={form.amount} onChange={upd('amount')} placeholder="0.00" className="in" /></L>
          <L label="Currency">
            <select value={form.currency} onChange={upd('currency')} className="in"><option>SGD</option><option>USD</option><option>CNY</option><option>EUR</option></select>
          </L>
          <L label="Method">
            <select value={form.method} onChange={upd('method')} className="in"><option>PayNow</option><option>T/T</option><option>Bank Transfer</option><option>Cheque</option></select>
          </L>
          <L label="Date sent"><input type="date" value={form.date_sent} onChange={upd('date_sent')} className="in" /></L>
          <L label="Due date"><input type="date" value={form.due_date} onChange={upd('due_date')} className="in" /></L>
          <L label="Request email link (optional)" full><input value={form.email_url} onChange={upd('email_url')} placeholder="https://mail.google.com/…" className="in" /></L>
        </div>
        <div className="flex justify-end gap-2.5 mt-5">
          <SmBtn ghost onClick={onClose}>Cancel</SmBtn>
          <button type="submit" disabled={busy} className="rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
            {busy ? 'Adding…' : 'Add request'}
          </button>
        </div>
        <style>{`.in{font:inherit;font-size:.875rem;color:var(--text);background:var(--surface);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;width:100%}`}</style>
      </form>
    </ModalShell>
  )
}

function ReminderModal({ list, onClose, onToast }) {
  const multi = list.length > 1
  function copy(txt) {
    navigator.clipboard?.writeText(txt).then(() => onToast('Message copied.'), () => onToast('Copy failed — select the text manually.'))
  }
  return (
    <ModalShell onClose={onClose} wide>
      <h3 className="text-lg font-semibold mb-1">WhatsApp reminder{multi ? 's' : ''}</h3>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        {multi ? `${list.length} overdue requests. ` : ''}Copy the message, then open WhatsApp and pick the Accounts team chat.
      </p>
      {list.map((r) => {
        const msg = waMessage(r)
        return (
          <div key={r.id} className="mb-3">
            <div className="text-sm leading-relaxed rounded-xl p-3.5" style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderLeft: '3px solid var(--wa, #1f7a4d)', color: 'var(--text-2)' }}>{msg}</div>
            <div className="flex gap-2.5 mt-2">
              <SmBtn onClick={() => copy(msg)}>Copy message</SmBtn>
              <a href={waLink(msg)} target="_blank" rel="noreferrer" className="rounded-full px-3.5 py-1.5 text-xs font-semibold text-white" style={{ background: 'var(--wa, #1f7a4d)' }}>Open WhatsApp</a>
            </div>
          </div>
        )
      })}
      {multi && (
        <div className="mt-3">
          <button type="button" onClick={() => copy(list.map(waMessage).join('\n\n'))} className="rounded-full px-4 py-2 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
            Copy all {list.length} messages
          </button>
        </div>
      )}
    </ModalShell>
  )
}

function DeleteModal({ row, busy, onCancel, onConfirm }) {
  return (
    <ModalShell onClose={onCancel}>
      <h3 className="text-lg font-semibold mb-1">Delete request #{row.id}?</h3>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        {row.vendor} — {row.currency} {fmtAmt(row.amount)}. This hides the row for good — the automatic Gmail sync
        won't re-add it.
      </p>
      <div className="flex justify-end gap-2.5">
        <SmBtn ghost onClick={onCancel}>Keep it</SmBtn>
        <button type="button" disabled={busy} onClick={onConfirm} className="rounded-full px-4 py-2 text-xs font-semibold text-white disabled:opacity-60" style={{ background: 'var(--critical)' }}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </ModalShell>
  )
}
