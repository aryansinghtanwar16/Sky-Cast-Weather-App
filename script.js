/*
   SkyCast — script.js
   Data: Open-Meteo (forecast + geocoding), BigDataCloud (reverse geocode)
   */
'use strict';

/* ---------- CONFIG ---------- */
const CONFIG = {
  GEO_URL: 'https://geocoding-api.open-meteo.com/v1/search',
  WX_URL: 'https://api.open-meteo.com/v1/forecast',
  REVERSE_URL: 'https://api.bigdatacloud.net/data/reverse-geocode-client',
  CACHE_TTL: 10 * 60 * 1000,   // 10 min
  REFRESH_MS: 10 * 60 * 1000,  // auto-refresh every 10 min
  MAX_RECENT: 6,
  DEBOUNCE_MS: 250,
  TIMEOUT_MS: 12000,
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'celsiusBtn', 'fahrenheitBtn', 'themeToggle', 'searchForm', 'cityInput', 'clearBtn',
  'locationBtn', 'suggestions', 'recentWrap', 'recentList', 'clearRecent', 'welcome',
  'loader', 'errorMsg', 'errorText', 'retryBtn', 'weather', 'cityName', 'cityMeta',
  'localTime', 'favBtn', 'currentIcon', 'currentTemp', 'tempUnit', 'currentDesc',
  'tempMax', 'tempMin', 'feelsLike', 'humidity', 'wind', 'windDir', 'uvIndex', 'uvFill',
  'precip', 'pressure', 'visibility', 'sunrise', 'sunset', 'sunDot', 'hourlyPrev',
  'hourlyNext', 'hourlyList', 'dailyList', 'toast', 'lastUpdated',
].map((id) => [id, $(id)]));

/* ---------- STORAGE ---------- */
const store = {
  get(k, fb) {
    try { const v = localStorage.getItem('skycast:' + k); return v === null ? fb : JSON.parse(v); }
    catch { return fb; }
  },
  set(k, v) { try { localStorage.setItem('skycast:' + k, JSON.stringify(v)); } catch {} },
};
const cache = {
  get(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      return Date.now() - entry.t < CONFIG.CACHE_TTL ? entry : null;
    } catch { return null; }
  },
  set(key, d) { try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch {} },
};

/* ---------- STATE ---------- */
const prefersLight = matchMedia('(prefers-color-scheme: light)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  unit: store.get('unit', 'celsius'),
  theme: store.get('theme', prefersLight ? 'light' : 'dark'),
  recent: store.get('recent', []),
  favs: store.get('favs', []),
  place: null,
  data: null,
  fetchedAt: 0,
  reqId: 0,
  suggestions: [],
  activeIdx: -1,
  geoCtrl: null,
  lastAction: null,
  refreshTimer: null,
};

/* ---------- WEATHER CODES (WMO) ---------- */
// code: [label, dayIcon, nightIcon, mood]
const WMO = {
  0: ['Clear sky', '☀️', '🌙', 'clear'],
  1: ['Mainly clear', '🌤️', '🌙', 'clear'],
  2: ['Partly cloudy', '⛅', '☁️', 'clouds'],
  3: ['Overcast', '☁️', '☁️', 'clouds'],
  45: ['Fog', '🌫️', '🌫️', 'fog'],
  48: ['Rime fog', '🌫️', '🌫️', 'fog'],
  51: ['Light drizzle', '🌦️', '🌧️', 'rain'],
  53: ['Drizzle', '🌦️', '🌧️', 'rain'],
  55: ['Dense drizzle', '🌧️', '🌧️', 'rain'],
  56: ['Freezing drizzle', '🌧️', '🌧️', 'rain'],
  57: ['Freezing drizzle', '🌧️', '🌧️', 'rain'],
  61: ['Light rain', '🌦️', '🌧️', 'rain'],
  63: ['Rain', '🌧️', '🌧️', 'rain'],
  65: ['Heavy rain', '🌧️', '🌧️', 'rain'],
  66: ['Freezing rain', '🌧️', '🌧️', 'rain'],
  67: ['Freezing rain', '🌧️', '🌧️', 'rain'],
  71: ['Light snow', '🌨️', '🌨️', 'snow'],
  73: ['Snow', '❄️', '❄️', 'snow'],
  75: ['Heavy snow', '❄️', '❄️', 'snow'],
  77: ['Snow grains', '🌨️', '🌨️', 'snow'],
  80: ['Rain showers', '🌦️', '🌧️', 'rain'],
  81: ['Rain showers', '🌧️', '🌧️', 'rain'],
  82: ['Violent showers', '⛈️', '⛈️', 'storm'],
  85: ['Snow showers', '🌨️', '🌨️', 'snow'],
  86: ['Heavy snow showers', '❄️', '❄️', 'snow'],
  95: ['Thunderstorm', '⛈️', '⛈️', 'storm'],
  96: ['Thunderstorm & hail', '⛈️', '⛈️', 'storm'],
  99: ['Severe thunderstorm', '⛈️', '⛈️', 'storm'],
};
function wmo(code, isDay = 1) {
  const [label, day, night, mood] = WMO[code] || ['Unknown', '🌡️', '🌡️', 'clouds'];
  return { label, icon: isDay ? day : night, mood };
}

/* ---------- UNITS (data is fetched in metric, converted instantly) ---------- */
const isF = () => state.unit === 'fahrenheit';
const temp = (c) => Math.round(isF() ? (c * 9) / 5 + 32 : c);
const speed = (kmh) => (isF() ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`);
const precipFmt = (mm) => (isF() ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`);
const pressureFmt = (hpa) => (isF() ? `${(hpa * 0.02953).toFixed(2)} inHg` : `${Math.round(hpa)} hPa`);
const visFmt = (m) => {
  if (m == null) return '--';
  if (isF()) { const mi = m / 1609.34; return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`; }
  const km = m / 1000; return `${km.toFixed(km < 10 ? 1 : 0)} km`;
};

/* ---------- HELPERS ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const samePlace = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;
const flag = (cc) => (cc && cc.length === 2
  ? cc.toUpperCase().replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0))) : '');

// Open-Meteo returns local times (timezone=auto) without offset → treat as UTC and format in UTC
const parseLocal = (s) => new Date(s.length === 10 ? `${s}T00:00Z` : `${s}Z`);
const fmt = (d, opts) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts }).format(d);
const fmtTime = (s) => fmt(parseLocal(s), { hour: 'numeric', minute: '2-digit' });
const nowAtPlace = () => new Date(Date.now() + state.data.utc_offset_seconds * 1000);

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

function uvLabel(uv) {
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}

function tzDiffLabel() {
  const diff = state.data.utc_offset_seconds / 60 + new Date().getTimezoneOffset();
  if (diff === 0) return 'same time as you';
  const a = Math.abs(diff), h = Math.floor(a / 60), m = a % 60;
  return `${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''} ${diff > 0 ? 'ahead' : 'behind'}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  return rtf.format(-Math.round(s / 3600), 'hour');
}

function animateNumber(el, to, dur = 900) {
  const parsed = parseInt(el.textContent, 10);
  const from = Number.isNaN(parsed) ? 0 : parsed;
  cancelAnimationFrame(el._raf);
  if (reduceMotion.matches || from === to) { el.textContent = to; return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

/* ---------- UI STATE ---------- */
function showView(view, msg) {
  els.welcome.classList.toggle('hidden', view !== 'welcome');
  els.loader.classList.toggle('hidden', view !== 'loader');
  els.errorMsg.classList.toggle('hidden', view !== 'error');
  els.weather.classList.toggle('hidden', view !== 'weather');
  if (view === 'loader') els.loader.querySelector('.loader-text').textContent = msg || 'Fetching the skies…';
}
function showError(msg) {
  els.errorText.textContent = msg;
  showView('error');
}
function friendlyError(err) {
  if (!navigator.onLine) return "You're offline. Check your connection and try again.";
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'The weather service is taking too long. Try again.';
  return err?.message || 'Something went wrong.';
}

let toastTimer;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  els.toast.style.animation = 'none';
  void els.toast.offsetWidth; // restart animation
  els.toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

/* ---------- API ---------- */
async function getJSON(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Weather service error (${res.status}).`);
  return res.json();
}
const timeoutSignal = () => (AbortSignal.timeout ? AbortSignal.timeout(CONFIG.TIMEOUT_MS) : undefined);

async function searchCities(q, signal) {
  const url = `${CONFIG.GEO_URL}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
  const json = await getJSON(url, signal);
  return (json.results || []).map((r) => ({
    name: r.name, admin: r.admin1 || '', country: r.country || '',
    cc: r.country_code || '', lat: r.latitude, lon: r.longitude,
  }));
}

async function reverseGeocode(lat, lon) {
  const fallback = { name: 'My Location', admin: '', country: '', cc: '', lat, lon };
  try {
    const j = await getJSON(`${CONFIG.REVERSE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`, timeoutSignal());
    return {
      ...fallback,
      name: j.city || j.locality || fallback.name,
      admin: j.principalSubdivision || '',
      country: j.countryName || '',
      cc: j.countryCode || '',
    };
  } catch { return fallback; }
}

async function fetchWeather(place, force) {
  const key = `wx:${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  if (!force) { const hit = cache.get(key); if (hit) return { data: hit.d, t: hit.t }; }

  const params = new URLSearchParams({
    latitude: place.lat,
    longitude: place.lon,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day,visibility,uv_index',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: 7,
  });
  const data = await getJSON(`${CONFIG.WX_URL}?${params}`, timeoutSignal());
  cache.set(key, data);
  return { data, t: Date.now() };
}

/* ---------- MAIN FLOW ---------- */
async function loadPlace(place, { force = false, silent = false } = {}) {
  state.lastAction = () => loadPlace(place, { force: true });
  const reqId = ++state.reqId;
  const isNewPlace = !samePlace(place, state.place);
  if (!silent) showView('loader');

  try {
    const { data, t } = await fetchWeather(place, force);
    if (reqId !== state.reqId) return; // a newer request won
    state.place = place;
    state.data = data;
    state.fetchedAt = t;
    showView('weather');
    render({ resetScroll: isNewPlace });
    addRecent(place);
    updateURL(place);
    store.set('last', place);
    scheduleRefresh();
  } catch (err) {
    if (reqId !== state.reqId) return;
    if (silent) return; // keep old data on background refresh failure
    showError(friendlyError(err));
  }
}

function useLocation() {
  if (!('geolocation' in navigator)) return toast("Geolocation isn't supported in this browser.");
  state.lastAction = useLocation;
  showView('loader', 'Finding you…');
  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => loadPlace(await reverseGeocode(coords.latitude, coords.longitude)),
    (err) => showError(err.code === 1
      ? 'Location permission denied. Search for a city instead.'
      : "Couldn't get your location. Try searching instead."),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

function refresh() {
  if (!state.place) return;
  toast('Refreshing…', 1200);
  loadPlace(state.place, { force: true, silent: true });
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.place) {
      loadPlace(state.place, { force: true, silent: true });
    }
  }, CONFIG.REFRESH_MS);
}

/* ---------- RENDER ---------- */
function render({ resetScroll = false } = {}) {
  const { current: c, hourly: h, daily: d } = state.data;
  const p = state.place;
  const w = wmo(c.weather_code, c.is_day);
  const hourIdx = Math.max(0, h.time.findIndex((t) => t.slice(0, 13) === c.time.slice(0, 13)));

  // Mood → accent colour + background animation
  document.body.dataset.weather = !c.is_day && w.mood === 'clear' ? 'night' : w.mood;
  updateThemeColor();

  // Header
  els.cityName.textContent = p.name;
  const region = [p.admin, p.country].filter((x) => x && x !== p.name).join(', ');
  els.cityMeta.textContent = `${flag(p.cc)} ${region || 'Unknown region'} · ${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°`.trim();

  // Current
  els.currentIcon.textContent = w.icon;
  animateNumber(els.currentTemp, temp(c.temperature_2m));
  els.tempUnit.textContent = isF() ? '°F' : '°C';
  els.currentDesc.textContent = w.label;
  els.tempMax.textContent = temp(d.temperature_2m_max[0]);
  els.tempMin.textContent = temp(d.temperature_2m_min[0]);

  // Details
  els.feelsLike.textContent = `${temp(c.apparent_temperature)}°`;
  els.humidity.textContent = `${c.relative_humidity_2m}%`;
  els.wind.textContent = speed(c.wind_speed_10m);
  els.windDir.innerHTML =
    `<span style="display:inline-block;transform:rotate(${c.wind_direction_10m + 180}deg)" aria-hidden="true">↑</span> ` +
    `${compass(c.wind_direction_10m)} · gusts ${speed(c.wind_gusts_10m)}`;

  const uv = h.uv_index?.[hourIdx] ?? d.uv_index_max[0] ?? 0;
  els.uvIndex.innerHTML = `${Math.round(uv)} <span style="font-size:.45em;color:var(--muted)">${uvLabel(uv)}</span>`;
  requestAnimationFrame(() => { els.uvFill.style.width = `${clamp(uv / 11, 0, 1) * 100}%`; });

  els.precip.textContent = precipFmt(c.precipitation);
  els.pressure.textContent = pressureFmt(c.pressure_msl);
  els.visibility.textContent = visFmt(h.visibility?.[hourIdx]);
  els.sunrise.textContent = fmtTime(d.sunrise[0]);
  els.sunset.textContent = fmtTime(d.sunset[0]);

  renderHourly(h, hourIdx, resetScroll);
  renderDaily(d);
  updateFavBtn();
  tick();

  // Tab title + favicon reflect live weather
  document.title = `${temp(c.temperature_2m)}° ${w.label} · ${p.name} — SkyCast`;
  setFavicon(w.icon);
}

function renderHourly(h, start, resetScroll) {
  const frag = document.createDocumentFragment();
  const end = Math.min(start + 24, h.time.length);
  for (let i = start; i < end; i++) {
    const hw = wmo(h.weather_code[i], h.is_day[i]);
    const pop = h.precipitation_probability?.[i] ?? 0;
    const label = i === start ? 'Now' : fmt(parseLocal(h.time[i]), { hour: 'numeric' });
    const item = document.createElement('div');
    item.className = `hour-item${i === start ? ' now' : ''}`;
    item.setAttribute('aria-label', `${label}: ${hw.label}, ${temp(h.temperature_2m[i])} degrees, ${pop}% chance of rain`);
    item.innerHTML = `
      <span class="hour-time">${label}</span>
      <span class="hour-icon" title="${hw.label}">${hw.icon}</span>
      <span class="hour-temp">${temp(h.temperature_2m[i])}°</span>
      <span class="hour-rain">${pop > 0 ? `${pop}%` : '&nbsp;'}</span>`;
    frag.appendChild(item);
  }
  els.hourlyList.replaceChildren(frag);
  if (resetScroll) els.hourlyList.scrollLeft = 0;
  updateScrollBtns();
}

function renderDaily(d) {
  const lo = Math.min(...d.temperature_2m_min);
  const hi = Math.max(...d.temperature_2m_max);
  const span = hi - lo || 1;
  const frag = document.createDocumentFragment();

  d.time.forEach((t, i) => {
    const dw = wmo(d.weather_code[i], 1);
    const min = d.temperature_2m_min[i], max = d.temperature_2m_max[i];
    const pop = d.precipitation_probability_max?.[i] ?? 0;
    const left = ((min - lo) / span) * 100;
    const width = Math.max(((max - min) / span) * 100, 4);
    const dayName = i === 0 ? 'Today' : fmt(parseLocal(t), { weekday: 'short' });

    const li = document.createElement('li');
    li.className = `day-item${i === 0 ? ' today' : ''}`;
    li.setAttribute('aria-label',
      `${i === 0 ? 'Today' : fmt(parseLocal(t), { weekday: 'long' })}: ${dw.label}, high ${temp(max)}, low ${temp(min)}`);
    li.innerHTML = `
      <span class="day-name">${dayName}</span>
      <span class="day-icon" title="${dw.label}">${dw.icon}</span>
      <span class="day-rain">${pop >= 10 ? `${pop}%` : ''}</span>
      <span class="day-min">${temp(min)}°</span>
      <div class="range-bar"><div class="range-fill" style="left:${left}%;width:0%" data-w="${width}"></div></div>
      <span class="day-max">${temp(max)}°</span>`;
    frag.appendChild(li);
  });

  els.dailyList.replaceChildren(frag);
  // grow-in animation for the range bars
  requestAnimationFrame(() => {
    els.dailyList.querySelectorAll('.range-fill').forEach((el, i) => {
      el.style.transition = 'width .8s cubic-bezier(.2,.7,.1,1)';
      el.style.transitionDelay = `${i * 50}ms`;
      el.style.width = `${el.dataset.w}%`;
    });
  });
}

/* Live clock, sun position, "updated x ago" */
function tick() {
  if (!state.data) return;
  const now = nowAtPlace();
  const tz = state.data.timezone_abbreviation ? ` ${state.data.timezone_abbreviation}` : '';
  els.localTime.textContent =
    `${fmt(now, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}${tz} · ${tzDiffLabel()}`;
  els.lastUpdated.textContent = `Updated ${relTime(state.fetchedAt)}`;

  const rise = parseLocal(state.data.daily.sunrise[0]).getTime();
  const set = parseLocal(state.data.daily.sunset[0]).getTime();
  const pct = clamp((now.getTime() - rise) / (set - rise || 1), 0, 1);
  els.sunDot.parentElement.style.setProperty('--p', pct.toFixed(3));
  els.sunDot.style.opacity = now.getTime() > rise && now.getTime() < set ? '1' : '.35';
}

function setFavicon(emoji) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${emoji}</text></svg>`;
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function updateThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#11100e';
}

/* ---------- HOURLY SCROLL ---------- */
function updateScrollBtns() {
  const el = els.hourlyList;
  const max = el.scrollWidth - el.clientWidth;
  const set = (btn, off) => { btn.disabled = off; btn.style.opacity = off ? '.35' : '1'; };
  set(els.hourlyPrev, el.scrollLeft <= 2);
  set(els.hourlyNext, el.scrollLeft >= max - 2);
}
const scrollHourly = (dir) => els.hourlyList.scrollBy({ left: dir * els.hourlyList.clientWidth * 0.8 });

/* ---------- SEARCH + AUTOCOMPLETE ---------- */
function highlight(name, q) {
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(name);
  return `${esc(name.slice(0, i))}<b>${esc(name.slice(i, i + q.length))}</b>${esc(name.slice(i + q.length))}`;
}

function showSuggestions(list, q) {
  state.suggestions = list;
  state.activeIdx = -1;
  if (!list.length) {
    els.suggestions.innerHTML = `<li aria-disabled="true"><span class="s-name">No matches for “${esc(q)}”</span></li>`;
  } else {
    els.suggestions.innerHTML = list.map((s, i) => `
      <li role="option" id="sugg-${i}" data-i="${i}" aria-selected="false">
        <span class="s-name">${flag(s.cc)} ${highlight(s.name, q)}</span>
        <span class="s-meta">${esc([s.admin, s.country].filter(Boolean).join(', '))}</span>
      </li>`).join('');
  }
  els.suggestions.classList.remove('hidden');
  els.cityInput.setAttribute('aria-expanded', 'true');
}

function hideSuggestions() {
  els.suggestions.classList.add('hidden');
  els.cityInput.setAttribute('aria-expanded', 'false');
  els.cityInput.removeAttribute('aria-activedescendant');
  state.activeIdx = -1;
}

function setActive(i) {
  const items = [...els.suggestions.querySelectorAll('li[role="option"]')];
  if (!items.length) return;
  state.activeIdx = (i + items.length) % items.length;
  items.forEach((li, j) => {
    const on = j === state.activeIdx;
    li.classList.toggle('active', on);
    li.setAttribute('aria-selected', String(on));
    if (on) { li.scrollIntoView({ block: 'nearest' }); els.cityInput.setAttribute('aria-activedescendant', li.id); }
  });
}

function choose(place) {
  hideSuggestions();
  els.cityInput.value = '';
  els.clearBtn.classList.add('hidden');
  els.cityInput.blur();
  loadPlace(place);
}

const onInput = debounce(async () => {
  const q = els.cityInput.value.trim();
  if (q.length < 2) return hideSuggestions();
  state.geoCtrl?.abort();
  state.geoCtrl = new AbortController();
  try {
    showSuggestions(await searchCities(q, state.geoCtrl.signal), q);
  } catch (e) {
    if (e.name !== 'AbortError') hideSuggestions();
  }
}, CONFIG.DEBOUNCE_MS);

async function onSubmit(e) {
  e.preventDefault();
  const q = els.cityInput.value.trim();
  if (!q) return;
  if (state.activeIdx >= 0 && state.suggestions[state.activeIdx]) return choose(state.suggestions[state.activeIdx]);

  state.lastAction = () => onSubmit(new Event('submit'));
  showView('loader', `Looking up “${q}”…`);
  try {
    const [first] = await searchCities(q, timeoutSignal());
    if (!first) return showError(`Couldn't find “${q}”. Check the spelling or try a nearby city.`);
    choose(first);
  } catch (err) {
    showError(friendlyError(err));
  }
}

/* ---------- RECENT + FAVOURITES ---------- */
function addRecent(place) {
  state.recent = [place, ...state.recent.filter((p) => !samePlace(p, place))].slice(0, CONFIG.MAX_RECENT);
  store.set('recent', state.recent);
  renderRecent();
}

function renderRecent() {
  const favs = state.favs;
  const recents = state.recent.filter((r) => !favs.some((f) => samePlace(f, r)));
  const all = [...favs.map((p) => ({ p, fav: true })), ...recents.map((p) => ({ p, fav: false }))];

  els.recentWrap.classList.toggle('hidden', all.length === 0);
  els.clearRecent.classList.toggle('hidden', recents.length === 0);
  els.recentList.replaceChildren(...all.map(({ p, fav }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-chip';
    b.textContent = `${fav ? '★ ' : ''}${p.name}`;
    b.title = [p.admin, p.country].filter(Boolean).join(', ');
    b.addEventListener('click', () => loadPlace(p));
    return b;
  }));
}

function updateFavBtn() {
  const on = state.favs.some((f) => samePlace(f, state.place));
  els.favBtn.textContent = on ? '★' : '☆';
  els.favBtn.setAttribute('aria-pressed', String(on));
  els.favBtn.setAttribute('aria-label', on ? 'Remove from saved cities' : 'Save city');
}

function toggleFav() {
  if (!state.place) return;
  const on = state.favs.some((f) => samePlace(f, state.place));
  state.favs = on
    ? state.favs.filter((f) => !samePlace(f, state.place))
    : [state.place, ...state.favs].slice(0, 8);
  store.set('favs', state.favs);
  updateFavBtn();
  renderRecent();
  toast(on ? `Removed ${state.place.name}` : `Saved ${state.place.name} ★`);
}

/* ---------- THEME + UNITS ---------- */
function applyTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  els.themeToggle.querySelector('.theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
  els.themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  store.set('theme', theme);
  updateThemeColor();
}

function updateUnitButtons() {
  [els.celsiusBtn, els.fahrenheitBtn].forEach((b) => {
    const on = b.dataset.unit === state.unit;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function setUnit(unit) {
  if (unit === state.unit) return;
  state.unit = unit;
  store.set('unit', unit);
  updateUnitButtons();
  if (state.data) render(); // instant, no refetch
  toast(unit === 'celsius' ? 'Metric · °C, km/h, mm' : 'Imperial · °F, mph, in');
}

/* ---------- URL (shareable links) ---------- */
function updateURL(p) {
  try {
    const url = new URL(location.href);
    url.search = new URLSearchParams({
      city: p.name, lat: p.lat.toFixed(4), lon: p.lon.toFixed(4), country: p.country || '', cc: p.cc || '',
    });
    history.replaceState(null, '', url);
  } catch {}
}

function placeFromURL() {
  const q = new URLSearchParams(location.search);
  const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { name: q.get('city') || 'Shared location', admin: '', country: q.get('country') || '', cc: q.get('cc') || '', lat, lon };
}

async function shareLink() {
  if (!state.place) return;
  try {
    if (navigator.share) await navigator.share({ title: document.title, url: location.href });
    else { await navigator.clipboard.writeText(location.href); toast('Link copied to clipboard 🔗'); }
  } catch {}
}

/* ---------- EVENTS ---------- */
function bindEvents() {
  els.searchForm.addEventListener('submit', onSubmit);

  els.cityInput.addEventListener('input', () => {
    els.clearBtn.classList.toggle('hidden', !els.cityInput.value);
    onInput();
  });

  els.cityInput.addEventListener('keydown', (e) => {
    const open = !els.suggestions.classList.contains('hidden');
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); setActive(state.activeIdx + 1); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setActive(state.activeIdx - 1); }
    else if (e.key === 'Escape') { hideSuggestions(); if (!open) els.cityInput.blur(); }
  });

  // mousedown so the click registers before input blur
  els.suggestions.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    choose(state.suggestions[+li.dataset.i]);
  });
  els.suggestions.addEventListener('mousemove', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && +li.dataset.i !== state.activeIdx) setActive(+li.dataset.i);
  });

  document.addEventListener('click', (e) => {
    if (!els.searchForm.contains(e.target)) hideSuggestions();
  });

  els.clearBtn.addEventListener('click', () => {
    els.cityInput.value = '';
    els.clearBtn.classList.add('hidden');
    hideSuggestions();
    els.cityInput.focus();
  });

  els.locationBtn.addEventListener('click', useLocation);
  els.retryBtn.addEventListener('click', () => (state.lastAction ? state.lastAction() : showView('welcome')));
  els.favBtn.addEventListener('click', toggleFav);
  els.clearRecent.addEventListener('click', () => {
    state.recent = [];
    store.set('recent', []);
    renderRecent();
    toast('Recent searches cleared');
  });

  els.celsiusBtn.addEventListener('click', () => setUnit('celsius'));
  els.fahrenheitBtn.addEventListener('click', () => setUnit('fahrenheit'));
  els.themeToggle.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));

  els.hourlyPrev.addEventListener('click', () => scrollHourly(-1));
  els.hourlyNext.addEventListener('click', () => scrollHourly(1));
  els.hourlyList.addEventListener('scroll', debounce(updateScrollBtns, 60), { passive: true });
  window.addEventListener('resize', debounce(updateScrollBtns, 150));

  // Keyboard shortcuts:  /  search · U units · T theme · L location · R refresh · F save · S share
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); els.cityInput.focus(); els.cityInput.select(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 'u': setUnit(isF() ? 'celsius' : 'fahrenheit'); break;
      case 't': applyTheme(state.theme === 'dark' ? 'light' : 'dark'); break;
      case 'l': useLocation(); break;
      case 'r': refresh(); break;
      case 'f': toggleFav(); break;
      case 's': shareLink(); break;
      default:
    }
  });

  // Refresh stale data when tab comes back into view
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.place && Date.now() - state.fetchedAt > CONFIG.CACHE_TTL) {
      loadPlace(state.place, { force: true, silent: true });
    }
  });

  window.addEventListener('offline', () => toast("You're offline — showing last known data", 4000));
  window.addEventListener('online', () => { toast('Back online ✓'); refresh(); });

  // Follow OS theme changes if user hasn't chosen manually
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
    if (store.get('theme', null) === null) applyTheme(e.matches ? 'light' : 'dark');
  });

  setInterval(tick, 15000);
}

/* ---------- INIT ---------- */
function init() {
  applyTheme(state.theme);
  updateUnitButtons();
  renderRecent();
  bindEvents();
  els.cityInput.setAttribute('role', 'combobox');
  els.cityInput.setAttribute('aria-expanded', 'false');

  const start = placeFromURL() || store.get('last', null);
  if (start) loadPlace(start);
  else showView('welcome');
}

init();