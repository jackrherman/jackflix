'use strict'

const express   = require('express')
const puppeteer = require('puppeteer')
const path      = require('path')

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
    // Block all new popup windows the embed tries to open
    page.on('popup', async popup => {
      try { await popup.close() } catch(_) {}
    })

    await page.setRequestInterception(true)

    page.on('request', req => {
      const url = req.url()
      const rt  = req.resourceType()

      // Capture stream URL and its referer
      if (isStreamUrl(url)) {
        streamUrl = url
        referer   = req.headers()['referer'] || null
        req.continue()
        return
      }

      // Abort assets we don't need — saves bandwidth and speeds up detection
      if (['image', 'font', 'media'].includes(rt)) {
        req.abort()
        return
      }

      req.continue()
    })

    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: SNIFF_TIMEOUT })

    // Click any play buttons that appear after the page loads
    await page.evaluate(() => {
      const selectors = [
        '.jw-display-icon-container',
        '.vjs-big-play-button',
        '[class*="play"]',
        'button',
      ]
      for (const s of selectors) {
        const el = document.querySelector(s)
        if (el) { el.click(); return }
      }
    }).catch(() => {})

    // Poll until we have the stream URL or we hit the timeout
    const deadline = Date.now() + SNIFF_TIMEOUT
    while (!streamUrl && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250))
    }

  } finally {
    // Always close the page to free memory
    await page.close().catch(() => {})
  }

  return { streamUrl, referer }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

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
  // Pre-warm the browser so the first stream request isn't slow
  getBrowser().catch(e => console.error('[browser] warm-up failed:', e.message))
})
