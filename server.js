'use strict'

const express = require('express')
const path    = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

// ── CONFIG ────────────────────────────────────────────────────────────────────

const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI4MjVlMzYzYTM3MDRhZDk5MTZlOTE4NzI3OWJjNjRkYyIsIm5iZiI6MTc3NjI4OTMwMC44MzgsInN1YiI6IjY5ZTAwNjE0OWMzOWYzNTRmODAxMmM0MCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.NSmPuuHTY8KGU4GTN4hz8_PVe9bxnXxmlfi5Ce5Co8A'

// ── VPS PROXY ─────────────────────────────────────────────────────────────────
// Profiles, auth, and continue-watching are stored centrally on the VPS so both
// the laptop and TV apps share the same data.

const VPS_BASE   = 'http://107.175.245.21.nip.io'
const VPS_SECRET = 'jf-rn-2026-xK9mP'

async function vpsRequest(method, path, reqBody, authHeader) {
  const headers = { 'x-jf-secret': VPS_SECRET }
  if (authHeader)          headers['Authorization'] = authHeader
  if (reqBody !== null)    headers['Content-Type']  = 'application/json'
  return fetch(`${VPS_BASE}${path}`, {
    method,
    headers,
    body: reqBody !== null ? JSON.stringify(reqBody) : undefined,
  })
}

// ── EMBED PROXY ───────────────────────────────────────────────────────────────
// Fetches embed pages server-side (stripping X-Frame-Options/CSP) and serves
// them from our own origin so the user's browser — at a residential IP — loads
// the player.  An injected script intercepts XHR/fetch for m3u8 URLs and
// postMessages them to the parent frame (player.js).
//
// Child iframes created by the embed page have their src rewritten to also go
// through this endpoint, so the interception is recursive.

// SSRF protection: block requests to localhost and private IP ranges.
// No domain allowlist — embed sites chain through unpredictable intermediate domains
// (e.g. vidsrc.to → vsembed.ru) that we can't enumerate in advance.
function isSafeProxyUrl(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname
    if (!h) return false
    if (h === 'localhost') return false
    if (/^127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(h)) return false
    if (h.endsWith('.local') || h.endsWith('.internal')) return false
    return rawUrl.startsWith('https://') || rawUrl.startsWith('http://')
  } catch(_) {
    return false
  }
}

// Script injected into every proxied HTML page.
// 1. Saves real parent ref, overrides window.top/parent/self (anti-frame-bust).
// 2. Intercepts XHR + fetch — routes all cross-origin requests through /api/req-proxy
//    so the server makes them with spoofed Origin/Referer (bypasses CORS).
// 3. Resolves relative URLs against the embed base URL (JS doesn't use <base>).
// 4. Scans both request URLs and response bodies for .m3u8 URLs.
// 5. Relays jf-stream messages from child frames upward (multi-iframe chains).
// 6. Rewrites iframe src assignments through /api/embed-proxy (recursive proxy).
const INJECTED_SCRIPT = `<script>
(function () {
  // 1. Save real parent reference BEFORE overriding window.parent
  var _P = null
  try { if (window.parent !== window) _P = window.parent } catch (e) {}

  try {
    var _dP = Object.defineProperty, _w = window
    _dP(_w, 'top',    { get: function () { return _w }, configurable: true })
    _dP(_w, 'parent', { get: function () { return _w }, configurable: true })
    _dP(_w, 'self',   { get: function () { return _w }, configurable: true })
  } catch (e) {}

  // 2. Stream URL detection
  function report(url) {
    if (!url || typeof url !== 'string' || url.indexOf('.m3u8') === -1) return
    if (url.indexOf('subtitle') !== -1 || url.indexOf('caption') !== -1 || url.indexOf('.vtt') !== -1) return
    var msg = { type: 'jf-stream', url: url, ref: location.href }
    if (_P) try { _P.postMessage(msg, '*') } catch (e) {}
  }

  function scanText(text) {
    if (!text) return
    var m = text.match(/https?:\\/\\/[^"'\\s\\\\]+\\.m3u8[^"'\\s\\\\]*/i)
    if (m) report(m[0])
  }

  // 3. Relay messages from deeper child frames
  window.addEventListener('message', function (e) {
    if (_P && e.data && e.data.type === 'jf-stream') try { _P.postMessage(e.data, '*') } catch (e2) {}
  })

  // 4. URL helpers — JS doesn't respect <base>, so we resolve relative URLs manually
  var _EMBED_BASE = ''
  try { var _b = document.querySelector('base'); if (_b && _b.href) _EMBED_BASE = _b.href } catch (e) {}

  function _resolve(u) {
    if (!u || typeof u !== 'string') return u || ''
    if (/^https?:\\/\\//.test(u)) return u
    if (!_EMBED_BASE) return u
    try { return new URL(u, _EMBED_BASE).href } catch (e) { return u }
  }

  function _shouldProxy(u) {
    if (!u) return false
    try {
      return new URL(u).origin !== location.origin && u.indexOf('/api/req-proxy') === -1
    } catch (e) { return false }
  }

  function _toReqProxy(u) {
    return '/api/req-proxy?url=' + encodeURIComponent(u) + '&ref=' + encodeURIComponent(_EMBED_BASE || location.href)
  }

  // 5. XHR intercept — resolve URL, proxy cross-origin, scan response body
  var _xo = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (m, u) {
    var abs = _resolve(String(u || ''))
    report(abs)
    var routed = _shouldProxy(abs) ? _toReqProxy(abs) : (abs || u)
    return _xo.apply(this, [m, routed].concat(Array.prototype.slice.call(arguments, 2)))
  }

  var _xs = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('readystatechange', function () {
      if (this.readyState === 4) try { scanText(this.responseText) } catch (e) {}
    })
    return _xs.apply(this, arguments)
  }

  // 6. fetch intercept — resolve URL, proxy cross-origin, scan response body
  var _f = window.fetch
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : ((input && input.url) || '')
    var abs = _resolve(u)
    report(abs)
    var routed = _shouldProxy(abs) ? _toReqProxy(abs) : abs
    var finalInput = typeof input === 'string' ? routed : routed
    return _f.call(window, finalInput, init).then(function (resp) {
      var ct = resp.headers.get('content-type') || ''
      if (ct.indexOf('json') !== -1 || ct.indexOf('javascript') !== -1 || ct.indexOf('text/plain') !== -1) {
        resp.clone().text().then(function (t) { scanText(t) }).catch(function () {})
      }
      return resp
    })
  }

  // 7. Iframe src rewrite — route child frames through embed proxy (recursive)
  function _proxyIframe(v) {
    if (v && /^https?:\\/\\//.test(v) && v.indexOf('/api/embed-proxy') === -1) {
      return '/api/embed-proxy?url=' + encodeURIComponent(v)
    }
    return v
  }
  try {
    var _sd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')
    if (_sd && _sd.set) Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      get: _sd.get,
      set: function (v) { return _sd.set.call(this, _proxyIframe(v)) },
      configurable: true
    })
  } catch (e) {}
  var _sa = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (n, v) {
    if (this.tagName === 'IFRAME' && (n === 'src' || n === 'data-src')) v = _proxyIframe(v)
    return _sa.call(this, n, v)
  }

  // 8. Video/source observer
  try {
    new MutationObserver(function () {
      document.querySelectorAll('video[src], source[src]').forEach(function (el) {
        report(el.getAttribute('src') || '')
      })
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  } catch (e) {}
})()
</script>`

app.get('/api/embed-proxy', async (req, res) => {
  const rawUrl = req.query.url
  if (!rawUrl) return res.status(400).json({ error: 'Missing url parameter' })
  if (!isSafeProxyUrl(rawUrl)) {
    console.log(`[proxy] blocked: ${rawUrl.slice(0, 80)}`)
    return res.status(403).json({ error: 'Blocked' })
  }

  try {
    const r = await fetch(rawUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer':         'https://www.google.com/',
      },
      redirect: 'follow',
    })

    const ct = (r.headers.get('content-type') || '').toLowerCase()

    // Non-HTML resources (JS, CSS, images): pass through with CORS header added
    if (!ct.includes('html')) {
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
      res.setHeader('Access-Control-Allow-Origin', '*')
      const buf = await r.arrayBuffer()
      return res.send(Buffer.from(buf))
    }

    let html = await r.text()

    // Strip any CSP meta tags baked into the HTML
    html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '')

    // Rewrite existing <iframe src="…"> attributes to go through our proxy
    html = html.replace(/(<iframe[^>]+\bsrc=)(["'])([^"']+)(["'])/gi, (m, pre, q1, url, q2) => {
      if (/^https?:\/\//.test(url)) {
        return pre + q1 + '/api/embed-proxy?url=' + encodeURIComponent(url) + q2
      }
      return m
    })

    // Inject <base> + interceptor script immediately after <head>
    const base     = `<base href="${rawUrl.replace(/"/g, '%22')}">`
    const injected = base + INJECTED_SCRIPT

    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, m => m + injected)
    } else {
      html = injected + html
    }

    // Serve with permissive headers — no frame-busting, no CSP restrictions
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:")
    res.setHeader('Access-Control-Allow-Origin', '*')
    // Explicitly do NOT set X-Frame-Options (omitting it allows framing)

    console.log(`[proxy] served: ${rawUrl.slice(0, 80)}`)
    res.send(html)

  } catch (e) {
    console.error('[proxy] error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// ── REQUEST PROXY ─────────────────────────────────────────────────────────────
// Proxies individual XHR/fetch calls from the injected script.
// The server makes the request with spoofed Origin/Referer so the embed site's
// API thinks the call is same-origin. This bypasses CORS without needing the
// user's browser to make cross-origin requests.

app.get('/api/req-proxy', async (req, res) => {
  const rawUrl  = req.query.url
  const referer = req.query.ref || ''
  if (!rawUrl) return res.status(400).end()

  if (!isSafeProxyUrl(rawUrl)) return res.status(403).end()
  let targetOrigin
  try { targetOrigin = new URL(rawUrl).origin } catch (_) { return res.status(400).end() }

  try {
    const r = await fetch(rawUrl, {
      headers: {
        'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':           '*/*',
        'Accept-Language':  'en-US,en;q=0.5',
        'Origin':           targetOrigin,
        'Referer':          referer || targetOrigin + '/',
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'follow',
    })

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
    const buf = await r.arrayBuffer()
    res.send(Buffer.from(buf))
  } catch (e) {
    console.error('[req-proxy]', e.message)
    res.status(502).end()
  }
})

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

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

app.get('/api/profiles', async (req, res) => {
  try { const r = await vpsRequest('GET', '/api/profiles', null, null); res.status(r.status).json(await r.json()) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

app.post('/api/profiles', async (req, res) => {
  try { const r = await vpsRequest('POST', '/api/profiles', req.body, null); res.status(r.status).json(await r.json()) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

app.delete('/api/profiles/:id', async (req, res) => {
  try { const r = await vpsRequest('DELETE', `/api/profiles/${req.params.id}`, null, null); res.status(r.status).end() }
  catch (e) { res.status(502).end() }
})

// ── API: AUTH ─────────────────────────────────────────────────────────────────

app.post('/api/auth', async (req, res) => {
  try { const r = await vpsRequest('POST', '/api/auth', req.body, null); res.status(r.status).json(await r.json()) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

// ── API: CONTINUE WATCHING ────────────────────────────────────────────────────

app.get('/api/cw', async (req, res) => {
  try { const r = await vpsRequest('GET', '/api/cw', null, req.headers.authorization); res.status(r.status).json(await r.json()) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

app.put('/api/cw', async (req, res) => {
  try { const r = await vpsRequest('PUT', '/api/cw', req.body, req.headers.authorization); res.status(r.status).json(await r.json()) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

// ── API: RESOLVE (stream URL lookup) ─────────────────────────────────────────

app.get('/api/resolve', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString()
    const r  = await vpsRequest('GET', '/api/resolve' + (qs ? '?' + qs : ''), null, null)
    res.status(r.status).json(await r.json())
  } catch(e) {
    res.status(502).json({ error: e.message })
  }
})

// ── API: TMDB PROXY ───────────────────────────────────────────────────────────

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

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`JackFlix running on port ${PORT}`)
})
