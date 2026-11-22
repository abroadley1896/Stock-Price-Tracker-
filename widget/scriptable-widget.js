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
  bgTop: new Color('#232327'),
  bgBottom: new Color('#151517'),
  text: Color.white(),
  muted: new Color('#8e8e93'),
  up: new Color('#30d158'),
  down: new Color('#ff453a'),
  flat: new Color('#98989d'),
  pre: new Color('#ffb340'),
};
const PAD = 14; // widget edge padding

// Widget sizes (points) by phone screen width: [small, medium width, large height]
function widgetSize(family) {
  const s = Device.screenSize();
  const sw = Math.round(Math.min(s.width, s.height));
  const t = { 440: [170, 364, 382], 430: [170, 364, 382], 428: [170, 364, 382], 414: [169, 360, 379],
    402: [162, 350, 365], 393: [158, 338, 354], 390: [158, 338, 354], 375: [148, 321, 324], 360: [155, 329, 345], 320: [141, 292, 311] }[sw]
    || [Math.round(sw * 0.4), Math.round(sw * 0.86), Math.round(sw * 0.9)];
  const width = family === 'small' ? t[0] : t[1];
  const height = family === 'large' ? t[2] : t[0];
  return { width, height };
}

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
  const [rs, re] = q.regRange || [0, data.length - 1];
  const color = dirColor(q.change);

  // shaded area under the regular-session line
  if (re > rs) {
    const area = new Path();
    area.move(new Point(x(rs), h));
    for (let i = rs; i <= re; i++) area.addLine(new Point(x(i), y(data[i])));
    area.addLine(new Point(x(re), h));
    area.closeSubpath();
    ctx.addPath(area);
    ctx.setFillColor(new Color(color.hex, 0.22));
    ctx.fillPath();
  }
  if (isNum(q.prevClose)) { // dashed previous-close line
    ctx.setFillColor(new Color(C.muted.hex, 0.7));
    for (let dx = 0; dx < w; dx += 6) ctx.fillRect(new Rect(dx, y(q.prevClose) - 0.5, 3, 1));
  }
  const seg = (a, b, col) => {
    if (b <= a) return;
    const path = new Path();
    path.move(new Point(x(a), y(data[a])));
    for (let i = a + 1; i <= b; i++) path.addLine(new Point(x(i), y(data[i])));
    ctx.addPath(path);
    ctx.setStrokeColor(col);
    ctx.setLineWidth(2);
    ctx.strokePath();
  };
  seg(0, rs, C.muted);
  seg(re, data.length - 1, C.muted);
  seg(rs, re, color);
  return ctx.getImage();
}

// ---------- Layout ----------
function text(stack, str, size, color, bold) {
  const t = stack.addText(str);
  t.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  return t;
}

function row(tile, label, value, color, extra, fs) {
  const r = tile.addStack();
  r.centerAlignContent();
  text(r, label, fs, C.muted);
  r.addSpacer();
  text(r, value, fs, color || C.text, true);
  if (extra) { r.addSpacer(4); text(r, extra, fs - 2, color || C.text, true); }
}

// One stock. w/h = the space this tile has.
function addTile(parent, sym, q, err, w, h) {
  const tile = parent.addStack();
  tile.layoutVertically();
  tile.size = new Size(w, h);
  const big = h > 150 ? 18 : 16; // ticker & price
  const fs = h > 150 ? 13 : 12; // rows

  const top = tile.addStack();
  top.centerAlignContent();
  if (q) { text(top, arrow(q.change), big - 5, dirColor(q.change), true); top.addSpacer(4); }
  text(top, q ? q.symbol : sym, big, C.text, true);
  top.addSpacer();
  text(top, q ? money(q.price, q) : '—', big, C.text, true);

  if (!q) {
    tile.addSpacer();
    text(tile, err || 'Unavailable', fs, C.muted);
    tile.addSpacer();
    return;
  }

  const sub = tile.addStack();
  sub.centerAlignContent();
  text(sub, STATE[q.state], fs - 1, q.state === 'open' ? C.up : q.state === 'closed' ? C.muted : C.pre);
  sub.addSpacer();
  text(sub, pct(q.changePct), fs - 1, dirColor(q.change), true);

  // chart takes whatever height is left after the text rows
  const rows = isNum(q.ext) ? 3 : 2;
  const textH = big * 1.25 + fs * 1.25 + rows * fs * 1.25 + 9;
  const chartH = Math.max(28, Math.round(h - textH));
  tile.addSpacer(5);
  const img = tile.addImage(chartImage(q, w, chartH));
  img.imageSize = new Size(w, chartH);
  tile.addSpacer();

  row(tile, 'Open', money(q.open, q), null, null, fs);
  row(tile, q.sessionDone ? 'Close' : 'Prev close', money(q.sessionDone ? q.price : q.prevClose, q), null, null, fs);
  if (isNum(q.ext)) row(tile, q.extLabel, money(q.ext, q), dirColor(q.ext - q.price), pct(q.extPct), fs);
}

async function build() {
  const family = config.widgetFamily || 'small';
  const count = { small: 1, medium: 2, large: 4 }[family] || 2;
  const tickers = String(args.widgetParameter || DEFAULT_TICKERS)
    .split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, count);

  const results = await Promise.all(tickers.map((s) =>
    getQuote(s).then((q) => ({ s, q })).catch((e) => ({ s, err: /404|not found/i.test(String(e)) ? 'Ticker not found' : 'No connection' }))));

  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [C.bgTop, C.bgBottom];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  w.setPadding(PAD, PAD, PAD, PAD);

  const size = widgetSize(family);
  const gap = 14;
  const cols = family === 'small' ? 1 : 2;
  const rowsN = family === 'large' ? 2 : 1;
  const tileW = Math.floor((size.width - PAD * 2 - gap * (cols - 1)) / cols) - 1;
  const tileH = Math.floor((size.height - PAD * 2 - gap * (rowsN - 1)) / rowsN) - 1;
  for (let r = 0; r < rowsN; r++) {
    const line = w.addStack();
    for (let c = 0; c < cols; c++) {
      const item = results[r * cols + c];
      if (c > 0) line.addSpacer(gap);
      if (item) addTile(line, item.s, item.q, item.err, tileW, tileH);
      else line.addSpacer(tileW);
    }
    if (r < rowsN - 1) w.addSpacer(gap);
  }
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall(); // preview when run inside the Scriptable app
Script.complete();
