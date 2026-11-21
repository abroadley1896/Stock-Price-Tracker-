// Ticker Watch — home screen widget for the Scriptable app (iOS).
// Shows price, open, close / previous close and after-hours for your stocks.
//
// Setup:
// 1. Install "Scriptable" from the App Store (free).
// 2. Open it, tap +, paste this whole script, name it "Ticker Watch".
// 3. Long-press home screen → Edit → Add Widget → Scriptable → pick a size.
// 4. Long-press the new widget → Edit Widget:
//      Script: Ticker Watch
//      Parameter: your tickers, e.g.  ANT   (small)  or  TSLA,ANT  (medium)  or  TSLA,ANT,O,AAPL  (large)
//
// Small shows 1 stock, medium 2, large 4. Tapping the widget opens the full app.
// iOS decides exactly when widgets refresh — usually every 5–15 minutes.

const RELAY = 'https://ticker-relay.alex-d2e.workers.dev';
const APP_URL = 'https://abroadley1896.github.io/Stock-Price-Tracker-/';
const DEFAULT_TICKERS = 'AAPL,TSLA,MSFT,NVDA';

const C = {
  bg: new Color('#0b0d12'),
  tile: new Color('#151821'),
  text: Color.white(),
  muted: new Color('#8a92a6'),
  line: new Color('#262b38'),
  up: new Color('#2fd07a'),
  down: new Color('#ff5c5c'),
  flat: new Color('#9aa3b5'),
  pre: new Color('#f5b84a'),
};

// ---------- Data ----------
const isNum = (v) => typeof v === 'number' && isFinite(v);

async function getQuote(symbol) {
  const yahoo = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=true`;
  const req = new Request(`${RELAY}/?url=${encodeURIComponent(yahoo)}`);
  req.timeoutInterval = 20;
  const json = await req.loadJSON();
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) throw new Error('Not found');
  const m = r.meta || {};
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const ts = r.timestamp || [];
  const candles = ts.map((t, i) => ({ t: t * 1000, o: q.open && q.open[i], c: q.close && q.close[i] })).filter((c) => isNum(c.c));

  const period = m.currentTradingPeriod || {};
  const tp = m.tradingPeriods;
  let regP = null;
  if (tp && !Array.isArray(tp) && tp.regular && tp.regular[0]) regP = tp.regular[0][0];
  else if (Array.isArray(tp) && tp[0]) regP = tp[0][0];
  regP = regP || period.regular || {};
  const regStart = regP.start ? regP.start * 1000 : -Infinity;
  const regEnd = regP.end ? regP.end * 1000 : Infinity;
  const pre = candles.filter((c) => c.t < regStart);
  const reg = candles.filter((c) => c.t >= regStart && c.t < regEnd);
  const post = candles.filter((c) => c.t >= regEnd);

  const now = Date.now();
  const inRange = (p) => p && p.start && p.end && now >= p.start * 1000 && now < p.end * 1000;
  let state = 'closed';
  if (inRange(period.regular)) state = 'open';
  else if (inRange(period.pre)) state = 'pre';
  else if (inRange(period.post)) state = 'post';

  const div = m.currency === 'GBp' || m.currency === 'GBX' ? 100 : 1;
  const p = (v) => (isNum(v) ? v / div : null);
  const price = p(isNum(m.regularMarketPrice) ? m.regularMarketPrice : reg.length ? reg[reg.length - 1].c : null);
  const open = reg.length ? p(isNum(reg[0].o) ? reg[0].o : reg[0].c) : null;
  const prevClose = p(isNum(m.chartPreviousClose) ? m.chartPreviousClose : m.previousClose);

  let ext = null;
  let extLabel = null;
  if (post.length && state !== 'open') { ext = p(post[post.length - 1].c); extLabel = 'After hrs'; }
  else if (pre.length && !reg.length) { ext = p(pre[pre.length - 1].c); extLabel = 'Pre-mkt'; }

  const change = isNum(price) && isNum(prevClose) ? price - prevClose : null;
  return {
    symbol: m.symbol || symbol,
    pence: div === 100,
    cur: { USD: '$', GBP: '£', GBp: '£', GBX: '£', EUR: '€' }[m.currency] || '',
    price, open, prevClose, change,
    changePct: isNum(change) && prevClose ? (change / prevClose) * 100 : null,
    ext, extLabel,
    extPct: isNum(ext) && price ? ((ext - price) / price) * 100 : null,
    state,
    sessionDone: state !== 'open' && reg.length > 0,
    spark: candles.map((c) => c.c / div),
    regRange: reg.length ? [pre.length, pre.length + reg.length - 1] : null,
  };
}

// ---------- Formatting ----------
function money(v, q) {
  if (!isNum(v)) return '—';
  if (q.pence) return `${(v * 100).toFixed(2)}p`;
  const s = Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2);
  return q.cur + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
const pct = (v) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '');
const dirColor = (v) => (!isNum(v) || Math.abs(v) < 1e-9 ? C.flat : v > 0 ? C.up : C.down);
const arrow = (v) => (!isNum(v) || Math.abs(v) < 1e-9 ? '•' : v > 0 ? '▲' : '▼');
const STATE = { open: 'Live', pre: 'Pre-mkt', post: 'After hrs', closed: 'Closed' };

// ---------- Chart ----------
function chartImage(q, w, h) {
  const data = q.spark;
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  if (!data || data.length < 2) return ctx.getImage();
  const vals = isNum(q.prevClose) ? data.concat([q.prevClose]) : data;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - 2 - ((v - min) / span) * (h - 4);

  if (isNum(q.prevClose)) { // dashed previous-close line
    ctx.setFillColor(C.muted);
    for (let dx = 0; dx < w; dx += 6) ctx.fillRect(new Rect(dx, y(q.prevClose) - 0.5, 3, 1));
  }
  const seg = (a, b, color) => {
    if (b <= a) return;
    const path = new Path();
    path.move(new Point(x(a), y(data[a])));
    for (let i = a + 1; i <= b; i++) path.addLine(new Point(x(i), y(data[i])));
    ctx.addPath(path);
    ctx.setStrokeColor(color);
    ctx.setLineWidth(2);
    ctx.strokePath();
  };
  const [rs, re] = q.regRange || [0, data.length - 1];
  seg(0, rs, C.muted);
  seg(re, data.length - 1, C.muted);
  seg(rs, re, dirColor(q.change));
  return ctx.getImage();
}

// ---------- Layout ----------
function text(stack, str, size, color, bold) {
  const t = stack.addText(str);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  return t;
}

function row(tile, label, value, color, extra) {
  const r = tile.addStack();
  r.centerAlignContent();
  text(r, label, 11, C.muted);
  r.addSpacer();
  text(r, value, 11, color || C.text, true);
  if (extra) { r.addSpacer(3); text(r, extra, 9, color || C.text, true); }
}

function addTile(parent, sym, q, err, chartW) {
  const tile = parent.addStack();
  tile.layoutVertically();
  tile.backgroundColor = C.tile;
  tile.cornerRadius = 14;
  tile.setPadding(8, 9, 8, 9);

  const top = tile.addStack();
  top.centerAlignContent();
  if (q) text(top, arrow(q.change) + ' ', 10, dirColor(q.change), true);
  text(top, q ? q.symbol : sym, 13, C.text, true);
  top.addSpacer();
  text(top, q ? money(q.price, q) : '—', 13, C.text, true);

  if (!q) {
    tile.addSpacer();
    text(tile, err || 'Unavailable', 10, C.muted);
    tile.addSpacer();
    return;
  }

  const sub = tile.addStack();
  sub.centerAlignContent();
  text(sub, STATE[q.state], 10, q.state === 'open' ? C.up : q.state === 'closed' ? C.muted : C.pre);
  sub.addSpacer();
  text(sub, pct(q.changePct), 10, dirColor(q.change), true);

  tile.addSpacer(4);
  const img = tile.addImage(chartImage(q, chartW, 34));
  img.imageSize = new Size(chartW, 34);
  tile.addSpacer(4);

  row(tile, 'Open', money(q.open, q));
  row(tile, q.sessionDone ? 'Close' : 'Prev', money(q.sessionDone ? q.price : q.prevClose, q));
  if (isNum(q.ext)) row(tile, q.extLabel, money(q.ext, q), dirColor(q.ext - q.price), pct(q.extPct));
}

async function build() {
  const family = config.widgetFamily || 'medium';
  const count = { small: 1, medium: 2, large: 4 }[family] || 2;
  const tickers = String(args.widgetParameter || DEFAULT_TICKERS)
    .split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, count);

  const results = await Promise.all(tickers.map((s) =>
    getQuote(s).then((q) => ({ s, q })).catch((e) => ({ s, err: /404|not found/i.test(String(e)) ? 'Ticker not found' : 'No connection' }))));

  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  w.setPadding(10, 10, 10, 10);

  const chartW = family === 'small' ? 118 : 128;
  const rowsOf = family === 'large' ? 2 : 1;
  const perRow = family === 'small' ? 1 : 2;
  for (let r = 0; r < rowsOf; r++) {
    const line = w.addStack();
    for (let c = 0; c < perRow; c++) {
      const item = results[r * perRow + c];
      if (!item) break;
      if (c > 0) line.addSpacer(8);
      addTile(line, item.s, item.q, item.err, chartW);
    }
    if (r < rowsOf - 1) w.addSpacer(8);
  }
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium(); // preview when run inside the Scriptable app
Script.complete();
