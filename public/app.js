const IMG = 'https://image.tmdb.org/t/p'

const ROWS = [
  { title: 'Trending Now',     endpoint: '/trending/all/week',  type: 'mixed' },
  { title: 'Popular Movies',   endpoint: '/movie/popular',       type: 'movie' },
  { title: 'Popular TV Shows', endpoint: '/tv/popular',          type: 'tv'    },
  { title: 'Top Rated Movies', endpoint: '/movie/top_rated',     type: 'movie' },
  { title: 'Top Rated TV',     endpoint: '/tv/top_rated',        type: 'tv'    },
  { title: 'Action',           endpoint: '/discover/movie',      type: 'movie', params: { with_genres: '28',  sort_by: 'popularity.desc' } },
  { title: 'Sci-Fi',           endpoint: '/discover/movie',      type: 'movie', params: { with_genres: '878', sort_by: 'popularity.desc' } },
  { title: 'Crime & Thriller', endpoint: '/discover/movie',      type: 'movie', params: { with_genres: '80',  sort_by: 'popularity.desc' } },
]

// ── STATE ─────────────────────────────────────────────────────────────────────

let activeFilter      = 'all'
let searchTimeout     = null
let modalItem         = null
let modalType         = null
let setupDone         = false    // prevents duplicate event listener registration
let _selectedProfile  = null
let _pinEntry         = ''

// ── HELPERS ───────────────────────────────────────────────────────────────────
// `tmdb` is defined in player.js (loaded first) as a var — do not redefine here.

const posterUrl = (p, sz='w342') => p ? `${IMG}/${sz}${p}` : null
const bdUrl     = (p, sz='w1280')=> p ? `${IMG}/${sz}${p}` : null
const ttitle    = i => i.title || i.name || 'Unknown'
const year      = i => (i.release_date || i.first_air_date || '').slice(0, 4)
const stars     = i => i.vote_average ? i.vote_average.toFixed(1) : '?'
const mtype     = (i, rt) => rt !== 'mixed' ? rt : (i.media_type || 'movie')

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  // ── Auth gate ──
  if (!checkAuth()) { showLoginScreen(); return }

  // ── One-time setup (adds event listeners — only run once) ──
  if (!setupDone) {
    setupDone = true
    setupNav()
    setupSearch()
    setupModal()
    setupPlayer()    // from player.js
    await loadCWFromServer()   // pull server CW and merge before rendering
  }

  const filtered = activeFilter === 'all'
    ? ROWS
    : ROWS.filter(r => r.type === activeFilter || r.type === 'mixed')

  const results = await Promise.all(
    filtered.map(row => tmdb(row.endpoint, row.params || {}).catch(() => ({ results: [] })))
  )

  // Hero from first trending item
  const tItems = results[0]?.results || []
  if (tItems.length) {
    const featured = tItems[Math.floor(Math.random() * Math.min(5, tItems.length))]
    renderHero(featured, mtype(featured, filtered[0].type))
  }

  const content = document.getElementById('content')
  content.innerHTML = ''

  // Continue watching row first
  const cwRow = buildCWRow()
  if (cwRow) content.appendChild(cwRow)

  filtered.forEach((row, i) => {
    const items = results[i]?.results || []
    if (items.length) content.appendChild(buildRow(row.title, items, row.type))
  })
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

function checkAuth() {
  const token = localStorage.getItem('jf_token')
  if (!token) return false
  try {
    // Decode the JWT payload (base64url) — no crypto needed for expiry check
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (payload.exp * 1000 < Date.now()) {
      localStorage.removeItem('jf_token')
      return false
    }
    serverToken = token   // keep the player.js global in sync
    return true
  } catch(_) {
    localStorage.removeItem('jf_token')
    return false
  }
}

async function showLoginScreen() {
  const screen = document.getElementById('loginScreen')
  screen.classList.remove('hidden')

  // Fetch profiles from server and build cards
  try {
    const res      = await fetch('/api/profiles')
    const profiles = await res.json()
    const cards    = document.getElementById('profileCards')
    cards.innerHTML = ''
    profiles.forEach(p => {
      const card = document.createElement('div')
      card.className = 'profile-card'
      card.innerHTML = `
        <div class="profile-avatar">${p.name[0].toUpperCase()}</div>
        <div class="profile-name">${p.name}</div>
      `
      card.addEventListener('click', () => showPinScreen(p))
      cards.appendChild(card)
    })
  } catch(_) {}

  buildPinKeypad()
  document.getElementById('pinBack').addEventListener('click', showProfilePicker)
}

function showPinScreen(profile) {
  _selectedProfile = profile
  _pinEntry        = ''
  document.getElementById('profilePicker').classList.add('hidden')
  document.getElementById('pinScreen').classList.remove('hidden')
  document.getElementById('pinFor').textContent = `Enter PIN for ${profile.name}`
  updatePinDots()
  document.getElementById('pinError').classList.add('hidden')
}

function showProfilePicker() {
  _selectedProfile = null
  _pinEntry        = ''
  document.getElementById('pinScreen').classList.add('hidden')
  document.getElementById('profilePicker').classList.remove('hidden')
}

function buildPinKeypad() {
  const keypad = document.getElementById('pinKeypad')
  keypad.innerHTML = ''
  const keys = ['1','2','3','4','5','6','7','8','9','clear','0','del']
  keys.forEach(k => {
    const btn = document.createElement('button')
    if (k === 'clear') {
      btn.className   = 'pin-key pin-key-special'
      btn.textContent = 'Clear'
      btn.addEventListener('click', () => {
        _pinEntry = ''
        updatePinDots()
        document.getElementById('pinError').classList.add('hidden')
      })
    } else if (k === 'del') {
      btn.className   = 'pin-key pin-key-special'
      btn.textContent = '⌫'
      btn.addEventListener('click', () => {
        _pinEntry = _pinEntry.slice(0, -1)
        updatePinDots()
        document.getElementById('pinError').classList.add('hidden')
      })
    } else {
      btn.className   = 'pin-key'
      btn.textContent = k
      btn.addEventListener('click', () => onPinKey(k))
    }
    keypad.appendChild(btn)
  })
}

function updatePinDots() {
  document.querySelectorAll('.pin-dot').forEach((dot, i) =>
    dot.classList.toggle('filled', i < _pinEntry.length))
}

function onPinKey(digit) {
  if (_pinEntry.length >= 4) return
  _pinEntry += digit
  updatePinDots()
  if (_pinEntry.length === 4) submitPin()
}

async function submitPin() {
  if (!_selectedProfile) return
  try {
    const res = await fetch('/api/auth', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ profileId: _selectedProfile.id, pin: _pinEntry }),
    })
    if (res.ok) {
      const { token } = await res.json()
      localStorage.setItem('jf_token', token)
      serverToken = token   // player.js global
      document.getElementById('loginScreen').classList.add('hidden')
      init()
    } else {
      _pinEntry = ''
      updatePinDots()
      document.getElementById('pinError').classList.remove('hidden')
    }
  } catch(_) {
    _pinEntry = ''
    updatePinDots()
    document.getElementById('pinError').classList.remove('hidden')
  }
}

// ── NAV ───────────────────────────────────────────────────────────────────────

function setupNav() {
  window.addEventListener('scroll', () => {
    document.getElementById('nav').classList.toggle('solid', window.scrollY > 20)
  })
  document.querySelectorAll('.nav-link').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'))
      el.classList.add('active')
      activeFilter = el.dataset.filter
      init()
    })
  })
}

// ── SEARCH ────────────────────────────────────────────────────────────────────

function setupSearch() {
  const wrap  = document.getElementById('searchWrap')
  const input = document.getElementById('searchInput')
  const res   = document.getElementById('searchResults')

  document.getElementById('searchToggle').addEventListener('click', () => {
    wrap.classList.toggle('open')
    if (wrap.classList.contains('open')) input.focus()
    else { input.value = ''; res.classList.add('hidden') }
  })

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout)
    const q = input.value.trim()
    if (!q) { res.classList.add('hidden'); return }
    searchTimeout = setTimeout(() => doSearch(q), 350)
  })

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      wrap.classList.remove('open')
      input.value = ''
      res.classList.add('hidden')
    }
  })
}

async function doSearch(query) {
  const res = document.getElementById('searchResults')
  res.innerHTML = '<div class="spinner"></div>'
  res.classList.remove('hidden')

  const data  = await tmdb('/search/multi', { query, include_adult: false })
  const items = (data.results || [])
    .filter(i => i.media_type === 'movie' || i.media_type === 'tv')
    .slice(0, 20)

  if (!items.length) {
    res.innerHTML = `<p class="search-results-title">No results for "${query}"</p>`
    return
  }

  res.innerHTML = `<p class="search-results-title">Results for "${query}"</p><div class="search-grid" id="searchGrid"></div>`
  items.forEach(i => document.getElementById('searchGrid').appendChild(buildCard(i, i.media_type)))
}

// ── HERO ──────────────────────────────────────────────────────────────────────

function renderHero(item, type) {
  const bg = bdUrl(item.backdrop_path, 'original')
  if (bg) document.getElementById('heroBackdrop').style.backgroundImage = `url(${bg})`

  document.getElementById('heroBadge').textContent    = type === 'tv' ? 'TV SHOW' : 'FILM'
  document.getElementById('heroTitle').textContent     = ttitle(item)
  document.getElementById('heroOverview').textContent  = item.overview || ''
  document.getElementById('heroMeta').innerHTML = `
    <span class="rating">${stars(item)} ★</span>
    <span>${year(item)}</span>
  `
  document.getElementById('heroPlay').onclick = () =>
    openPlayer(ttitle(item), item.id, type, 1, 1, item.poster_path)
  document.getElementById('heroInfo').onclick = () => openModal(item, type)
}

// ── ROWS ──────────────────────────────────────────────────────────────────────

function buildRow(rowTitle, items, rowType) {
  const section = document.createElement('section')
  section.className = 'row'
  section.innerHTML = `
    <div class="row-header"><h2 class="row-title">${rowTitle}</h2></div>
    <div class="row-scroll-wrap">
      <button class="row-arrow left">&#8249;</button>
      <div class="row-cards"></div>
      <button class="row-arrow right">&#8250;</button>
    </div>
  `
  const cards   = section.querySelector('.row-cards')
  const scroller = cards

  items.forEach(item => cards.appendChild(buildCard(item, mtype(item, rowType))))

  section.querySelector('.row-arrow.left').addEventListener('click',
    () => scroller.scrollBy({ left: -scroller.clientWidth * 0.75, behavior: 'smooth' }))
  section.querySelector('.row-arrow.right').addEventListener('click',
    () => scroller.scrollBy({ left:  scroller.clientWidth * 0.75, behavior: 'smooth' }))

  return section
}

// ── CONTINUE WATCHING ROW ─────────────────────────────────────────────────────

function buildCWRow() {
  const entries = cwRecent()   // from player.js
  if (!entries.length) return null

  const section = document.createElement('section')
  section.className = 'row'
  section.id = 'cwRow'
  section.innerHTML = `
    <div class="row-header"><h2 class="row-title">Continue Watching</h2></div>
    <div class="row-scroll-wrap">
      <button class="row-arrow left">&#8249;</button>
      <div class="row-cards" id="cwCards"></div>
      <button class="row-arrow right">&#8250;</button>
    </div>
  `
  const cards    = section.querySelector('#cwCards')
  const scroller = cards

  entries.forEach(e => cards.appendChild(buildCWCard(e)))

  section.querySelector('.row-arrow.left').addEventListener('click',
    () => scroller.scrollBy({ left: -scroller.clientWidth * 0.75, behavior: 'smooth' }))
  section.querySelector('.row-arrow.right').addEventListener('click',
    () => scroller.scrollBy({ left:  scroller.clientWidth * 0.75, behavior: 'smooth' }))

  return section
}

function buildCWCard(entry) {
  const card = document.createElement('div')
  card.className = 'card'
  const p   = posterUrl(entry.posterPath)
  const pct = Math.round(entry.pct * 100)
  const epLabel = entry.type === 'tv'
    ? `<div class="card-ep">S${entry.season}E${entry.episode}</div>`
    : ''
  const cwActions = entry.type === 'tv'
    ? `<div class="cw-actions"><button class="cw-ep-btn">Episodes</button></div>`
    : ''

  card.innerHTML = p
    ? `<img src="${p}" alt="${entry.title}" loading="lazy">
       <div class="card-overlay">
         <div class="card-title">${entry.title}</div>${epLabel}
       </div>
       <div class="cw-progress"><div class="cw-progress-fill" style="width:${pct}%"></div></div>
       ${cwActions}`
    : `<div class="card-no-image">${entry.title}</div>
       <div class="cw-progress"><div class="cw-progress-fill" style="width:${pct}%"></div></div>
       ${cwActions}`

  card.addEventListener('click', () =>
    openPlayer(entry.title, entry.tmdbId, entry.type,
               entry.season, entry.episode, entry.posterPath, entry.position))

  if (entry.type === 'tv') {
    card.querySelector('.cw-ep-btn').addEventListener('click', async e => {
      e.stopPropagation()
      try {
        const det = await tmdb(`/tv/${entry.tmdbId}`)
        openModal(det, 'tv')
      } catch(_) {}
    })
  }

  return card
}

// ── CARD ──────────────────────────────────────────────────────────────────────

function buildCard(item, type) {
  const card = document.createElement('div')
  card.className = 'card'
  const p = posterUrl(item.poster_path)
  card.innerHTML = p
    ? `<img src="${p}" alt="${ttitle(item)}" loading="lazy">
       <div class="card-overlay">
         <div class="card-title">${ttitle(item)}</div>
         <div class="card-rating">${stars(item)} ★</div>
       </div>`
    : `<div class="card-no-image">${ttitle(item)}</div>
       <div class="card-overlay"><div class="card-rating">${stars(item)} ★</div></div>`
  card.addEventListener('click', () => openModal(item, type))
  return card
}

// ── MODAL ─────────────────────────────────────────────────────────────────────

function setupModal() {
  document.getElementById('modalClose').addEventListener('click', closeModal)
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay')) closeModal()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' &&
        !document.getElementById('vpOverlay').classList.contains('hidden') === false) {
      closeModal()
    }
  })
}

async function openModal(item, type) {
  modalItem = item
  modalType = type

  document.getElementById('modalOverlay').classList.remove('hidden')
  document.body.style.overflow = 'hidden'

  document.getElementById('modalTitle').textContent    = ttitle(item)
  document.getElementById('modalOverview').textContent = item.overview || ''
  document.getElementById('modalMeta').innerHTML = `
    <span class="match">${stars(item)} ★</span>
    <span class="year">${year(item)}</span>
  `
  document.getElementById('modalBackdrop').src = bdUrl(item.backdrop_path) || ''
  document.getElementById('episodesSection').classList.add('hidden')

  const playBtn = document.getElementById('modalPlay')
  playBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    ${type === 'tv' ? 'Play S1:E1' : 'Play'}
  `
  playBtn.onclick = () => {
    closeModal()
    openPlayer(ttitle(item), item.id, type, 1, 1, item.poster_path)
  }

  const endpoint = type === 'tv' ? `/tv/${item.id}` : `/movie/${item.id}`
  try {
    const [det, cred] = await Promise.all([tmdb(endpoint), tmdb(`${endpoint}/credits`)])

    let runtime = ''
    if (type === 'movie' && det.runtime)
      runtime = `${Math.floor(det.runtime/60)}h ${det.runtime % 60}m`
    else if (type === 'tv' && det.number_of_seasons)
      runtime = `${det.number_of_seasons} Season${det.number_of_seasons > 1 ? 's' : ''}`

    document.getElementById('modalMeta').innerHTML = `
      <span class="match">${stars(item)} ★</span>
      <span class="year">${year(item)}</span>
      ${runtime ? `<span class="runtime">${runtime}</span>` : ''}
      ${det.genres ? `<span class="rating-badge">${det.genres.map(g=>g.name).join(', ')}</span>` : ''}
    `

    const cast = (cred.cast || []).slice(0, 6).map(a => a.name).join(', ')
    const dir  = (cred.crew || []).find(c => c.job === 'Director')
    document.getElementById('modalSide').innerHTML = `
      ${cast ? `<div><span style="color:var(--muted)">Cast: </span><span>${cast}</span></div>` : ''}
      ${dir  ? `<div><span style="color:var(--muted)">Director: </span><span>${dir.name}</span></div>` : ''}
    `

    if (type === 'tv' && det.seasons) {
      const seasons = det.seasons.filter(s => s.season_number > 0)
      buildSeasonSelector(seasons, item.id)
      document.getElementById('episodesSection').classList.remove('hidden')
    }
  } catch(_) {}
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden')
  document.body.style.overflow = ''
}

// ── SEASON / EPISODE UI ───────────────────────────────────────────────────────

function buildSeasonSelector(seasons, tmdbId) {
  const sel = document.getElementById('seasonSelect')
  sel.innerHTML = ''
  seasons.forEach(s => {
    const opt = document.createElement('option')
    opt.value = s.season_number
    opt.textContent = `Season ${s.season_number}`
    sel.appendChild(opt)
  })
  loadEpisodes(tmdbId, seasons[0].season_number)
  sel.addEventListener('change', () => loadEpisodes(tmdbId, parseInt(sel.value)))
}

async function loadEpisodes(tmdbId, seasonNum) {
  const list = document.getElementById('episodeList')
  list.innerHTML = '<div class="spinner"></div>'

  const data = await tmdb(`/tv/${tmdbId}/season/${seasonNum}`)
  const eps  = data.episodes || []

  list.innerHTML = ''
  eps.forEach(ep => {
    const card  = document.createElement('div')
    card.className = 'episode-card'
    const thumb = ep.still_path ? `${IMG}/w300${ep.still_path}` : null
    card.innerHTML = `
      <div class="episode-thumb-wrap">
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<div style="width:100%;height:100%;background:#222"></div>'}
        <div class="episode-play-icon">▶</div>
      </div>
      <div class="episode-info">
        <div class="episode-header">
          <span class="episode-num">${ep.episode_number}</span>
          <span class="episode-title">${ep.name}</span>
          ${ep.runtime ? `<span class="episode-runtime">${ep.runtime}m</span>` : ''}
        </div>
        ${ep.overview ? `<p class="episode-desc">${ep.overview}</p>` : ''}
      </div>
    `
    card.addEventListener('click', () => {
      closeModal()
      openPlayer(ttitle(modalItem), tmdbId, 'tv', seasonNum, ep.episode_number, modalItem.poster_path)
    })
    list.appendChild(card)
  })
}

// ── START ─────────────────────────────────────────────────────────────────────

init()
