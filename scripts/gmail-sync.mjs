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

// Cuts a reply body down to only what was newly typed, dropping quoted
// history beneath it. Deliberately does NOT treat a line starting with ">"
// as a quote marker — the request template itself uses ">>> AMOUNT: ..." /
// ">>> PAYMENT DUE DATE: ..." as bullet emphasis, not as a reply quote, so
// that heuristic would truncate the very fields we need to parse. Instead
// this looks for the structural markers Gmail/Outlook actually insert.
function stripQuotedText(text) {
  if (!text) return ''
  const markers = [
    /^on .{0,200}wrote:\s*$/im,
    /^-{2,}\s*(?:original|forwarded) message\s*-{2,}/im,
    /^_{5,}\s*$/m,
    /^from:\s*.+\n+(?:sent|date):\s*.+\n+to:\s*.+\n+subject:/im,
  ]
  let cutIndex = text.length
  for (const re of markers) {
    const m = re.exec(text)
    if (m && m.index < cutIndex) cutIndex = m.index
  }
  return text.slice(0, cutIndex).trim()
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
  return /\b(disregard|kindly ignore|please ignore|cancel this (?:request|payment)|ignore this request)\b/i.test(text)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Real emails write this as "PAYMENT DUE DATE: 17th Sep 2026" / "- Payment due
// date: 17th September 2026" — never ISO — so this has to parse the ordinal
// day + month name + year form, not look for YYYY-MM-DD.
function parseDueDate(text) {
  const m = /due\s*(?:date)?:?\s*[*_>\-\s]*(\d{1,2})(?:st|nd|rd|th)?[\s,]+([A-Za-z]+)[\s,]+(\d{4})/i.exec(text)
  if (!m) return null
  const day = parseInt(m[1], 10)
  const monthIdx = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3))
  if (monthIdx === -1 || !day || day > 31) return null
  return `${m[3]}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Every request email has a consistent "Billing Entity or Billing outlet: X"
// line — read the real entity instead of defaulting every row to one guess.
function parseEntity(text) {
  const m = /billing entity(?:\s*or\s*billing outlet)?:\s*(.+)/i.exec(text)
  if (!m) return null
  const full = m[1].trim().replace(/[*_]/g, '')
  const short = full.replace(/\s*(pte\.?\s*ltd\.?|private\s+limited|limited|ltd\.?)\s*$/i, '').trim()
  return { full, short: short || full }
}

// "Product or Service: Tofu G Paper Spoon" is the closest thing to a clean
// description these emails have — prefer it over the subject line.
function parseDescription(text, fallbackSubject) {
  const m = /product or service:\s*(.+)/i.exec(text)
  return m ? m[1].trim().replace(/[*_]/g, '') : fallbackSubject
}

// Every request email's "Beneficiary information" block names the true
// payee (e.g. "Holder Name: Zhejiang Zhuzhi Industry and Trade Co., Ltd."),
// and this is the exact string the OCBC advice later echoes back in its own
// "Name:" field — far more reliable than guessing the vendor from a
// human-written subject line.
function parseBeneficiary(text) {
  const m = /(?:holder name|paynow recipient name|beneficiary name)\s*:\s*(.+)/i.exec(text)
  if (!m) return null
  const name = m[1].trim().replace(/[*_]/g, '')
  return name || null
}

// Every OCBC advice opens with "Our customer, <ENTITY>, would like us to
// inform you..." — <ENTITY> is which Initia subsidiary actually paid.
// Matching vendor + amount is not enough to settle a row: two different
// Initia entities can independently pay the same vendor the same exact
// amount (e.g. two outlets both ordering from the same supplier), and
// without this check that coincidence reads as a confirmed payment for the
// wrong entity's request.
function parsePayerEntity(text) {
  const m = /our customer,\s*([^,]+),/i.exec(text)
  if (!m) return null
  return m[1].trim() || null
}

// Subjects use at least three templates:
//   "Payment Request to VENDOR for DESC"
//   "Payment Request for DESC to VENDOR for DESC2"        (freight/logistics)
//   "[Outlet] Payment request — VENDOR for DESC - sender_date"   (em dash, no "to")
// The first two both have "to VENDOR for" somewhere; the third doesn't use
// "to" at all. Try the "to...for" shape first, then the dash shape, then give
// up and hand back the cleaned subject.
function parseVendorFromSubject(rawSubject) {
  let subject = rawSubject.replace(/^\s*(re|fwd):\s*/i, '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/^\s*(re|fwd):\s*/i, '')
  let m = /\bto\s+(.+?)\s+for\b/i.exec(subject)
  if (m) return m[1].trim()
  m = /payment request\s*[—:\-]+\s*(.+?)\s+for\b/i.exec(subject)
  if (m) return m[1].trim()
  return subject.replace(/\s*-\s*Li Yang.*$/i, '').trim()
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

    // Only the newly-typed portion of the message — a reply that merely
    // quotes the original request (e.g. a one-line "please disregard" on top
    // of the quoted original) must not have its quoted Amount:/intent lines
    // re-parsed as if they were new.
    const newContent = stripQuotedText(msg.body)

    const existing = byMsgId.get(msg.id)
    if (existing) {
      if (existing.status === 'pending' && isDisregard(newContent)) {
        await supabase.from('payment_requests').update({
          status: 'cancelled',
          notes: `${existing.notes || ''} Cancelled per follow-up email on ${new Date().toISOString().slice(0, 10)}.`.trim(),
        }).eq('id', existing.id)
        existing.status = 'cancelled'
        cancelled++
      }
      continue
    }

    // A reply in an already-tracked thread saying to disregard/cancel: cancel
    // the pending row(s) in that thread here, before falling through to the
    // "new request" parsing below — otherwise the quoted original's Amount:
    // line would get parsed out of newContent... except newContent has that
    // quote stripped, so without this check the disregard reply would simply
    // be ignored (no intent line of its own) and the original row would be
    // stuck pending forever instead of being cancelled.
    if (isDisregard(newContent)) {
      const pendingInThread = runRows.filter((r) => r.request_thread_id === msg.threadId && r.status === 'pending')
      if (pendingInThread.length) {
        for (const row of pendingInThread) {
          await supabase.from('payment_requests').update({
            status: 'cancelled',
            notes: `${row.notes || ''} Cancelled per follow-up email on ${new Date().toISOString().slice(0, 10)}.`.trim(),
          }).eq('id', row.id)
          row.status = 'cancelled'
          cancelled++
        }
        continue
      }
    }

    if (!hasIntentLine(newContent)) continue
    const parsedAmount = parseAmountLine(newContent)
    if (!parsedAmount) continue

    // Prefer the bank-verified beneficiary name (present in every request
    // email's "Beneficiary information" block) over the subject-line guess —
    // it's the exact string the OCBC advice will echo back in Phase 2, so
    // matching against it there is far more reliable than a subject guess.
    const vendorGuess = parseVendorFromSubject(msg.subject)
    const beneficiary = parseBeneficiary(newContent)
    const vendorFull = beneficiary || vendorGuess

    // T2: not a re-send of an already-tracked request (same loose vendor + same
    // amount, from a DIFFERENT thread — same-thread matches are the legitimate
    // 50% deposit -> balance case).
    const isDuplicate = runRows.some((r) =>
      r.request_thread_id !== msg.threadId &&
      Number(r.amount) === parsedAmount.amount &&
      looseVendorMatch(r.vendor_full || r.vendor, vendorFull)
    )
    if (isDuplicate) continue

    const dueDate = parseDueDate(newContent)
    const entity = parseEntity(newContent)
    const dateSent = msg.date ? new Date(msg.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
    const verifyFlags = []
    if (!dueDate) verifyFlags.push('due date')
    if (!entity) verifyFlags.push('entity')
    const newRow = {
      request_message_id: msg.id,
      request_thread_id: msg.threadId,
      date_sent: dateSent,
      vendor: vendorGuess.slice(0, 80),
      vendor_full: vendorFull,
      description: parseDescription(newContent, msg.subject.replace(/^(re|fwd):\s*/i, '')),
      entity: entity ? entity.short : 'Initia International',
      entity_full: entity ? entity.full : 'Initia International Pte Ltd',
      amount: parsedAmount.amount,
      currency: parsedAmount.currency,
      method: parsedAmount.currency === 'SGD' ? 'PayNow' : 'T/T',
      due_date: dueDate || dateSent,
      status: 'pending',
      email_url: gmailUrl(msg.id),
      notes: `Auto-added from sent mail on ${new Date().toISOString().slice(0, 10)}.` +
        (verifyFlags.length ? ` (verify: ${verifyFlags.join(', ')} — could not parse from email)` : ''),
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
    .filter((r) => !r.dismissed && r.status !== 'cancelled' && !(r.status === 'done' && r.slip_url))
    .sort((a, b) => (a.due_date > b.due_date ? 1 : -1))
    .slice(0, 15)

  // A slip settles at most one row per run. Message id alone isn't enough:
  // OCBC delivers the SAME transaction to more than one recipient (e.g. a
  // direct notification plus a copy forwarded through a shared alias),
  // producing two different Gmail message ids with the identical OCBC
  // reference / SWIFT UETR for one real transfer. The OCBC reference is the
  // actual unique transaction id, so that's the key that must not repeat —
  // dedupe by message id too, only to also cover the Accounts-reply fallback
  // path below, which has no OCBC reference to key off of.
  const usedSlipMessageIds = new Set(freshRows.filter((r) => r.slip_message_id).map((r) => r.slip_message_id))
  const usedSlipRefs = new Set(freshRows.filter((r) => r.ref).map((r) => r.ref))

  for (const row of eligible) {
    const { plain, grouped } = amountVariants(row.amount)
    let queries = [`subject:"details of a transaction" ("${grouped}" OR "${plain}") newer_than:30d`]
    if (row.ref) queries.push(`"${row.ref}" subject:"details of a transaction" newer_than:45d`)

    let matched = false
    for (const q of queries) {
      const ids = await searchMessageIds(token, q, 20)
      for (const id of ids) {
        if (usedSlipMessageIds.has(id)) continue
        const msg = await getMessage(token, id)
        const amtMatch = new RegExp(`transaction amount:\\s*${row.currency}\\s*${plain.replace('.', '\\.')}`, 'i').test(msg.body)
          || msg.body.includes(grouped)
        const nameMatch = /(?:PayNow Recipient Name|Name):\s*(.+)/i.exec(msg.body)
        const beneficiary = nameMatch ? nameMatch[1].split('\n')[0].trim() : ''
        const beneficiaryMatches = beneficiary && looseVendorMatch(beneficiary, row.vendor_full || row.vendor)
        const payerEntity = parsePayerEntity(msg.body)
        const entityMatches = !payerEntity || looseVendorMatch(payerEntity, row.entity_full || row.entity)
        const refMatch = /OCBC reference no\.?:\s*(\S+)/i.exec(msg.body)
        const dateMatch = /Value date[^:]*:\s*(\d{1,2}\s+\w+\s+\d{4})/i.exec(msg.body)

        // Same real transfer delivered as a second copy to another
        // recipient — already claimed by another row, so this can't settle
        // this one too, no matter how well the amount/name happen to match.
        if (refMatch && usedSlipRefs.has(refMatch[1])) continue

        // A slip dated before the request was even sent can't be this
        // payment — reject it outright rather than let a stale,
        // coincidentally-sized payment settle the row.
        if (dateMatch) {
          const valueDate = new Date(dateMatch[1])
          if (!Number.isNaN(valueDate.getTime()) && valueDate < new Date(row.date_sent)) continue
        }

        if (amtMatch && beneficiaryMatches && entityMatches) {
          const paymentDate = dateMatch ? new Date(dateMatch[1]).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
          await supabase.from('payment_requests').update({
            status: 'done',
            payment_date: paymentDate,
            ref: refMatch ? refMatch[1] : row.ref,
            slip_message_id: msg.id,
            slip_url: gmailUrl(msg.id),
            notes: `OCBC advice confirms ${row.currency} ${plain}, value date ${dateMatch ? dateMatch[1] : 'unknown'}${refMatch ? `, ref ${refMatch[1]}` : ''}.`,
          }).eq('id', row.id)
          usedSlipMessageIds.add(msg.id)
          if (refMatch) usedSlipRefs.add(refMatch[1])
          settled++
          matched = true
          break
        } else if (amtMatch && beneficiaryMatches && !entityMatches && !matched) {
          // Right vendor, right amount — but paid by a different Initia
          // entity than this request was billed under. Two entities can
          // genuinely pay the same vendor the same amount independently, so
          // this must never auto-settle; leave a breadcrumb naming the
          // mismatch instead. Guarded so reruns don't pile up duplicates.
          const breadcrumb = `Possible payment seen: OCBC ${row.currency} ${plain}${refMatch ? ` ref ${refMatch[1]}` : ''} was paid by "${payerEntity}", not "${row.entity_full || row.entity}" — verify this is the right transaction.`
          if (!(row.notes || '').includes(breadcrumb)) {
            await supabase.from('payment_requests').update({
              notes: `${row.notes || ''} ${breadcrumb}`.trim(),
            }).eq('id', row.id)
            row.notes = `${row.notes || ''} ${breadcrumb}`.trim()
          }
        } else if (amtMatch && !matched) {
          // Near miss: right amount, unconfirmed beneficiary — leave a breadcrumb, don't
          // settle. Guarded so reruns don't pile up the same breadcrumb every 30 minutes.
          const breadcrumb = `Possible payment seen: OCBC ${row.currency} ${plain}${refMatch ? ` ref ${refMatch[1]}` : ''} - verify.`
          if (!(row.notes || '').includes(breadcrumb)) {
            await supabase.from('payment_requests').update({
              notes: `${row.notes || ''} ${breadcrumb}`.trim(),
            }).eq('id', row.id)
            row.notes = `${row.notes || ''} ${breadcrumb}`.trim()
          }
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
        !usedSlipMessageIds.has(m.id) &&
        // Fixed: the original `/@initiagroup\.sg$/` anchor never matched
        // because From headers look like "Accounts Team <accounts@initiagroup.sg>"
        // — the domain is followed by ">", not end-of-string.
        (/@initiagroup\.sg/i.test(m.from) || /^accounts/i.test(m.from) || /procurement@initia\.sg/i.test(m.from)) &&
        /(payment slip|slip attached|kindly see the attached|attached payment slip|proof of payment|remittance advice|payment (?:has been made|completed))/i.test(m.body) &&
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
        usedSlipMessageIds.add(slipReply.id)
        settled++
      }
    } catch (e) {
      console.error(`Thread fallback failed for row ${row.id}:`, e.message)
    }
  }

  console.log(`Sync done: ${added} added, ${cancelled} cancelled, ${settled} settled.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
