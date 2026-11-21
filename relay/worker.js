// Ticker Watch price relay — a Cloudflare Worker (free plan is plenty).
// Yahoo Finance blocks requests from web pages, so the app asks this relay,
// and the relay asks Yahoo. It only forwards to Yahoo Finance, nothing else.
const ALLOWED_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Ticker Watch relay is running', { headers: CORS });

    let url;
    try { url = new URL(target); } catch { return new Response('Bad url', { status: 400, headers: CORS }); }
    if (!ALLOWED_HOSTS.includes(url.hostname)) return new Response('Host not allowed', { status: 403, headers: CORS });

    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        Accept: 'application/json',
      },
      cf: { cacheTtl: 15, cacheEverything: true },
    };
    let res = await fetch(url.toString(), opts);
    if (!res.ok && url.hostname === 'query1.finance.yahoo.com') {
      url.hostname = 'query2.finance.yahoo.com'; // backup Yahoo server
      res = await fetch(url.toString(), opts);
    }
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=15' },
    });
  },
};
