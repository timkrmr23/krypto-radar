'use strict';

// Krypto-Radar: Binance-Coins, eigene Käufe und Marker, Strategie EMA 10/30 mit Bitcoin-Filter und Muster aus
// der Vergangenheit. Kurse kommen direkt von Binance, die Musterauswertung täglich aus der Cloud (Ordner daten/).
// Käufe und Marker bleiben nur auf diesem Gerät.

const API = 'https://data-api.binance.vision/api/v3';
const STREAM = 'wss://data-stream.binance.vision/stream?streams=';
const DATA = 'daten/';
const STORE_KEY = 'krypto-radar-v1';
const FAST = 10;
const SLOW = 30;
const BTC_DAYS = 200;
const DAY_MS = 86400000;
const TICKERS_MAX_AGE = 60000;
const CHART_DAYS = 180;
const MARKER_AMOUNT = 1000;
const GITHUB_API = 'https://api.github.com';
const WORKFLOW = 'radar.yml';
const TOKEN_KEY = 'krypto-radar-github'; // GitHub-Schlüssel: nur auf diesem Gerät, nicht in der Datensicherung

const state = {
  stand: null,        // daten/stand.json: Coinliste, Strategie und Musterkennzahlen (täglich aus der Cloud)
  standTried: false,
  signale: null,      // daten/signale.json: aktuelle und frühere Muster-Signale
  muster: new Map(),  // Coin -> Promise<daten/muster/<COIN>.json oder null>
  tickers: new Map(), // Coin -> { price, open, volume } in USDT
  tickersAt: 0,
  eurusdt: null,      // 1 EUR in USDT
  klines: new Map(),  // Coin -> Promise<[{ time, close }]> abgeschlossene Tageskerzen in USDT
  klinesDay: utcDay(Date.now()),
  store: loadStore(),
  coinSort: 'volume',
  coinQuery: '',
  socket: null,
  socketKey: '',
  liveTimer: null,
  renderToken: 0,
  run: { phase: 'idle', text: '', url: '' }, // Auswertung von Hand: idle, starting, queued, running, done, error
};

// ---------- Hilfsfunktionen ----------

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function utcDay(ms) {
  return Math.floor(ms / DAY_MS);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function todayLocal() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fmtDate(value) {
  if (value == null) return '–';
  const date = typeof value === 'number' ? new Date(value) : new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

function fmtMonth(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return date.toLocaleDateString('de-DE', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtClock(date) {
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function fmtEur(value) {
  if (value == null || !Number.isFinite(value)) return '–';
  return value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function fmtSignedEur(value) {
  if (value == null || !Number.isFinite(value)) return '–';
  return (value > 0 ? '+' : '') + fmtEur(value);
}

function fmtPrice(value) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '–';
  const digits = value >= 10 ? 2 : value >= 1 ? 3 : Math.min(10, 3 - Math.floor(Math.log10(value)));
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: digits })} €`;
}

function fmtPct(fraction, digits = 1) {
  if (fraction == null || !Number.isFinite(fraction)) return '–';
  const value = Math.round(fraction * 100 * 10 ** digits) / 10 ** digits || 0; // ohne "-0"
  return `${value > 0 ? '+' : ''}${value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

function fmtQty(value) {
  if (value == null || !Number.isFinite(value)) return '–';
  return value.toLocaleString('de-DE', { maximumFractionDigits: value >= 100 ? 2 : value >= 1 ? 4 : 8 });
}

function fmtCompact(value) {
  if (value == null || !Number.isFinite(value)) return '–';
  return `${value.toLocaleString('de-DE', { notation: 'compact', maximumFractionDigits: 1 })} €`;
}

function tone(value) {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.0005) return ''; // ±0,0 % bleibt neutral
  return value > 0 ? 'up' : 'down';
}

function parseNumber(text) {
  let value = String(text || '').trim().replace(/\s|€/g, '');
  if (value.includes(',') && value.includes('.')) value = value.replace(/\./g, '');
  value = value.replace(',', '.');
  const number = Number(value);
  return value && Number.isFinite(number) ? number : null;
}

function coinColor(coin) {
  let hash = 0;
  for (const char of coin) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash}, 55%, 46%)`;
}

function coinIcon(coin) {
  const icon = el('span', 'coin-icon', coin.slice(0, 4));
  icon.style.background = coinColor(coin);
  if (coin.length > 3) icon.style.fontSize = '10px';
  return icon;
}

function toast(text) {
  document.querySelectorAll('.toast').forEach((node) => node.remove());
  const node = el('div', 'toast', text);
  document.body.append(node);
  setTimeout(() => node.remove(), 3200);
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function eur(usdt) {
  return usdt != null && state.eurusdt ? usdt / state.eurusdt : null;
}

// ---------- Speicher auf dem Gerät ----------

function loadStore() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY));
    if (data && Array.isArray(data.positions)) return data;
  } catch { /* noch nichts gespeichert oder nicht lesbar */ }
  return { version: 1, positions: [] };
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
    return true;
  } catch {
    toast('Speichern nicht möglich. Ist der private Modus aktiv?');
    return false;
  }
}

function positions(kind) {
  return state.store.positions.filter((position) => !kind || position.kind === kind);
}

// ---------- Daten ----------

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadStand() {
  try {
    state.stand = await getJson(`${DATA}stand.json`, { cache: 'no-cache' });
  } catch {
    state.stand = null;
  }
  state.standTried = true;
}

async function loadSignale() {
  try {
    state.signale = await getJson(`${DATA}signale.json`, { cache: 'no-cache' });
  } catch {
    state.signale = null;
  }
  updateMusterBadge();
}

function loadMuster(coin) {
  if (!state.muster.has(coin)) {
    state.muster.set(coin, getJson(`${DATA}muster/${coin}.json`, { cache: 'no-cache' }).catch(() => null));
  }
  return state.muster.get(coin);
}

function standCoin(coin) {
  return state.stand?.coins.find((item) => item.coin === coin) || null;
}

function setTicker(coin, price, open, volume) {
  if (coin === 'EUR') state.eurusdt = price;
  else state.tickers.set(coin, { price, open, volume });
}

async function loadAllTickers(force = false) {
  if (!force && Date.now() - state.tickersAt < TICKERS_MAX_AGE) return;
  const rows = await getJson(`${API}/ticker/24hr?type=MINI`);
  for (const row of rows) {
    if (row.symbol === 'EURUSDT') setTicker('EUR', Number(row.lastPrice));
    else if (row.symbol.endsWith('USDT')) {
      setTicker(row.symbol.slice(0, -4), Number(row.lastPrice), Number(row.openPrice), Number(row.quoteVolume));
    }
  }
  state.tickersAt = Date.now();
}

async function loadPrices(coins) {
  const symbols = [...new Set(coins)].map((coin) => `${coin}USDT`).concat('EURUSDT');
  const apply = (rows) => rows.forEach((row) => setTicker(
    row.symbol === 'EURUSDT' ? 'EUR' : row.symbol.slice(0, -4), Number(row.lastPrice), Number(row.openPrice), Number(row.quoteVolume)));
  try {
    apply(await getJson(`${API}/ticker/24hr?type=MINI&symbols=${encodeURIComponent(JSON.stringify(symbols))}`));
  } catch {
    // Ein nicht mehr gehandelter Coin lässt die Sammelabfrage scheitern: dann einzeln
    const rows = await Promise.all(symbols.map((symbol) => getJson(`${API}/ticker/24hr?type=MINI&symbol=${symbol}`).catch(() => null)));
    apply(rows.filter(Boolean));
  }
}

function dailyCloses(coin) {
  const day = utcDay(Date.now());
  if (day !== state.klinesDay) {
    state.klines.clear();
    state.klinesDay = day;
  }
  if (!state.klines.has(coin)) {
    const request = getJson(`${API}/klines?symbol=${coin}USDT&interval=1d&limit=1000`)
      .then((rows) => rows.filter((row) => row[6] < Date.now()).map((row) => ({ time: row[0], close: Number(row[4]) })));
    request.catch(() => state.klines.delete(coin));
    state.klines.set(coin, request);
  }
  return state.klines.get(coin);
}

// ---------- Live-Kurse ----------

function watch(coins) {
  const wanted = [...new Set(coins)].sort();
  const key = wanted.join(',');
  if (key === state.socketKey && state.socket && state.socket.readyState <= 1) return;
  if (state.socket) {
    const old = state.socket;
    state.socket = null;
    old.close();
  }
  state.socketKey = key;
  if (!wanted.length || document.hidden) return;
  const streams = [...wanted.map((coin) => `${coin.toLowerCase()}usdt@miniTicker`), 'eurusdt@miniTicker'].join('/');
  const socket = new WebSocket(STREAM + streams);
  socket.addEventListener('message', (event) => {
    const { data } = JSON.parse(event.data);
    if (!data?.s) return;
    setTicker(data.s === 'EURUSDT' ? 'EUR' : data.s.slice(0, -4), Number(data.c), Number(data.o), Number(data.q));
    scheduleLive();
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    state.socket = null;
    setTimeout(() => { if (!state.socket) watch(state.socketKey ? state.socketKey.split(',') : []); }, 5000);
  });
  state.socket = socket;
}

function scheduleLive() {
  if (state.liveTimer) return;
  state.liveTimer = setTimeout(() => {
    state.liveTimer = null;
    updateLive();
  }, 1000);
}

// Elemente mit data-live werden bei neuen Kursen aktualisiert, ohne die Ansicht neu aufzubauen
const LIVE = {
  price: (coin) => [fmtPrice(eur(state.tickers.get(coin)?.price)), ''],
  change: (coin) => {
    const ticker = state.tickers.get(coin);
    const change = ticker?.open ? ticker.price / ticker.open - 1 : null;
    return [fmtPct(change), tone(change)];
  },
  value: (coin) => {
    const value = holding(coin).value;
    return [fmtEur(value), ''];
  },
  pl: (coin) => {
    const { pl, plPct } = holding(coin);
    return [`${fmtSignedEur(pl)} (${fmtPct(plPct)})`, tone(pl)];
  },
  entry: (id) => {
    const entry = state.store.positions.find((item) => item.id === id);
    const change = entry ? entryChange(entry) : null;
    return [fmtPct(change), tone(change)];
  },
  total: () => [fmtEur(portfolio().value), ''],
  totalpl: () => {
    const { pl, plPct } = portfolio();
    return [`${fmtSignedEur(pl)} (${fmtPct(plPct)})`, tone(pl)];
  },
};

function live(node, kind, arg = '') {
  node.dataset.live = `${kind}:${arg}`;
  node.dataset.base = node.className;
  const [text, cls] = LIVE[kind](arg);
  node.textContent = text;
  node.className = [node.dataset.base, cls].filter(Boolean).join(' ');
  return node;
}

function updateLive() {
  for (const node of document.querySelectorAll('[data-live]')) {
    const [kind, arg] = node.dataset.live.split(':');
    const [text, cls] = LIVE[kind](arg);
    if (node.textContent !== text) node.textContent = text;
    node.className = [node.dataset.base, cls].filter(Boolean).join(' ');
  }
}

// ---------- Bestand ----------

function holding(coin) {
  const buys = positions('kauf').filter((position) => position.coin === coin);
  const quantity = buys.reduce((sum, position) => sum + position.quantity, 0);
  const invested = buys.reduce((sum, position) => sum + position.amount, 0);
  const price = eur(state.tickers.get(coin)?.price);
  const value = price != null ? quantity * price : null;
  const pl = value != null ? value - invested : null;
  return { buys, quantity, invested, average: quantity ? invested / quantity : null, value, pl, plPct: pl != null && invested ? pl / invested : null };
}

function heldCoins() {
  return [...new Set(positions('kauf').map((position) => position.coin))];
}

function portfolio() {
  let value = 0;
  let invested = 0;
  let complete = true;
  for (const coin of heldCoins()) {
    const item = holding(coin);
    invested += item.invested;
    if (item.value == null) complete = false;
    else value += item.value;
  }
  const pl = complete ? value - invested : null;
  return { value: complete ? value : null, invested, pl, plPct: pl != null && invested ? pl / invested : null };
}

function entryChange(entry) {
  const price = state.tickers.get(entry.coin)?.price;
  return price && entry.priceUsdt ? price / entry.priceUsdt - 1 : null;
}

// ---------- Strategie EMA 10/30 mit Bitcoin-Filter ----------

function emaValues(values, span) {
  const k = 2 / (span + 1);
  let value = null;
  return values.map((close) => (value = value == null ? close : close * k + value * (1 - k)));
}

function sinceIndex(flags) {
  const last = flags.length - 1;
  let start = last;
  while (start > 0 && flags[start - 1] === flags[last]) start -= 1;
  return start;
}

function trendOf(closes) {
  if (!closes || closes.length < 2 * SLOW) return null;
  const values = closes.map((item) => item.close);
  const fast = emaValues(values, FAST);
  const slow = emaValues(values, SLOW);
  const flags = fast.map((value, index) => value > slow[index]);
  const last = flags.length - 1;
  return { inTrend: flags[last], since: closes[sinceIndex(flags)].time, gap: fast[last] / slow[last] - 1, fast, slow };
}

function btcFilterOf(closes) {
  if (!closes || closes.length < BTC_DAYS + 10) return null;
  const values = closes.map((item) => item.close);
  let sum = 0;
  const average = values.map((value, index) => {
    sum += value - (index >= BTC_DAYS ? values[index - BTC_DAYS] : 0);
    return index >= BTC_DAYS - 1 ? sum / BTC_DAYS : null;
  });
  const flags = values.map((value, index) => average[index] != null && value > average[index]);
  const last = flags.length - 1;
  return { above: flags[last], since: closes[sinceIndex(flags)].time, close: values[last], average: average[last] };
}

async function strategyFor(coin) {
  const [closes, btcCloses] = await Promise.all([dailyCloses(coin), dailyCloses('BTC')]);
  return { trend: trendOf(closes), btc: btcFilterOf(btcCloses), closes };
}

function verdict({ trend, btc }, held) {
  if (!trend || !btc) {
    return { tone: 'neutral', icon: '?', title: 'Strategie: zu wenig Daten', text: 'Für die Regel braucht der Coin mindestens 60 Tageskerzen.' };
  }
  if (!btc.above) {
    return {
      tone: 'down', icon: '↓', title: held ? 'Strategie: verkaufen' : 'Strategie: nicht kaufen',
      text: `Bitcoin schließt seit ${fmtDate(btc.since)} unter seiner 200-Tage-Linie. Dann hält die Strategie keine Coins.`,
    };
  }
  if (!trend.inTrend) {
    return {
      tone: 'down', icon: '↓', title: held ? 'Strategie: verkaufen' : 'Strategie: kein Trend',
      text: `EMA 10 liegt seit ${fmtDate(trend.since)} unter EMA 30 (Abstand ${fmtPct(trend.gap)}).`,
    };
  }
  return {
    tone: 'up', icon: '↑', title: held ? 'Strategie: halten' : 'Strategie: im Trend',
    text: `EMA 10 liegt seit ${fmtDate(trend.since)} über EMA 30 (Abstand ${fmtPct(trend.gap)}), Bitcoin über seiner 200-Tage-Linie.`,
  };
}

function verdictBadge(result) {
  const short = { 'Strategie: halten': 'Halten', 'Strategie: verkaufen': 'Verkaufen', 'Strategie: im Trend': 'Im Trend',
    'Strategie: kein Trend': 'Kein Trend', 'Strategie: nicht kaufen': 'Nicht kaufen' }[result.title] || '–';
  return el('span', `badge ${result.tone}`, short);
}

function statusCard(result) {
  return el('div', 'card status-card',
    el('div', `icon ${result.tone}`, result.icon),
    el('div', null, el('div', 'title', result.title), el('p', null, result.text)));
}

// ---------- Diagramme (SVG) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function niceStep(range) {
  const raw = range / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((step) => step >= raw) || power * 10;
}

function chartWidth() {
  return Math.max(260, Math.min(688, ($('#view').clientWidth || 360) - 32 - 32));
}

// lines: [{ points: [{x, y}], color, width, dash, opacity }], bands: [{ points: [{x, lo, hi}], color }]
function lineChart({ lines = [], bands = [], height = 190, yFormat = String, xTicks = [], baseline = null, dots = [], vline = null }) {
  const width = chartWidth();
  const pad = { left: 4, right: 58, top: 10, bottom: 22 };
  const points = [
    ...lines.flatMap((line) => line.points),
    ...bands.flatMap((band) => band.points.flatMap((p) => [{ x: p.x, y: p.lo }, { x: p.x, y: p.hi }])),
    ...dots,
  ].filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x));
  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  if (!points.length) return root;
  let [xMin, xMax] = [Math.min(...points.map((p) => p.x)), Math.max(...points.map((p) => p.x))];
  let [yMin, yMax] = [Math.min(...points.map((p) => p.y)), Math.max(...points.map((p) => p.y))];
  if (baseline != null) [yMin, yMax] = [Math.min(yMin, baseline), Math.max(yMax, baseline)];
  if (xMax === xMin) xMax = xMin + 1;
  const margin = (yMax - yMin) * 0.06 || Math.abs(yMax) * 0.05 || 1;
  yMin -= margin;
  yMax += margin;
  const sx = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * (width - pad.left - pad.right);
  const sy = (y) => pad.top + ((yMax - y) / (yMax - yMin)) * (height - pad.top - pad.bottom);

  const step = niceStep(yMax - yMin);
  for (let value = Math.ceil(yMin / step) * step; value <= yMax; value += step) {
    root.append(svg('line', { class: 'grid', x1: pad.left, x2: width - pad.right + 4, y1: sy(value), y2: sy(value) }));
    const label = svg('text', { x: width - pad.right + 8, y: sy(value) + 3.5 });
    label.textContent = yFormat(value);
    root.append(label);
  }
  for (const tick of xTicks) {
    const label = svg('text', { x: sx(tick.x), y: height - 6, 'text-anchor': tick.anchor || 'middle' });
    label.textContent = tick.label;
    root.append(label);
  }
  if (baseline != null) {
    root.append(svg('line', { x1: pad.left, x2: width - pad.right + 4, y1: sy(baseline), y2: sy(baseline), stroke: 'var(--muted)', 'stroke-dasharray': '3 4', 'stroke-width': 1 }));
  }
  if (vline != null) {
    root.append(svg('line', { x1: sx(vline), x2: sx(vline), y1: pad.top, y2: height - pad.bottom, stroke: 'var(--muted)', 'stroke-dasharray': '3 4', 'stroke-width': 1 }));
  }
  for (const band of bands) {
    const top = band.points.map((p) => `${sx(p.x)},${sy(p.hi)}`);
    const bottom = band.points.slice().reverse().map((p) => `${sx(p.x)},${sy(p.lo)}`);
    root.append(svg('polygon', { points: [...top, ...bottom].join(' '), fill: band.color, opacity: band.opacity ?? 0.15 }));
  }
  for (const line of lines) {
    let d = '';
    let open = false;
    for (const p of line.points) {
      if (!Number.isFinite(p.y)) {
        open = false;
        continue;
      }
      d += `${open ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
      open = true;
    }
    root.append(svg('path', {
      d, fill: 'none', stroke: line.color, 'stroke-width': line.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: line.opacity ?? 1, ...(line.dash ? { 'stroke-dasharray': line.dash } : {}),
    }));
  }
  for (const dot of dots) {
    root.append(svg('circle', { cx: sx(dot.x), cy: sy(dot.y), r: dot.r || 4.5, fill: dot.color || 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  }
  return root;
}

function legend(items) {
  const node = el('div', 'legend');
  for (const [label, color, dash] of items) {
    const swatch = el('i');
    swatch.style.background = dash ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color;
    node.append(el('span', null, swatch, label));
  }
  return node;
}

function priceChart(closes, trend, entries) {
  const recent = closes.slice(-CHART_DAYS);
  const offset = closes.length - recent.length;
  const toPoint = (values) => recent.map((item, index) => ({ x: item.time, y: eur(values[offset + index]) }));
  const first = recent[0]?.time;
  const last = recent[recent.length - 1]?.time;
  const dots = entries
    .filter((entry) => entry.time >= first)
    .map((entry) => ({ x: Math.min(entry.time, last), y: entry.price, color: entry.kind === 'kauf' ? 'var(--up)' : 'var(--accent)' }));
  return lineChart({
    lines: [
      { points: recent.map((item) => ({ x: item.time, y: eur(item.close) })), color: 'var(--text)', width: 1.6 },
      ...(trend ? [
        { points: toPoint(trend.fast), color: 'var(--fast)', width: 1.4 },
        { points: toPoint(trend.slow), color: 'var(--slow)', width: 1.4 },
      ] : []),
    ],
    dots,
    yFormat: (value) => fmtPrice(value).replace(' €', ''),
    xTicks: first ? [
      { x: first, label: fmtMonth(isoDay(first)), anchor: 'start' },
      { x: (first + last) / 2, label: fmtMonth(isoDay((first + last) / 2)) },
      { x: last, label: 'heute', anchor: 'end' },
    ] : [],
  });
}

function spread(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

// Muster: links der Verlauf vor dem Stichtag (heute bzw. damals), rechts, wie es danach weiterging.
// Die früheren Verläufe links sind auf die heutige Schwankung skaliert: Verglichen wird die Form, nicht die Höhe.
function patternChart(data, actual) {
  const analogs = data.analogs;
  const lines = [];
  const target = data.recent ? spread(data.recent) : null;
  for (const analog of analogs) {
    const own = spread(analog.before);
    const scale = target && own ? target / own : 1;
    const before = analog.before.map((y, index) => ({ x: index - analog.before.length + 1, y: y * scale }));
    const after = analog.path.map((y, index) => ({ x: index, y }));
    lines.push({ points: [...before, ...after.slice(1)], color: 'var(--muted)', width: 1, opacity: 0.35 });
  }
  const days = analogs[0]?.path.length || 0;
  const middle = [];
  const band = [];
  for (let day = 0; day < days; day += 1) {
    const values = analogs.map((analog) => analog.path[day]).sort((a, b) => a - b);
    middle.push({ x: day, y: median(values) });
    band.push({ x: day, lo: values[Math.floor((values.length - 1) * 0.25)], hi: values[Math.ceil((values.length - 1) * 0.75)] });
  }
  lines.push({ points: middle, color: 'var(--up)', width: 2.2, dash: '5 4' });
  if (data.recent) lines.push({ points: data.recent.map((y, index) => ({ x: index - data.recent.length + 1, y })), color: 'var(--accent)', width: 2.4 });
  if (actual?.length) lines.push({ points: actual, color: 'var(--accent)', width: 2.6 });
  const length = data.recent?.length || analogs[0]?.before.length || 20;
  return lineChart({
    lines,
    bands: [{ points: band, color: 'var(--up)', opacity: 0.14 }],
    baseline: 0,
    vline: 0,
    height: 200,
    yFormat: (value) => fmtPct(value, 0),
    xTicks: [
      { x: -length + 1, label: `−${length - 1} T.`, anchor: 'start' },
      { x: 0, label: actual ? 'Marker' : 'heute' },
      { x: days - 1, label: `+${days - 1} T.`, anchor: 'end' },
    ],
  });
}

// ---------- Navigation ----------

const ROUTES = [
  [/^#?\/?$/, () => renderStart(), 'start'],
  [/^#\/coins$/, () => renderCoins(), 'coins'],
  [/^#\/muster$/, () => renderMuster(), 'muster'],
  [/^#\/mehr$/, () => renderMehr(), 'mehr'],
  [/^#\/coin\/([A-Z0-9]+)$/, (match) => renderCoin(match[1]), 'coins'],
  [/^#\/eintrag\/([\w-]+)$/, (match) => renderEntry(match[1]), 'start'],
];

function setTitle(title, sub = false, status = '') {
  $('#title').textContent = title;
  $('#top').classList.toggle('sub', sub);
  $('#top-status').textContent = status;
  document.title = sub ? `${title} · Krypto-Radar` : 'Krypto-Radar';
}

function show(...nodes) {
  $('#view').replaceChildren(...nodes);
}

function route() {
  const hash = location.hash || '#/';
  const token = ++state.renderToken;
  for (const [pattern, render, tab] of ROUTES) {
    const match = hash.match(pattern);
    if (!match) continue;
    document.querySelectorAll('.tabs a').forEach((link) => link.classList.toggle('active', link.dataset.tab === tab));
    window.scrollTo(0, 0);
    Promise.resolve(render(match)).catch((error) => {
      if (token === state.renderToken) show(el('p', 'empty', `Fehler beim Laden: ${error.message}. Besteht eine Internetverbindung?`));
    });
    return;
  }
  location.hash = '#/';
}

function current(token) {
  return token === state.renderToken;
}

function section(title, ...children) {
  return [el('h2', null, title), ...children];
}

// ---------- Start ----------

async function renderStart() {
  const token = state.renderToken;
  setTitle('Krypto-Radar');
  const coins = heldCoins();
  const markers = positions('marker');
  const needed = [...new Set([...coins, ...markers.map((marker) => marker.coin)])];
  watch(needed);
  if (!state.store.positions.length && !state.standTried) show(el('p', 'loading', 'Lade …'));
  const [strategies, btcCloses] = await Promise.all([
    Promise.all(coins.map((coin) => strategyFor(coin).catch(() => ({})))),
    dailyCloses('BTC').catch(() => null),
    needed.length ? loadPrices(needed) : Promise.resolve(),
    state.standTried ? null : loadStand(),
    state.signale ? null : loadSignale(),
  ]);
  if (!current(token)) return;

  const nodes = [];
  const btc = btcFilterOf(btcCloses);
  if (coins.length) {
    const hero = el('div', 'card hero',
      el('div', 'label', 'Ihre Käufe'),
      live(el('div', 'big'), 'total'),
      el('div', 'line', 'Gewinn/Verlust ', live(el('strong'), 'totalpl'), ` · eingesetzt ${fmtEur(portfolio().invested)}`));
    nodes.push(hero);
    const list = el('div', 'card flush');
    coins.forEach((coin, index) => {
      const item = holding(coin);
      const result = verdict(strategies[index], true);
      list.append(el('a', 'row', coinIcon(coin),
        el('div', 'main',
          el('div', 'name', coin, ' ', verdictBadge(result)),
          el('div', 'sub', `${fmtQty(item.quantity)} · Ø ${fmtPrice(item.average)}`)),
        el('div', 'end', live(el('div', 'name'), 'value', coin), live(el('div', 'sub small'), 'pl', coin))));
      list.lastChild.href = `#/coin/${coin}`;
    });
    nodes.push(...section('Meine Käufe', list));
    const sells = coins.filter((_, index) => verdict(strategies[index], true).tone === 'down');
    if (sells.length) {
      nodes.push(el('p', 'note warn', `Laut Strategie EMA 10/30 mit Bitcoin-Filter: verkaufen bei ${sells.join(', ')}. Das ist eine Regel, keine Empfehlung.`));
    }
  } else {
    nodes.push(el('div', 'card hero',
      el('div', 'label', 'Willkommen'),
      el('div', 'explain',
        el('p', null, 'Hier erscheinen Ihre Käufe mit aktuellem Kurs und dem Stand nach der Strategie EMA 10/30 mit Bitcoin-Filter.'),
        el('p', null, 'Öffnen Sie unter „Coins“ einen Coin und tippen Sie auf „Kauf eintragen“ oder „Marker setzen“.'))));
  }

  if (markers.length) {
    const list = el('div', 'card flush');
    for (const marker of markers) {
      const row = el('a', 'row', coinIcon(marker.coin),
        el('div', 'main', el('div', 'name', marker.coin), el('div', 'sub', `Marker ${fmtDate(marker.date)} · ${fmtPrice(marker.price)}`)),
        el('div', 'end', live(el('div', 'name'), 'entry', marker.id), el('div', 'sub small', markerCompareText(marker))));
      row.href = `#/eintrag/${marker.id}`;
      list.append(row);
    }
    nodes.push(...section('Beobachtet', list));
  }

  const signals = state.signale?.signals || [];
  if (signals.length) {
    const list = el('div', 'card flush');
    for (const signal of signals.slice(0, 3)) list.append(signalRow(signal));
    if (signals.length > 3) {
      const more = el('a', 'row', el('div', 'main', el('div', 'name', `Alle ${signals.length} Muster ansehen`)));
      more.href = '#/muster';
      list.append(more);
    }
    nodes.push(...section('Neue Muster', list));
  }

  if (btc) {
    nodes.push(el('p', 'note', 'Bitcoin-Filter: Bitcoin liegt ',
      el('strong', btc.above ? 'up' : 'down', btc.above ? 'über' : 'unter'),
      ` seiner 200-Tage-Linie (seit ${fmtDate(btc.since)}).`));
  }
  show(...nodes);
}

function markerCompareText(marker) {
  const days = Math.floor((Date.now() - marker.time) / DAY_MS);
  const paths = marker.snapshot?.analogs?.map((analog) => analog.path) || [];
  if (days < 1) return 'heute gesetzt';
  if (!paths.length) return `seit ${days} T.`;
  const day = Math.min(days, paths[0].length - 1);
  const typical = median(paths.map((path) => path[day]));
  return `früher nach ${day} T.: ${fmtPct(typical, 0)}`;
}

// ---------- Coins ----------

async function renderCoins() {
  const token = state.renderToken;
  setTitle('Coins');
  watch([]);
  show(el('p', 'loading', 'Lade Kurse von Binance …'));
  await Promise.all([loadAllTickers(), state.standTried ? null : loadStand()]);
  if (!current(token)) return;

  const known = state.stand?.coins || [...state.tickers.entries()]
    .filter(([, ticker]) => ticker.volume > 0)
    .map(([coin, ticker]) => ({ coin, volume: ticker.volume }));
  const search = el('input');
  Object.assign(search, { type: 'search', placeholder: `${known.length} Coins durchsuchen`, value: state.coinQuery, autocapitalize: 'characters', autocomplete: 'off', spellcheck: false });
  const chips = el('div', 'chips');
  const sorts = { volume: 'Umsatz', change: '24 h', trend: 'Im Trend', name: 'Name' };
  for (const [key, label] of Object.entries(sorts)) {
    const chip = el('button', `chip${state.coinSort === key ? ' active' : ''}`, label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      state.coinSort = key;
      chips.querySelectorAll('.chip').forEach((node) => node.classList.toggle('active', node === chip));
      fill();
    });
    chips.append(chip);
  }
  const list = el('div', 'card flush');
  const note = el('p', 'note');

  function fill() {
    const query = state.coinQuery.trim().toUpperCase();
    let items = known.filter((item) => !query || item.coin.includes(query));
    const change = (item) => {
      const ticker = state.tickers.get(item.coin);
      return ticker?.open ? ticker.price / ticker.open - 1 : -Infinity;
    };
    if (state.coinSort === 'name') items = items.slice().sort((a, b) => a.coin.localeCompare(b.coin));
    else if (state.coinSort === 'change') items = items.slice().sort((a, b) => change(b) - change(a));
    else if (state.coinSort === 'trend') items = items.filter((item) => item.trend?.in_trend).sort((a, b) => (b.trend.gap_pct ?? 0) - (a.trend.gap_pct ?? 0));
    else items = items.slice().sort((a, b) => (state.tickers.get(b.coin)?.volume ?? b.volume ?? 0) - (state.tickers.get(a.coin)?.volume ?? a.volume ?? 0));
    list.replaceChildren(...items.slice(0, 600).map((item) => coinRow(item)));
    if (!items.length) list.append(el('p', 'empty', 'Kein Coin gefunden.'));
    note.textContent = state.stand
      ? `Alle Coins, die bei Binance gegen USDT handelbar sind. Kurse in Euro (1 € = ${state.eurusdt?.toLocaleString('de-DE', { maximumFractionDigits: 4 })} USDT). Strategie-Stand vom Tagesschluss ${fmtDate(state.stand.as_of)}.`
      : 'Die tägliche Auswertung aus der Cloud fehlt noch. Die Liste zeigt alle Binance-Coins mit Umsatz.';
  }
  search.addEventListener('input', () => {
    state.coinQuery = search.value;
    fill();
  });
  fill();
  show(el('div', 'search', search, chips), list, note);
  const refresh = setInterval(async () => {
    if (!current(token)) {
      clearInterval(refresh);
      return;
    }
    if (document.hidden) return;
    await loadAllTickers(true).catch(() => null);
    if (current(token)) updateLive();
  }, TICKERS_MAX_AGE);
}

function coinRow(item) {
  const signal = item.signal ? el('span', 'badge info', 'Muster') : null;
  const trend = item.trend ? el('span', `dot ${item.trend.in_trend ? 'up' : 'down'}`) : null;
  if (trend) trend.title = item.trend.in_trend ? 'Im Trend (EMA 10 über EMA 30)' : 'Kein Trend';
  const row = el('a', 'row', coinIcon(item.coin),
    el('div', 'main', el('div', 'name', item.coin, ' ', signal), el('div', 'sub', trend, trend ? ' ' : '', `Umsatz ${fmtCompact(eur(state.tickers.get(item.coin)?.volume ?? item.volume))}`)),
    el('div', 'end', live(el('div', 'name'), 'price', item.coin), live(el('div', 'sub small'), 'change', item.coin)));
  row.href = `#/coin/${item.coin}`;
  return row;
}

// ---------- Coin ----------

async function renderCoin(coin) {
  const token = state.renderToken;
  setTitle(coin, true);
  watch([coin]);
  show(el('p', 'loading', `Lade ${coin} …`));
  const [strategy, muster] = await Promise.all([
    strategyFor(coin),
    loadMuster(coin),
    loadPrices([coin]),
    state.standTried ? null : loadStand(),
  ]);
  if (!current(token)) return;

  const entries = state.store.positions.filter((position) => position.coin === coin);
  const held = entries.some((entry) => entry.kind === 'kauf');
  const nodes = [
    el('div', 'price-head', live(el('div', 'big'), 'price', coin), el('div', 'line', live(el('span'), 'change', coin), el('span', 'muted', ' in 24 Stunden'))),
  ];
  if (strategy.closes.length) {
    nodes.push(el('div', 'card', priceChart(strategy.closes, strategy.trend, entries),
      legend([['Kurs', 'var(--text)'], ['EMA 10', 'var(--fast)'], ['EMA 30', 'var(--slow)'], ...(entries.length ? [['Ihre Einträge', 'var(--up)']] : [])])));
  }
  nodes.push(...section('Strategie EMA 10/30 + Bitcoin-Filter', statusCard(verdict(strategy, held))));

  const actions = el('div', 'actions');
  const buy = el('button', 'button primary', 'Kauf eintragen');
  buy.type = 'button';
  buy.addEventListener('click', () => openBuySheet(coin, muster));
  const mark = el('button', 'button', 'Marker setzen');
  mark.type = 'button';
  mark.addEventListener('click', () => openMarkerSheet(coin, muster));
  actions.append(buy, mark);
  nodes.push(actions);

  nodes.push(...section('Ähnliche Verläufe in der Vergangenheit', musterCard(coin, muster)));

  if (entries.length) {
    const list = el('div', 'card flush');
    for (const entry of entries) list.append(entryRow(entry));
    nodes.push(...section('Ihre Einträge', list));
  }
  show(...nodes);
}

function musterSentence(coin, summary, horizon) {
  const up = Math.round(summary.share_up * summary.count);
  return `Der Verlauf der letzten Tage ähnelt ${summary.count} früheren Phasen von ${coin}. Danach stieg ${coin} in ${up} von ${summary.count} Fällen, `
    + `im Mittel ${fmtPct(summary.median)} nach ${horizon} Tagen. Den höchsten Stand erreichte der Kurs im Mittel nach ${Math.round(summary.peak_day)} Tagen (${fmtPct(summary.peak)}).`;
}

function musterCard(coin, muster) {
  const card = el('div', 'card');
  if (!muster) {
    card.append(el('p', 'explain', state.stand
      ? `Für ${coin} gibt es noch keine Auswertung. Ausgewertet werden Coins mit genug Kursgeschichte und Umsatz.`
      : 'Die tägliche Auswertung aus der Cloud fehlt noch.'));
    return card;
  }
  if (!muster.analogs.length) {
    card.append(el('p', 'explain', `Der heutige Verlauf von ${coin} ähnelt keiner früheren Phase deutlich genug (Ähnlichkeit mindestens ${muster.min_corr.toLocaleString('de-DE')}).`));
    return card;
  }
  card.append(
    musterStatus(standCoin(coin)),
    el('p', 'explain', musterSentence(coin, muster.summary, muster.horizon)),
    patternChart(muster),
    legend([['heute', 'var(--accent)'], ['frühere Phasen', 'var(--muted)'], ['Mittel danach', 'var(--up)', true]]),
    el('p', 'note', 'Links die Form der letzten Tage, rechts die tatsächliche Veränderung nach den früheren Phasen. Die grüne Fläche zeigt die mittlere Hälfte der Fälle.'),
  );
  const list = el('div', 'analog-list');
  for (const analog of muster.analogs) {
    list.append(el('div', 'analog',
      el('span', null, fmtDate(analog.date), el('span', 'muted', ` · Ähnlichkeit ${analog.corr.toLocaleString('de-DE', { maximumFractionDigits: 2 })}`)),
      el('span', `num ${tone(analog.change)}`, `${fmtPct(analog.change)} nach ${muster.horizon} T.`)));
  }
  card.append(list, el('p', 'note', reliabilityText()));
  return card;
}

function musterRule() {
  const rule = state.stand?.muster;
  if (!rule) return '';
  return `mindestens ${rule.min_count} ähnliche frühere Phasen, davon mindestens ${Math.round(rule.share * 100)} % danach gestiegen, `
    + `im Mittel um mindestens ${Math.round(rule.median * 100)} % in ${rule.horizon} Tagen${rule.btc_filter ? ', Bitcoin über seiner 200-Tage-Linie' : ''}`;
}

function musterStatus(item) {
  const line = el('p', 'explain');
  line.style.marginBottom = '8px';
  if (item?.signal) {
    line.append(el('span', 'badge info', 'Deutliches Muster'), ' Erfüllt alle Bedingungen und wurde gemeldet.');
  } else if (item?.deutlich) {
    line.append(el('span', 'badge warn', 'Deutliches Muster'), ' Aber Bitcoin liegt unter seiner 200-Tage-Linie, deshalb keine Meldung. In solchen Zeiten taugten die Muster im Test nicht.');
  } else {
    line.append(el('span', 'badge neutral', 'Kein deutliches Muster'), ` Gemeldet wird erst bei: ${musterRule() || 'strengeren Bedingungen'}.`);
  }
  return line;
}

function reliabilityText() {
  const test = state.stand?.muster?.pruefung;
  return test?.text || 'Ob solche Muster etwas vorhersagen, wurde an fünf Jahren Binance-Daten geprüft. Die Ergebnisse stehen unter „Muster“.';
}

function entryRow(entry) {
  const label = entry.kind === 'kauf' ? `Kauf ${fmtDate(entry.date)}` : `Marker ${fmtDate(entry.date)}`;
  const row = el('a', 'row',
    el('span', `badge ${entry.kind === 'kauf' ? 'up' : 'info'}`, entry.kind === 'kauf' ? 'Kauf' : 'Marker'),
    el('div', 'main', el('div', 'name', label), el('div', 'sub', `${fmtPrice(entry.price)}${entry.kind === 'kauf' ? ` · ${fmtEur(entry.amount)}` : ''}`)),
    el('div', 'end', live(el('div', 'name'), 'entry', entry.id)));
  row.href = `#/eintrag/${entry.id}`;
  return row;
}

// ---------- Eintrag (Kauf oder Marker) ----------

async function renderEntry(id) {
  const token = state.renderToken;
  const entry = state.store.positions.find((item) => item.id === id);
  if (!entry) {
    location.hash = '#/';
    return;
  }
  setTitle(`${entry.coin} · ${entry.kind === 'kauf' ? 'Kauf' : 'Marker'}`, true);
  watch([entry.coin]);
  const [strategy] = await Promise.all([strategyFor(entry.coin), loadPrices([entry.coin])]);
  if (!current(token)) return;

  const price = eur(state.tickers.get(entry.coin)?.price);
  const value = price != null ? entry.quantity * price : null;
  const nodes = [
    el('div', 'card hero',
      el('div', 'label', entry.kind === 'kauf' ? `Kauf vom ${fmtDate(entry.date)}` : `Marker vom ${fmtDate(entry.date)}${entry.kind === 'marker' ? ` · gedachter Betrag ${fmtEur(entry.amount)}` : ''}`),
      el('div', 'big', live(el('span'), 'entry', entry.id)),
      el('div', 'line', `Einstieg ${fmtPrice(entry.price)} · jetzt `, live(el('strong'), 'price', entry.coin))),
  ];
  const facts = el('div', 'facts',
    el('div', null, 'Betrag', el('strong', null, fmtEur(entry.amount))),
    el('div', null, 'Menge', el('strong', null, fmtQty(entry.quantity))),
    el('div', null, 'Wert jetzt', el('strong', null, fmtEur(value))),
    el('div', null, 'Gewinn/Verlust', el('strong', tone(value - entry.amount), fmtSignedEur(value != null ? value - entry.amount : null))));
  nodes[0].append(facts);

  const actual = actualPath(entry, strategy.closes);
  if (entry.snapshot?.analogs?.length) {
    nodes.push(...section('Vergleich mit früheren Phasen',
      el('div', 'card',
        el('p', 'explain', compareText(entry, actual)),
        patternChart({ analogs: entry.snapshot.analogs, horizon: entry.snapshot.horizon, recent: entry.snapshot.recent }, actual),
        legend([['seit Ihrem Eintrag', 'var(--accent)'], ['frühere Phasen', 'var(--muted)'], ['Mittel danach', 'var(--up)', true]]))));
  } else if (actual.length > 1) {
    nodes.push(...section('Verlauf seit dem Eintrag', el('div', 'card', lineChart({
      lines: [{ points: actual, color: 'var(--accent)', width: 2.4 }],
      baseline: 0,
      yFormat: (v) => fmtPct(v, 0),
      xTicks: [{ x: 0, label: fmtDate(entry.date), anchor: 'start' }, { x: actual[actual.length - 1].x, label: 'heute', anchor: 'end' }],
    }))));
  }
  nodes.push(...section('Strategie EMA 10/30 + Bitcoin-Filter', statusCard(verdict(strategy, entry.kind === 'kauf'))));
  if (entry.note) nodes.push(el('p', 'note', `Notiz: ${entry.note}`));

  const actions = el('div', 'actions');
  if (entry.kind === 'marker') {
    const convert = el('button', 'button primary', 'Als Kauf eintragen');
    convert.type = 'button';
    convert.addEventListener('click', () => openBuySheet(entry.coin, null, entry));
    actions.append(convert);
  } else {
    const edit = el('button', 'button', 'Bearbeiten');
    edit.type = 'button';
    edit.addEventListener('click', () => openBuySheet(entry.coin, null, entry));
    actions.append(edit);
  }
  const remove = el('button', 'button danger', 'Löschen');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    if (!window.confirm(`${entry.kind === 'kauf' ? 'Kauf' : 'Marker'} von ${entry.coin} löschen?`)) return;
    state.store.positions = state.store.positions.filter((item) => item.id !== entry.id);
    if (saveStore()) {
      toast('Gelöscht');
      location.hash = `#/coin/${entry.coin}`;
    }
  });
  actions.append(remove);
  const coinLink = el('a', 'button full', `${entry.coin} öffnen`);
  coinLink.href = `#/coin/${entry.coin}`;
  nodes.push(actions, coinLink);
  show(...nodes);
}

// Veränderung seit dem Eintrag je Tag: Tagesschlusskurse danach, zuletzt der aktuelle Kurs
function actualPath(entry, closes) {
  if (!entry.priceUsdt) return [];
  const start = utcDay(entry.time);
  const points = [{ x: 0, y: 0 }];
  for (const item of closes) {
    const day = utcDay(item.time) - start;
    if (day >= 1) points.push({ x: day, y: item.close / entry.priceUsdt - 1 });
  }
  const now = state.tickers.get(entry.coin)?.price;
  if (now) points.push({ x: Math.max(points[points.length - 1].x, (Date.now() - entry.time) / DAY_MS), y: now / entry.priceUsdt - 1 });
  return points;
}

function compareText(entry, actual) {
  const days = Math.floor((Date.now() - entry.time) / DAY_MS);
  const paths = entry.snapshot.analogs.map((analog) => analog.path);
  const day = Math.min(days, paths[0].length - 1);
  const typical = median(paths.map((path) => path[day]));
  const now = actual.length ? actual[actual.length - 1].y : null;
  if (days < 1) return `Gerade gesetzt. In den nächsten ${paths[0].length - 1} Tagen sehen Sie hier, ob ${entry.coin} sich wie in den ${paths.length} früheren Phasen entwickelt.`;
  const relation = now == null || typical == null ? '' : now > typical ? 'besser als' : now < typical ? 'schlechter als' : 'genau wie';
  return `Nach ${days} Tagen: ${entry.coin} ${fmtPct(now)}. Die früheren Phasen lagen nach ${day} Tagen im Mittel bei ${fmtPct(typical)} – also ${relation} damals.`;
}

// ---------- Formulare ----------

function snapshotOf(muster) {
  if (!muster?.analogs?.length) return null;
  return {
    asOf: muster.as_of, length: muster.length, horizon: muster.horizon, recent: muster.recent,
    analogs: muster.analogs.map(({ date, corr, change, path, before }) => ({ date, corr, change, path, before })),
  };
}

function field(label, input) {
  return el('label', 'field', el('span', null, label), input);
}

function input(attrs) {
  const node = el('input');
  Object.assign(node, attrs);
  return node;
}

function openSheet(build) {
  const sheet = $('#sheet');
  const form = el('form');
  form.method = 'dialog';
  build(form, () => sheet.close());
  sheet.replaceChildren(form);
  sheet.showModal();
}

function openBuySheet(coin, muster, existing = null) {
  const priceNow = eur(state.tickers.get(coin)?.price);
  const editing = existing?.kind === 'kauf';
  openSheet((form, close) => {
    const date = input({ type: 'date', value: editing ? existing.date : todayLocal(), max: todayLocal(), required: true });
    const price = input({ type: 'text', inputMode: 'decimal', value: String(editing ? existing.price : existing?.price || priceNow || '').replace('.', ','), required: true });
    const amount = input({ type: 'text', inputMode: 'decimal', value: editing ? String(existing.amount).replace('.', ',') : '', placeholder: 'z. B. 250', required: true });
    const note = el('textarea');
    note.rows = 2;
    note.value = editing ? existing.note || '' : '';
    const result = el('p', 'result');
    const update = () => {
      const p = parseNumber(price.value);
      const a = parseNumber(amount.value);
      result.textContent = p && a ? `Das sind ${fmtQty(a / p)} ${coin}.` : 'Kurs und Betrag in Euro, so wie Sie gekauft haben.';
    };
    price.addEventListener('input', update);
    amount.addEventListener('input', update);
    update();
    const cancel = el('button', 'button', 'Abbrechen');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    const save = el('button', 'button primary', 'Speichern');
    save.type = 'submit';
    form.append(
      el('h3', null, editing ? `Kauf ${coin} bearbeiten` : `Kauf ${coin} eintragen`),
      el('p', 'lead', 'Die Angaben bleiben nur auf diesem iPhone.'),
      field('Kaufdatum', date), field('Kurs je Coin in €', price), field('Betrag in €', amount), field('Notiz (optional)', note),
      result, el('div', 'buttons', cancel, save));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const p = parseNumber(price.value);
      const a = parseNumber(amount.value);
      if (!p || !a || p <= 0 || a <= 0) {
        toast('Bitte Kurs und Betrag als Zahl eingeben.');
        return;
      }
      const isToday = date.value === todayLocal();
      const time = isToday ? Date.now() : Date.parse(`${date.value}T12:00:00`);
      const record = {
        id: editing ? existing.id : uid(), coin, kind: 'kauf', date: date.value, time, price: p, amount: a, quantity: a / p,
        priceUsdt: state.eurusdt ? p * state.eurusdt : null, note: note.value.trim(),
        snapshot: editing ? existing.snapshot : existing?.snapshot || (isToday ? snapshotOf(muster) : null),
      };
      state.store.positions = state.store.positions.filter((item) => item.id !== record.id && item.id !== existing?.id);
      state.store.positions.push(record);
      if (!saveStore()) return;
      close();
      toast(editing ? 'Kauf geändert' : 'Kauf gespeichert');
      location.hash = `#/eintrag/${record.id}`;
      route();
    });
  });
}

function openMarkerSheet(coin, muster) {
  const usdt = state.tickers.get(coin)?.price;
  const priceNow = eur(usdt);
  if (!priceNow) {
    toast('Kein aktueller Kurs. Bitte gleich noch einmal versuchen.');
    return;
  }
  openSheet((form, close) => {
    const amount = input({ type: 'text', inputMode: 'decimal', value: String(MARKER_AMOUNT) });
    const cancel = el('button', 'button', 'Abbrechen');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    const save = el('button', 'button primary', 'Marker setzen');
    save.type = 'submit';
    const comparison = muster?.analogs?.length
      ? `Die App vergleicht die nächsten ${muster.analogs[0].path.length - 1} Tage mit den ${muster.analogs.length} ähnlichen früheren Phasen.`
      : 'Für diesen Coin gibt es gerade keine ähnlichen früheren Phasen. Sie sehen dann nur den Verlauf seit dem Marker.';
    form.append(
      el('h3', null, `Marker für ${coin}`),
      el('p', 'lead', `Als hätten Sie jetzt zu ${fmtPrice(priceNow)} gekauft. ${comparison}`),
      field('Gedachter Betrag in €', amount),
      el('div', 'buttons', cancel, save));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const a = parseNumber(amount.value) || MARKER_AMOUNT;
      const record = {
        id: uid(), coin, kind: 'marker', date: todayLocal(), time: Date.now(), price: priceNow, priceUsdt: usdt,
        amount: a, quantity: a / priceNow, snapshot: snapshotOf(muster),
      };
      state.store.positions.push(record);
      if (!saveStore()) return;
      close();
      toast('Marker gesetzt');
      location.hash = `#/eintrag/${record.id}`;
    });
  });
}

// ---------- Muster ----------

function signalRow(signal) {
  const row = el('a', 'row', coinIcon(signal.coin),
    el('div', 'main',
      el('div', 'name', signal.coin, ' ', el('span', 'badge info', `${Math.round(signal.share_up * signal.count)} von ${signal.count} stiegen`)),
      el('div', 'sub', `früher Ø ${fmtPct(signal.median)} in ${signal.horizon} T. · Hoch nach ${Math.round(signal.peak_day)} T.`)),
    el('div', 'end', live(el('div', 'name'), 'price', signal.coin), el('div', 'sub small', fmtDate(signal.date))));
  row.href = `#/coin/${signal.coin}`;
  return row;
}

async function renderMuster() {
  const token = state.renderToken;
  setTitle('Muster');
  show(el('p', 'loading', 'Lade Muster …'));
  await Promise.all([state.standTried ? null : loadStand(), loadSignale()]);
  if (!current(token)) return;
  const signals = state.signale?.signals || [];
  watch(signals.map((signal) => signal.coin));
  await loadPrices(signals.map((signal) => signal.coin)).catch(() => null);
  if (!current(token)) return;

  const test = state.stand?.muster;
  const nodes = [];
  if (test?.btc_filter && state.stand.btc && !state.stand.btc.above) {
    nodes.push(el('p', 'note warn', 'Gerade keine Meldungen: Bitcoin liegt unter seiner 200-Tage-Linie. In solchen Zeiten taugten die Muster im Test nicht.'));
  }
  if (!state.signale) {
    nodes.push(el('p', 'empty', 'Die tägliche Auswertung aus der Cloud fehlt noch.'));
  } else if (!signals.length) {
    nodes.push(el('div', 'card', el('p', 'empty', `Heute (Tagesschluss ${fmtDate(state.signale.as_of)}) erfüllt kein Coin die Bedingungen.`)));
  } else {
    const list = el('div', 'card flush');
    signals.forEach((signal) => list.append(signalRow(signal)));
    nodes.push(...section(`Heute · Tagesschluss ${fmtDate(state.signale.as_of)}`, list));
  }
  const explanation = test ? el('div', 'card explain',
    el('p', null, el('strong', null, 'So entsteht ein Muster: '),
      `Die App vergleicht jeden Tag den Verlauf der letzten ${test.length} Tage jedes Coins mit seiner eigenen Vergangenheit. `
      + `Sie meldet ein deutliches Muster bei: ${musterRule()}. Ausgewertet werden Coins mit mindestens 1 Mio. $ Tagesumsatz und 400 Tagen Kursgeschichte.`),
    test.pruefung ? el('p', null, el('strong', null, 'Wie verlässlich? '), test.pruefung.text) : null) : null;
  const history = state.signale?.history || [];
  if (history.length) {
    const list = el('div', 'card flush');
    for (const item of history.slice(0, 40)) {
      const outcome = item.result != null ? el('div', `name ${tone(item.result)}`, fmtPct(item.result)) : el('div', 'name muted', 'läuft');
      const row = el('a', 'row', coinIcon(item.coin),
        el('div', 'main', el('div', 'name', item.coin), el('div', 'sub', `${fmtDate(item.date)} · erwartet ${fmtPct(item.median)} in ${item.horizon} T.`)),
        el('div', 'end', outcome, el('div', 'sub small', item.result != null ? `nach ${item.horizon} T.` : `seit ${fmtDate(item.date)}`)));
      row.href = `#/coin/${item.coin}`;
      list.append(row);
    }
    nodes.push(...section('Frühere Meldungen', list), el('p', 'note', 'Wie ist es nach früheren Meldungen tatsächlich ausgegangen? Daran sehen Sie selbst, ob die Muster taugen.'));
  }
  if (explanation) nodes.push(...section('So funktioniert es', explanation));
  show(...nodes);
}

function updateMusterBadge() {
  const count = state.signale?.signals?.length || 0;
  const badge = $('#muster-count');
  if (count) badge.dataset.count = count;
  else delete badge.dataset.count;
}

// ---------- Auswertung von Hand starten (GitHub Actions) ----------

function repoName() {
  const [owner] = location.hostname.split('.');
  const [repo] = location.pathname.split('/').filter(Boolean);
  return location.hostname.endsWith('.github.io') && repo ? `${owner}/${repo}` : null;
}

function githubToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

async function github(path, { method = 'GET', body = null, token = githubToken() } = {}) {
  const response = await fetch(`${GITHUB_API}/repos/${repoName()}${path}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (response.status === 401) throw new Error('Der Schlüssel ist ungültig oder abgelaufen.');
  if (response.status === 403 || response.status === 404) throw new Error('Der Schlüssel darf die Auswertung nicht starten. Fehlt die Berechtigung „Actions: Read and write“ für krypto-radar?');
  if (!response.ok) throw new Error(`GitHub antwortet mit Fehler ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

function setRun(phase, text, url = '') {
  state.run = { phase, text, url };
  const box = $('#run-box');
  if (box) fillRunBox(box);
}

function runBusy() {
  return ['starting', 'queued', 'running'].includes(state.run.phase);
}

async function startRun() {
  if (runBusy()) return;
  const since = Date.now();
  setRun('starting', 'Starte die Auswertung …');
  try {
    await github(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: 'main' } });
    await followRun(since);
  } catch (error) {
    setRun('error', `Nicht gestartet: ${error.message}`, state.run.url);
  }
}

// Fortschritt abfragen, bis der Lauf fertig ist; danach die neuen Daten laden
async function followRun(since) {
  const deadline = Date.now() + 15 * 60000;
  let run = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, run ? 10000 : 4000));
    const data = await github(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`);
    run = data.workflow_runs.find((item) => Date.parse(item.created_at) >= since - 60000) || null;
    if (!run) {
      setRun('queued', 'Auftrag angenommen, GitHub bereitet den Lauf vor …');
    } else if (run.status !== 'completed') {
      const started = run.run_started_at ? fmtClock(new Date(run.run_started_at)) : null;
      setRun(run.status === 'in_progress' ? 'running' : 'queued',
        run.status === 'in_progress' ? `Läuft seit ${started} Uhr, dauert etwa 2 Minuten …` : 'Wartet auf einen freien Platz bei GitHub …', run.html_url);
    } else if (run.conclusion === 'success') {
      state.muster.clear();
      await Promise.all([loadStand(), loadSignale()]);
      setRun('done', `Fertig um ${fmtClock(new Date(run.updated_at))} Uhr. Stand: Tagesschluss ${fmtDate(state.stand?.as_of)}.`, run.html_url);
      return;
    } else {
      setRun('error', `Die Auswertung ist fehlgeschlagen (${run.conclusion}).`, run.html_url);
      return;
    }
  }
  setRun('error', 'Keine Rückmeldung von GitHub. Ob der Lauf geklappt hat, sehen Sie unter „Details bei GitHub“.', run?.html_url || '');
}

async function saveToken(value, status) {
  const token = value.trim();
  if (!token) return;
  status.textContent = 'Prüfe den Schlüssel …';
  try {
    await github(`/actions/workflows/${WORKFLOW}`, { token });
    localStorage.setItem(TOKEN_KEY, token);
    toast('Schlüssel gespeichert');
    fillRunBox($('#run-box'));
  } catch (error) {
    status.textContent = error.message;
  }
}

function fillRunBox(box) {
  box.replaceChildren();
  box.append(el('p', null, 'Die Auswertung läuft jeden Morgen von selbst. Neue Ergebnisse gibt es erst nach dem Tagesschluss (2:00 Uhr, im Winter 1:00 Uhr). Tagsüber liefert ein Lauf dasselbe Ergebnis wie am Morgen.'));
  if (!repoName()) {
    box.append(el('p', null, 'Das Starten von Hand funktioniert nur in der veröffentlichten App (github.io).'));
    return;
  }
  if (!githubToken()) {
    const link = el('a', null, 'Neuen Schlüssel bei GitHub anlegen');
    link.href = 'https://github.com/settings/personal-access-tokens/new';
    link.target = '_blank';
    link.rel = 'noopener';
    const steps = el('ol', null,
      el('li', null, link, ' (am besten hier auf dem iPhone, in Safari bei GitHub angemeldet).'),
      el('li', null, 'Name z. B. „Krypto-Radar App“, Ablauf z. B. 1 Jahr.'),
      el('li', null, 'Repository access: „Only select repositories“ → krypto-radar.'),
      el('li', null, 'Permissions: „Actions“ mit „Read and write“ hinzufügen. Sonst nichts.'),
      el('li', null, '„Generate token“, den Schlüssel kopieren und hier einfügen.'));
    steps.style.paddingLeft = '20px';
    const field = input({ type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: false });
    const status = el('p', 'small down');
    const save = el('button', 'button primary full', 'Schlüssel speichern');
    save.type = 'button';
    save.addEventListener('click', () => saveToken(field.value, status));
    box.append(el('p', null, el('strong', null, 'Einmalig einrichten: '), 'Die App braucht einen GitHub-Schlüssel, der nur das Auswerten starten darf. Er bleibt nur auf diesem iPhone.'),
      steps, el('label', 'field', el('span', null, 'GitHub-Schlüssel'), field), status, save);
    return;
  }
  const button = el('button', 'button primary full', runBusy() ? 'Läuft …' : 'Auswertung jetzt starten');
  button.type = 'button';
  button.disabled = runBusy();
  button.addEventListener('click', startRun);
  box.append(button);
  if (state.run.text) {
    box.append(el('p', `small ${state.run.phase === 'error' ? 'down' : state.run.phase === 'done' ? 'up' : ''}`, state.run.text));
  }
  if (state.run.url) {
    const details = el('a', 'small', 'Details bei GitHub');
    details.href = state.run.url;
    details.target = '_blank';
    details.rel = 'noopener';
    box.append(el('p', null, details));
  }
  const remove = el('button', 'button danger full', 'Schlüssel entfernen');
  remove.type = 'button';
  remove.style.marginTop = '8px';
  remove.addEventListener('click', () => {
    if (!window.confirm('GitHub-Schlüssel von diesem iPhone entfernen?')) return;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* nichts gespeichert */ }
    fillRunBox(box);
  });
  box.append(remove);
}

// ---------- Mehr ----------

function renderMehr() {
  setTitle('Mehr');
  watch([]);
  const nodes = [];
  const updated = state.stand?.updated ? new Date(state.stand.updated).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const runBox = el('div', 'card explain');
  runBox.id = 'run-box';
  fillRunBox(runBox);
  nodes.push(...section('Auswertung von Hand', runBox));
  nodes.push(...section('Benachrichtigungen', el('div', 'card explain',
    el('p', null, 'Neue Muster meldet die App über die kostenlose App „ntfy“. Installieren Sie ntfy aus dem App Store und abonnieren Sie dort Ihr persönliches Thema. Den Namen des Themas erhalten Sie bei der Einrichtung.'),
    el('p', null, 'Ein Tippen auf die Nachricht öffnet den Coin hier in der App.'))));

  const exportButton = el('button', 'button full', 'Daten sichern (Datei)');
  exportButton.type = 'button';
  exportButton.addEventListener('click', exportData);
  const importInput = input({ type: 'file', accept: 'application/json,.json' });
  importInput.hidden = true;
  importInput.addEventListener('change', () => importData(importInput.files[0]));
  const importButton = el('button', 'button full', 'Sicherung einspielen');
  importButton.type = 'button';
  importButton.addEventListener('click', () => importInput.click());
  nodes.push(...section('Ihre Daten', el('div', 'card explain',
    el('p', null, `Gespeichert: ${positions('kauf').length} ${positions('kauf').length === 1 ? 'Kauf' : 'Käufe'} und ${positions('marker').length} Marker – nur auf diesem Gerät, in dieser App.`),
    el('p', null, 'Sichern Sie die Daten gelegentlich als Datei, zum Beispiel in iCloud Drive. Löschen Sie die App vom Home-Bildschirm, sind die Daten sonst weg.')),
  el('div', 'actions', exportButton, importButton), importInput));

  nodes.push(...section('Datenstand', el('div', 'card explain',
    el('p', null, updated ? `Auswertung aus der Cloud: ${updated}, Tagesschluss ${fmtDate(state.stand.as_of)}.` : 'Die tägliche Auswertung aus der Cloud fehlt noch.'),
    el('p', null, 'Kurse live von Binance (öffentliche Marktdaten). Euro-Umrechnung mit dem Binance-Kurs EUR/USDT.'))));

  nodes.push(...section('Hinweis', el('div', 'card explain',
    el('p', null, 'Die App zeigt Regeln und Auswertungen der Vergangenheit. Das ist keine Anlageberatung und keine Prognose. Kryptowährungen können stark und schnell an Wert verlieren.'))));
  show(...nodes);
}

async function exportData() {
  const text = JSON.stringify({ ...state.store, exported: new Date().toISOString() }, null, 2);
  const name = `krypto-radar-${todayLocal()}.json`;
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Krypto-Radar Sicherung' });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const link = el('a');
  link.href = URL.createObjectURL(file);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

async function importData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.positions)) throw new Error('keine Krypto-Radar-Sicherung');
    if (!window.confirm(`Sicherung mit ${data.positions.length} Einträgen einspielen? Die aktuellen Einträge werden ersetzt.`)) return;
    state.store = { version: 1, positions: data.positions };
    if (saveStore()) toast('Sicherung eingespielt');
    route();
  } catch (error) {
    toast(`Sicherung nicht lesbar: ${error.message}`);
  }
}

// ---------- Start der App ----------

function init() {
  $('#back').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.hash = '#/';
  });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.socket) {
        const socket = state.socket;
        state.socket = null;
        socket.close();
      }
      return;
    }
    loadSignale();
    route(); // nach dem Zurückkehren frische Kurse und Daten
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => null);
  loadSignale();
  route();
}

init();
