// Netlify Function: GET /api/scraper?code=<קוד אוצר>
// מאתר את דף המסלול ב-mygemel.net, שולף שם + חשיפה למניות ולאג"ח, ושומר במטמון ל-24 שעות.

import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.mygemel.net';
const ALLOWED_HOST = 'www.mygemel.net';
const TTL_MS = 24 * 60 * 60 * 1000;          // 24 שעות לתוצאה תקינה
const NOT_FOUND_TTL_MS = 60 * 60 * 1000;     // שעה לקוד שלא נמצא (מונע הצפה בקודים שגויים)
const MAX_CACHE_ENTRIES = 2000;
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (compatible; StressTestBot/1.0)';

// נקודות החיפוש של האתר (אותן נקודות שמשמשות את תיבת החיפוש שלו), לפי סדר עדיפות.
const SEARCH_ENDPOINTS = [
  { type: 'קרן השתלמות',      path: '/api/funds/קרנות-השתלמות' },
  { type: 'קופת גמל',          path: '/api/funds/קופות-גמל' },
  { type: 'קופת גמל להשקעה',   path: '/api/funds/קופת-גמל-להשקעה' },
  { type: 'קרן פנסיה',         path: '/api/pension_tracks/פנסיה' },
  { type: 'פוליסת חיסכון',     path: '/api/policies/פוליסות-חיסכון' },
  { type: 'חיסכון לכל ילד',    path: '/api/funds/חיסכון-לכל-ילד' },
];

// מטמון בזיכרון. נשמר כל עוד מופע הפונקציה "חם"; בנוסף מוגדרות כותרות מטמון כדי שגם ה-CDN של Netlify ישמור.
const cache = globalThis.__stressCache || (globalThis.__stressCache = new Map());

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value); // הוצאת הרשומה הוותיקה ביותר
  }
  cache.set(key, { value, expires: Date.now() + ttl });
}

async function fetchWithTimeout(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'he-IL,he;q=0.9' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// מוודא שכתובת שהתקבלה מהחיפוש אכן מפנה ל-mygemel.net (הגנת SSRF).
function safeFundUrl(raw) {
  try {
    const url = new URL(raw, BASE_URL);
    if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// הטקסט בתוצאות החיפוש נראה כך: "כלל השתלמות כללי (456)" או בפנסיה "שם (513621110 - 14049)".
export function matchesCode(text, code) {
  const m = /\(([^()]*)\)\s*$/.exec(text || '');
  if (!m) return false;
  return m[1].split('-').map((s) => s.trim()).pop() === code;
}

async function searchEndpoint(endpoint, code) {
  const url = `${BASE_URL}${encodeURI(endpoint.path)}?q=${encodeURIComponent(code)}`;
  const res = await fetchWithTimeout(url, 'application/json');
  const data = await res.json();
  const hit = (data.results || []).find((r) => matchesCode(r.text, code));
  if (!hit) return null;
  const pageUrl = safeFundUrl(hit.id);
  return pageUrl ? { type: endpoint.type, url: pageUrl } : null;
}

async function findFundPage(code) {
  const results = await Promise.allSettled(SEARCH_ENDPOINTS.map((ep) => searchEndpoint(ep, code)));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  if (results.every((r) => r.status === 'rejected')) {
    throw new Error('Source site unreachable');
  }
  return null;
}

function parsePercent(text) {
  const n = parseFloat(String(text).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// אוסף את כל זוגות "תווית: ערך" מתוך רשימה שמופיעה אחרי כותרת h2 מסוימת.
function readSection($, headingText) {
  const items = [];
  $('h2').each((_, h2) => {
    if (!$(h2).text().includes(headingText)) return;
    $(h2).nextAll('ul').first().find('li').each((__, li) => {
      const spans = $(li).find('span');
      if (spans.length < 2) return;
      const label = $(spans[0]).text().replace(/[:\s]+$/, '').trim();
      const value = $(spans[spans.length - 1]).text().trim();
      items.push({ label, value });
    });
  });
  return items;
}

const BOND_LABEL = /אג["״]?ח|אגרות חוב/;
const EQUITY_LABEL = /מניות|מנייתי/;

export function parseFundPage(html) {
  const $ = cheerio.load(html);

  const name = $('h1.entry-title').first().text().trim() || $('h1').first().text().trim();
  const exposures = readSection($, 'היקף נכסים וחשיפות');
  const composition = readSection($, 'פירוט הרכב הנכסים');

  // מניות: עדיף הנתון "סך חשיפה למניות" (כולל נגזרים); אחרת – סכום שורות המניות בהרכב הנכסים.
  const totalEquity = exposures.find((i) => i.label.includes('חשיפה למניות'));
  let equity = totalEquity ? parsePercent(totalEquity.value) : null;
  if (equity === null) {
    const rows = composition.filter((i) => EQUITY_LABEL.test(i.label));
    if (rows.length) equity = rows.reduce((s, i) => s + (parsePercent(i.value) || 0), 0);
  }

  // אג"ח: סכום כל שורות האג"ח בהרכב הנכסים (ממשלתי, קונצרני סחיר ולא סחיר).
  const bondRows = composition.filter((i) => BOND_LABEL.test(i.label) && !EQUITY_LABEL.test(i.label));
  const bonds = bondRows.length ? bondRows.reduce((s, i) => s + (parsePercent(i.value) || 0), 0) : null;

  const dataDate = $('time.entry-date').attr('datetime') || null;

  return {
    name,
    equityPct: equity === null ? null : Math.round(equity * 100) / 100,
    bondPct: bonds === null ? null : Math.round(bonds * 100) / 100,
    bondBreakdown: bondRows.map((i) => ({ label: i.label, pct: parsePercent(i.value) })),
    dataDate,
  };
}

async function scrapeFund(code) {
  const found = await findFundPage(code);
  if (!found) return null;

  const res = await fetchWithTimeout(found.url, 'text/html');
  const parsed = parseFundPage(await res.text());
  if (!parsed.name || parsed.equityPct === null) {
    throw new Error('Unexpected page structure');
  }

  return {
    code,
    name: parsed.name,
    productType: found.type,
    equityPct: parsed.equityPct,
    bondPct: parsed.bondPct ?? 0,
    bondBreakdown: parsed.bondBreakdown,
    dataDate: parsed.dataDate,
    sourceUrl: found.url,
    scrapedAt: new Date().toISOString(),
  };
}

function json(status, body, req, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
  // ברירת מחדל: אותו דומיין בלבד. להתרת דומיין נוסף – משתנה סביבה ALLOWED_ORIGIN.
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.get('origin') === allowed) {
    headers['Access-Control-Allow-Origin'] = allowed;
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Vary'] = 'Origin';
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

// שמירה ב-CDN של Netlify ל-24 שעות, כאשר מפתח המטמון הוא רק הפרמטר code.
const CDN_CACHE = {
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=86400, stale-while-revalidate=3600',
  'Netlify-Vary': 'query=code',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return json(204, null, req);
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, req);

  const code = (new URL(req.url).searchParams.get('code') || '').trim();
  if (!/^\d{1,7}$/.test(code)) {
    return json(400, { error: 'יש להזין מספר מסלול (קוד אוצר) בספרות בלבד.' }, req);
  }

  const cached = cacheGet(code);
  if (cached) {
    if (cached.notFound) {
      return json(404, { error: `לא נמצא מסלול עם המספר ${code}.` }, req, { 'X-Cache': 'HIT' });
    }
    return json(200, { ...cached, cached: true }, req, { ...CDN_CACHE, 'X-Cache': 'HIT' });
  }

  try {
    const data = await scrapeFund(code);
    if (!data) {
      cacheSet(code, { notFound: true }, NOT_FOUND_TTL_MS);
      return json(404, { error: `לא נמצא מסלול עם המספר ${code}.` }, req);
    }
    cacheSet(code, data, TTL_MS);
    return json(200, { ...data, cached: false }, req, { ...CDN_CACHE, 'X-Cache': 'MISS' });
  } catch (err) {
    console.error(`[scraper] code=${code}:`, err.message);
    return json(502, { error: 'לא ניתן לשלוף את הנתונים כרגע. אנא נסו שוב בעוד מספר דקות.' }, req);
  }
}

// הכתובת שה-Frontend פונה אליה
export const config = { path: '/api/scraper' };
