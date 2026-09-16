#!/usr/bin/env node
// Gmail -> Supabase sync for the Payment Request Tracker.
//
// This replaces a Claude cloud routine that ran a full agentic session ~17x/day,
// re-reading and republishing an entire ~100KB artifact file each time. This
// script does the same two jobs (STEP 4 / STEP 5 below) as plain deterministic
// code against a real table: only the rows that actually changed get written.
//
// Required env vars (see .env.example):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//   GMAIL_USER_EMAIL (default liyang@initia.sg), ACCOUNTS_EMAIL (default accounts@initia.sg)
//
// Run: node scripts/gmail-sync.mjs   (or `npm run sync`)

import { createClient } from '@supabase/supabase-js'

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  GMAIL_USER_EMAIL = 'liyang@initia.sg',
  ACCOUNTS_EMAIL = 'accounts@initia.sg',
} = process.env

for (const [name, val] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN })) {
  if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1) }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

// ---------- Gmail auth + low-level fetch helpers ----------

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
    }),
  })
  const json = await res.json()
  if (!json.access_token) throw new Error(`Gmail token refresh failed: ${JSON.stringify(json)}`)
  return json.access_token
}

async function gmailGet(token, path) {
  const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Gmail API ${path} -> ${res.status}: ${await res.text()}`)
  return res.json()
}

async function searchMessageIds(token, q, maxResults = 50) {
  const json = await gmailGet(token, `/messages?maxResults=${maxResults}&q=${encodeURIComponent(q)}`)
  return (json.messages || []).map((m) => m.id)
}

function b64urlDecode(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function plainTextFromPayload(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64urlDecode(payload.body.data)
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return b64urlDecode(part.body.data)
    }
    for (const part of payload.parts) {
      const nested = plainTextFromPayload(part)
      if (nested) return nested
    }
    // Fall back to stripped HTML if no text/plain part exists anywhere.
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return b64urlDecode(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      }
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  }
  return ''
}

function hasAttachment(payload) {
  if (!payload?.parts) return false
  return payload.parts.some((p) => p.filename && p.filename.length > 0)
}

function header(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : ''
}

async function getMessage(token, id) {
  const json = await gmailGet(token, `/messages/${id}?format=full`)
  const headers = json.payload?.headers || []
  return {
    id: json.id,
    threadId: json.threadId,
    labelIds: json.labelIds || [],
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    cc: header(headers, 'Cc'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    body: plainTextFromPayload(json.payload),
    hasAttachment: hasAttachment(json.payload),
  }
}

async function getThreadMessages(token, threadId) {
  const json = await gmailGet(token, `/threads/${threadId}?format=full`)
  return (json.messages || []).map((m) => {
    const headers = m.payload?.headers || []
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds || [],
      from: header(headers, 'From'),
      to: header(headers, 'To'),
      cc: header(headers, 'Cc'),
      subject: header(headers, 'Subject'),
      date: header(headers, 'Date'),
      body: plainTextFromPayload(m.payload),
      hasAttachment: hasAttachment(m.payload),
    }
  })
}

// ---------- parsing helpers ----------

const LEGAL_WORDS = /\b(pte|ltd|limited|co|inc|llc|company|corp|corporation|import|export|and)\b/g
function normVendor(s) {
  return String(s || '').toLowerCase().replace(LEGAL_WORDS, ' ').replace(/[^a-z0-9]+/g, '')
}
function looseVendorMatch(a, b) {
  const na = normVendor(a), nb = normVendor(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

function hasIntentLine(text) {
  return /please proceed with payment/i.test(text) || /payment info/i.test(text) || /product or service:/i.test(text)
}

// "Amount: *USD 8,800.00*" / "Amount: S$226.55" / "Amount: SGD 1,242.60"
function parseAmountLine(text) {
  const m = /amount:\s*[*_]*\s*(S\$|US\$|[A-Za-z]{3})\s*([\d,]+(?:\.\d+)?)/i.exec(text)
  if (!m) return null
  let currency = m[1].toUpperCase()
  if (currency === 'S$') currency = 'SGD'
  else if (currency === 'US$') currency = 'USD'
  const amount = parseFloat(m[2].replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  return { currency, amount }
}

function isDisregard(text) {
  return /\b(disregard|cancel|ignore this request)\b/i.test(text)
}

function amountVariants(amount) {
  const plain = Number(amount).toFixed(2)
  const grouped = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })
  return { plain, grouped }
}

function emailListIncludes(headerValue, addr) {
  return (headerValue || '').toLowerCase().includes(addr.toLowerCase())
}

function gmailUrl(messageId) {
  return `https://mail.google.com/mail/u/0/#all/${messageId}`
}

// ---------- main ----------

async function main() {
  const token = await getAccessToken()

  const { data: existingRows, error: fetchErr } = await supabase.from('payment_requests').select('*')
  if (fetchErr) throw fetchErr
  const byMsgId = new Map(existingRows.map((r) => [r.request_message_id, r]))

  let added = 0, cancelled = 0, settled = 0

  // ---------- STEP 4 equivalent: new sent payment-request emails ----------
  const sentIds = await searchMessageIds(token, `in:sent to:${ACCOUNTS_EMAIL} newer_than:14d`, 50)
  const runRows = [...existingRows] // grows as we add within this run, for T2 dedup against same-run additions

  for (const id of sentIds) {
    const msg = await getMessage(token, id)
    const subjectMatches = /payment request/i.test(msg.subject)
    const fromMe = emailListIncludes(msg.from, GMAIL_USER_EMAIL)
    const toAccounts = emailListIncludes(msg.to, ACCOUNTS_EMAIL) || emailListIncludes(msg.cc, ACCOUNTS_EMAIL)
    const isSent = msg.labelIds.includes('SENT')
    if (!(subjectMatches && fromMe && toAccounts && isSent)) continue

    const existing = byMsgId.get(msg.id)
    if (existing) {
      if (existing.status === 'pending' && isDisregard(msg.body)) {
        await supabase.from('payment_requests').update({
          status: 'cancelled',
          notes: `${existing.notes || ''} Cancelled per follow-up email on ${new Date().toISOString().slice(0, 10)}.`.trim(),
        }).eq('id', existing.id)
        cancelled++
      }
      continue
    }

    if (!hasIntentLine(msg.body)) continue
    const parsedAmount = parseAmountLine(msg.body)
    if (!parsedAmount) continue

    // T2: not a re-send of an already-tracked request (same loose vendor + same
    // amount, from a DIFFERENT thread — same-thread matches are the legitimate
    // 50% deposit -> balance case).
    const vendorGuess = (/payment request to (.+?) for/i.exec(msg.subject) || [])[1] || msg.subject
    const isDuplicate = runRows.some((r) =>
      r.request_thread_id !== msg.threadId &&
      Number(r.amount) === parsedAmount.amount &&
      looseVendorMatch(r.vendor_full || r.vendor, vendorGuess)
    )
    if (isDuplicate) continue

    const dueDateMatch = /due\s*(?:date)?:?\s*(\d{4}-\d{2}-\d{2})/i.exec(msg.body)
    const dateSent = msg.date ? new Date(msg.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
    const newRow = {
      request_message_id: msg.id,
      request_thread_id: msg.threadId,
      date_sent: dateSent,
      vendor: vendorGuess.slice(0, 80),
      vendor_full: vendorGuess,
      description: msg.subject.replace(/^(re|fwd):\s*/i, ''),
      entity: 'Initia International', // best-guess default; correct manually if a different billing entity applies
      entity_full: 'Initia International Pte Ltd',
      amount: parsedAmount.amount,
      currency: parsedAmount.currency,
      method: parsedAmount.currency === 'SGD' ? 'PayNow' : 'T/T',
      due_date: dueDateMatch ? dueDateMatch[1] : dateSent,
      status: 'pending',
      email_url: gmailUrl(msg.id),
      notes: `Auto-added from sent mail on ${new Date().toISOString().slice(0, 10)}. (verify: entity, description, due date parsed automatically)`,
    }
    const { data: inserted, error: insErr } = await supabase.from('payment_requests').insert(newRow).select().single()
    if (insErr) { console.error('Insert failed for', msg.id, insErr.message); continue }
    runRows.push(inserted)
    added++
  }

  // ---------- STEP 5 equivalent: match settlements (OCBC advice, then Accounts slip) ----------
  const { data: freshRows, error: reloadErr } = await supabase.from('payment_requests').select('*')
  if (reloadErr) throw reloadErr
  const eligible = freshRows
    .filter((r) => r.status !== 'cancelled' && !(r.status === 'done' && r.slip_url))
    .sort((a, b) => (a.due_date > b.due_date ? 1 : -1))
    .slice(0, 15)

  for (const row of eligible) {
    const { plain, grouped } = amountVariants(row.amount)
    let queries = [`subject:"details of a transaction" ("${grouped}" OR "${plain}") newer_than:30d`]
    if (row.ref) queries.push(`"${row.ref}" subject:"details of a transaction" newer_than:45d`)

    let matched = false
    for (const q of queries) {
      const ids = await searchMessageIds(token, q, 20)
      for (const id of ids) {
        const msg = await getMessage(token, id)
        const amtMatch = new RegExp(`transaction amount:\\s*${row.currency}\\s*${plain.replace('.', '\\.')}`, 'i').test(msg.body)
          || msg.body.includes(grouped)
        const nameMatch = /(?:PayNow Recipient Name|Name):\s*(.+)/i.exec(msg.body)
        const beneficiary = nameMatch ? nameMatch[1].split('\n')[0].trim() : ''
        const beneficiaryMatches = beneficiary && looseVendorMatch(beneficiary, row.vendor_full || row.vendor)

        if (amtMatch && beneficiaryMatches) {
          const refMatch = /OCBC reference no\.?:\s*(\S+)/i.exec(msg.body)
          const dateMatch = /Value date[^:]*:\s*(\d{1,2}\s+\w+\s+\d{4})/i.exec(msg.body)
          const paymentDate = dateMatch ? new Date(dateMatch[1]).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
          await supabase.from('payment_requests').update({
            status: 'done',
            payment_date: paymentDate,
            ref: refMatch ? refMatch[1] : row.ref,
            slip_message_id: msg.id,
            slip_url: gmailUrl(msg.id),
            notes: `OCBC advice confirms ${row.currency} ${plain}, value date ${dateMatch ? dateMatch[1] : 'unknown'}${refMatch ? `, ref ${refMatch[1]}` : ''}.`,
          }).eq('id', row.id)
          settled++
          matched = true
          break
        } else if (amtMatch && !matched) {
          // Near miss: right amount, unconfirmed beneficiary — leave a breadcrumb, don't settle.
          await supabase.from('payment_requests').update({
            notes: `${row.notes || ''} Possible payment seen: OCBC ${row.currency} ${plain}${refMatch ? '' : ''} - verify.`.trim(),
          }).eq('id', row.id)
        }
      }
      if (matched) break
    }
    if (matched) continue

    // Fallback: an Accounts reply in the original request thread saying the slip is attached.
    try {
      const threadMsgs = await getThreadMessages(token, row.request_thread_id)
      const slipReply = threadMsgs.find((m) =>
        m.id !== row.request_message_id &&
        (/@initiagroup\.sg$/i.test(m.from) || /^accounts/i.test(m.from) || /procurement@initia\.sg/i.test(m.from)) &&
        /(payment slip|slip attached|kindly see the attached|attached payment slip)/i.test(m.body) &&
        m.hasAttachment
      )
      if (slipReply) {
        await supabase.from('payment_requests').update({
          status: 'done',
          payment_date: new Date(slipReply.date).toISOString().slice(0, 10),
          slip_message_id: slipReply.id,
          slip_url: gmailUrl(slipReply.id),
          notes: `Payment slip received from Accounts on ${new Date(slipReply.date).toISOString().slice(0, 10)} (slip attached in the request thread).`,
        }).eq('id', row.id)
        settled++
      }
    } catch (e) {
      console.error(`Thread fallback failed for row ${row.id}:`, e.message)
    }
  }

  console.log(`Sync done: ${added} added, ${cancelled} cancelled, ${settled} settled.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
