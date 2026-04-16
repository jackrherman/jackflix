'use strict'

const express        = require('express')
const puppeteer      = require('puppeteer-extra')
const StealthPlugin  = require('puppeteer-extra-plugin-stealth')
const path           = require('path')
const crypto         = require('crypto')
const jwt            = require('jsonwebtoken')

puppeteer.use(StealthPlugin())

const app  = express()
const PORT = process.env.PORT || 3000

// ── CONFIG ────────────────────────────────────────────────────────────────────

const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI4MjVlMzYzYTM3MDRhZDk5MTZlOTE4NzI3OWJjNjRkYyIsIm5iZiI6MTc3NjI4OTMwMC44MzgsInN1YiI6IjY5ZTAwNjE0OWMzOWYzNTRmODAxMmM0MCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.NSmPuuHTY8KGU4GTN4hz8_PVe9bxnXxmlfi5Ce5Co8A'

const SNIFF_TIMEOUT = 20_000  // ms to wait for the m3u8 URL per server attempt

const MOVIE_SERVERS = [
  id       => `https://vidsrc.to/embed/movie/${id}`,
  id       => `https://www.2embed.cc/embed/${id}`,
  id       => `https://embed.su/embed/movie/${id}`,
]
const TV_SERVERS = [
  (id,s,e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  (id,s,e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  (id,s,e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
]

function buildEmbedUrl({ tmdbId, type, season, episode, serverIndex = 0 }) {
  const si = Math.min(serverIndex, 2)
  return type === 'movie'
    ? MOVIE_SERVERS[si](tmdbId)
    : TV_SERVERS[si](tmdbId, season, episode)
}

function isStreamUrl(url) {
  return url.includes('.m3u8') &&
    !url.includes('subtitle') &&
    !url.includes('caption') &&
    !url.includes('.vtt')
}

// ── AUTH CONFIG ───────────────────────────────────────────────────────────────
// JWT_SECRET and JACK_PIN_HASH are set as Render environment variables.
// JACK_PIN_HASH = PBKDF2-SHA256(pin, 'jackflix', 100000, 32) as hex.
// The PIN itself never leaves the server.

const JWT_SECRET   = process.env.JWT_SECRET  || 'dev-secret-change-me'
const PBKDF2_SALT  = 'jackflix'
const PBKDF2_ITERS = 100_000
const PBKDF2_LEN   = 32

// Profiles keyed by id. Add more by setting MORE_PROFILE env vars as needed.
const PROFILES = {
  jack: {
    id:      'jack',
    name:    'Jack',
    pinHash: process.env.JACK_PIN_HASH || '',
  },
}

// ── CONTINUE WATCHING (in-memory) ─────────────────────────────────────────────
// Keyed by profileId. Survives page reloads (clients re-sync on connect).
// Cleared on server restart — clients push their local store on next cwSave().

const cwStore = {}

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Max 5 auth attempts per IP per minute.

const authAttempts = {}

function checkRateLimit(ip) {
  const now = Date.now()
  if (!authAttempts[ip]) authAttempts[ip] = []
  authAttempts[ip] = authAttempts[ip].filter(t => now - t < 60_000)
  if (authAttempts[ip].length >= 5) return false
  authAttempts[ip].push(now)
  return true
}

// ── PIN HASHING ───────────────────────────────────────────────────────────────

function hashPin(pin) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(String(pin), PBKDF2_SALT, PBKDF2_ITERS, PBKDF2_LEN, 'sha256',
      (err, key) => err ? reject(err) : resolve(key.toString('hex'))))
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth  = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.profile = jwt.verify(token, JWT_SECRET)
    next()
  } catch(_) {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// ── PERSISTENT BROWSER ────────────────────────────────────────────────────────
// One browser instance is shared across all requests.
// Render free tier has 512MB RAM — Puppeteer uses ~150–250MB with these flags.

let browser = null

async function getBrowser() {
  if (browser && browser.isConnected()) return browser

  console.log('[browser] launching…')
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',   // use /tmp instead of /dev/shm — critical for low-RAM
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      '--disable-default-apps',
    ],
  })

  browser.on('disconnected', () => {
    browser = null
    console.log('[browser] disconnected — will relaunch on next request')
  })

  console.log('[browser] ready')
  return browser
}

// ── STREAM EXTRACTION ─────────────────────────────────────────────────────────

async function extractStream(embedUrl) {
  const b    = await getBrowser()
  const page = await b.newPage()

  let streamUrl = null
  let referer   = null

  try {
    page.on('popup', async popup => {
      try { await popup.close() } catch(_) {}
    })

    // Forward page console logs so we can see what the embed page is doing
    page.on('console', msg => console.log(`[page] ${msg.type()}: ${msg.text()}`))
    page.on('pageerror', err => console.log(`[page] error: ${err.message}`))

    await page.setRequestInterception(true)

    page.on('request', req => {
      const url = req.url()
      const rt  = req.resourceType()

      if (isStreamUrl(url)) {
        console.log(`[stream] intercepted: ${url.slice(0, 120)}`)
        streamUrl = url
        referer   = req.headers()['referer'] || null
        req.continue()
        return
      }

      // Only block images and fonts — don't block media (might be needed by player)
      if (['image', 'font'].includes(rt)) {
        req.abort()
        return
      }

      req.continue()
    })

    // Also scan JSON/JS responses for embedded m3u8 URLs
    page.on('response', async response => {
      if (streamUrl) return
      try {
        const ct = response.headers()['content-type'] || ''
        if (ct.includes('json') || ct.includes('javascript')) {
          const text = await response.text().catch(() => '')
          const match = text.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i)
          if (match) {
            console.log(`[stream] found in response body: ${match[0].slice(0, 120)}`)
            streamUrl = match[0]
            referer   = response.url()
          }
        }
      } catch(_) {}
    })

    console.log(`[extract] loading: ${embedUrl}`)
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: SNIFF_TIMEOUT })
    console.log(`[extract] page loaded — title: "${await page.title().catch(() => '?')}"`)

    // Give the player JS time to initialise before clicking
    await new Promise(r => setTimeout(r, 2500))

    // Try clicking play multiple times — some sites need it after ads/overlays settle
    for (let attempt = 0; attempt < 3 && !streamUrl; attempt++) {
      await page.evaluate(() => {
        const selectors = [
          '.jw-display-icon-container',
          '.jw-icon-display',
          '.vjs-big-play-button',
          '[class*="play-btn"]',
          '[class*="play-button"]',
          '[class*="btn-play"]',
          '[class*="playBtn"]',
          '[class*="play_btn"]',
          '.play',
          'button',
        ]
        for (const s of selectors) {
          const el = document.querySelector(s)
          if (el) { el.click(); return }
        }
      }).catch(() => {})
      if (!streamUrl) await new Promise(r => setTimeout(r, 1500))
    }

    const deadline = Date.now() + SNIFF_TIMEOUT
    while (!streamUrl && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250))
    }
    console.log(`[extract] done — streamUrl: ${streamUrl ? 'FOUND' : 'NOT FOUND'}`)

  } finally {
    await page.close().catch(() => {})
  }

  return { streamUrl, referer }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

// CORS — allow browser and Electron app (file:// origin → null or undefined)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── API: PROFILES ─────────────────────────────────────────────────────────────
// Returns profile list — no PINs or hashes, safe to expose.

app.get('/api/profiles', (req, res) => {
  const list = Object.values(PROFILES).map(p => ({ id: p.id, name: p.name }))
  res.json(list)
})

// ── API: AUTH ─────────────────────────────────────────────────────────────────
// Rate-limited. PIN is hashed server-side; never returned to client.

app.post('/api/auth', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' })
  }

  const { profileId, pin } = req.body || {}
  const profile = PROFILES[String(profileId || '').toLowerCase()]
  if (!profile || !profile.pinHash) {
    return res.status(401).json({ error: 'Unknown profile' })
  }

  try {
    const hash = await hashPin(pin)
    if (hash !== profile.pinHash) {
      return res.status(401).json({ error: 'Wrong PIN' })
    }
    const token = jwt.sign(
      { profileId: profile.id, name: profile.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    )
    res.json({ token, name: profile.name })
  } catch(e) {
    console.error('[auth]', e.message)
    res.status(500).json({ error: 'Auth error' })
  }
})

// ── API: CONTINUE WATCHING ────────────────────────────────────────────────────
// GET  — returns server CW for the authenticated profile
// PUT  — merges client CW with server CW (newer timestamp wins), returns merged

app.get('/api/cw', requireAuth, (req, res) => {
  res.json(cwStore[req.profile.profileId] || {})
})

app.put('/api/cw', requireAuth, (req, res) => {
  const profileId = req.profile.profileId
  const clientCW  = req.body || {}
  const serverCW  = cwStore[profileId] || {}

  // Merge: prefer the entry with the newer timestamp
  const merged = { ...serverCW }
  for (const [key, entry] of Object.entries(clientCW)) {
    if (!merged[key] || (entry.ts || 0) > (merged[key].ts || 0)) {
      merged[key] = entry
    }
  }

  // Trim to 50 entries, dropping oldest
  const entries = Object.entries(merged).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
  cwStore[profileId] = Object.fromEntries(entries.slice(0, 50))

  res.json(cwStore[profileId])
})

// ── API: TMDB PROXY ───────────────────────────────────────────────────────────
// Keeps the TMDB token server-side instead of in the browser.

app.get('/api/tmdb/*', async (req, res) => {
  try {
    const endpoint = '/' + req.params[0]
    const url      = new URL(`https://api.themoviedb.org/3${endpoint}`)
    Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v))

    const r    = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
    })
    const data = await r.json()
    res.json(data)
  } catch(e) {
    console.error('[tmdb]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── API: STREAM EXTRACTION ────────────────────────────────────────────────────
// Puppeteer loads the embed URL, intercepts the m3u8 request, returns the URL.

app.post('/api/stream', async (req, res) => {
  const { tmdbId, type, season, episode, serverIndex = 0 } = req.body
  if (!tmdbId || !type) return res.status(400).json({ error: 'Missing tmdbId/type' })

  const embedUrl = buildEmbedUrl({ tmdbId, type, season, episode, serverIndex })
  console.log(`[stream] ${type} ${tmdbId}${type === 'tv' ? ` S${season}E${episode}` : ''} server=${serverIndex}`)

  try {
    const { streamUrl, referer } = await extractStream(embedUrl)

    if (!streamUrl) {
      console.log('[stream] not found within timeout')
      return res.status(404).json({ error: 'No stream found' })
    }

    console.log(`[stream] found: …${streamUrl.slice(-60)}`)
    res.json({ streamUrl, referer })
  } catch(e) {
    console.error('[stream] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`JackFlix running on port ${PORT}`)
  getBrowser().catch(e => console.error('[browser] warm-up failed:', e.message))
})
