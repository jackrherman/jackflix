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

// ── EMBED PROXY ───────────────────────────────────────────────────────────────

async function handleEmbedProxy(searchParams) {
  const rawUrl = searchParams.get('url')
  if (!rawUrl) {
    return new Response('{"error":"Missing url"}', {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    })
  }
  if (!isSafeProxyUrl(rawUrl)) {
    return new Response('{"error":"Blocked"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    })
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

    // Non-HTML resources: pass through with CORS header
    if (!ct.includes('html')) {
      const buf = await r.arrayBuffer()
      return new Response(buf, {
        headers: {
          'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
          ...corsHeaders(),
        },
      })
    }

    let html = await r.text()

    // Strip baked-in CSP meta tags
    html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '')

    // Rewrite existing <iframe src="…"> to go through our proxy
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

    return new Response(html, {
      headers: {
        'Content-Type':            'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
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

// ── REQUEST PROXY ─────────────────────────────────────────────────────────────

async function handleReqProxy(searchParams) {
  const rawUrl  = searchParams.get('url')
  const referer = searchParams.get('ref') || ''
  if (!rawUrl) return new Response('', { status: 400, headers: corsHeaders() })
  if (!isSafeProxyUrl(rawUrl)) return new Response('', { status: 403, headers: corsHeaders() })

  let targetOrigin
  try { targetOrigin = new URL(rawUrl).origin } catch (_) {
    return new Response('', { status: 400, headers: corsHeaders() })
  }

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

    const buf = await r.arrayBuffer()
    return new Response(buf, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
      },
    })
  } catch (e) {
    return new Response('', { status: 502, headers: corsHeaders() })
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

    if (url.pathname === '/api/embed-proxy') return handleEmbedProxy(url.searchParams)
    if (url.pathname === '/api/req-proxy')   return handleReqProxy(url.searchParams)

    return new Response('JackFlix Proxy Worker — OK', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  },
}
