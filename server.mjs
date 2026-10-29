import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const USER_AGENT = 'Hekomi/1.0 (personal manga discovery; respects robots.txt)';
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/png', '.webmanifest':'application/manifest+json; charset=utf-8' };
const rate = new Map();
const require = createRequire(import.meta.url);
const axios = require('axios');
const { Batoto, MangaBuddy, Mangakakalot } = require('mangascrape');
axios.defaults.headers.common['User-Agent'] = USER_AGENT;
axios.defaults.headers.common['Accept'] = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
// Do not follow source redirects without re-checking the destination host and its robots rules.
axios.defaults.maxRedirects = 0;
const mangaScrapeAdapters = {
  batoto: new Batoto({ baseUrl:'https://fto.to', cache:false }),
  mangabuddy: new MangaBuddy({ cache:false }),
  mangakakalot: new Mangakakalot({ cache:false }),
  // Manga Hook exposes a documented JSON API; its adapter is handled below.
  mangahook: { cache:false }
};
const MANGAHOOK_API_BASE = 'https://mangahook-api.vercel.app';
const mangaScrapeRobotsCache = new Map();
const mangaScrapeFeedCache = new Map();
const mangaScrapeLastRequest = new Map();
const MANGASCRAPE_SOURCES = {
  batoto: { label:'Bato network', origin:'https://fto.to', allowedHosts:['fto.to'] },
  mangabuddy: { label:'MangaBuddy', origin:'https://mangabuddy.com', allowedHosts:['mangabuddy.com'] },
  mangakakalot: { label:'Mangakakalot', origin:'https://mangakakalot.com', allowedHosts:['mangakakalot.com','chapmanganato.to'] },
  mangahook: { label:'Manga Hook API', origin:MANGAHOOK_API_BASE, allowedHosts:['mangahook-api.vercel.app'] }
};

function send(res, status, payload, headers={}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers });
  res.end(body);
}
function readBody(req, maxBytes=24_000) {
  return new Promise((resolve, reject) => {
    let data='';
    req.on('data', chunk => { data += chunk; if (data.length > maxBytes) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function isPrivateIPv4(ip) {
  const a = ip.split('.').map(Number); if (a.length !== 4 || a.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
    (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && a[1] === 168) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 192 && a[1] === 0) || (a[0] === 198 && (a[1] === 18 || a[1] === 19));
}
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  return s === '::' || s === '::1' || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('ff') || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.');
}
async function validatePublicUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error('Enter a valid website URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS websites are supported.');
  if (u.username || u.password) throw new Error('URLs containing usernames or passwords are not supported.');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Local and private network addresses cannot be crawled.');
  if (net.isIP(host)) {
    if (net.isIPv4(host) ? isPrivateIPv4(host) : isPrivateIPv6(host)) throw new Error('Private or reserved IP addresses cannot be crawled.');
  } else {
    let results; try { results = await dns.lookup(host, { all:true, verbatim:true }); } catch { throw new Error('The website hostname could not be resolved.'); }
    if (!results.length || results.some(r => net.isIPv4(r.address) ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address))) throw new Error('The hostname resolves to a private or reserved address, so it was blocked.');
  }
  u.hash = '';
  return u;
}
async function fetchLimited(url, maxRedirects=4, maxBytes=2_000_000) {
  let current = await validatePublicUrl(url);
  for (let i=0; i<=maxRedirects; i++) {
    const response = await fetch(current, { method:'GET', redirect:'manual', signal:AbortSignal.timeout(12000), headers:{ 'User-Agent':USER_AGENT, 'Accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
    if ([301,302,303,307,308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc || i === maxRedirects) throw new Error('Too many or invalid redirects.');
      current = await validatePublicUrl(new URL(loc, current).href); continue;
    }
    if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error('This URL did not return an HTML page.');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('Page is too large to inspect safely.');
    const reader = response.body.getReader(); const chunks=[]; let size=0;
    while (true) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>maxBytes){reader.cancel();throw new Error('Page exceeded the 2 MB inspection limit.');} chunks.push(value); }
    return { url:current.href, html:new TextDecoder('utf-8').decode(Buffer.concat(chunks)) };
  }
  throw new Error('Could not follow website redirects.');
}
function decodeEntities(s='') {
  return s.replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function cleanText(s='') { return decodeEntities(s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\\u[\da-f]{4}/gi,' ')).replace(/\s+/g,' ').trim(); }
function attr(tag, name) { const re = new RegExp("(?:^|\\s)"+name+"\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i"); const m=tag.match(re); return m ? decodeEntities(m[2]).trim() : ''; }
function meta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const t of tags) { const k=attr(t,'property') || attr(t,'name') || attr(t,'itemprop'); if (k.toLowerCase()===key.toLowerCase()) return attr(t,'content'); }
  return '';
}
function robotsAllowed(url, robotsText) {
  // Practical robots.txt parser: honor wildcard user-agent group and our declared crawler name.
  let groups=[], group={agents:[],rules:[]};
  for (const line of robotsText.split(/\r?\n/)) {
    const clean=line.split('#')[0].trim(); if(!clean) continue;
    const m=clean.match(/^([^:]+):\s*(.*)$/); if(!m) continue;
    const key=m[1].trim().toLowerCase(), val=m[2].trim();
    if(key==='user-agent') { if(group.rules.length) { groups.push(group); group={agents:[],rules:[]}; } group.agents.push(val.toLowerCase()); }
    else if(['allow','disallow'].includes(key) && group.agents.length && val) group.rules.push({allow:key==='allow',path:val});
    else if(key==='crawl-delay' && group.agents.length) group.delay=Number(val)||0;
  }
  if(group.agents.length) groups.push(group);
  let best=groups.filter(g=>g.agents.some(a=>a!=='*' && USER_AGENT.toLowerCase().includes(a))).sort((a,b)=>Math.max(...b.agents.map(x=>x.length))-Math.max(...a.agents.map(x=>x.length)))[0];
  if(!best) best=groups.find(g=>g.agents.includes('*'));
  if(!best) return {allowed:true, delay:0};
  const pathToTest=url.pathname+url.search;
  const matches=best.rules.filter(r=>pathToTest.startsWith(r.path)).sort((a,b)=>b.path.length-a.path.length);
  if(!matches.length) return {allowed:true, delay:best.delay||0};
  return {allowed:matches[0].allow, delay:best.delay||0};
}
function mangaScrapeProvider(raw) {
  const key = String(raw || '').trim().toLowerCase();
  const source = MANGASCRAPE_SOURCES[key];
  const adapter = mangaScrapeAdapters[key];
  if (!source || !adapter) throw new Error('Choose one of the supported MangaScrape sources.');
  return { key, source, adapter };
}
function mangaScrapeQuery(raw) {
  const query = String(raw || '').normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[?#&=]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 100);
  if (query.length < 2) throw new Error('Enter a manga title with at least two characters.');
  return query;
}
function mangaScrapeId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.length > 180 || !/^[\p{L}\p{N}_-]+$/u.test(id)) {
    throw new Error('The source returned an invalid manga ID.');
  }
  return id;
}
function mangaScrapeCleanId(provider, raw) {
  let id = mangaScrapeId(raw);
  // The Manga List endpoint prefixes some IDs with "1"; the detail API expects the raw ID.
  if (provider === 'mangahook' && id.startsWith('1manga-')) id = id.slice(1);
  return id;
}
function mangaScrapeSourceKind(provider, raw) {
  if (provider !== 'mangakakalot') return '';
  return raw === 'chapmanganato' ? 'chapmanganato' : 'mangakakalot';
}
function mangaScrapeSearchUrl(provider, query) {
  if (provider === 'mangahook') return MANGAHOOK_API_BASE + '/api/search/' + encodeURIComponent(query) + '?page=1';
  if (provider === 'batoto') return 'https://fto.to/v3x-search?word=' + encodeURIComponent(query);
  if (provider === 'mangabuddy') return 'https://mangabuddy.com/search?q=' + encodeURIComponent(query);
  if (provider === 'mangakakalot') {
    const pathQuery = query.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!pathQuery) throw new Error('Use an English or numeric title for this provider search.');
    return 'https://mangakakalot.com/search/story/' + pathQuery;
  }
  throw new Error('This provider does not have a working search adapter.');
}
function mangaScrapeTitleUrl(provider, id, rawSourceKind) {
  const safeId = mangaScrapeCleanId(provider, id);
  const sourceKind = mangaScrapeSourceKind(provider, rawSourceKind);
  if (provider === 'mangahook') return 'https://ww6.mangakakalot.tv/manga/' + safeId;
  if (provider === 'batoto') return 'https://fto.to/title/' + safeId;
  if (provider === 'mangabuddy') return 'https://mangabuddy.com/' + safeId;
  if (sourceKind === 'chapmanganato') return 'https://chapmanganato.to/manga-' + safeId;
  if (provider === 'mangakakalot') return 'https://mangakakalot.com/manga/' + safeId;
  throw new Error('Choose a supported MangaScrape source.');
}
function mangaScrapeChapterUrl(provider, mangaId, chapterId, rawSourceKind) {
  const safeMangaId = mangaScrapeCleanId(provider, mangaId);
  const safeChapterId = mangaScrapeId(chapterId);
  const sourceKind = mangaScrapeSourceKind(provider, rawSourceKind);
  if (provider === 'mangahook') return 'https://ww6.mangakakalot.tv/chapter/' + safeMangaId + '/' + safeChapterId;
  if (provider === 'batoto') return 'https://fto.to/title/' + safeMangaId + '/' + safeChapterId;
  if (provider === 'mangabuddy') return 'https://mangabuddy.com/' + safeMangaId + '/' + safeChapterId;
  if (sourceKind === 'chapmanganato') return 'https://chapmanganato.to/manga-' + safeMangaId + '/' + safeChapterId;
  if (provider === 'mangakakalot') return 'https://mangakakalot.com/chapter/' + safeMangaId + '/' + safeChapterId;
  throw new Error('This provider does not expose a supported chapter URL.');
}
async async function mangaHookApiRequest(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('Invalid Manga Hook API path.');
  const target = new URL(path, MANGAHOOK_API_BASE);
  if (target.origin !== MANGAHOOK_API_BASE) throw new Error('Invalid Manga Hook API host.');
  await assertMangaScrapeAllowed(target.href);
  let response;
  try {
    response = await fetch(target.href, {
      redirect:'manual', signal:AbortSignal.timeout(10000),
      headers:{'User-Agent':USER_AGENT,'Accept':'application/json'}
    });
  } catch {
    throw new Error('Manga Hook API could not be reached. Please try again shortly.');
  }
  if (response.status >= 300 && response.status < 400) throw new Error('Manga Hook API redirected this request; it was stopped for safety.');
  if (!response.ok) throw new Error('Manga Hook API returned HTTP ' + response.status + '.');
  const body = await response.text();
  if (body.length > 8_000_000) throw new Error('Manga Hook returned an unexpectedly large response.');
  let payload;
  try { payload = JSON.parse(body); } catch { throw new Error('Manga Hook returned an invalid JSON response.'); }
  if (!payload || typeof payload !== 'object') throw new Error('Manga Hook returned an empty response.');
  return payload;
}
async function assertMangaScrapeAllowed(rawUrl) {
  const url = await validatePublicUrl(rawUrl);
  const now = Date.now();
  const last = mangaScrapeLastRequest.get(url.origin) || 0;
  const waitMs = 1400 - (now - last);
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  let cached = mangaScrapeRobotsCache.get(url.origin);
  if (!cached || now - cached.checkedAt > 10 * 60 * 1000) {
    let robots = '';
    try {
      const response = await fetch(new URL('/robots.txt', url.origin), {
        redirect:'manual', signal:AbortSignal.timeout(5000),
        headers:{'User-Agent':USER_AGENT,'Accept':'text/plain'}
      });
      if (response.ok) robots = (await response.text()).slice(0, 200000);
      else if (response.status !== 404 && response.status !== 410) {
        throw new Error('robots.txt could not be checked (HTTP ' + response.status + '); this source was not requested.');
      }
      cached = { text:robots, checkedAt:Date.now() };
      mangaScrapeRobotsCache.set(url.origin, cached);
    } catch (error) {
      if (error && error.message && error.message.includes('robots.txt could not be checked')) throw error;
      throw new Error('Could not verify robots.txt for this source, so the request was stopped.');
    }
  }
  const rule = robotsAllowed(url, cached.text);
  if (!rule.allowed) throw new Error('This page is disallowed by the source robots.txt rules.');
  if (rule.delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(rule.delay, 10) * 1000));
  mangaScrapeLastRequest.set(url.origin, Date.now());
  return url;
}
function mangaScrapeSafeAsset(raw) {
  try {
    const url = new URL(String(raw || ''));
    return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function mangaScrapeTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string' ? item : String(item && item.name || '')).map(item => item.trim()).filter(Boolean).slice(0, 30);
}
function mangaScrapeTitleText(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.original || value.english || value.romaji || value.title || '').trim();
  return '';
}
function mangaScrapeNormalizeSearch(provider, item) {
  if (!item || typeof item !== 'object') return null;
  let id;
  try { id = mangaScrapeCleanId(provider, item.id); } catch { return null; }
  const sourceKind = mangaScrapeSourceKind(provider, item.source);
  const title = mangaScrapeTitleText(item.title || item.name) || 'Untitled manga';
  const chapter = item.lastChapter || (Array.isArray(item.lastChapters) ? item.lastChapters[0] : null) || {};
  return {
    id, provider, sourceKind, title,
    url: mangaScrapeTitleUrl(provider, id, sourceKind),
    cover: mangaScrapeSafeAsset(item.poster || item.cover || item.image || ''),
    description: String(item.description || item.summary || '').replace(/\s+/g, ' ').trim().slice(0, 1400),
    genres: mangaScrapeTextList(item.genres),
    authors: mangaScrapeTextList(item.authors || (item.author ? [item.author] : [])),
    status: String(item.status || ''),
    score: Number(item.score || item.rating) || 0,
    mature: Boolean(item.mature),
    lastUpdate: String(item.lastUpdate || item.update || ''),
    latestChapter: String(chapter.title || chapter.name || ''),
    latestChapterId: String(chapter.id || ''),
    source: String(provider)
  };
}
function mangaScrapeNormalizeDetails(provider, id, rawSourceKind, item) {
  if (!item || typeof item !== 'object') throw new Error('The provider did not return manga details.');
  const safeId = mangaScrapeCleanId(provider, item.id || id);
  const sourceKind = mangaScrapeSourceKind(provider, rawSourceKind || item.source);
  const title = mangaScrapeTitleText(item.title || item.name) || 'Untitled manga';
  const rawChapters = provider === 'mangahook' ? item.chapterList : item.chapters;
  const chapters = (Array.isArray(rawChapters) ? rawChapters : []).slice(0, 300).map(chapter => {
    let chapterId = '';
    try { chapterId = mangaScrapeId(chapter && chapter.id); } catch { return null; }
    return {
      id: chapterId,
      title: String(chapter.title || chapter.name || ('Chapter ' + chapterId)).replace(/\s+/g, ' ').trim().slice(0, 240),
      url: mangaScrapeChapterUrl(provider, safeId, chapterId, sourceKind),
      readerProvider: provider === 'mangahook' ? 'mangahook' : '',
      update: String(chapter.update || chapter.createdAt || chapter.date || (chapter.timestamp ? new Date(Number(chapter.timestamp)).toISOString() : '') || ''),
      views: String(chapter.views || chapter.view || '')
    };
  }).filter(Boolean);
  return {
    id: safeId, provider, sourceKind, providerLabel: MANGASCRAPE_SOURCES[provider].label,
    title, url: mangaScrapeTitleUrl(provider, safeId, sourceKind),
    cover: mangaScrapeSafeAsset(item.poster || item.cover || item.image || item.imageUrl || ''),
    description: String(item.description || item.summary || '').replace(/\s+/g, ' ').trim().slice(0, 12000),
    genres: mangaScrapeTextList(item.genres),
    authors: mangaScrapeTextList(item.authors || (item.author ? [item.author] : [])),
    artists: mangaScrapeTextList(item.artists),
    status: String(item.status || ''),
    score: Number((item.rating && item.rating.average) || item.rating || item.score) || 0,
    lastUpdate: String(item.lastUpdate || item.updated || item.update || ''),
    chapters
  };
}
async function getMangaScrapeProviderFeed(provider, feed) {
  const { source, adapter } = mangaScrapeProvider(provider);
  let target = source.origin + '/';
  let raw = [];
  if (provider === 'batoto') {
    target = 'https://fto.to/v3x';
    await assertMangaScrapeAllowed(target);
    const home = await adapter.home();
    raw = feed === 'latest' ? (home.latestReleases || []) : (home.popularUpdates || []);
  } else if (provider === 'mangabuddy') {
    target = source.origin + (feed === 'latest' ? '/latest' : '/popular');
    await assertMangaScrapeAllowed(target);
    raw = feed === 'latest' ? await adapter.latest() : await adapter.popular();
  } else if (provider === 'mangakakalot') {
    target = source.origin + '/';
    await assertMangaScrapeAllowed(target);
    const home = await adapter.home();
    raw = feed === 'latest' ? (home.latestUpdates || []) : (home.populars || []);
  } else if (provider === 'mangahook') {
    const type = feed === 'latest' ? 'latest' : 'topview';
    const payload = await mangaHookApiRequest('/api/mangaList?page=1&type=' + type);
    raw = Array.isArray(payload.mangaList) ? payload.mangaList : [];
  }
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 24)
    .map(item => mangaScrapeNormalizeSearch(provider, item))
    .filter(Boolean)
    .map(item => ({ ...item, providerLabel:source.label }));
}
async function loadMangaScrapeDiscovery(provider, feed, force=false) {
  const cacheKey = provider + ':' + feed;
  const cached = mangaScrapeFeedCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.cachedAt < 8 * 60 * 1000) return cached.payload;
  const providers = provider === 'all' ? Object.keys(MANGASCRAPE_SOURCES) : [provider];
  const settled = await Promise.allSettled(providers.map(key => getMangaScrapeProviderFeed(key, feed)));
  const results = [];
  const errors = [];
  settled.forEach((item,index) => {
    if (item.status === 'fulfilled') results.push(...item.value);
    else errors.push({
      provider:providers[index],
      label:MANGASCRAPE_SOURCES[providers[index]].label,
      message:String(item.reason && item.reason.message || 'This source could not be reached.')
    });
  });
  // Keep results diverse and stable, without pretending failed providers succeeded.
  const seen = new Set();
  let unique = results.filter(item => {
    const key = item.provider + ':' + item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 60);
  let fallback = false;
  // Never let an unavailable/robots-disallowed scraper take the whole discovery page down.
  // Use the public AniList catalog as a read-only discovery fallback; do not crawl blocked sources.
  if (!unique.length) {
    try {
      const catalog = await getPublicCatalog();
      const manga = Array.isArray(catalog.manga) ? catalog.manga.slice() : [];
      if (feed === 'trending') manga.sort((a,b) => (Number(b.popularity)||0) - (Number(a.popularity)||0));
      else manga.sort((a,b) => (Number(b.updatedAt)||0) - (Number(a.updatedAt)||0));
      unique = manga.slice(0, 48).map(item => ({
        id:String(item.id), provider:'catalog', providerLabel:'AniList catalog',
        title:item.title || 'Untitled manga', url:item.siteUrl || ('https://anilist.co/manga/'+Number(item.id)+'/'),
        cover:item.cover || '', description:item.description || '',
        genres:Array.isArray(item.genres)?item.genres:[], authors:[], artists:[],
        status:item.status || '', score:Number(item.averageScore)||0,
        lastUpdate:item.updatedAt ? new Date(Number(item.updatedAt)*1000).toISOString() : '',
        latestChapter:'', latestChapterId:'', source:'catalog', sourceKind:'',
        popularity:Number(item.popularity)||0, format:item.format||''
      }));
      fallback = unique.length > 0;
    } catch (error) {
      errors.push({provider:'catalog',label:'AniList catalog',message:String(error && error.message || 'Catalog fallback unavailable.')});
    }
  }
  const payload = {
    feed, provider, results:unique, errors, fallback,
    fetchedAt:new Date().toISOString(),
    notice:fallback
      ? 'Showing catalog recommendations because live source feeds are unavailable. Open a title on AniList; source restrictions were not bypassed.'
      : errors.length ? 'Some sources could not load. Available results are still shown; no source restrictions were bypassed.' : 'Chapter details open on the original source. Availability depends on each provider.'
  };
  if (unique.length || !cached) mangaScrapeFeedCache.set(cacheKey,{cachedAt:Date.now(),payload});
  return payload;
}
async function inspectWebsite(rawUrl) {
  const url=await validatePublicUrl(rawUrl);
  const hostKey=url.host;
  const now=Date.now(), last=rate.get(hostKey)||0;
  if(now-last<2500) throw new Error('Please wait a moment before inspecting this website again.');
  rate.set(hostKey,now);
  let robots='';
  try {
    const rr=await fetch(new URL('/robots.txt',url.origin), { redirect:'manual', signal:AbortSignal.timeout(5000), headers:{'User-Agent':USER_AGENT,'Accept':'text/plain'} });
    if(rr.ok) robots=(await rr.text()).slice(0,200000);
    else if(rr.status !== 404 && rr.status !== 410) throw new Error(`robots.txt could not be checked (HTTP ${rr.status}); inspection stopped out of caution.`);
  } catch(e) { if(e.message.includes('inspection stopped')) throw e; throw new Error('Could not verify robots.txt for this site, so inspection was stopped.'); }
  const rule=robotsAllowed(url,robots);
  if(!rule.allowed) throw new Error('This URL is disallowed by the website robots.txt rules.');
  if(rule.delay > 5) await new Promise(r=>setTimeout(r,Math.min(rule.delay,10)*1000));
  const {url:finalUrl,html}=await fetchLimited(url.href);
  const title=cleanText((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||meta(html,'og:title')||meta(html,'twitter:title')||new URL(finalUrl).hostname);
  const description=cleanText(meta(html,'description')||meta(html,'og:description')||meta(html,'twitter:description'));
  let image=meta(html,'og:image')||meta(html,'twitter:image')||meta(html,'og:image:url');
  if(image) { try { image=new URL(image,finalUrl).href; } catch { image=''; } }
  const links=[]; const seen=new Set(); const re=/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi; let m;
  while((m=re.exec(html)) && links.length<3000) {
    const href=decodeEntities(m[2]).trim(), text=cleanText(m[3]); if(!href||!text||href.startsWith('#')||/^(javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    let abs; try { abs=new URL(href,finalUrl); } catch { continue; }
    if(abs.origin!==new URL(finalUrl).origin || seen.has(abs.href)) continue;
    seen.add(abs.href);
    const ctx=(m[0].slice(0,300)+' '+text+' '+abs.pathname).toLowerCase();
    const chapter=/\b(chapter|ch\.?\s*\d|episode|ep\.?\s*\d|read\s+now|\bscan\b)/i.test(ctx);
    const manga=/\b(manga|manhwa|manhua|comic|series|title|book|webtoon)\b/i.test(ctx) || /\/(manga|manhwa|manhua|series|title|comic|webtoon)\//i.test(abs.pathname);
    if(chapter||manga) links.push({title:text.slice(0,140),url:abs.href,type:chapter?'chapter':'manga'});
  }
  const mangaLinks=links.filter(x=>x.type==='manga').slice(0,80);
  const chapterLinks=links.filter(x=>x.type==='chapter').slice(0,120);
  return {url:finalUrl,title,description,image,mangaLinks,chapterLinks,checkedAt:new Date().toISOString(),notice:'Generic extraction is heuristic. Some sites need a dedicated source adapter; only publicly accessible pages permitted by the site rules are inspected.'};
}

async function searchMangaWebsites(rawQuery) {
  const query=String(rawQuery||'').trim().slice(0,160);
  if(query.length<2) throw new Error('Enter a manga title or search phrase.');
  // Search for public source pages; this does not crawl result sites until the user chooses one.
  const q=`${query} manga manhwa read chapters`;
  const endpoint='https://html.duckduckgo.com/html/?q='+encodeURIComponent(q);
  let response, html='';
  try {
    response=await fetch(endpoint,{redirect:'follow',signal:AbortSignal.timeout(12000),headers:{'User-Agent':USER_AGENT,'Accept':'text/html,application/xhtml+xml'}});
    if(!response.ok) throw new Error(`Web search returned HTTP ${response.status}.`);
    html=(await response.text()).slice(0,2_000_000);
  } catch {
    const encoded=encodeURIComponent(q);
    return {query,results:[
      {title:'Search the web with DuckDuckGo',url:`https://duckduckgo.com/?q=${encoded}`,origin:'https://duckduckgo.com',domain:'duckduckgo.com',snippet:'Open search results, then copy a public manga or chapter URL into Hekomi.',searchPage:true},
      {title:'Search the web with Bing',url:`https://www.bing.com/search?q=${encoded}`,origin:'https://www.bing.com',domain:'bing.com',snippet:'Alternative search provider if direct result retrieval is unavailable.',searchPage:true},
      {title:'Search the web with Google',url:`https://www.google.com/search?q=${encoded}`,origin:'https://www.google.com',domain:'google.com',snippet:'Alternative search provider. Paste a chosen public result URL into Hekomi to inspect it.',searchPage:true}
    ],notice:'Direct search retrieval is unavailable from this server right now. Open a search provider, then paste a chosen public result URL into the crawler.'};
  }
  const results=[],seen=new Set();
  const re=/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(html))&&results.length<12){
    let href=decodeEntities(m[1]);
    try {
      if(href.startsWith('//')) href='https:'+href;
      const parsed=new URL(href);
      if(parsed.hostname.includes('duckduckgo.com')&&parsed.searchParams.has('uddg')) href=parsed.searchParams.get('uddg');
      const u=await validatePublicUrl(href);
      if(seen.has(u.origin)||/duckduckgo\.com$/i.test(u.hostname)) continue;
      seen.add(u.origin);
      const title=cleanText(m[2])||u.hostname;
      const snippetMatch=html.slice(Math.max(0,m.index-100),Math.min(html.length,m.index+1800)).match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
      results.push({title:title.slice(0,180),url:u.href,origin:u.origin,domain:u.hostname,snippet:snippetMatch?cleanText(snippetMatch[1]).slice(0,300):'Search result for manga or manhwa.'});
    } catch {}
  }
  if(!results.length) throw new Error('The web search returned no readable results. Try a different title or use a website URL directly.');
  return {query,results,notice:'Search results are suggestions, not endorsements. Choose a result to inspect its public page; source restrictions are checked before crawling.'};
}

async function extractChapterImages(rawUrl) {
  const url=await validatePublicUrl(rawUrl);
  const hostKey=url.host, now=Date.now(), last=rate.get(hostKey)||0;
  if(now-last<2500) throw new Error('Please wait a moment before loading another chapter from this website.');
  rate.set(hostKey,now);
  let robots='';
  try { const rr=await fetch(new URL('/robots.txt',url.origin),{redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'User-Agent':USER_AGENT,'Accept':'text/plain'}}); if(rr.ok) robots=(await rr.text()).slice(0,200000); else if(rr.status!==404&&rr.status!==410) throw new Error(`robots.txt could not be checked (HTTP ${rr.status}).`); }
  catch(e){ if(e.message.includes('robots.txt')) throw e; throw new Error('Could not verify robots.txt; chapter extraction stopped.'); }
  if(!robotsAllowed(url,robots).allowed) throw new Error('This chapter URL is disallowed by robots.txt.');
  const {url:finalUrl,html}=await fetchLimited(url.href,4,4_000_000);
  const found=[], seen=new Set();
  const tags=html.match(/<(?:img|source)\b[^>]*>/gi)||[];
  for(const tag of tags){
    let src=attr(tag,'src')||attr(tag,'data-src')||attr(tag,'data-lazy-src')||attr(tag,'data-original')||attr(tag,'data-url')||attr(tag,'srcset');
    if(!src) continue;
    if(src.includes(',')) src=src.split(',')[0].trim().split(/\s+/)[0];
    try { const u=new URL(src,finalUrl); if(!['http:','https:'].includes(u.protocol)||seen.has(u.href)) continue; seen.add(u.href);
      const info=(attr(tag,'alt')+' '+attr(tag,'class')+' '+attr(tag,'id')+' '+u.pathname).toLowerCase();
      if(/logo|avatar|icon|banner|advert|adsense|profile/.test(info)) continue;
      found.push({url:u.href,alt:attr(tag,'alt')||'',width:Number(attr(tag,'width'))||0,height:Number(attr(tag,'height'))||0});
    }catch{}
  }
  // Manga pages are often lazy-loaded with data attributes or embedded JSON.
  const jsonImages=html.match(/(?:https?:\\?\/\\?\/[^"'\\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?)/gi)||[];
  for(let raw of jsonImages){raw=raw.replace(/\\\//g,'/').replace(/\\u0026/g,'&');try{const u=new URL(raw,finalUrl);if(!seen.has(u.href)){seen.add(u.href);found.push({url:u.href,alt:'',width:0,height:0});}}catch{}}
  const filtered=found.filter(x=>/\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/i.test(x.url)||/chapter|page|image|uploads|manga|comic/i.test(x.url));
  if(!filtered.length) throw new Error('No chapter page images were detected. This site may use JavaScript rendering or protected image delivery; a dedicated adapter may be needed.');
  return {url:finalUrl,title:cleanText((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'Chapter'),images:filtered.slice(0,250),notice:'Images are extracted from the publicly accessible chapter HTML. Site restrictions are respected; protected or script-only images may not be available.'};
}


const MAL_SESSION_COOKIE = 'folio_mal_session';
const MAL_FLOW_COOKIE = 'folio_mal_oauth';
const SESSION_SECRET = process.env.FOLIO_SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('base64url'));

function malAuthConfigured() {
  return Boolean(process.env.MAL_CLIENT_ID && process.env.MAL_CLIENT_SECRET && SESSION_SECRET);
}
function sessionKey() {
  if (!SESSION_SECRET) throw new Error('Hekomi MAL sign-in has not been configured by the app maintainer.');
  return crypto.createHash('sha256').update(SESSION_SECRET).digest();
}
function sealJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function unsealJson(value) {
  try {
    const raw = Buffer.from(String(value || ''), 'base64url');
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
  } catch { return null; }
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}
function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function cookieHeader(req, name, value, maxAge) {
  return name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (isSecureRequest(req) ? '; Secure' : '');
}
function clearMalCookies(req, res) {
  res.setHeader('Set-Cookie', [
    cookieHeader(req, MAL_SESSION_COOKIE, '', 0),
    cookieHeader(req, MAL_FLOW_COOKIE, '', 0)
  ]);
}
function getMalRedirectUri(req) {
  const configured = String(process.env.MAL_REDIRECT_URI || '').trim();
  if (configured) return configured;
  const renderUrl = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (renderUrl) return renderUrl + '/api/mal/auth/callback';
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || ('localhost:' + PORT);
  return proto + '://' + host + '/api/mal/auth/callback';
}
function redirect(res, location, status=303) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}
async function postMalToken(form) {
  const response = await fetch('https://myanimelist.net/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: form,
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.message || ('MAL token exchange failed (' + response.status + ').'));
  return data;
}
async function refreshMalSession(req, res, session) {
  if (session && session.accessToken && Number(session.expiresAt || 0) > Date.now() + 60000) return session;
  if (!session || !session.refreshToken || !malAuthConfigured()) return null;
  try {
    const form = new URLSearchParams({
      client_id: process.env.MAL_CLIENT_ID,
      client_secret: process.env.MAL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken
    });
    const token = await postMalToken(form);
    const updated = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || session.refreshToken,
      expiresAt: Date.now() + (Number(token.expires_in) || 2592000) * 1000,
      username: session.username || ''
    };
    res.setHeader('Set-Cookie', cookieHeader(req, MAL_SESSION_COOKIE, sealJson(updated), 60 * 60 * 24 * 180));
    return updated;
  } catch (error) {
    console.warn('MAL token refresh failed:', error.message);
    res.setHeader('Set-Cookie', cookieHeader(req, MAL_SESSION_COOKIE, '', 0));
    return null;
  }
}
async function getMalSession(req, res) {
  const initial = unsealJson(readCookie(req, MAL_SESSION_COOKIE));
  return refreshMalSession(req, res, initial);
}
async function malAuthStatus(req, res) {
  let session = null;
  if (malAuthConfigured()) session = await getMalSession(req, res);
  return send(res, 200, {
    configured: malAuthConfigured(),
    connected: Boolean(session && session.accessToken),
    username: session ? session.username || '' : ''
  });
}
async function startMalAuth(req, res) {
  if (!malAuthConfigured()) return send(res, 503, { error: 'Hekomi MAL sign-in is not configured yet. The app maintainer must add MAL_CLIENT_ID, MAL_CLIENT_SECRET, and FOLIO_SESSION_SECRET to the server environment.' });
  const state = crypto.randomBytes(24).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const redirectUri = getMalRedirectUri(req);
  const flow = { state, verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 };
  const authorize = new URL('https://myanimelist.net/v1/oauth2/authorize');
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.MAL_CLIENT_ID,
    code_challenge: verifier,
    code_challenge_method: 'plain',
    state,
    redirect_uri: redirectUri
  }).toString();
  res.setHeader('Set-Cookie', cookieHeader(req, MAL_FLOW_COOKIE, sealJson(flow), 600));
  redirect(res, authorize.toString(), 302);
}
async function completeMalAuth(req, res, query) {
  const flow = unsealJson(readCookie(req, MAL_FLOW_COOKIE));
  const state = query.get('state') || '';
  const code = query.get('code') || '';
  if (!malAuthConfigured() || query.get('error') || !flow || !state || state !== flow.state || Date.now() > Number(flow.expiresAt || 0) || !code) {
    res.setHeader('Set-Cookie', cookieHeader(req, MAL_FLOW_COOKIE, '', 0));
    console.warn('MAL OAuth callback rejected: configuration, code, state, or expiry check failed.');
    return redirect(res, '/?mal=error');
  }
  try {
    const form = new URLSearchParams({
      client_id: process.env.MAL_CLIENT_ID,
      client_secret: process.env.MAL_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri
    });
    const token = await postMalToken(form);
    let username = '';
    try {
      const profile = await fetch('https://api.myanimelist.net/v2/users/@me', {
        headers: { 'X-MAL-CLIENT-ID': process.env.MAL_CLIENT_ID, Authorization: 'Bearer ' + token.access_token, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (profile.ok) {
        const data = await profile.json();
        username = String(data.name || '');
      }
    } catch {}
    const session = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || '',
      expiresAt: Date.now() + (Number(token.expires_in) || 2592000) * 1000,
      username
    };
    res.setHeader('Set-Cookie', [
      cookieHeader(req, MAL_SESSION_COOKIE, sealJson(session), 60 * 60 * 24 * 180),
      cookieHeader(req, MAL_FLOW_COOKIE, '', 0)
    ]);
    return redirect(res, '/?mal=connected');
  } catch (error) {
    console.error('MAL OAuth token exchange failed:', error.message);
    res.setHeader('Set-Cookie', cookieHeader(req, MAL_FLOW_COOKIE, '', 0));
    return redirect(res, '/?mal=error');
  }
}
async function malLogout(req, res) {
  clearMalCookies(req, res);
  return send(res, 200, { ok: true });
}
async function malRequest(req, res, pathname, query) {
  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) return send(res, 503, { error: 'MAL catalog search is not configured by the Hekomi maintainer yet.' });
  if (!['/search','/details','/me','/list','/update'].includes(pathname)) return send(res,404,{error:'Unknown MAL endpoint.'});
  let session = null;
  if (!['/search','/details'].includes(pathname)) {
    session = await getMalSession(req, res);
    if (!session || !session.accessToken) return send(res,401,{error:'Sign in with MyAnimeList first.'});
  }
  let apiPath = '';
  let method = 'GET';
  let body;
  const animeFields='alternative_titles,synopsis,mean,rank,popularity,num_list_users,num_scoring_users,genres,num_episodes,media_type,main_picture,start_date,end_date,status,start_season,broadcast,source,average_episode_duration,rating,studios,updated_at';
  if (pathname === '/search') apiPath='/anime?q='+encodeURIComponent(query.get('q')||'')+'&limit=10&fields='+animeFields;
  if (pathname === '/details') { const id=Number(query.get('id')); if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'A valid anime ID is required.'}); apiPath='/anime/'+id+'?fields='+animeFields; }
  if (pathname === '/me') apiPath='/users/@me';
  if (pathname === '/list') apiPath='/users/@me/animelist?limit=100&fields=list_status,alternative_titles,synopsis,mean,rank,popularity,num_list_users,num_scoring_users,genres,num_episodes,media_type,main_picture,start_date,end_date,status,start_season,broadcast,source,average_episode_duration,rating,studios,updated_at';
  if (pathname === '/update') {
    const data = await readBody(req);
    if (!Number.isInteger(Number(data.id))) return send(res,400,{error:'A valid anime ID is required.'});
    apiPath='/anime/'+Number(data.id)+'/my_list_status'; method='PATCH';
    const form=new URLSearchParams();
    for(const k of ['status','score','num_watched_episodes']) if(data[k]!==undefined && data[k]!==null && data[k]!=='') form.set(k,String(data[k]));
    body=form;
  }
  const headers = { 'X-MAL-CLIENT-ID': clientId, Accept: 'application/json' };
  if (session) headers.Authorization = 'Bearer ' + session.accessToken;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  try {
    const r = await fetch('https://api.myanimelist.net/v2' + apiPath, { method, headers, body, signal: AbortSignal.timeout(12000) });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { message: txt.slice(0, 500) }; }
    return send(res, r.status, data);
  } catch (e) {
    return send(res, 502, { error: 'Could not reach the MyAnimeList API: ' + e.message });
  }
}


const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const MEDIA_CATALOG_FIELDS = 'id idMal type title { romaji english native } coverImage { color extraLarge large medium } bannerImage description(asHtml:false) genres averageScore popularity favourites status episodes chapters volumes season seasonYear format countryOfOrigin source duration startDate { year month day } endDate { year month day } studios(isMain:true) { nodes { name } } nextAiringEpisode { airingAt timeUntilAiring episode } trailer { id site thumbnail } siteUrl updatedAt isLicensed isAdult';
const HOME_CATALOG_QUERY = 'query HekomiHomeCatalog($season:MediaSeason!,$seasonYear:Int!) { anime: Page(page:1,perPage:10) { media(type:ANIME,sort:[TRENDING_DESC,POPULARITY_DESC],isAdult:false) { ' + MEDIA_CATALOG_FIELDS + ' } } manga: Page(page:1,perPage:10) { media(type:MANGA,sort:[TRENDING_DESC,POPULARITY_DESC],isAdult:false) { ' + MEDIA_CATALOG_FIELDS + ' } } airing: Page(page:1,perPage:10) { media(type:ANIME,status:RELEASING,sort:[POPULARITY_DESC],isAdult:false) { ' + MEDIA_CATALOG_FIELDS + ' } } seasonal: Page(page:1,perPage:10) { media(type:ANIME,season:$season,seasonYear:$seasonYear,sort:[POPULARITY_DESC],isAdult:false) { ' + MEDIA_CATALOG_FIELDS + ' } } }';
function currentAnimeSeason(date=new Date()) { const month=date.getUTCMonth()+1; return month<=3?'WINTER':month<=6?'SPRING':month<=9?'SUMMER':'FALL'; }
const SEASON_CATALOG_QUERY = 'query HekomiSeasonCatalog($season:MediaSeason!,$seasonYear:Int!) { seasonal: Page(page:1,perPage:18) { media(type:ANIME,season:$season,seasonYear:$seasonYear,sort:[POPULARITY_DESC],isAdult:false) { ' + MEDIA_CATALOG_FIELDS + ' } } }';
const seasonCatalogCache = new Map();
const CATALOG_SEARCH_QUERY = 'query HekomiCatalogSearch($search:String!,$page:Int!) { anime: Page(page:$page,perPage:24) { pageInfo { currentPage hasNextPage } media(search:$search,type:ANIME,sort:[SEARCH_MATCH],isAdult:false) { ' + MEDIA_CATALOG_FIELDS + ' } } manga: Page(page:$page,perPage:24) { pageInfo { currentPage hasNextPage } media(search:$search,type:MANGA,sort:[SEARCH_MATCH],isAdult:false) { ' + MEDIA_CATALOG_FIELDS + ' } } }';
const MEDIA_DETAIL_QUERY = 'query HekomiMediaDetail($id:Int!) { Media(id:$id) { ' + MEDIA_CATALOG_FIELDS + ' } }';
const publicCatalogCache = { data:null, expiresAt:0 };
const publicCatalogSearchCache = new Map();
const mediaDetailCache = new Map();
let publicCatalogInFlight = null;

function htmlEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function mediaSlug(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,90) || 'series';
}
function publicOrigin(req) {
  const configured = String(process.env.HEKOMI_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (configured) {
    try { const parsed = new URL(configured); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.origin; } catch {}
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT)).split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim().toLowerCase();
  try { return new URL((proto === 'https' ? 'https://' : 'http://') + host).origin; }
  catch { return 'http://localhost:' + PORT; }
}
async function requestAniList(query, variables={}) {
  const response = await fetch(ANILIST_ENDPOINT, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({query,variables}),
    signal:AbortSignal.timeout(12000)
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('The catalog source returned an unreadable response.'); }
  if (!response.ok || payload.errors || !payload.data) {
    const message = payload.errors && payload.errors[0] && payload.errors[0].message;
    throw new Error(message || ('The catalog source returned HTTP ' + response.status + '.'));
  }
  return payload.data;
}
function packMedia(item) {
  if (!item || item.isAdult) return null;
  const title = item.title && (item.title.english || item.title.romaji || item.title.native) || 'Untitled';
  const cover = item.coverImage && (item.coverImage.extraLarge || item.coverImage.large || item.coverImage.medium) || '';
  const studios = item.studios && Array.isArray(item.studios.nodes) ? item.studios.nodes.map(studio=>studio&&studio.name).filter(Boolean) : [];
  const nextAiringEpisode = item.nextAiringEpisode ? {
    episode:Number(item.nextAiringEpisode.episode)||null,
    airingAt:Number(item.nextAiringEpisode.airingAt)||null,
    timeUntilAiring:Number(item.nextAiringEpisode.timeUntilAiring)||null
  } : null;
  const trailer = item.trailer ? {id:item.trailer.id||'',site:item.trailer.site||'',thumbnail:item.trailer.thumbnail||''} : null;
  return {
    id:Number(item.id), idMal:item.idMal || null, type:item.type || '',
    accentColor:item.coverImage && item.coverImage.color || '',
    title,titleEnglish:item.title && item.title.english || '',
    titleRomaji:item.title && item.title.romaji || '',
    titleNative:item.title && item.title.native || '',
    cover:cover, bannerImage:item.bannerImage || '',
    description:cleanText(item.description || '').slice(0,3500),
    genres:Array.isArray(item.genres)?item.genres.slice(0,8):[],
    averageScore:Number(item.averageScore)||0,popularity:Number(item.popularity)||0,
    favourites:Number(item.favourites)||0,
    status:item.status||'',episodes:item.episodes||null,chapters:item.chapters||null,
    volumes:item.volumes||null,season:item.season||'',seasonYear:item.seasonYear||(item.startDate&&item.startDate.year)||null,
    format:item.format||'',countryOfOrigin:item.countryOfOrigin||'',source:item.source||'',
    duration:Number(item.duration)||null,studios,nextAiringEpisode,trailer,
    siteUrl:item.siteUrl||'',isLicensed:!!item.isLicensed,isAdult:false,
    startDate:item.startDate||null,endDate:item.endDate||null,updatedAt:Number(item.updatedAt)||null
  };
}
async function getPublicCatalog(force=false) {
  if (!force && publicCatalogCache.data && Date.now() < publicCatalogCache.expiresAt) return publicCatalogCache.data;
  if (publicCatalogInFlight) return publicCatalogInFlight;
  publicCatalogInFlight = (async()=>{
    try {
      const now = new Date();
      const data = await requestAniList(HOME_CATALOG_QUERY,{season:currentAnimeSeason(now),seasonYear:now.getUTCFullYear()});
      const result = {
        anime:(data.anime && data.anime.media || []).map(packMedia).filter(Boolean),
        manga:(data.manga && data.manga.media || []).map(packMedia).filter(Boolean),
        airing:(data.airing && data.airing.media || []).map(packMedia).filter(Boolean),
        seasonal:(data.seasonal && data.seasonal.media || []).map(packMedia).filter(Boolean),
        season:currentAnimeSeason(now),seasonYear:now.getUTCFullYear(),
        source:'AniList',updatedAt:new Date().toISOString(),stale:false
      };
      publicCatalogCache.data = result;
      publicCatalogCache.expiresAt = Date.now() + 20*60*1000;
      return result;
    } catch (error) {
      if (publicCatalogCache.data) return {...publicCatalogCache.data,stale:true};
      throw error;
    } finally { publicCatalogInFlight = null; }
  })();
  return publicCatalogInFlight;
}
async function getSeasonCatalog(rawSeason,rawYear) {
  const season=String(rawSeason||'').toUpperCase();
  const year=Math.floor(Number(rawYear)||new Date().getUTCFullYear());
  if(!['WINTER','SPRING','SUMMER','FALL'].includes(season)) throw new Error('Choose a valid anime season.');
  if(year<1940||year>new Date().getUTCFullYear()+2) throw new Error('Choose a valid season year.');
  const key=season+':'+year, cached=seasonCatalogCache.get(key);
  if(cached&&Date.now()<cached.expiresAt)return cached.data;
  const payload=await requestAniList(SEASON_CATALOG_QUERY,{season,seasonYear:year});
  const data={season,seasonYear:year,anime:(payload.seasonal&&payload.seasonal.media||[]).map(packMedia).filter(Boolean),source:'AniList',updatedAt:new Date().toISOString()};
  seasonCatalogCache.set(key,{data,expiresAt:Date.now()+30*60*1000});
  if(seasonCatalogCache.size>24)seasonCatalogCache.delete(seasonCatalogCache.keys().next().value);
  return data;
}

async function searchPublicCatalog(rawQuery, rawPage=1) {
  const query = String(rawQuery || '').trim().replace(/\s+/g,' ').slice(0,100);
  if (query.length < 2) throw new Error('Enter at least two characters to search.');
  const page = Math.max(1,Math.min(50,Math.floor(Number(rawPage)||1)));
  const key = query.toLowerCase() + ':' + page;
  const cached = publicCatalogSearchCache.get(key);
  if (cached && Date.now() - cached.at < 10*60*1000) return cached.value;
  const data = await requestAniList(CATALOG_SEARCH_QUERY,{search:query,page});
  const animePage=data.anime||{},mangaPage=data.manga||{};
  const result = { anime:(animePage.media||[]).map(packMedia).filter(Boolean), manga:(mangaPage.media||[]).map(packMedia).filter(Boolean), page, hasNextPage:!!((animePage.pageInfo&&animePage.pageInfo.hasNextPage)||(mangaPage.pageInfo&&mangaPage.pageInfo.hasNextPage)), source:'AniList',updatedAt:new Date().toISOString() };
  publicCatalogSearchCache.set(key,{at:Date.now(),value:result});
  if (publicCatalogSearchCache.size > 160) publicCatalogSearchCache.delete(publicCatalogSearchCache.keys().next().value);
  return result;
}
async function getMediaDetail(id, expectedKind) {
  const key = String(id);
  const cached = mediaDetailCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    if (!expectedKind || String(cached.value.type).toLowerCase() === expectedKind) return cached.value;
    return null;
  }
  const data = await requestAniList(MEDIA_DETAIL_QUERY,{id:Number(id)});
  const raw = data.Media;
  if (!raw || raw.isAdult || (expectedKind && String(raw.type).toLowerCase() !== expectedKind)) return null;
  const media = packMedia(raw);
  if (media) {
    mediaDetailCache.set(key,{value:media,expiresAt:Date.now()+60*60*1000});
    if (mediaDetailCache.size > 300) mediaDetailCache.delete(mediaDetailCache.keys().next().value);
  }
  return media;
}
function sendHtml(res,status,body,headers={}) {
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'public, max-age=300, stale-while-revalidate=1800',...headers});
  res.end(body);
}
function renderMediaPage(req,kind,media) {
  const origin = publicOrigin(req);
  const canonical = origin + '/series/' + kind + '/' + media.id + '-' + mediaSlug(media.title);
  const label = kind === 'anime' ? 'Anime' : (media.countryOfOrigin==='KR'?'Manhwa':media.countryOfOrigin==='CN'?'Manhua':'Manga');
  const pageTitle = media.title + ' — ' + label + ' Details, Synopsis & Genres | Hekomi';
  const synopsis = String(media.description || '').replace(/\s+/g,' ').trim();
  const description = (synopsis ? synopsis.slice(0,190).replace(/\s+\S*$/,'') + ' ' : '') + 'Explore the synopsis, genres, score and details for ' + media.title + ' on Hekomi.';
  const cover = media.cover && /^https:\/\//i.test(media.cover) ? media.cover : '';
  const score = media.averageScore ? (media.averageScore/10).toFixed(1) + '/10' : 'Not rated';
  const dateText = value => {
    if(!value)return '';
    const year=Number(value.year)||null,month=Number(value.month)||null,day=Number(value.day)||null;
    if(!year)return '';
    if(!month)return String(year);
    if(!day)return new Date(Date.UTC(year,month-1,1)).toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'UTC'});
    return new Date(Date.UTC(year,month-1,day)).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});
  };
  const sourceLabel = String(media.source||'').replace(/_/g,' ').toLowerCase().replace(/\b\w/g,ch=>ch.toUpperCase());
  const seasonLabel = [media.season,media.seasonYear].filter(Boolean).join(' ');
  const nextEpisodeLabel = media.nextAiringEpisode && media.nextAiringEpisode.airingAt
    ? 'Episode '+(media.nextAiringEpisode.episode||'?')+' · '+new Date(media.nextAiringEpisode.airingAt*1000).toISOString().replace('T',' ').slice(0,16)+' UTC'
    : '';
  const details = [
    ['Format',media.format],['Release status',String(media.status||'').replace(/_/g,' ')],
    ['First aired',dateText(media.startDate)],['Last aired',dateText(media.endDate)],
    ['Season',seasonLabel],['Episodes',kind==='anime'?media.episodes:null],
    ['Episode length',kind==='anime'&&media.duration?media.duration+' minutes':null],
    ['Next episode',kind==='anime'?nextEpisodeLabel:null],
    ['Source material',sourceLabel],['Studio',(media.studios||[]).join(', ')],
    ['Country',media.countryOfOrigin],['Popularity',media.popularity?Number(media.popularity).toLocaleString():null],
    ['Favorites',media.favourites?Number(media.favourites).toLocaleString():null],
    ['Chapters',kind==='manga'?media.chapters:null],['Volumes',kind==='manga'?media.volumes:null]
  ].filter(pair=>pair[1] !== null && pair[1] !== undefined && pair[1] !== '');
  const infoRows = details.map(pair=>'<div class="info-cell"><dt>'+htmlEscape(pair[0])+'</dt><dd>'+htmlEscape(String(pair[1]).replace(/_/g,' '))+'</dd></div>').join('');
  const schema = {
    '@context':'https://schema.org',
    '@type':kind==='anime'?'TVSeries':'ComicSeries',
    name:media.title,description:synopsis || description,url:canonical,
    image:cover || undefined,genre:media.genres && media.genres.length ? media.genres : undefined
  };
  const jsonLd = JSON.stringify(schema).replace(/</g,'\\u003c');
  const coverHtml = cover ? '<img class="detail-cover" src="'+htmlEscape(cover)+'" alt="Cover artwork for '+htmlEscape(media.title)+' ('+label+')" title="Cover artwork for '+htmlEscape(media.title)+'" width="280" height="420" fetchpriority="high" decoding="async" referrerpolicy="no-referrer">' : '<div class="detail-cover detail-cover-missing" role="img" aria-label="No cover artwork available">H</div>';
  const metaImage = cover || (origin + '/assets/hekomi-social.svg');
  const malLink = kind==='anime' && media.idMal ? '<a class="detail-secondary" href="https://myanimelist.net/anime/'+Number(media.idMal)+'" rel="noreferrer" target="_blank">Open on MyAnimeList ↗</a>' : '';
  const genreTags = (media.genres||[]).map(g=>'<span class="genre-pill">'+htmlEscape(g)+'</span>').join('');
  const descriptionHtml = synopsis ? '<p class="detail-synopsis">'+htmlEscape(synopsis).replace(/\n/g,'<br>')+'</p>' : '<p class="detail-synopsis">No synopsis is available from the catalog source yet.</p>';
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<title>'+htmlEscape(pageTitle)+'</title><meta name="description" content="'+htmlEscape(description)+'">',
    '<meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#080916">',
    '<link rel="canonical" href="'+htmlEscape(canonical)+'"><link rel="icon" href="/Anime%20Manga%20Duality%20Emblem.ico" type="image/png">',
    '<meta property="og:type" content="article"><meta property="og:site_name" content="Hekomi"><meta property="og:title" content="'+htmlEscape(pageTitle)+'"><meta property="og:description" content="'+htmlEscape(description)+'"><meta property="og:url" content="'+htmlEscape(canonical)+'"><meta property="og:image" content="'+htmlEscape(metaImage)+'"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="'+htmlEscape(pageTitle)+'"><meta name="twitter:description" content="'+htmlEscape(description)+'"><meta name="twitter:image" content="'+htmlEscape(metaImage)+'">',
    '<script type="application/ld+json">'+jsonLd+'</script>',
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;color:#f2f4f8;background:radial-gradient(ellipse at 75% 0,rgba(116,75,160,.2),transparent 45%),#080916;font:16px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.detail-wrap{width:min(1120px,calc(100% - 36px));margin:auto}.detail-header{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #292d4b}.detail-brand{color:#c6b7ff;font-weight:850;font-size:21px;text-decoration:none;letter-spacing:.03em}.detail-back{color:#c6b7ff;text-decoration:none;font-size:13px}.breadcrumbs{margin:25px 0;color:#9ca4c4;font-size:12px}.breadcrumbs a{color:#b9a6ff;text-decoration:none}.detail-hero{display:grid;grid-template-columns:minmax(180px,280px) minmax(0,1fr);gap:clamp(25px,5vw,65px);align-items:start;padding:20px 0 45px}.detail-cover{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:15px;border:1px solid #ffffff1c;background:#151327;box-shadow:0 25px 55px #0008}.detail-cover-missing{display:grid;place-items:center;color:#b9a6ff;font-size:70px}.detail-type{color:#8be1cf;font-size:11px;letter-spacing:.17em;font-weight:850;text-transform:uppercase}.detail-title{font-size:clamp(32px,5vw,55px);line-height:1.05;letter-spacing:-.05em;margin:9px 0 13px}.detail-score{display:inline-flex;gap:8px;align-items:center;padding:7px 11px;border-radius:9px;background:#19172a;border:1px solid #41385b;color:#e3d7ff;font-weight:750;font-size:13px}.detail-genres{display:flex;gap:7px;flex-wrap:wrap;margin:16px 0}.genre-pill{font-size:12px;color:#c4bdd9;border:1px solid #39334a;border-radius:99px;padding:5px 9px}.detail-synopsis{margin:18px 0 23px;color:#c3c5d1;white-space:normal}.detail-actions{display:flex;flex-wrap:wrap;gap:10px}.detail-primary,.detail-secondary{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;padding:10px 15px;border-radius:11px;font-weight:750;font-size:13px}.detail-primary{background:#b9a6ff;color:#171222}.detail-secondary{border:1px solid #39334a;color:#e8e3f3}.detail-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:0 0 28px}.info-cell{border:1px solid #292d4b;background:#101327;border-radius:12px;padding:12px}.info-cell dt{font-size:11px;color:#9ca4c4;text-transform:uppercase;letter-spacing:.08em}.info-cell dd{margin:5px 0 0;font-size:14px;font-weight:750}.detail-credit{border-top:1px solid #292d4b;padding:19px 0 35px;color:#8f96ad;font-size:11px}.detail-credit a{color:#b9a6ff}@media(max-width:650px){.detail-hero{grid-template-columns:110px minmax(0,1fr);gap:17px;padding-top:8px}.detail-title{font-size:28px}.detail-cover{border-radius:9px}.detail-synopsis{grid-column:1/-1;margin-top:10px}.detail-info{grid-template-columns:repeat(2,minmax(0,1fr))}.detail-header{height:64px}.detail-wrap{width:calc(100% - 26px)}}@media(prefers-color-scheme:light){body{background:#f6f1f9;color:#282333}.detail-header,.detail-credit{border-color:#ded2e5}.detail-brand,.breadcrumbs a,.detail-back,.detail-credit a{color:#7050a4}.detail-type{color:#287a6b}.detail-score{background:#eee6f6;border-color:#d9cae8;color:#4c3670}.genre-pill,.detail-secondary{color:#554563;border-color:#ded2e5}.detail-synopsis{color:#61576a}.info-cell{background:#fffaff;border-color:#ded2e5}.info-cell dt{color:#756b7b}.detail-primary{background:#7050a4;color:#fff}}</style>',
    '</head><body><div class="detail-wrap"><header class="detail-header"><a class="detail-brand" href="/">Hekomi</a><a class="detail-back" href="/">← Back to discovery</a></header>',
    '<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span>'+label+'</span> / <span aria-current="page">'+htmlEscape(media.title)+'</span></nav>',
    '<main><article class="detail-article"><section class="detail-hero"><div>'+coverHtml+'</div><div><div class="detail-type">'+label+' / '+htmlEscape(media.format||'SERIES')+'</div><h1 class="detail-title">'+htmlEscape(media.title)+'</h1><div class="detail-score">★ '+score+'</div><div class="detail-genres">'+genreTags+'</div>'+descriptionHtml+'<div class="detail-actions"><a class="detail-primary" href="/">Explore Hekomi ↗</a><a class="detail-secondary" href="https://anilist.co/'+kind+'/'+Number(media.id)+'/" target="_blank" rel="noreferrer">Source details ↗</a>'+malLink+'</div></div></section>',
    '<dl class="detail-info">'+infoRows+'</dl></article></main>',
    '<footer class="detail-credit">Catalog metadata supplied by <a href="https://anilist.co/" target="_blank" rel="noreferrer">AniList</a>. Cover artwork belongs to its respective rights holders. Hekomi is an independent project and is not affiliated with AniList, MyAnimeList, studios, or publishers.</footer></div></body></html>'
  ].join('');
}
async function serveSitemap(req,res) {
  const origin=publicOrigin(req);
  let urls=[origin+'/'];
  try {
    const catalog=await getPublicCatalog();
    for (const media of [...(catalog.anime||[]),...(catalog.manga||[])]) {
      const kind=media.type==='ANIME'?'anime':'manga';
      urls.push(origin+'/series/'+kind+'/'+Number(media.id)+'-'+mediaSlug(media.title));
    }
  } catch {}
  const body='<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    [...new Set(urls)].map(u=>'<url><loc>'+u.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</loc></url>').join('') +
    '</urlset>';
  res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=900'});
  res.end(body);
}

const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  if(origin && !origin.startsWith(`http://localhost:${PORT}`) && !origin.startsWith(`http://127.0.0.1:${PORT}`)) { /* no permissive cross-origin access */ }
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET' && url.pathname==='/api/health') return send(res,200,{ok:true,app:'Hekomi',crawler:'robots-aware chapter image extractor',malProxy:true});

  if(req.method==='GET' && url.pathname==='/robots.txt') {
    const base=publicOrigin(req);
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=3600'});
    return res.end('User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: '+base+'/sitemap.xml\n');
  }
  if(req.method==='GET' && url.pathname==='/sitemap.xml') return serveSitemap(req,res);
  if(req.method==='GET' && url.pathname==='/api/catalog') {
    try { return send(res,200,await getPublicCatalog(url.searchParams.get('refresh')==='1'),{'Cache-Control':'public, max-age=300'}); }
    catch(e) { return send(res,502,{error:'The public catalog is temporarily unavailable. '+(e.message||'')}); }
  }
  if(req.method==='GET' && url.pathname==='/api/catalog/detail') {
    const id=Number(url.searchParams.get('id'));
    const kind=String(url.searchParams.get('kind')||'anime').toLowerCase();
    if(!Number.isSafeInteger(id)||id<1||!['anime','manga'].includes(kind)) return send(res,400,{error:'Provide a valid catalog ID and kind.'});
    try {
      const media=await getMediaDetail(id,kind);
      if(!media)return send(res,404,{error:'This title was not found in the public catalog.'});
      return send(res,200,media,{'Cache-Control':'public, max-age=600, stale-while-revalidate=3600'});
    } catch(e) {
      return send(res,502,{error:'The title details are temporarily unavailable. '+(e.message||'')});
    }
  }
  if(req.method==='GET' && url.pathname==='/api/catalog/season') {
    try { return send(res,200,await getSeasonCatalog(url.searchParams.get('season'),url.searchParams.get('year')) ,{'Cache-Control':'public, max-age=1800'}); }
    catch(e) { return send(res,400,{error:e.message||'Seasonal catalog could not be loaded.'}); }
  }
  if(req.method==='GET' && url.pathname==='/api/catalog/search') {
    try { return send(res,200,await searchPublicCatalog(url.searchParams.get('q'),url.searchParams.get('page')),{'Cache-Control':'public, max-age=300'}); }
    catch(e) { return send(res,400,{error:e.message||'Catalog search failed.'}); }
  }
  const seriesRoute=url.pathname.match(/^\/series\/(anime|manga)\/(\d+)(?:-[a-z0-9-]*)?\/?$/i);
  if((req.method==='GET'||req.method==='HEAD') && seriesRoute) {
    const kind=seriesRoute[1].toLowerCase(), id=Number(seriesRoute[2]);
    if(!Number.isSafeInteger(id)||id<1) return sendHtml(res,404,'<!doctype html><title>Not found | Hekomi</title><h1>Series not found</h1><a href="/">Back to Hekomi</a>',{'X-Robots-Tag':'noindex'});
    try {
      const media=await getMediaDetail(id,kind);
      if(!media) return sendHtml(res,404,'<!doctype html><title>Series not found | Hekomi</title><h1>Series not found</h1><p>This title may be unavailable in the public catalog.</p><a href="/">Back to Hekomi</a>',{'X-Robots-Tag':'noindex'});
      const page=renderMediaPage(req,kind,media);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'public, max-age=600, stale-while-revalidate=3600'});
      return req.method==='HEAD'?res.end():res.end(page);
    } catch(e) {
      return sendHtml(res,503,'<!doctype html><title>Catalog temporarily unavailable | Hekomi</title><meta name="robots" content="noindex"><h1>The catalog is temporarily unavailable</h1><p>Please try again shortly.</p><a href="/">Back to Hekomi</a>',{'Retry-After':'60','Cache-Control':'no-store'});
    }
  }

if(req.method==='GET' && url.pathname==='/api/mangascrape/providers') {
    return send(res,200,{providers:Object.entries(MANGASCRAPE_SOURCES).map(([id,source])=>({id,label:source.label,origin:source.origin}))});
  }
if(req.method==='POST' && url.pathname==='/api/mangascrape/discover') {
    try {
      const data=await readBody(req);
      const provider=String(data.provider||'all').trim().toLowerCase();
      const feed=String(data.feed||'trending').trim().toLowerCase();
      if(provider!=='all'&&!MANGASCRAPE_SOURCES[provider]) throw new Error('Choose a supported source or All sources.');
      if(!['trending','latest'].includes(feed)) throw new Error('Choose Trending or Latest updates.');
      const payload=await loadMangaScrapeDiscovery(provider,feed,data.refresh===true);
      const status=payload.results.length?200:(payload.errors.length?503:200);
      return send(res,status,payload,{'Cache-Control':'no-store'});
    } catch(error) {
      const message=String(error && error.message || 'Manga discovery could not be loaded.');
      return send(res,/temporarily unavailable|could not verify robots|robots\.txt could not be checked/i.test(message)?503:400,{error:message});
    }
  }
  if(req.method==='POST' && url.pathname==='/api/mangascrape/search') {
    try {
      const data=await readBody(req);
      const query=mangaScrapeQuery(data.query);
      const requested=String(data.provider||'all').trim().toLowerCase();
      let providers;
      if(requested==='all') {
        const enabled=Array.isArray(data.enabledProviders)?data.enabledProviders.map(x=>String(x).toLowerCase()):Object.keys(MANGASCRAPE_SOURCES);
        providers=Object.keys(MANGASCRAPE_SOURCES).filter(key=>enabled.includes(key));
        if(!providers.length) throw new Error('Enable at least one manga extension in Extension manager.');
      } else {
        mangaScrapeProvider(requested);
        providers=[requested];
      }
      const settled=await Promise.allSettled(providers.map(async key=>{
        const selected=mangaScrapeProvider(key);
        let raw;
        if (key === 'mangahook') {
          const target = new URL(mangaScrapeSearchUrl(key, query));
          const payload = await mangaHookApiRequest(target.pathname + target.search);
          raw = Array.isArray(payload.mangaList) ? payload.mangaList : [];
        } else {
          const target = mangaScrapeSearchUrl(key,query);
          await assertMangaScrapeAllowed(target);
          if (key === 'batoto') {
            const result = await selected.adapter.search({query});
            raw = result && Array.isArray(result.results) ? result.results : [];
          } else if (key === 'mangabuddy') {
            raw = await selected.adapter.search(encodeURIComponent(query));
          } else {
            raw = await selected.adapter.search(query);
          }
        }
        return (Array.isArray(raw)?raw:[]).slice(0,30).map(item=>mangaScrapeNormalizeSearch(key,item)).filter(Boolean).map(item=>({...item,providerLabel:selected.source.label}));
      }));
      const results=[],errors=[];
      settled.forEach((item,index)=>{
        if(item.status==='fulfilled') results.push(...item.value);
        else errors.push({provider:providers[index],label:MANGASCRAPE_SOURCES[providers[index]].label,message:String(item.reason&&item.reason.message||'Extension search failed.')});
      });
      const seen=new Set();
      const unique=results.filter(item=>{const key=(item.title||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();if(!key)return true;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,60);
      return send(res,200,{provider:requested,providerLabel:requested==='all'?'Enabled extensions':MANGASCRAPE_SOURCES[requested].label,query,results:unique,errors,notice:'Search runs across enabled extensions. Results contain source metadata; chapter availability and reading access depend on each source.'});
    } catch(error) {
      const message=String(error && error.message || 'Manga source search failed.');
      const status=/wait a moment/i.test(message)?429:/temporarily unavailable|could not verify robots|robots\.txt could not be checked/i.test(message)?503:400;
      return send(res,status,{error:message});
    }
  }
  if(req.method==='POST' && url.pathname==='/api/mangascrape/details') {
    try {
      const data=await readBody(req);
      const selected=mangaScrapeProvider(data.provider);
      const id=mangaScrapeId(data.id);
      const sourceKind=mangaScrapeSourceKind(selected.key,data.sourceKind);
      let item;
      if (selected.key === 'mangahook') {
        item = await mangaHookApiRequest('/api/manga/' + encodeURIComponent(mangaScrapeCleanId(selected.key, id)));
      } else {
        const target = mangaScrapeTitleUrl(selected.key,id,sourceKind);
        await assertMangaScrapeAllowed(target);
        if (selected.key === 'batoto') item = await selected.adapter.id(id);
        else if (selected.key === 'mangabuddy') item = await selected.adapter.id(id);
        else item = await selected.adapter.id(id,sourceKind);
      }
            const detail=mangaScrapeNormalizeDetails(selected.key,id,sourceKind,item);
      return send(res,200,detail);
    } catch(error) {
      const message=String(error && error.message || 'Manga details could not be loaded.');
      const status=/wait a moment/i.test(message)?429:/temporarily unavailable|could not verify robots|robots\.txt could not be checked/i.test(message)?503:400;
      return send(res,status,{error:message});
    }
  }
  if(req.method==='POST' && url.pathname==='/api/mangascrape/chapter') {
    try {
      const data=await readBody(req);
      const id=mangaScrapeCleanId('mangahook',data.id);
      const chapterId=mangaScrapeId(data.chapterId);
      const payload=await mangaHookApiRequest('/api/manga/'+encodeURIComponent(id)+'/'+encodeURIComponent(chapterId));
      const images=(Array.isArray(payload.images)?payload.images:[])
        .map(image=>({url:mangaScrapeSafeAsset(image&&image.image)}))
        .filter(image=>image.url).slice(0,300);
      if(!images.length) throw new Error('Manga Hook did not return readable page images for this chapter.');
      return send(res,200,{
        title:String(payload.currentChapter||payload.title||('Chapter '+chapterId)).slice(0,240),
        images,
        notice:'Page images are loaded from the Manga Hook API response. Image availability depends on the source host.'
      });
    } catch(error) {
      const message=String(error&&error.message||'Manga Hook chapter could not be loaded.');
      const status=/HTTP 429|wait a moment/i.test(message)?429:/could not be reached|temporarily unavailable|robots.txt could not be checked|Could not verify robots.txt/i.test(message)?503:400;
      return send(res,status,{error:message});
    }
  }
  if(req.method==='POST' && url.pathname==='/api/search-manga-sites') {
    try { const data=await readBody(req); return send(res,200,await searchMangaWebsites(data.query)); } catch(e) { return send(res,400,{error:e.message||'Manga website search failed.'}); }
  }
  if(req.method==='POST' && url.pathname==='/api/chapter-images') {
    try { const data=await readBody(req); if(!data.url) return send(res,400,{error:'Chapter URL required.'}); return send(res,200,await extractChapterImages(String(data.url))); } catch(e) { return send(res,400,{error:e.message||'Chapter extraction failed.'}); }
  }
  if(req.method==='POST' && url.pathname==='/api/inspect') {
    try { const data=await readBody(req); if(!data.url) return send(res,400,{error:'Website URL required.'}); const result=await inspectWebsite(String(data.url)); return send(res,200,result); }
    catch(e) { return send(res,400,{error:e.message||'Website inspection failed.'}); }
  }
  if(req.method==='GET' && url.pathname==='/api/mal/auth/status') return malAuthStatus(req,res).catch(e=>send(res,500,{error:e.message||'Could not check MAL connection.'}));
  if(req.method==='GET' && url.pathname==='/api/mal/auth/start') return startMalAuth(req,res).catch(e=>send(res,500,{error:e.message||'Could not start MAL sign-in.'}));
  if(req.method==='GET' && url.pathname==='/api/mal/auth/callback') return completeMalAuth(req,res,url.searchParams);
  if(req.method==='POST' && url.pathname==='/api/mal/auth/logout') return malLogout(req,res);
  if(url.pathname.startsWith('/api/mal/')) return malRequest(req,res,url.pathname.slice('/api/mal'.length),url.searchParams).catch(e=>send(res,500,{error:e.message||'MAL request failed.'}));
  if(req.method!=='GET' && req.method!=='HEAD') return send(res,405,{error:'Method not allowed.'});
  const normalizedPath=decodeURIComponent(url.pathname).replace(/\/+$/,'')||'/';
  const appPath=normalizedPath==='/index.html'?'/':normalizedPath;
  const pageRoutes=new Set(['/','/discover','/anime','/manga','/profile']);
  const isAppPage=pageRoutes.has(appPath);
  let filePath=path.resolve(__dirname, '.'+(isAppPage?'/index.html':normalizedPath));
  if(!filePath.startsWith(__dirname+path.sep) && filePath!==path.join(__dirname,'index.html')) return send(res,403,'Forbidden');
  try {
    const data=await fs.readFile(filePath);
    let body=data;
    if(filePath===path.join(__dirname,'index.html')) {
      const origin=publicOrigin(req);
      const pageName=appPath==='/'?'home':appPath.slice(1);
      const pageTitles={
        home:'Hekomi — Anime &amp; Manga Discovery, Tracking &amp; Reading',
        discover:'Discover Anime &amp; Manga — Hekomi',
        anime:'Anime List &amp; MyAnimeList Tracker — Hekomi',
        manga:'Manga Library &amp; Website Discovery — Hekomi',
        profile:'Your Hekomi Profile &amp; Settings'
      };
      const canonicalPath=appPath==='/'?'/':appPath;
      body=Buffer.from(data.toString('utf8')
        .replaceAll('__HEKOMI_PUBLIC_URL__',origin)
        .replaceAll('__HEKOMI_CANONICAL_URL__',origin+canonicalPath)
        .replaceAll('__HEKOMI_PAGE__',pageRoutes.has(appPath)?pageName:'home')
        .replaceAll('__HEKOMI_PAGE_TITLE__',pageTitles[pageName]||pageTitles.home),'utf8');
    }
    res.writeHead(200,{'Content-Type':MIME[path.extname(filePath)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'no-cache'});
    return req.method==='HEAD'?res.end():res.end(body);
  }
  catch { return send(res,404,'Not found'); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Hekomi running at http://localhost:${PORT}`));
