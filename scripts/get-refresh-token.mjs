#!/usr/bin/env node
// One-time helper: exchanges a Google OAuth consent for a refresh token that
// scripts/gmail-sync.mjs (and GitHub Actions) can use indefinitely afterwards.
//
// Usage:
//   1. In Google Cloud Console, create an OAuth client of type "Desktop app".
//   2. GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
//   3. Open the printed URL, sign in as liyang@initia.sg, approve.
//   4. The refresh token prints in this terminal — put it in GitHub secrets
//      as GMAIL_REFRESH_TOKEN (and in .env for local testing). It does not expire
//      unless revoked, so this is a one-time step.

import http from 'node:http'

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env
if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.')
  process.exit(1)
}

const PORT = 53682
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: GMAIL_CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent', // forces a refresh_token even if this client was authorized before
})}`

console.log('\nOpen this URL, sign in as liyang@initia.sg, and approve:\n')
console.log(authUrl + '\n')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI)
  if (url.pathname !== '/oauth2callback') { res.end(); return }
  const code = url.searchParams.get('code')
  res.end('Done — you can close this tab and go back to the terminal.')
  server.close()

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })
  const json = await tokenRes.json()
  if (!json.refresh_token) {
    console.error('No refresh_token in response — did you already grant this app consent before? Response:', json)
    process.exit(1)
  }
  console.log('\nGMAIL_REFRESH_TOKEN=' + json.refresh_token + '\n')
  console.log('Save this as a GitHub Actions secret (and locally in .env). It will not be shown again — if lost, just rerun this script.')
  process.exit(0)
})

server.listen(PORT)
