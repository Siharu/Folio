import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const USER_AGENT = 'PersonalMangaDiscovery/0.1 (respecting robots.txt)';
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json; charset=utf-8' };
const rate = new Map();

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
  if (!['/search','/me','/list','/update'].includes(pathname)) return send(res,404,{error:'Unknown MAL endpoint.'});
  let session = null;
  if (pathname !== '/search') {
    session = await getMalSession(req, res);
    if (!session || !session.accessToken) return send(res,401,{error:'Sign in with MyAnimeList first.'});
  }
  let apiPath = '';
  let method = 'GET';
  let body;
  if (pathname === '/search') apiPath='/anime?q='+encodeURIComponent(query.get('q')||'')+'&limit=10&fields=alternative_titles,synopsis,mean,genres,num_episodes,media_type,main_picture';
  if (pathname === '/me') apiPath='/users/@me';
  if (pathname === '/list') apiPath='/users/@me/animelist?limit=100&fields=list_status,num_episodes,mean,media_type,main_picture';
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

const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  if(origin && !origin.startsWith(`http://localhost:${PORT}`) && !origin.startsWith(`http://127.0.0.1:${PORT}`)) { /* no permissive cross-origin access */ }
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET' && url.pathname==='/api/health') return send(res,200,{ok:true,app:'Hekomi Night Edition',crawler:'robots-aware chapter image extractor',malProxy:true});
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
  let filePath=path.resolve(__dirname, '.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!filePath.startsWith(__dirname+path.sep) && filePath!==path.join(__dirname,'index.html')) return send(res,403,'Forbidden');
  try { const data=await fs.readFile(filePath); res.writeHead(200,{'Content-Type':MIME[path.extname(filePath)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'no-cache'}); return req.method==='HEAD'?res.end():res.end(data); }
  catch { return send(res,404,'Not found'); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Hekomi running at http://localhost:${PORT}`));
