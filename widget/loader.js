// Ticker Watch widget loader — paste this into Scriptable ONCE.
// Each time the widget refreshes it downloads the latest widget design from
// GitHub, so you never need to re-paste. If there's no internet it uses the
// last copy it downloaded.
//
// Setup:
// 1. Scriptable → + → paste this → rename the script "Ticker Watch" → Done.
// 2. Home screen → long-press → Edit → Add Widget → Scriptable → pick a size.
// 3. Long-press the widget → Edit Widget → Script: Ticker Watch,
//    Parameter: one ticker, e.g. ANT.

const SOURCE = 'https://abroadley1896.github.io/Stock-Price-Tracker-/widget/scriptable-widget.js';

const fm = FileManager.local();
const cache = fm.joinPath(fm.documentsDirectory(), 'ticker-watch-widget-cache.js');
let code = null;
try {
  const req = new Request(`${SOURCE}?t=${Date.now()}`);
  req.timeoutInterval = 15;
  const fresh = await req.loadString();
  if (fresh.includes('[TICKER_WATCH_WIDGET]')) {
    code = fresh;
    fm.writeString(cache, fresh);
  }
} catch (e) { /* offline — fall back to the saved copy */ }
if (!code && fm.fileExists(cache)) code = fm.readString(cache);

if (code) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(code)();
} else {
  const w = new ListWidget();
  w.backgroundColor = new Color('#1c1c1e');
  const t = w.addText('Ticker Watch: no connection yet. Open Scriptable and run this script once.');
  t.textColor = Color.white();
  t.font = Font.systemFont(12);
  Script.setWidget(w);
  Script.complete();
}
