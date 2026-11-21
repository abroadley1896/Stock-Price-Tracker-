/* Ticker Watch — simple stock watchlist.
 * Shows live price, open, close / previous close, high and low for each stock.
 * Data: Yahoo Finance (no key, US + UK) or Finnhub (free key, US only).
 * Everything is stored locally in the browser — nothing is sent anywhere except the price lookups.
 */
(() => {
  'use strict';

  const STORE_KEY = 'tickerwatch.v1';
  const PROXY_KEY = 'tickerwatch.proxy';
  const DEMO = new URLSearchParams(location.search).has('demo');

  const DEFAULT_STATE = {
    watchlist: ['TSLA', 'COIN', 'ANT', 'O', 'BHHOF', 'AAPL'].map((symbol) => ({ symbol })),
    view: 'tiles',
    provider: 'yahoo',
    finnhubKey: '',
    relayUrl: '',
    refreshSec: 60,
    showHoldings: false,
  };

  // ---------- State ----------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch (_) { /* storage unavailable */ }
    return structuredClone(DEFAULT_STATE);
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  let state = loadState();
  if (DEMO) {
    state = {
      ...structuredClone(DEFAULT_STATE),
      watchlist: ['TSLA', 'COIN', 'O', 'AAPL', 'VOD.L', 'LLOY.L'].map((symbol) => ({ symbol })),
      view: new URLSearchParams(location.search).get('view') || 'tiles',
    };
  }

  const quotes = new Map(); // symbol -> quote | {error}
  let lastUpdated = null;
  let refreshTimer = null;
  let loading = false;

  // ---------- Helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  const fmtCache = new Map();
  function money(v, currency, opts = {}) {
    if (!isNum(v)) return '—';
    const abs = Math.abs(v);
    const dp = opts.dp ?? (abs > 0 && abs < 1 ? 4 : 2);
    const key = `${currency}|${dp}|${opts.sign ? 1 : 0}`;
    let f = fmtCache.get(key);
    if (!f) {
      try {
        f = new Intl.NumberFormat('en-GB', {
          style: currency ? 'currency' : 'decimal',
          currency: currency || undefined,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: dp,
          maximumFractionDigits: dp,
          signDisplay: opts.sign ? 'exceptZero' : 'auto',
        });
      } catch (_) {
        f = new Intl.NumberFormat('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp, signDisplay: opts.sign ? 'exceptZero' : 'auto' });
      }
      fmtCache.set(key, f);
    }
    return f.format(v);
  }
  // Price display: UK shares quoted in pence show as e.g. 65.75p
  function px(v, q, opts = {}) {
    if (q && q.pence) {
      if (!isNum(v)) return '—';
      const p = v * 100;
      return `${opts.sign && p > 0 ? '+' : ''}${p.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}p`;
    }
    return money(v, q?.currency, opts);
  }
  function pct(v) {
    if (!isNum(v)) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  }
  function dirClass(v) {
    if (!isNum(v) || Math.abs(v) < 1e-9) return 'flat';
    return v > 0 ? 'up' : 'down';
  }
  function arrow(v) {
    const d = dirClass(v);
    return d === 'up' ? '▲' : d === 'down' ? '▼' : '•';
  }
  function timeStr(ms, tz) {
    try {
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(ms);
    } catch (_) {
      return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
  }
  function dayStr(ms, tz) {
    try {
      return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(ms);
    } catch (_) {
      return new Date(ms).toDateString();
    }
  }
  function dateKey(ms, tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
    } catch (_) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function friendly(e) {
    const m = e?.message || '';
    if (/HTTP 404/.test(m)) return 'Ticker not found';
    if (/fetch|network|abort|HTTP 5|HTTP 4/i.test(m) || e?.name === 'AbortError') {
      return state.relayUrl ? "Couldn't reach price feed — tap refresh" : "Couldn't reach price feed — add your relay link in Settings";
    }
    return m || 'Unavailable';
  }

  async function fetchJSON(url, ms = 9000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- Yahoo Finance ----------
  // Yahoo doesn't allow direct browser requests, so we try direct first and
  // then a few public CORS relays. Only the ticker symbol is sent.
  const PROXIES = [
    (u) => u,
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];
  let goodProxy = 1;
  try { goodProxy = Number(localStorage.getItem(PROXY_KEY) ?? 1) || 0; } catch (_) { /* ignore */ }

  async function yahooFetch(url) {
    // Your own relay (Settings) is tried first — the public ones are a fallback.
    const relay = (state.relayUrl || '').trim().replace(/\/+$/, '');
    if (relay) {
      try {
        return await fetchJSON(`${relay}/?url=${encodeURIComponent(url)}`);
      } catch (e) {
        if (/HTTP 4/.test(e.message)) throw e; // e.g. ticker not found
      }
    }
    const order = [goodProxy, ...PROXIES.keys()].filter((v, i, a) => a.indexOf(v) === i && PROXIES[v]);
    let lastErr;
    for (const i of order) {
      try {
        const json = await fetchJSON(PROXIES[i](url));
        if (goodProxy !== i) {
          goodProxy = i;
          try { localStorage.setItem(PROXY_KEY, String(i)); } catch (_) { /* ignore */ }
        }
        return json;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Network error');
  }

  async function yahooQuote(symbol) {
    // Intraday (5-min) data for the latest session, including pre-market and
    // after-hours trading: gives today's open, previous close, close,
    // extended-hours price and the chart line.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=true`;
    const json = await yahooFetch(url);
    const err = json?.chart?.error;
    if (err) throw new Error(err.description || 'Not found');
    const r = json?.chart?.result?.[0];
    if (!r) throw new Error('Not found');
    const m = r.meta || {};
    const q = r.indicators?.quote?.[0] || {};
    const ts = r.timestamp || [];
    const tz = m.exchangeTimezoneName || 'UTC';

    const candles = ts.map((t, i) => ({
      t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i],
    })).filter((c) => isNum(c.c));

    // Regular session window for the day this data covers
    const period = m.currentTradingPeriod || {};
    const tp = m.tradingPeriods;
    const regP = (tp && !Array.isArray(tp) ? tp.regular?.[0]?.[0] : Array.isArray(tp) ? tp[0]?.[0] : null) || period.regular || {};
    const regStart = regP.start ? regP.start * 1000 : -Infinity;
    const regEnd = regP.end ? regP.end * 1000 : Infinity;
    const pre = candles.filter((c) => c.t < regStart);
    const reg = candles.filter((c) => c.t >= regStart && c.t < regEnd);
    const post = candles.filter((c) => c.t >= regEnd);

    // Market state right now
    const now = Date.now();
    const inRange = (p) => p && p.start && p.end && now >= p.start * 1000 && now < p.end * 1000;
    let marketState = 'closed';
    if (inRange(period.regular)) marketState = 'open';
    else if (inRange(period.pre)) marketState = 'pre';
    else if (inRange(period.post)) marketState = 'post';

    let price = isNum(m.regularMarketPrice) ? m.regularMarketPrice : reg[reg.length - 1]?.c;
    let open = reg[0] ? (isNum(reg[0].o) ? reg[0].o : reg[0].c) : null;
    const hs = reg.map((c) => c.h).filter(isNum);
    const ls = reg.map((c) => c.l).filter(isNum);
    let high = isNum(m.regularMarketDayHigh) ? m.regularMarketDayHigh : hs.length ? Math.max(...hs) : null;
    let low = isNum(m.regularMarketDayLow) ? m.regularMarketDayLow : ls.length ? Math.min(...ls) : null;
    let prevClose = m.chartPreviousClose ?? m.previousClose ?? null;

    // Extended hours: after-hours once the session has closed, pre-market before it opens
    let extPrice = null;
    let extLabel = null;
    let extTime = null;
    if (post.length && marketState !== 'open') {
      extPrice = post[post.length - 1].c; extLabel = 'After hours'; extTime = post[post.length - 1].t;
    } else if (pre.length && !reg.length) {
      extPrice = pre[pre.length - 1].c; extLabel = 'Pre-market'; extTime = pre[pre.length - 1].t;
    }

    let spark = candles.map((c) => c.c);
    if (marketState === 'open' && isNum(price) && spark.length) spark.push(price);
    const sparkReg = reg.length ? [pre.length, pre.length + reg.length - 1 + (marketState === 'open' ? 1 : 0)] : null;

    // London prices come in pence (GBp) — convert to pounds internally
    let currency = m.currency || '';
    let pence = false;
    if (currency === 'GBp' || currency === 'GBX') {
      const p = (v) => (isNum(v) ? v / 100 : v);
      price = p(price); open = p(open); high = p(high); low = p(low); prevClose = p(prevClose); extPrice = p(extPrice);
      spark = spark.map(p);
      currency = 'GBP';
      pence = true;
    }

    const change = isNum(price) && isNum(prevClose) ? price - prevClose : null;
    const changePct = isNum(change) && prevClose ? (change / prevClose) * 100 : null;
    const extChange = isNum(extPrice) && isNum(price) ? extPrice - price : null;
    const extChangePct = isNum(extChange) && price ? (extChange / price) * 100 : null;

    return {
      symbol: m.symbol || symbol,
      name: m.longName || m.shortName || '',
      exchange: m.fullExchangeName || m.exchangeName || '',
      currency, pence, price, open, high, low, prevClose, change, changePct,
      extPrice, extLabel, extChange, extChangePct, extTime,
      marketState,
      sessionDone: marketState !== 'open' && reg.length > 0,
      time: (m.regularMarketTime || 0) * 1000 || reg[reg.length - 1]?.t || now,
      tz,
      spark, sparkReg,
    };
  }

  async function yahooSearch(term) {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(term)}&quotesCount=8&newsCount=0&listsCount=0`;
    const json = await yahooFetch(url);
    return (json.quotes || [])
      .filter((x) => x.symbol && ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(x.quoteType))
      .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || '', exchange: x.exchDisp || x.exchange || '' }));
  }

  // ---------- Finnhub ----------
  const FH = 'https://finnhub.io/api/v1';
  let fhStatusCache = { at: 0, val: null };

  async function finnhubQuote(symbol) {
    const key = state.finnhubKey.trim();
    if (!key) throw new Error('Add your Finnhub key in Settings');
    const tok = `token=${encodeURIComponent(key)}`;
    const [q, status] = await Promise.all([
      fetchJSON(`${FH}/quote?symbol=${encodeURIComponent(symbol)}&${tok}`),
      finnhubStatus(tok),
    ]);
    if (!q || !isNum(q.c) || (q.c === 0 && q.pc === 0)) throw new Error('Not found (US stocks only on free plan)');

    const item = state.watchlist.find((w) => w.symbol === symbol);
    let name = item?.name || '';
    let currency = item?.currency || 'USD';
    if (!name) {
      try {
        const p = await fetchJSON(`${FH}/stock/profile2?symbol=${encodeURIComponent(symbol)}&${tok}`);
        if (p?.name) { name = p.name; currency = p.currency || currency; if (item) { item.name = name; item.currency = currency; saveState(); } }
      } catch (_) { /* optional */ }
    }

    let marketState = 'closed';
    if (status?.isOpen) marketState = 'open';
    else if (status?.session === 'pre-market') marketState = 'pre';
    else if (status?.session === 'post-market') marketState = 'post';

    const tz = 'America/New_York';
    const qTime = (q.t || 0) * 1000;
    const sameDay = qTime && dateKey(qTime, tz) === dateKey(Date.now(), tz);
    return {
      symbol, name, exchange: 'US', currency,
      price: q.c, open: q.o || null, high: q.h || null, low: q.l || null, prevClose: q.pc || null,
      change: q.d, changePct: q.dp,
      marketState,
      sessionDone: marketState !== 'open' && !!sameDay,
      time: qTime || Date.now(),
      tz,
      spark: null,
    };
  }

  async function finnhubStatus(tok) {
    if (Date.now() - fhStatusCache.at < 60_000) return fhStatusCache.val;
    try {
      const val = await fetchJSON(`${FH}/stock/market-status?exchange=US&${tok}`);
      fhStatusCache = { at: Date.now(), val };
      return val;
    } catch (_) {
      return null;
    }
  }

  async function finnhubSearch(term) {
    const key = state.finnhubKey.trim();
    if (!key) throw new Error('Add your Finnhub key in Settings');
    const json = await fetchJSON(`${FH}/search?q=${encodeURIComponent(term)}&token=${encodeURIComponent(key)}`);
    return (json.result || [])
      .filter((x) => x.symbol && !x.symbol.includes('.'))
      .slice(0, 8)
      .map((x) => ({ symbol: x.symbol, name: x.description || '', exchange: x.type || '' }));
  }

  // ---------- Demo data (?demo) ----------
  function demoQuote(symbol) {
    const base = { AAPL: [231.4, 'Apple Inc.', 'NasdaqGS', 'USD'], TSLA: [342.1, 'Tesla, Inc.', 'NasdaqGS', 'USD'], NVDA: [141.9, 'NVIDIA Corporation', 'NasdaqGS', 'USD'], COIN: [104.2, 'Coinbase Global, Inc.', 'NasdaqGS', 'USD'], O: [57.6, 'Realty Income Corporation', 'NYSE', 'USD'], 'VOD.L': [0.7184, 'Vodafone Group Plc', 'LSE', 'GBP'], 'LLOY.L': [0.5512, 'Lloyds Banking Group plc', 'LSE', 'GBP'] }[symbol] || [100, symbol, 'NYSE', 'USD'];
    let seed = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const prevClose = base[0];
    const isUK = symbol.endsWith('.L');
    const preN = isUK ? 0 : 66, regN = isUK ? 102 : 78, postN = isUK ? 0 : 48;
    const pre = [];
    let v = prevClose;
    for (let i = 0; i < preN; i++) pre.push((v *= 1 + (rnd() - 0.5) * 0.002));
    const open = (pre[preN - 1] ?? prevClose) * (1 + (rnd() - 0.5) * 0.006);
    const drift = (rnd() - 0.5) * 0.0025;
    const reg = [open];
    for (let i = 1; i < regN; i++) reg.push(reg[i - 1] * (1 + drift + (rnd() - 0.5) * 0.006));
    const price = reg[regN - 1];
    const post = [];
    v = price;
    for (let i = 0; i < postN; i++) post.push((v *= 1 + (rnd() - 0.5) * 0.002));
    const spark = [...pre, ...reg, ...post];
    const extPrice = postN ? post[postN - 1] : null;
    return {
      symbol, name: base[1], exchange: base[2], currency: base[3], pence: isUK,
      price, open, prevClose,
      high: Math.max(price, open) * 1.006, low: Math.min(price, open) * 0.994,
      change: price - prevClose, changePct: ((price - prevClose) / prevClose) * 100,
      marketState: isUK ? 'closed' : 'post', sessionDone: true,
      extPrice, extLabel: extPrice ? 'After hours' : null, extChange: extPrice ? extPrice - price : null,
      extChangePct: extPrice ? ((extPrice - price) / price) * 100 : null, extTime: Date.now(),
      sparkReg: preN || postN ? [preN, preN + regN - 1] : null,
      time: Date.now(), tz: isUK ? 'Europe/London' : 'America/New_York', spark,
    };
  }

  const getQuote = (s) => (DEMO ? Promise.resolve(demoQuote(s)) : state.provider === 'finnhub' ? finnhubQuote(s) : yahooQuote(s));
  const search = (t) => (state.provider === 'finnhub' && !DEMO ? finnhubSearch(t) : yahooSearch(t));

  // ---------- Refresh ----------
  async function refreshAll() {
    if (loading) return;
    loading = true;
    $('#refreshBtn').classList.add('spin');
    const symbols = state.watchlist.map((w) => w.symbol);
    // small concurrency limit so public relays aren't hammered
    const queue = [...symbols];
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          quotes.set(s, await getQuote(s));
        } catch (e) {
          const prev = quotes.get(s);
          quotes.set(s, prev && !prev.error ? { ...prev, stale: true } : { error: friendly(e) });
        }
        render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, worker));
    lastUpdated = Date.now();
    loading = false;
    $('#refreshBtn').classList.remove('spin');
    render();
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    if (state.refreshSec > 0) {
      refreshTimer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshAll();
      }, state.refreshSec * 1000);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!lastUpdated || Date.now() - lastUpdated > 20_000)) refreshAll();
  });

  // ---------- Rendering ----------
  const ICON_GRID = '<svg viewBox="0 0 24 24" width="20" height="20"><g fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></g></svg>';
  const ICON_LIST = '<svg viewBox="0 0 24 24" width="20" height="20"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/></g></svg>';
  const STATE_LABEL = { open: 'Market open', pre: 'Pre-market', post: 'After hours', closed: 'Market closed' };

  function sparkSVG(data, cls, h = 34, base = null, klass = '', segReg = null) {
    if (!data || data.length < 2) return klass ? `<div class="${klass} nochart"></div>` : '';
    const w = 300;
    const vals = isNum(base) ? [...data, base] : data;
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const y = (v) => (h - 3 - ((v - min) / span) * (h - 6)).toFixed(1);
    const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${y(v)}`);
    const color = cls === 'up' ? 'var(--up)' : cls === 'down' ? 'var(--down)' : 'var(--flat)';
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    const line = (a, b, stroke, op = 1) => (b > a ? `<polyline points="${pts.slice(a, b + 1).join(' ')}" fill="none" stroke="${stroke}" stroke-opacity="${op}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>` : '');
    const [rs, re] = segReg && segReg[1] > segReg[0] ? [segReg[0], Math.min(segReg[1], pts.length - 1)] : [0, pts.length - 1];
    const x = (i) => ((i / (data.length - 1)) * w).toFixed(1);
    const baseLine = isNum(base) ? `<line x1="0" x2="${w}" y1="${y(base)}" y2="${y(base)}" stroke="var(--muted)" stroke-opacity=".6" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : '';
    return `<svg class="${klass || (h > 50 ? 'detail-spark' : 'spark')}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${baseLine}
      <polygon points="${x(rs)},${h} ${pts.slice(rs, re + 1).join(' ')} ${x(re)},${h}" fill="url(#${id})"/>
      ${line(0, rs, 'var(--muted)', 0.55)}${line(re, pts.length - 1, 'var(--muted)', 0.55)}${line(rs, re, color)}
    </svg>`;
  }

  function extHTML(q, klass) {
    if (!isNum(q.extPrice)) return '';
    const d = dirClass(q.extChange);
    return `<div class="${klass}"><span>${q.extLabel === 'Pre-market' ? 'Pre-mkt' : 'After hrs'}</span><b class="num ${d}">${px(q.extPrice, q)} <small>${pct(q.extChangePct)}</small></b></div>`;
  }

  function priceLabel(q) {
    if (q.marketState === 'open') return 'Live';
    if (q.marketState === 'pre') return 'Last close';
    if (q.sessionDone) return `Close · ${dayStr(q.time, q.tz)}`;
    return 'Last close';
  }

  function holdingFor(item, q) {
    if (!state.showHoldings || !isNum(item.shares) || item.shares <= 0 || !q || q.error) return null;
    const value = item.shares * q.price;
    const day = isNum(q.change) ? item.shares * q.change : null;
    const pl = isNum(item.avgCost) && item.avgCost > 0 ? value - item.shares * item.avgCost : null;
    const plPct = isNum(pl) ? (pl / (item.shares * item.avgCost)) * 100 : null;
    return { value, day, pl, plPct, currency: q.currency };
  }

  function cardHTML(item) {
    const q = quotes.get(item.symbol);
    if (!q) {
      return `<button class="card" data-sym="${esc(item.symbol)}">
        <div class="card-top"><div class="name-block"><div class="ticker">${esc(item.symbol)}</div><div class="company">${esc(item.name || '')}</div></div>
        <div class="price-block"><div class="price"><span class="skeleton"></span></div></div></div></button>`;
    }
    if (q.error) {
      return `<button class="card error" data-sym="${esc(item.symbol)}">
        <div class="card-top"><div class="name-block"><div class="ticker">${esc(item.symbol)}</div><div class="company">${esc(q.error)}</div></div>
        <div class="price-block"><div class="price">Unavailable</div></div></div></button>`;
    }
    const d = dirClass(q.change);
    const h = holdingFor(item, q);
    const stateCls = q.marketState;
    return `<button class="card" data-sym="${esc(item.symbol)}">
      <div class="card-top">
        <div class="name-block">
          <div class="ticker">${esc(q.symbol)}</div>
          <div class="company">${esc(q.name || q.exchange)}</div>
          <div class="status"><i class="dot ${stateCls}"></i>${STATE_LABEL[stateCls]}${q.stale ? ' · offline' : ''}</div>
        </div>
        <div class="price-block">
          <div class="price-label">${esc(priceLabel(q))}</div>
          <div class="price num">${px(q.price, q)}</div>
          <div class="chg num ${d}">${arrow(q.change)} ${px(Math.abs(q.change ?? NaN), q, { dp: 2 })} (${pct(q.changePct)})</div>
          ${isNum(q.extPrice) ? `<div class="ext-line num">${esc(q.extLabel)} <b class="${dirClass(q.extChange)}">${px(q.extPrice, q)} (${pct(q.extChangePct)})</b></div>` : ''}
        </div>
      </div>
      ${sparkSVG(q.spark, d, 34, q.prevClose, '', q.sparkReg)}
      <div class="stats">
        <div class="stat"><span>Open</span><b class="num">${px(q.open, q)}</b></div>
        <div class="stat"><span>Prev close</span><b class="num">${px(q.prevClose, q)}</b></div>
        <div class="stat"><span>High</span><b class="num">${px(q.high, q)}</b></div>
        <div class="stat"><span>Low</span><b class="num">${px(q.low, q)}</b></div>
      </div>
      ${h ? `<div class="holding num"><span>${item.shares} shares · ${money(h.value, h.currency)}</span>
        ${isNum(h.pl) ? `<span class="${dirClass(h.pl)}">P/L ${money(h.pl, h.currency, { sign: true })} (${pct(h.plPct)})</span>` : ''}</div>` : ''}
    </button>`;
  }

  function tileHTML(item) {
    const q = quotes.get(item.symbol);
    const sym = esc(item.symbol);
    if (!q || q.error) {
      return `<button class="tile${q ? ' error' : ''}" data-sym="${sym}">
        <div class="tile-top"><span class="ticker">${sym}</span><span class="price">${q ? '—' : '<span class="skeleton"></span>'}</span></div>
        <div class="tile-chart nochart"></div>
        <div class="tile-msg">${q ? esc(q.error) : 'Loading…'}</div>
      </button>`;
    }
    const d = dirClass(q.change);
    const closeLabel = q.sessionDone ? 'Close' : 'Prev close';
    const closeVal = q.sessionDone ? q.price : q.prevClose;
    return `<button class="tile" data-sym="${sym}">
      <div class="tile-top">
        <span class="ticker"><span class="${d}">${arrow(q.change)}</span> ${esc(q.symbol)}</span>
        <span class="price num">${px(q.price, q)}</span>
      </div>
      <div class="tile-sub">
        <span class="status"><i class="dot ${q.marketState}"></i>${{ open: 'Live', pre: 'Pre-mkt', post: 'After hrs', closed: 'Closed' }[q.marketState]}${q.stale ? ' · offline' : ''}</span>
        <span class="num ${d}">${isNum(q.change) ? (q.change >= 0 ? '+' : '−') + px(Math.abs(q.change), q, { dp: 2 }) : ''}</span>
      </div>
      ${sparkSVG(q.spark, d, 60, q.prevClose, 'tile-chart', q.sparkReg)}
      <div class="tile-oc"><span>Open</span><b class="num">${px(q.open, q)}</b></div>
      <div class="tile-oc"><span>${closeLabel}</span><b class="num">${px(closeVal, q)}</b></div>
      ${extHTML(q, 'tile-oc ext')}
    </button>`;
  }

  function renderPortfolio() {
    const el = $('#portfolio');
    if (!state.showHoldings) { el.hidden = true; return; }
    const totals = {};
    for (const item of state.watchlist) {
      const h = holdingFor(item, quotes.get(item.symbol));
      if (!h) continue;
      const t = (totals[h.currency] ||= { value: 0, day: 0, pl: 0, cost: 0 });
      t.value += h.value;
      t.day += h.day || 0;
      if (isNum(h.pl)) { t.pl += h.pl; t.cost += h.value - h.pl; }
    }
    const curs = Object.keys(totals);
    if (!curs.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<div class="label">My holdings</div>` + curs.map((c) => {
      const t = totals[c];
      const dayPct = t.value - t.day ? (t.day / (t.value - t.day)) * 100 : null;
      return `<div class="row">
        <div class="total num">${money(t.value, c)}</div>
        <div class="sub num"><span class="${dirClass(t.day)}">Today ${money(t.day, c, { sign: true })} (${pct(dayPct)})</span>${t.cost ? ` · <span class="${dirClass(t.pl)}">Total ${money(t.pl, c, { sign: true })}</span>` : ''}</div>
      </div>`;
    }).join('');
  }

  function render() {
    const tiles = state.view !== 'list';
    $('#list').className = tiles ? 'list tiles' : 'list';
    $('#list').innerHTML = state.watchlist.map(tiles ? tileHTML : cardHTML).join('');
    $('#viewBtn').innerHTML = tiles ? ICON_LIST : ICON_GRID;
    $('#viewBtn').setAttribute('aria-label', tiles ? 'Show detailed list' : 'Show tiles');
    $('#empty').hidden = state.watchlist.length > 0;
    renderPortfolio();
    const upd = $('#updated');
    if (DEMO) upd.textContent = 'Demo data';
    else if (loading && !lastUpdated) upd.textContent = 'Loading…';
    else if (lastUpdated) upd.textContent = `Updated ${timeStr(lastUpdated)}${state.refreshSec ? ` · auto every ${state.refreshSec < 60 ? state.refreshSec + 's' : state.refreshSec / 60 + ' min'}` : ''}`;
  }

  // ---------- Card tap → detail ----------
  $('#list').addEventListener('click', (e) => {
    const card = e.target.closest('.card, .tile');
    if (card) openDetail(card.dataset.sym);
  });

  function openDetail(symbol) {
    const idx = state.watchlist.findIndex((w) => w.symbol === symbol);
    if (idx < 0) return;
    const item = state.watchlist[idx];
    const q = quotes.get(symbol);
    const ok = q && !q.error;
    const d = ok ? dirClass(q.change) : 'flat';
    const cur = ok ? q.currency : '';
    $('#detailBody').innerHTML = `
      <div class="sheet-head">
        <h2>${esc(symbol)}</h2>
        <button class="text-btn" data-act="close">Done</button>
      </div>
      ${ok ? `
        <div class="company">${esc(q.name)}${q.exchange ? ' · ' + esc(q.exchange) : ''}</div>
        <div class="status"><i class="dot ${q.marketState}"></i>${STATE_LABEL[q.marketState]} · as of ${timeStr(q.time, q.tz)} ${esc(dayStr(q.time, q.tz))}</div>
        <div class="price-label" style="margin-top:12px">${esc(priceLabel(q))}</div>
        <div class="detail-price num">${px(q.price, q)}</div>
        <div class="chg num ${d}">${arrow(q.change)} ${px(Math.abs(q.change ?? NaN), q, { dp: 2 })} (${pct(q.changePct)}) today</div>
        ${isNum(q.extPrice) ? `<div class="ext-line num" style="text-align:left">${esc(q.extLabel)}: <b class="${dirClass(q.extChange)}">${px(q.extPrice, q)} ${arrow(q.extChange)} ${px(Math.abs(q.extChange), q, { dp: 2 })} (${pct(q.extChangePct)})</b>${q.extTime ? ' · ' + timeStr(q.extTime, q.tz) : ''}</div>` : ''}
        ${sparkSVG(q.spark, d, 90, q.prevClose, '', q.sparkReg)}
        ${q.spark ? `<p class="hint" style="margin-top:-6px">Latest session · dashed line = previous close${q.sparkReg ? ' · grey = pre-market / after hours' : ''}</p>` : ''}
        <div class="detail-grid">
          <div class="stat"><span>Open</span><b class="num">${px(q.open, q)}</b></div>
          <div class="stat"><span>${q.sessionDone ? 'Close' : 'Current'}</span><b class="num">${px(q.price, q)}</b></div>
          <div class="stat"><span>Prev close</span><b class="num">${px(q.prevClose, q)}</b></div>
          <div class="stat"><span>Day range</span><b class="num">${isNum(q.low) ? px(q.low, q) + ' – ' + px(q.high, q) : '—'}</b></div>
        </div>` : `<p class="hint">${esc(q?.error || 'Loading…')}</p>`}

      <div class="section-title">My holding (optional)</div>
      <div class="two-col">
        <label class="field"><span>Shares</span><input type="number" inputmode="decimal" step="any" min="0" id="dShares" value="${isNum(item.shares) ? item.shares : ''}" placeholder="0"></label>
        <label class="field"><span>Avg price paid${ok && q.pence ? ' (pence)' : cur ? ' (' + esc(cur) + ')' : ''}</span><input type="number" inputmode="decimal" step="any" min="0" id="dCost" value="${isNum(item.avgCost) ? +(item.avgCost * (ok && q.pence ? 100 : 1)).toFixed(6) : ''}" placeholder="0.00"></label>
      </div>
      <button class="primary" data-act="save">Save</button>
      <div class="btn-row">
        <button data-act="up" ${idx === 0 ? 'disabled' : ''}>Move up</button>
        <button data-act="down" ${idx === state.watchlist.length - 1 ? 'disabled' : ''}>Move down</button>
      </div>
      <div class="btn-row"><button class="danger" data-act="remove">Remove from watchlist</button></div>
    `;
    const sheet = $('#detailSheet');
    sheet.dataset.sym = symbol;
    sheet.showModal();
  }

  $('#detailBody').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const sheet = $('#detailSheet');
    const sym = sheet.dataset.sym;
    const idx = state.watchlist.findIndex((w) => w.symbol === sym);
    const item = state.watchlist[idx];
    if (act === 'close') return sheet.close();
    if (act === 'save' && item) {
      const s = parseFloat($('#dShares').value);
      const c = parseFloat($('#dCost').value);
      item.shares = isNum(s) && s > 0 ? s : undefined;
      const pence = quotes.get(sym)?.pence;
      item.avgCost = isNum(c) && c > 0 ? (pence ? c / 100 : c) : undefined;
      if (item.shares && !state.showHoldings) state.showHoldings = true;
    }
    if (act === 'up' && idx > 0) [state.watchlist[idx - 1], state.watchlist[idx]] = [state.watchlist[idx], state.watchlist[idx - 1]];
    if (act === 'down' && idx < state.watchlist.length - 1) [state.watchlist[idx + 1], state.watchlist[idx]] = [state.watchlist[idx], state.watchlist[idx + 1]];
    if (act === 'remove' && confirm(`Remove ${sym} from your watchlist?`)) {
      state.watchlist.splice(idx, 1);
      quotes.delete(sym);
    } else if (act === 'remove') return;
    saveState();
    render();
    sheet.close();
  });

  // ---------- Add stock ----------
  let searchTimer = null;
  let searchSeq = 0;
  $('#addBtn').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#results').innerHTML = '';
    $('#addSheet').showModal();
    setTimeout(() => $('#searchInput').focus(), 50);
  });

  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const term = e.target.value.trim();
    if (!term) { $('#results').innerHTML = ''; return; }
    const direct = `<li><button type="button" data-add="${esc(term.toUpperCase())}"><span><span class="r-sym">Add “${esc(term.toUpperCase())}”</span><br><span class="r-name">Use this exact ticker</span></span></button></li>`;
    $('#results').innerHTML = direct + '<li class="r-msg">Searching…</li>';
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const res = await search(term);
        if (seq !== searchSeq) return;
        $('#results').innerHTML = res.map((r) => `<li><button type="button" data-add="${esc(r.symbol)}" data-name="${esc(r.name)}">
            <span><span class="r-sym">${esc(r.symbol)}</span><br><span class="r-name">${esc(r.name)}</span></span>
            <span class="r-ex">${esc(r.exchange)}</span></button></li>`).join('') || direct + '<li class="r-msg">No matches — you can still add the ticker above.</li>';
      } catch (err) {
        if (seq !== searchSeq) return;
        $('#results').innerHTML = direct + `<li class="r-msg">Search unavailable (${esc(err.message)}). Add the exact ticker above.</li>`;
      }
    }, 350);
  });

  $('#addForm').addEventListener('submit', (e) => {
    // Enter key adds the typed ticker
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const term = $('#searchInput').value.trim().toUpperCase();
    if (term) addSymbol(term);
  });

  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b) addSymbol(b.dataset.add, b.dataset.name);
  });

  function addSymbol(symbol, name) {
    symbol = symbol.trim().toUpperCase();
    if (!symbol) return;
    if (!state.watchlist.some((w) => w.symbol === symbol)) {
      state.watchlist.push({ symbol, name: name || undefined });
      saveState();
    }
    $('#addSheet').close();
    render();
    getQuote(symbol)
      .then((q) => quotes.set(symbol, q))
      .catch((err) => quotes.set(symbol, { error: friendly(err) }))
      .finally(render);
  }

  // ---------- Settings ----------
  function syncKeyField() {
    $('#keyField').hidden = $('#providerSelect').value !== 'finnhub';
    $('#relayField').hidden = $('#providerSelect').value !== 'yahoo';
  }
  $('#settingsBtn').addEventListener('click', () => {
    $('#providerSelect').value = state.provider;
    $('#finnhubKey').value = state.finnhubKey;
    $('#relayUrl').value = state.relayUrl || '';
    $('#refreshSelect').value = String(state.refreshSec);
    $('#showHoldings').checked = !!state.showHoldings;
    syncKeyField();
    $('#settingsSheet').showModal();
  });
  $('#providerSelect').addEventListener('change', syncKeyField);
  $('#settingsForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    const providerChanged = state.provider !== $('#providerSelect').value || state.finnhubKey !== $('#finnhubKey').value.trim() || state.relayUrl !== $('#relayUrl').value.trim();
    state.relayUrl = $('#relayUrl').value.trim();
    state.provider = $('#providerSelect').value;
    state.finnhubKey = $('#finnhubKey').value.trim();
    state.refreshSec = Number($('#refreshSelect').value);
    state.showHoldings = $('#showHoldings').checked;
    saveState();
    scheduleRefresh();
    if (providerChanged) { quotes.clear(); lastUpdated = null; }
    render();
    refreshAll();
  });

  $('#refreshBtn').addEventListener('click', refreshAll);
  $('#viewBtn').addEventListener('click', () => {
    state.view = state.view === 'list' ? 'tiles' : 'list';
    saveState();
    render();
  });

  // Close sheets when tapping the backdrop
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  });

  // ---------- Boot ----------
  render();
  refreshAll();
  scheduleRefresh();

  if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
    // When a new version is installed, reload once so it shows straight away
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); }
    });
  }
})();
