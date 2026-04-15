// ── TMDB HELPER ───────────────────────────────────────────────────────────────
// Defined here (player.js loads first) so both player.js and app.js can use it.

var tmdb = (ep, p = {}) => {
  const url = new URL(`/api/tmdb${ep}`, location.origin)
  Object.entries(p).forEach(([k, v]) => url.searchParams.set(k, v))
  return fetch(url).then(r => r.json())
}

// ── PLAYER STATE ──────────────────────────────────────────────────────────────

let currentPlayer        = null
let hlsInstance          = null
let hideTimer            = null
let isScrubbing          = false
let playerReady          = false   // guard: setupPlayer() runs only once
let streamAbortController = null   // cancels in-flight /api/stream fetch on close

const vid = () => document.getElementById('vpVideo')

// ── CONTINUE WATCHING ─────────────────────────────────────────────────────────

const CW_KEY = 'cineb_cw'

function cwKey(p) {
  return p.type === 'movie'
    ? `m_${p.tmdbId}`
    : `t_${p.tmdbId}_${p.season}_${p.episode}`
}

function cwSave() {
  const v = vid()
  if (!currentPlayer || !v.duration || v.duration < 60) return
  const pct = v.currentTime / v.duration
  if (pct < 0.02 || pct > 0.95) return
  const store = cwAll()
  store[cwKey(currentPlayer)] = {
    tmdbId:     currentPlayer.tmdbId,
    type:       currentPlayer.type,
    title:      currentPlayer.title,
    posterPath: currentPlayer.posterPath || null,
    season:     currentPlayer.season,
    episode:    currentPlayer.episode,
    position:   v.currentTime,
    duration:   v.duration,
    pct,
    ts:         Date.now(),
  }
  const entries = Object.entries(store).sort((a,b) => b[1].ts - a[1].ts)
  const trimmed = Object.fromEntries(entries.slice(0, 50))
  localStorage.setItem(CW_KEY, JSON.stringify(trimmed))
}

function cwAll() {
  try { return JSON.parse(localStorage.getItem(CW_KEY) || '{}') } catch { return {} }
}

function cwGet(p) {
  return cwAll()[cwKey(p)] || null
}

function cwRemove(p) {
  const store = cwAll()
  delete store[cwKey(p)]
  localStorage.setItem(CW_KEY, JSON.stringify(store))
}

function cwRecent() {
  return Object.values(cwAll())
    .filter(e => e.pct > 0.02 && e.pct < 0.95)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20)
}

// ── OPEN PLAYER ───────────────────────────────────────────────────────────────

function openPlayer(title, tmdbId, type, season = 1, episode = 1, posterPath = null, resumeFrom = null) {
  currentPlayer = {
    title, tmdbId, type,
    season:      type === 'movie' ? null : season,
    episode:     type === 'movie' ? null : episode,
    serverIndex: 0,
    posterPath,
    resumeFrom,
    autoRetry:   0,
    seasonCache: {},
    referer:     null,
  }

  if (resumeFrom === null) {
    const saved = cwGet(currentPlayer)
    if (saved && saved.pct > 0.02 && saved.pct < 0.95) {
      currentPlayer.resumeFrom = saved.position
    }
  }

  showOverlay()
  showLoading('Finding stream…', '')

  if (type === 'tv') prefetchSeasons(tmdbId, season)

  tryServer(0)

  document.addEventListener('keydown', onPlayerKey)
}

// ── STREAM FETCH ──────────────────────────────────────────────────────────────
// Replaces the Electron webRequest sniffing: calls the server's /api/stream
// endpoint which runs Puppeteer server-side and returns the m3u8 URL.

async function tryServer(serverIndex) {
  if (!currentPlayer) return
  currentPlayer.serverIndex = serverIndex

  // Cancel any previous in-flight request
  if (streamAbortController) streamAbortController.abort()
  streamAbortController = new AbortController()

  try {
    const res = await fetch('/api/stream', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tmdbId:      currentPlayer.tmdbId,
        type:        currentPlayer.type,
        season:      currentPlayer.season,
        episode:     currentPlayer.episode,
        serverIndex,
      }),
      signal: streamAbortController.signal,
    })

    if (!currentPlayer) return  // closed while waiting

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { streamUrl, referer } = await res.json()
    if (!streamUrl) throw new Error('Empty stream URL')

    currentPlayer.referer = referer
    startHLS(streamUrl)
  } catch(e) {
    if (e.name === 'AbortError') return  // intentional close — do nothing
    onTimeout()
  }
}

function showOverlay() {
  document.getElementById('vpOverlay').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
  document.getElementById('vpTitle').textContent = buildLabel()
  document.querySelectorAll('.vp-srv-btn').forEach((b,i) => b.classList.toggle('active', i === 0))
  document.getElementById('vpVideo').style.display = 'block'

  const isTV = currentPlayer?.type === 'tv'
  document.getElementById('vpEpListBtn').classList.toggle('hidden', !isTV)
  closeEpisodePanel()
}

function buildLabel() {
  if (!currentPlayer) return ''
  const { title, type, season, episode } = currentPlayer
  if (type !== 'tv') return title
  const s = String(season).padStart(2,'0')
  const e = String(episode).padStart(2,'0')
  return `${title}  ·  S${s}E${e}`
}

// ── LOADING STATES ────────────────────────────────────────────────────────────

function showLoading(msg, sub) {
  document.getElementById('vpLoading').classList.remove('hidden')
  document.getElementById('vpLoadingMsg').textContent = msg
  document.getElementById('vpLoadingSub').textContent = sub || ''
  document.getElementById('vpControls').classList.add('vp-hidden')
}

function hideLoading() {
  document.getElementById('vpLoading').classList.add('hidden')
}

// ── TIMEOUT / AUTO-RETRY ──────────────────────────────────────────────────────

function onTimeout() {
  if (!currentPlayer) return
  currentPlayer.autoRetry++

  if (currentPlayer.autoRetry <= 2) {
    currentPlayer.serverIndex = currentPlayer.autoRetry
    showLoading('Finding stream…', `Server ${currentPlayer.serverIndex + 1} — trying next…`)
    document.querySelectorAll('.vp-srv-btn').forEach((b,i) =>
      b.classList.toggle('active', i === currentPlayer.serverIndex))
    tryServer(currentPlayer.serverIndex)
  } else {
    showLoading('No stream found.', 'Check your connection or try again later.')
    document.getElementById('vpBack').closest('.vp-controls').classList.remove('vp-hidden')
  }
}

// ── HLS INITIALISATION ────────────────────────────────────────────────────────

function startHLS(streamUrl) {
  if (!currentPlayer) return

  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null }

  hideLoading()
  document.getElementById('vpControls').classList.remove('vp-hidden')
  resetHideTimer()

  const v = vid()
  v.style.display = 'block'

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    hlsInstance = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 })
    hlsInstance.loadSource(streamUrl)
    hlsInstance.attachMedia(v)

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (currentPlayer?.resumeFrom) {
        v.currentTime = currentPlayer.resumeFrom
        currentPlayer.resumeFrom = null
      }
      v.play().catch(() => {})
      buildQualityMenu()
    })

    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) showLoading('Playback error.', 'Try another server.')
    })
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    v.src = streamUrl
    v.addEventListener('loadedmetadata', () => {
      if (currentPlayer?.resumeFrom) {
        v.currentTime = currentPlayer.resumeFrom
        currentPlayer.resumeFrom = null
      }
      v.play().catch(() => {})
    }, { once: true })
  } else {
    showLoading('HLS not supported.', 'Try another server.')
  }
}

// ── SERVER SWITCH ─────────────────────────────────────────────────────────────

function switchServer(idx) {
  if (!currentPlayer) return
  currentPlayer.serverIndex = idx
  currentPlayer.autoRetry   = idx

  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null }
  const v = vid()
  v.pause(); v.removeAttribute('src')

  showLoading('Switching server…', '')
  tryServer(idx)
}

// ── CLOSE PLAYER ─────────────────────────────────────────────────────────────

function closePlayer() {
  cwSave()
  closePlayerSilent()
}

function closePlayerSilent() {
  // Cancel any pending stream fetch
  if (streamAbortController) {
    streamAbortController.abort()
    streamAbortController = null
  }

  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null }

  const v = vid()
  v.pause()
  v.removeAttribute('src')
  v.style.display = 'block'

  document.getElementById('vpOverlay').classList.add('hidden')
  document.getElementById('vpLoading').classList.add('hidden')
  document.getElementById('vpBufRing').classList.add('hidden')
  document.getElementById('vpControls').classList.remove('vp-hidden')
  document.getElementById('vpQualityBtn').textContent = 'Auto'
  document.getElementById('vpQualityMenu').innerHTML  = ''
  document.getElementById('vpQualityMenu').classList.add('hidden')
  document.body.style.overflow = ''

  // Reset episode panel state
  document.getElementById('vpEpPanel').classList.add('hidden')
  document.getElementById('vpEpListBtn').classList.remove('open')
  document.getElementById('vpEpSeasonSel').innerHTML     = ''
  document.getElementById('vpEpSeasonSel').dataset.tmdbId = ''

  clearTimeout(hideTimer)
  document.removeEventListener('keydown', onPlayerKey)

  currentPlayer = null
}

// ── QUALITY MENU ─────────────────────────────────────────────────────────────

function buildQualityMenu() {
  const menu = document.getElementById('vpQualityMenu')
  const btn  = document.getElementById('vpQualityBtn')
  if (!menu || !hlsInstance) return

  menu.innerHTML = ''
  const levels = hlsInstance.levels || []
  const seen   = new Set()
  const opts   = [{ label: 'Auto', idx: -1 }]

  ;[...levels]
    .map((l, i) => ({ label: l.height ? `${l.height}p` : `Level ${i+1}`, idx: i, height: l.height || 0 }))
    .sort((a, b) => b.height - a.height)
    .forEach(o => { if (!seen.has(o.label)) { seen.add(o.label); opts.push(o) } })

  opts.forEach(opt => {
    const el = document.createElement('button')
    el.className = 'vp-quality-opt'
    el.textContent = opt.label
    el.dataset.idx = opt.idx
    if (opt.idx === -1) el.classList.add('active')
    el.addEventListener('click', () => {
      hlsInstance.currentLevel = opt.idx
      btn.textContent = opt.label
      menu.classList.add('hidden')
      menu.querySelectorAll('.vp-quality-opt').forEach(b =>
        b.classList.toggle('active', b.dataset.idx == opt.idx))
    })
    menu.appendChild(el)
  })

  if (opts.length > 1) {
    const highest = opts[1]
    hlsInstance.startLevel = highest.idx
    btn.textContent = highest.label
    setTimeout(() => {
      menu.querySelectorAll('.vp-quality-opt').forEach(b =>
        b.classList.toggle('active', b.dataset.idx == highest.idx))
    }, 50)
  }
}

// ── VIDEO CONTROLS SETUP (runs once) ─────────────────────────────────────────

function setupPlayer() {
  if (playerReady) return
  playerReady = true

  const v   = vid()
  const ov  = document.getElementById('vpOverlay')
  const ctr = document.getElementById('vpControls')

  // ── Video events ──
  v.addEventListener('play',    () => { updatePlayIcon(); resetHideTimer() })
  v.addEventListener('pause',   () => { updatePlayIcon(); showControls()   })
  v.addEventListener('waiting', () => document.getElementById('vpBufRing').classList.remove('hidden'))
  v.addEventListener('playing', () => document.getElementById('vpBufRing').classList.add('hidden'))
  v.addEventListener('timeupdate', onTimeUpdate)
  v.addEventListener('progress',   onBuffer)
  v.addEventListener('ended',      onEnded)
  v.addEventListener('click',      togglePlay)

  // ── Controls auto-hide ──
  ov.addEventListener('mousemove', resetHideTimer)
  ctr.addEventListener('mouseenter', () => { clearTimeout(hideTimer); showControls() })
  ctr.addEventListener('mouseleave', resetHideTimer)

  // ── Buttons ──
  document.getElementById('vpBack').addEventListener('click', closePlayer)

  document.getElementById('vpQualityBtn').addEventListener('click', e => {
    e.stopPropagation()
    document.getElementById('vpQualityMenu').classList.toggle('hidden')
  })
  document.addEventListener('click', () =>
    document.getElementById('vpQualityMenu').classList.add('hidden'))

  document.getElementById('vpPlayBtn').addEventListener('click', togglePlay)
  document.getElementById('vpSkipBack').addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 10) })
  document.getElementById('vpSkipFwd').addEventListener('click',  () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10) })
  document.getElementById('vpMute').addEventListener('click', toggleMute)
  document.getElementById('vpFs').addEventListener('click', toggleFullscreen)
  document.getElementById('vpPrevEp').addEventListener('click', playPrev)
  document.getElementById('vpNextEp').addEventListener('click', playNext)

  // ── Episode panel ──
  document.getElementById('vpEpListBtn').addEventListener('click', e => {
    e.stopPropagation()
    const panel = document.getElementById('vpEpPanel')
    if (panel.classList.contains('hidden')) openEpisodePanel()
    else closeEpisodePanel()
  })
  document.getElementById('vpEpPanelClose').addEventListener('click', closeEpisodePanel)
  document.getElementById('vpEpSeasonSel').addEventListener('change', () => {
    loadEpisodePanel(parseInt(document.getElementById('vpEpSeasonSel').value))
  })

  // ── Server buttons ──
  document.querySelectorAll('.vp-srv-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.vp-srv-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      switchServer(parseInt(btn.dataset.s))
    })
  })

  // ── Volume ──
  const volSlider = document.getElementById('vpVolSlider')
  volSlider.addEventListener('input', () => {
    v.volume = parseFloat(volSlider.value)
    v.muted  = v.volume === 0
    updateVolIcon()
  })

  // ── Seek bar ──
  const seekWrap  = document.getElementById('vpSeekWrap')
  const seekTrack = document.getElementById('vpSeekTrack')
  const seekTip   = document.getElementById('vpSeekTip')

  seekWrap.addEventListener('mousedown', e => { isScrubbing = true; seekToEvent(e) })
  seekWrap.addEventListener('mousemove', e => {
    const rect = seekTrack.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seekTip.textContent = fmtTime(frac * (v.duration || 0))
    seekTip.style.left  = `${frac * 100}%`
    seekTrack.querySelector('.vp-seek-dot').style.left = `${frac * 100}%`
  })
  document.addEventListener('mousemove', e => { if (isScrubbing) seekToEvent(e) })
  document.addEventListener('mouseup',   () => { isScrubbing = false })

  // ── Fullscreen change ──
  // On workspace switch or external fullscreen exit, always show controls
  // so the user can see the back button and close the player.
  document.addEventListener('fullscreenchange', () => {
    updateFsIcon()
    if (!document.fullscreenElement && currentPlayer) {
      clearTimeout(hideTimer)
      showControls()
    }
  })

  // ── Window focus safety net ──
  // After switching workspaces and back: show controls if player is open,
  // or restore body scroll if both overlays are somehow stuck hidden.
  window.addEventListener('focus', () => {
    if (currentPlayer) {
      clearTimeout(hideTimer)
      showControls()
      return
    }
    const playerOpen = !document.getElementById('vpOverlay').classList.contains('hidden')
    const modalOpen  = !document.getElementById('modalOverlay').classList.contains('hidden')
    if (!playerOpen && !modalOpen) document.body.style.overflow = ''
  })
}

function seekToEvent(e) {
  const track = document.getElementById('vpSeekTrack')
  const rect  = track.getBoundingClientRect()
  const frac  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const v     = vid()
  if (v.duration) v.currentTime = frac * v.duration
}

// ── PLAYBACK CONTROLS ─────────────────────────────────────────────────────────

function togglePlay() {
  const v = vid()
  if (v.paused) v.play().catch(() => {})
  else v.pause()
}

function toggleMute() {
  const v = vid()
  v.muted = !v.muted
  const slider = document.getElementById('vpVolSlider')
  if (!v.muted && slider.value == 0) { v.volume = 0.5; slider.value = 0.5 }
  updateVolIcon()
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.getElementById('vpOverlay').requestFullscreen().catch(() => {})
  } else {
    document.exitFullscreen()
  }
}

// ── ICONS ─────────────────────────────────────────────────────────────────────

function updatePlayIcon() {
  const v = vid()
  document.querySelector('.ico-pause').classList.toggle('hidden', v.paused)
  document.querySelector('.ico-play').classList.toggle('hidden', !v.paused)
}

function updateVolIcon() {
  const v = vid()
  document.querySelector('.ico-vol').classList.toggle('hidden', v.muted)
  document.querySelector('.ico-mute').classList.toggle('hidden', !v.muted)
}

function updateFsIcon() {
  const inFs = !!document.fullscreenElement
  document.querySelector('.ico-fs-in').classList.toggle('hidden', inFs)
  document.querySelector('.ico-fs-out').classList.toggle('hidden', !inFs)
}

// ── PROGRESS BAR ──────────────────────────────────────────────────────────────

function onTimeUpdate() {
  const v = vid()
  if (!v.duration) return
  const pct = (v.currentTime / v.duration) * 100
  document.getElementById('vpSeekFill').style.width = `${pct}%`
  document.getElementById('vpSeekWrap').querySelector('.vp-seek-dot').style.left = `${pct}%`
  document.getElementById('vpTime').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`
  if (Math.floor(v.currentTime) % 5 === 0) cwSave()
}

function onBuffer() {
  const v = vid()
  if (!v.duration || !v.buffered.length) return
  const end = v.buffered.end(v.buffered.length - 1)
  document.getElementById('vpSeekBuf').style.width = `${(end / v.duration) * 100}%`
}

function onEnded() {
  if (!currentPlayer) return
  cwRemove(currentPlayer)
  if (currentPlayer.type === 'tv') playNext()
}

function fmtTime(s) {
  if (!isFinite(s) || isNaN(s)) return '0:00'
  const h   = Math.floor(s / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

// ── AUTO-HIDE CONTROLS ────────────────────────────────────────────────────────

function showControls() {
  document.getElementById('vpControls').classList.remove('vp-hidden')
}

function resetHideTimer() {
  showControls()
  clearTimeout(hideTimer)
  if (!vid().paused) {
    hideTimer = setTimeout(() => {
      const ctr = document.getElementById('vpControls')
      if (!ctr.matches(':hover')) ctr.classList.add('vp-hidden')
    }, 3000)
  }
}

// ── KEYBOARD ──────────────────────────────────────────────────────────────────

function onPlayerKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
  const v = vid()
  switch (e.key) {
    case ' ':
    case 'k': e.preventDefault(); togglePlay(); break
    case 'ArrowLeft':
      e.preventDefault()
      v.currentTime = Math.max(0, v.currentTime - 10)
      resetHideTimer()
      break
    case 'ArrowRight':
      e.preventDefault()
      v.currentTime = Math.min(v.duration || 0, v.currentTime + 10)
      resetHideTimer()
      break
    case 'ArrowUp':
      e.preventDefault()
      v.volume = Math.min(1, v.volume + 0.1)
      document.getElementById('vpVolSlider').value = v.volume
      updateVolIcon()
      break
    case 'ArrowDown':
      e.preventDefault()
      v.volume = Math.max(0, v.volume - 0.1)
      document.getElementById('vpVolSlider').value = v.volume
      if (v.volume === 0) v.muted = true
      updateVolIcon()
      break
    case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break
    case 'm': case 'M': e.preventDefault(); toggleMute(); break
    case 'Escape':
      e.preventDefault()
      if (document.fullscreenElement) document.exitFullscreen()
      else closePlayer()
      break
    case 'n': case 'N': e.preventDefault(); playNext(); break
  }
}

// ── EPISODE PANEL ─────────────────────────────────────────────────────────────

function openEpisodePanel() {
  if (!currentPlayer || currentPlayer.type !== 'tv') return
  document.getElementById('vpEpPanel').classList.remove('hidden')
  document.getElementById('vpEpListBtn').classList.add('open')

  const sel = document.getElementById('vpEpSeasonSel')
  if (sel.dataset.tmdbId != currentPlayer.tmdbId) {
    sel.innerHTML = ''
    sel.dataset.tmdbId = ''
  }
  loadEpisodePanel(currentPlayer.season)
}

function closeEpisodePanel() {
  document.getElementById('vpEpPanel').classList.add('hidden')
  document.getElementById('vpEpListBtn').classList.remove('open')
}

async function loadEpisodePanel(seasonNum) {
  if (!currentPlayer || currentPlayer.type !== 'tv') return

  const list = document.getElementById('vpEpPanelList')
  const sel  = document.getElementById('vpEpSeasonSel')
  list.innerHTML = '<div class="spinner"></div>'

  if (!sel.dataset.tmdbId || sel.dataset.tmdbId != currentPlayer.tmdbId) {
    sel.innerHTML = ''
    sel.dataset.tmdbId = currentPlayer.tmdbId
    try {
      const det     = await tmdb(`/tv/${currentPlayer.tmdbId}`)
      if (!currentPlayer) return
      const seasons = (det.seasons || []).filter(s => s.season_number > 0)
      seasons.forEach(s => {
        const opt = document.createElement('option')
        opt.value = s.season_number
        opt.textContent = `Season ${s.season_number}`
        if (s.season_number === seasonNum) opt.selected = true
        sel.appendChild(opt)
      })
    } catch(_) {}
  } else {
    sel.value = seasonNum
  }

  try {
    const data    = await tmdb(`/tv/${currentPlayer.tmdbId}/season/${seasonNum}`)
    if (!currentPlayer) return
    const eps     = data.episodes || []
    const cwStore = cwAll()

    list.innerHTML = ''
    eps.forEach(ep => {
      const key      = `t_${currentPlayer.tmdbId}_${seasonNum}_${ep.episode_number}`
      const cwEntry  = cwStore[key]
      const isCurrent = seasonNum === currentPlayer.season && ep.episode_number === currentPlayer.episode
      const progPct  = cwEntry ? Math.round(cwEntry.pct * 100) : 0

      const item  = document.createElement('div')
      item.className = 'vp-ep-item' + (isCurrent ? ' current' : '')
      const thumb = ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null

      item.innerHTML = `
        <div class="vp-ep-thumb">
          ${thumb
            ? `<img src="${thumb}" alt="" loading="lazy">`
            : '<div style="width:100%;height:100%;background:#333;border-radius:4px"></div>'}
          <div class="vp-ep-thumb-play">▶</div>
          ${progPct > 0
            ? `<div class="vp-ep-thumb-prog"><div class="vp-ep-thumb-prog-fill" style="width:${progPct}%"></div></div>`
            : ''}
        </div>
        <div class="vp-ep-info">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:3px">
            <span class="vp-ep-num">${ep.episode_number}</span>
            <span class="vp-ep-title">${ep.name || `Episode ${ep.episode_number}`}</span>
            ${ep.runtime ? `<span class="vp-ep-runtime">${ep.runtime}m</span>` : ''}
          </div>
          ${isCurrent ? '<span class="vp-ep-now-playing">Now Playing</span>' : ''}
          ${ep.overview ? `<p style="font-size:12px;color:#aaa;margin:4px 0 0;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${ep.overview}</p>` : ''}
        </div>
      `

      item.addEventListener('click', () => {
        if (isCurrent) return
        const { title, tmdbId, posterPath } = currentPlayer
        closeEpisodePanel()
        closePlayerSilent()
        openPlayer(title, tmdbId, 'tv', seasonNum, ep.episode_number, posterPath)
      })

      list.appendChild(item)
    })

    const currentItem = list.querySelector('.vp-ep-item.current')
    if (currentItem) currentItem.scrollIntoView({ block: 'center', behavior: 'smooth' })

  } catch(_) {
    list.innerHTML = '<p style="padding:16px;color:#999;text-align:center">Could not load episodes.</p>'
  }
}

// ── PREV / NEXT EPISODE ───────────────────────────────────────────────────────

async function prefetchSeasons(tmdbId, currentSeason) {
  if (!currentPlayer) return
  try {
    const det = await tmdb(`/tv/${tmdbId}`)
    if (!currentPlayer) return
    currentPlayer._totalSeasons = det.number_of_seasons

    if (!currentPlayer.seasonCache[currentSeason]) {
      const s = await tmdb(`/tv/${tmdbId}/season/${currentSeason}`)
      if (!currentPlayer) return
      currentPlayer.seasonCache[currentSeason] = (s.episodes || []).length
    }
    updateEpButtons()
  } catch(_) {}
}

async function getEpCount(tmdbId, season) {
  if (currentPlayer?.seasonCache[season]) return currentPlayer.seasonCache[season]
  try {
    const s     = await tmdb(`/tv/${tmdbId}/season/${season}`)
    const count = (s.episodes || []).length
    if (currentPlayer) currentPlayer.seasonCache[season] = count
    return count
  } catch(_) { return 0 }
}

function updateEpButtons() {
  if (!currentPlayer || currentPlayer.type !== 'tv') {
    document.getElementById('vpPrevEp').classList.add('hidden')
    document.getElementById('vpNextEp').classList.add('hidden')
    return
  }
  const { season, episode, _totalSeasons, seasonCache } = currentPlayer
  const epInSeason = seasonCache[season] || 99
  const hasPrev    = season > 1 || episode > 1
  const hasNext    = episode < epInSeason || season < (_totalSeasons || 99)

  document.getElementById('vpPrevEp').classList.toggle('hidden', !hasPrev)
  document.getElementById('vpNextEp').classList.toggle('hidden', !hasNext)
}

async function playNext() {
  if (!currentPlayer || currentPlayer.type !== 'tv') return
  cwSave()

  const { tmdbId, season, episode, title, posterPath } = currentPlayer
  const epCount = await getEpCount(tmdbId, season)

  let ns = season, ne = episode + 1
  if (epCount && ne > epCount) {
    ns = season + 1
    ne = 1
    if (currentPlayer._totalSeasons && ns > currentPlayer._totalSeasons) {
      showLoading('Series complete!', '')
      setTimeout(() => closePlayer(), 2000)
      return
    }
  }

  closePlayerSilent()
  openPlayer(title, tmdbId, 'tv', ns, ne, posterPath)
}

async function playPrev() {
  if (!currentPlayer || currentPlayer.type !== 'tv') return
  cwSave()

  const { tmdbId, season, episode, title, posterPath } = currentPlayer
  let ns = season, ne = episode - 1

  if (ne < 1) {
    ns = season - 1
    if (ns < 1) return
    const prevCount = await getEpCount(tmdbId, ns)
    ne = prevCount || 1
  }

  closePlayerSilent()
  openPlayer(title, tmdbId, 'tv', ns, ne, posterPath)
}
