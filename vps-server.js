'use strict'
const http   = require('http')
const https  = require('https')
const url    = require('url')
const crypto = require('crypto')

const SECRET = 'jf-rn-2026-xK9mP'
const PORT   = 80

// ── COOKIE JAR ────────────────────────────────────────────────────────────────
// Stores cookies per-hostname so Turnstile verification persists across requests.
// Persisted to disk so VPS restarts don't force re-solving Turnstile.
const fs = require('fs')
const COOKIE_FILE = '/opt/jackflix-proxy/cookies.json'

let cookieJar = new Map()

function loadCookies() {
  try {
    const raw = fs.readFileSync(COOKIE_FILE, 'utf8')
    const obj = JSON.parse(raw)
    cookieJar = new Map(Object.entries(obj))
  } catch (_) {}
}

function saveCookies() {
  try {
    const obj = {}
    cookieJar.forEach((v, k) => { obj[k] = v })
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(obj))
  } catch (_) {}
}

loadCookies()

function storeCookies(hostname, setCookieHeaders) {
  if (!setCookieHeaders) return
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]
  const jar = cookieJar.get(hostname) || {}
  let changed = false
  for (const h of list) {
    const [pair] = h.split(';')
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name) { jar[name] = value; changed = true }
  }
  if (changed) { cookieJar.set(hostname, jar); saveCookies() }
}

function getCookies(hostname) {
  const jar = cookieJar.get(hostname)
  if (!jar || !Object.keys(jar).length) return ''
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
}

// ── PROFILES / AUTH / CW ──────────────────────────────────────────────────────

const JWT_SECRET    = 'jf-jwt-2026-xK9mP7'
const PROFILES_FILE = '/opt/jackflix-proxy/profiles.json'
const CW_FILE       = '/opt/jackflix-proxy/cw.json'

let profilesStore = {}
let cwDb          = {}

function loadAppData() {
  try { profilesStore = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')) } catch (_) {}
  try { cwDb          = JSON.parse(fs.readFileSync(CW_FILE,       'utf8')) } catch (_) {}
}

function saveProfiles() {
  try { fs.writeFileSync(PROFILES_FILE, JSON.stringify(profilesStore)) } catch (_) {}
}

function saveCW() {
  try { fs.writeFileSync(CW_FILE, JSON.stringify(cwDb)) } catch (_) {}
}

loadAppData()

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function jwtSign(payload) {
  const hdr  = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 })))
  const sig  = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${hdr}.${body}`).digest())
  return `${hdr}.${body}.${sig}`
}

function jwtVerify(token) {
  const p = (token || '').split('.')
  if (p.length !== 3) throw new Error('bad token')
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${p[0]}.${p[1]}`).digest())
  if (sig !== p[2]) throw new Error('bad sig')
  const pl = JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
  if (pl.exp < Math.floor(Date.now() / 1000)) throw new Error('expired')
  return pl
}

function hashPin(pin) {
  return crypto.createHmac('sha256', 'jf-pin-salt-2026').update(String(pin)).digest('hex')
}

function readBody(req, cb) {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')))
}

// ── INJECTED SCRIPT ───────────────────────────────────────────────────────────
const INJECTED_SCRIPT = `<script>
(function () {
  var _P = null
  try { if (window.parent !== window) _P = window.parent } catch (e) {}
  try {
    var _dP = Object.defineProperty, _w = window
    _dP(_w, 'top',    { get: function () { return _w }, configurable: true })
    _dP(_w, 'parent', { get: function () { return _w }, configurable: true })
    _dP(_w, 'self',   { get: function () { return _w }, configurable: true })
  } catch (e) {}
  function report(url) {
    if (!url || typeof url !== 'string' || url.indexOf('.m3u8') === -1) return
    if (url.indexOf('subtitle') !== -1 || url.indexOf('caption') !== -1 || url.indexOf('.vtt') !== -1) return
    var msg = { type: 'jf-stream', url: url, ref: location.href }
    if (_P) try { _P.postMessage(msg, '*') } catch (e) {}
  }
  function scanText(text) {
    if (!text) return
    var m = text.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i)
    if (m) report(m[0])
  }
  window.addEventListener('message', function (e) {
    if (_P && e.data && e.data.type === 'jf-stream') try { _P.postMessage(e.data, '*') } catch (e2) {}
  })
  var _EMBED_BASE = ''
  try { var _b = document.querySelector('base'); if (_b && _b.href) _EMBED_BASE = _b.href } catch (e) {}
  function _resolve(u) {
    if (!u || typeof u !== 'string') return u || ''
    if (/^https?:\/\//.test(u)) return u
    if (!_EMBED_BASE) return u
    try { return new URL(u, _EMBED_BASE).href } catch (e) { return u }
  }
  function _shouldProxy(u) {
    if (!u) return false
    try {
      var _h = new URL(u).hostname
      // Never proxy Cloudflare challenge/beacon - Turnstile needs direct browser access
      if (_h === 'challenges.cloudflare.com' || _h === 'static.cloudflareinsights.com') return false
      return new URL(u).origin !== location.origin && u.indexOf('/api/req-proxy') === -1
    } catch (e) { return false }
  }
  function _toReqProxy(u) {
    return '/api/req-proxy?url=' + encodeURIComponent(u) + '&ref=' + encodeURIComponent(_EMBED_BASE || location.href)
  }
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
  var _f = window.fetch
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : ((input && input.url) || '')
    var abs = _resolve(u)
    report(abs)
    var routed = _shouldProxy(abs) ? _toReqProxy(abs) : abs
    return _f.call(window, routed, init).then(function (resp) {
      var ct = resp.headers.get('content-type') || ''
      if (ct.indexOf('json') !== -1 || ct.indexOf('javascript') !== -1 || ct.indexOf('text/plain') !== -1) {
        resp.clone().text().then(function (t) { scanText(t) }).catch(function () {})
      }
      return resp
    })
  }
  function _proxyIframe(v) {
    if (!v || typeof v !== 'string') return v
    if (v.indexOf('/api/embed-proxy') !== -1) return v
    var abs = v
    if (!/^https?:\/\//.test(v)) {
      try { abs = new URL(v, _EMBED_BASE || location.href).href } catch(e) { return v }
    }
    return '/api/embed-proxy?url=' + encodeURIComponent(abs) + '&ref=' + encodeURIComponent(_EMBED_BASE || location.href)
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
  try {
    new MutationObserver(function () {
      document.querySelectorAll('video[src], source[src]').forEach(function (el) {
        report(el.getAttribute('src') || '')
      })
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  } catch (e) {}

  // Auto-click play buttons so embed players start loading the stream
  function _autoClick() {
    var sels = ['#pl_but', '.play-btn', '.play_btn', '.play-button', '[class*="play-ic"]', '[id="play"]', '.jw-display-icon-container', '.vjs-big-play-button']
    sels.forEach(function(s) {
      try { var el = document.querySelector(s); if (el) el.click() } catch(e) {}
    })
  }
  setTimeout(_autoClick, 800)
  setTimeout(_autoClick, 2000)
  setTimeout(_autoClick, 4000)

  // Scan initial page HTML for m3u8 URLs that are already present
  setTimeout(function() {
    try { scanText(document.documentElement.innerHTML) } catch(e) {}
  }, 1000)
  setTimeout(function() {
    try { scanText(document.documentElement.innerHTML) } catch(e) {}
  }, 3000)
})()
</script>`

function isSafe(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname
    if (!h || h === 'localhost') return false
    if (/^127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(h)) return false
    if (h.endsWith('.local') || h.endsWith('.internal')) return false
    return rawUrl.startsWith('https://') || rawUrl.startsWith('http://')
  } catch (_) { return false }
}

// fetchUrl: supports GET/POST, per-hostname cookie jar, body forwarding
function fetchUrl(rawUrl, headers, method, body, cb) {
  if (typeof method === 'function') { cb = method; method = 'GET'; body = null }
  if (typeof body === 'function') { cb = body; body = null }
  const parsed = new URL(rawUrl)
  const mod = parsed.protocol === 'https:' ? https : http

  // Merge stored cookies for this hostname
  const stored = getCookies(parsed.hostname)
  const mergedHeaders = stored ? Object.assign({}, headers, { 'Cookie': stored }) : Object.assign({}, headers)

  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null
  if (bodyBuf) mergedHeaders['Content-Length'] = bodyBuf.length

  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + (parsed.search || ''),
    method: method || 'GET',
    headers: mergedHeaders,
    rejectUnauthorized: false,
  }
  const req = mod.request(opts, (upstream) => {
    storeCookies(parsed.hostname, upstream.headers['set-cookie'])
    cb(upstream, null)
  })
  req.on('error', (e) => cb(null, e))
  if (bodyBuf) req.write(bodyBuf)
  req.end()
}

const server = http.createServer((req, res) => {
  if (req.headers['x-jf-secret'] !== SECRET) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  const parsed = url.parse(req.url, true)
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return
  }

  if (parsed.pathname === '/api/embed-proxy') {
    const rawUrl = parsed.query.url
    const embedRef = parsed.query.ref || ''
    if (!rawUrl || !isSafe(rawUrl)) { res.writeHead(400); res.end('Bad url'); return }
    let embedReferer = 'https://www.google.com/'
    if (embedRef) {
      try { embedReferer = new URL(embedRef).href } catch (_) {}
    }
    fetchUrl(rawUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': embedReferer,
    }, 'GET', null, (upstream, err) => {
      if (err || !upstream) { res.writeHead(502); res.end('Upstream error: ' + (err && err.message)); return }
      let chunks = []
      upstream.on('data', c => chunks.push(c))
      upstream.on('end', () => {
        const ct = (upstream.headers['content-type'] || '').toLowerCase()
        const body = Buffer.concat(chunks)
        if (!ct.includes('html')) {
          res.writeHead(upstream.statusCode, { 'Content-Type': ct || 'application/octet-stream' })
          res.end(body); return
        }
        let html = body.toString('utf8')
        html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '')
        html = html.replace(/(<iframe[^>]+\bsrc=)(["'])([^"']+)(["'])/gi, (m, pre, q1, u, q2) => {
          if (u.indexOf('/api/embed-proxy') !== -1) return m
          let abs = u
          if (!/^https?:\/\//.test(u)) {
            try { abs = new URL(u, rawUrl).href } catch (_) { return m }
          }
          if (!isSafe(abs)) return m
          return pre + q1 + '/api/embed-proxy?url=' + encodeURIComponent(abs) + '&ref=' + encodeURIComponent(rawUrl) + q2
        })
        const base = '<base href="' + rawUrl.replace(/"/g, '%22') + '">'
        const injected = base + INJECTED_SCRIPT
        if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/<head[^>]*>/i, m => m + injected)
        } else {
          html = injected + html
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
        })
        res.end(html)
      })
    })
  } else if (parsed.pathname === '/api/req-proxy') {
    const rawUrl = parsed.query.url
    const ref = parsed.query.ref || ''
    if (!rawUrl || !isSafe(rawUrl)) { res.writeHead(400); res.end('Bad url'); return }
    let targetOrigin
    try { targetOrigin = new URL(rawUrl).origin } catch (_) { res.writeHead(400); res.end(); return }

    // Read incoming request body (needed for POST, e.g. Turnstile /rcp_verify)
    const bodyChunks = []
    req.on('data', c => bodyChunks.push(c))
    req.on('end', () => {
      const reqBody = bodyChunks.length ? Buffer.concat(bodyChunks) : null
      const reqMethod = req.method || 'GET'
      const proxyHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Origin': targetOrigin,
        'Referer': ref || targetOrigin + '/',
        'X-Requested-With': 'XMLHttpRequest',
      }
      if (req.headers['content-type']) proxyHeaders['Content-Type'] = req.headers['content-type']

      fetchUrl(rawUrl, proxyHeaders, reqMethod, reqBody, (upstream, err) => {
        if (err || !upstream) { res.writeHead(502); res.end(''); return }
        let chunks = []
        upstream.on('data', c => chunks.push(c))
        upstream.on('end', () => {
          res.writeHead(upstream.statusCode, { 'Content-Type': upstream.headers['content-type'] || 'application/octet-stream' })
          res.end(Buffer.concat(chunks))
        })
      })
    })
  } else if (parsed.pathname === '/api/resolve') {
    // Resolve a TMDB ID to a flixcdn video_url via moviesapi.to
    const tmdbId  = parsed.query.tmdbId
    const type    = parsed.query.type || 'movie'
    const season  = parsed.query.season  || '1'
    const episode = parsed.query.episode || '1'
    if (!tmdbId) { res.writeHead(400); res.end('Missing tmdbId'); return }

    const apiUrl = type === 'tv'
      ? `https://ww2.moviesapi.to/api/tv/${tmdbId}/${season}/${episode}`
      : `https://ww2.moviesapi.to/api/movie/${tmdbId}`

    fetchUrl(apiUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, */*',
      'Referer': 'https://ww2.moviesapi.to/',
      'Origin': 'https://ww2.moviesapi.to',
    }, (upstream, err) => {
      if (err || !upstream) { res.writeHead(502); res.end(JSON.stringify({ error: 'upstream' })); return }
      let chunks = []
      upstream.on('data', c => chunks.push(c))
      upstream.on('end', () => {
        res.writeHead(upstream.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(Buffer.concat(chunks))
      })
    })
  // ── PROFILES ────────────────────────────────────────────────────────────────
  } else if (parsed.pathname === '/api/profiles' && req.method === 'GET') {
    const list = Object.values(profilesStore).map(p => ({ id: p.id, name: p.name, avatar: p.avatar || 0, hasPin: !!p.pinHash }))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(list))

  } else if (parsed.pathname === '/api/profiles' && req.method === 'POST') {
    readBody(req, raw => {
      try {
        const { name, avatar, pin } = JSON.parse(raw)
        if (!name || typeof name !== 'string' || !name.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Name required' })); return }
        const id = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now()
        profilesStore[id] = {
          id,
          name:    name.trim().slice(0, 20),
          avatar:  typeof avatar === 'number' ? Math.max(0, Math.min(7, avatar)) : 0,
          pinHash: pin ? hashPin(String(pin)) : null,
        }
        saveProfiles()
        const p = profilesStore[id]
        res.writeHead(201, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ id: p.id, name: p.name, avatar: p.avatar, hasPin: !!p.pinHash }))
      } catch (_) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })) }
    })

  } else if (parsed.pathname.startsWith('/api/profiles/') && req.method === 'DELETE') {
    const id = parsed.pathname.slice('/api/profiles/'.length)
    if (profilesStore[id]) { delete profilesStore[id]; saveProfiles() }
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end()

  // ── AUTH ─────────────────────────────────────────────────────────────────────
  } else if (parsed.pathname === '/api/auth' && req.method === 'POST') {
    readBody(req, raw => {
      try {
        const { profileId, pin } = JSON.parse(raw)
        const profile = profilesStore[profileId]
        if (!profile) { res.writeHead(401); res.end(JSON.stringify({ error: 'Profile not found' })); return }
        if (profile.pinHash && hashPin(String(pin || '')) !== profile.pinHash) {
          res.writeHead(401); res.end(JSON.stringify({ error: 'Wrong PIN' })); return
        }
        const token = jwtSign({ profileId: profile.id, name: profile.name })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ token, name: profile.name }))
      } catch (_) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })) }
    })

  // ── CONTINUE WATCHING ────────────────────────────────────────────────────────
  } else if (parsed.pathname === '/api/cw' && req.method === 'GET') {
    const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
    let profile
    try { profile = jwtVerify(auth) } catch (_) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' })
    res.end(JSON.stringify(cwDb[profile.profileId] || {}))

  } else if (parsed.pathname === '/api/cw' && (req.method === 'PUT' || req.method === 'POST')) {
    const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
    let profile
    try { profile = jwtVerify(auth) } catch (_) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return }
    readBody(req, raw => {
      try {
        const clientCW = JSON.parse(raw)
        const serverCW = cwDb[profile.profileId] || {}
        const merged   = { ...serverCW }
        for (const [key, entry] of Object.entries(clientCW)) {
          if (!merged[key] || (entry.ts || 0) > (merged[key].ts || 0)) merged[key] = entry
        }
        const entries = Object.entries(merged).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
        cwDb[profile.profileId] = Object.fromEntries(entries.slice(0, 50))
        saveCW()
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' })
        res.end(JSON.stringify(cwDb[profile.profileId]))
      } catch (_) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })) }
    })

  } else {
    res.writeHead(200); res.end('JackFlix VPS proxy OK')
  }
})

server.listen(PORT, () => console.log('jackflix-proxy listening on ' + PORT))
