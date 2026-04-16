'use strict'

// ── INJECTED SCRIPT ───────────────────────────────────────────────────────────
// Injected into every proxied HTML page.
// 1. Saves real parent ref, overrides window.top/parent/self (anti-frame-bust).
// 2. Intercepts XHR + fetch — routes all cross-origin requests through /api/req-proxy.
// 3. Scans request URLs and response bodies for .m3u8 URLs.
// 4. Relays jf-stream messages from child frames upward (multi-iframe chains).
// 5. Rewrites iframe src assignments through /api/embed-proxy (recursive proxy).

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
    var m = text.match(/https?:\\/\\/[^"'\\s\\\\]+\\.m3u8[^"'\\s\\\\]*/i)
    if (m) report(m[0])
  }

  window.addEventListener('message', function (e) {
    if (_P && e.data && e.data.type === 'jf-stream') try { _P.postMessage(e.data, '*') } catch (e2) {}
  })

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
    var finalInput = typeof input === 'string' ? routed : routed
    return _f.call(window, finalInput, init).then(function (resp) {
      var ct = resp.headers.get('content-type') || ''
      if (ct.indexOf('json') !== -1 || ct.indexOf('javascript') !== -1 || ct.indexOf('text/plain') !== -1) {
        resp.clone().text().then(function (t) { scanText(t) }).catch(function () {})
      }
      return resp
    })
  }

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

  try {
    new MutationObserver(function () {
      document.querySelectorAll('video[src], source[src]').forEach(function (el) {
        report(el.getAttribute('src') || '')
      })
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  } catch (e) {}
})()
</script>`

// ── HELPERS ───────────────────────────────────────────────────────────────────

function isSafeProxyUrl(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname
    if (!h) return false
    if (h === 'localhost') return false
    if (/^127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(h)) return false
    if (h.endsWith('.local') || h.endsWith('.internal')) return false
    return rawUrl.startsWith('https://') || rawUrl.startsWith('http://')
  } catch (_) {
    return false
  }
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  }
}

// ── VPS BACKEND ───────────────────────────────────────────────────────────────

const VPS_BASE   = 'http://107.175.245.21:3000'
const VPS_SECRET = 'jf-rn-2026-xK9mP'

async function forwardToVPS(pathname, searchParams) {
  const qs  = searchParams.toString()
  const vpsUrl = `${VPS_BASE}${pathname}${qs ? '?' + qs : ''}`
  try {
    const r = await fetch(vpsUrl, {
      headers: { 'x-jf-secret': VPS_SECRET },
      redirect: 'follow',
    })
    const buf = await r.arrayBuffer()
    return new Response(buf, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
        ...corsHeaders(),
      },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    })
  }
}

// ── WORKER ENTRY POINT ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    if (url.pathname === '/api/embed-proxy') return forwardToVPS('/api/embed-proxy', url.searchParams)
    if (url.pathname === '/api/req-proxy')   return forwardToVPS('/api/req-proxy',   url.searchParams)

    return new Response('JackFlix Proxy Worker — OK (VPS backend)', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  },
}
