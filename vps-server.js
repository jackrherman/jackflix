'use strict'
const http = require('http')
const https = require('https')
const url = require('url')

const SECRET = 'jf-rn-2026-xK9mP'
const PORT = 3000

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
    try { return new URL(u).origin !== location.origin && u.indexOf('/api/req-proxy') === -1 } catch (e) { return false }
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
    if (v && /^https?:\/\//.test(v) && v.indexOf('/api/embed-proxy') === -1) {
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
  try {
    new MutationObserver(function () {
      document.querySelectorAll('video[src], source[src]').forEach(function (el) {
        report(el.getAttribute('src') || '')
      })
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  } catch (e) {}
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

function fetchUrl(rawUrl, headers, cb) {
  const parsed = new URL(rawUrl)
  const mod = parsed.protocol === 'https:' ? https : http
  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + (parsed.search || ''),
    method: 'GET',
    headers,
    rejectUnauthorized: false,
  }
  const req = mod.request(opts, cb)
  req.on('error', (e) => cb(null, e))
  req.end()
}

const server = http.createServer((req, res) => {
  if (req.headers['x-jf-secret'] !== SECRET) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  const parsed = url.parse(req.url, true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')

  if (parsed.pathname === '/api/embed-proxy') {
    const rawUrl = parsed.query.url
    if (!rawUrl || !isSafe(rawUrl)) { res.writeHead(400); res.end('Bad url'); return }
    fetchUrl(rawUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.google.com/',
    }, (upstream, err) => {
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
          if (/^https?:\/\//.test(u)) return pre + q1 + '/api/embed-proxy?url=' + encodeURIComponent(u) + q2
          return m
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
    fetchUrl(rawUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
      'Origin': targetOrigin,
      'Referer': ref || targetOrigin + '/',
      'X-Requested-With': 'XMLHttpRequest',
    }, (upstream, err) => {
      if (err || !upstream) { res.writeHead(502); res.end(''); return }
      let chunks = []
      upstream.on('data', c => chunks.push(c))
      upstream.on('end', () => {
        res.writeHead(upstream.statusCode, { 'Content-Type': upstream.headers['content-type'] || 'application/octet-stream' })
        res.end(Buffer.concat(chunks))
      })
    })
  } else {
    res.writeHead(200); res.end('JackFlix VPS proxy OK')
  }
})

server.listen(PORT, () => console.log('jackflix-proxy listening on ' + PORT))
