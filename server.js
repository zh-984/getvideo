/**
 * GetVideo v4.1 — 规则解耦影视聚合搜索 + 零流量穿透 + 播放质量保障
 *
 * 核心特性：
 *   1. 规则解耦：站点配置、优先级与代理策略全部位于 rules.json
 *   2. 零流量穿透：重写 m3u8 和代理密钥，媒体分片由浏览器直连 CDN
 *   3. 播放前并发体检 (/api/probe)：自动检测死链/延迟/分辨率/CORS，优先秒播最稳高清源
 *   4. 智能去插播广告切片：精准过滤 #EXT-X-DISCONTINUITY 异路径/夹心广告段，消除音画断层
 *   5. 嵌套 Master Playlist 递归重写 + 深度 SSRF 防护（DNS + 逐跳重定向 IP 校验）
 */

const express = require('express');
const path    = require('path');
const axios   = require('axios');
const cors    = require('cors');
const fs      = require('fs');
const net     = require('net');
const dns     = require('dns').promises;
const { URL } = require('url');
const zlib    = require('zlib');

// ── 轻量加载 .env（不覆盖已有环境变量） ──
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (err) {
    console.warn('[env] Failed to parse .env:', err.message);
  }
})();

const app         = express();
const PORT        = parseInt(process.env.PORT || '3000', 10);
const SERVER_HOST = (process.env.SERVER_HOST || '').trim().replace(/\/+$/, '');
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

app.set('trust proxy', 1);
app.disable('x-powered-by');

const corsOptions = (!CORS_ORIGIN || CORS_ORIGIN === '*')
  ? {}
  : { origin: CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) };
app.use(cors(corsOptions));
app.use(express.json({ limit: '64kb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ── 安全 Gzip 压缩（仅压缩 >= 1KB 的文本/JSON/m3u8） ──
app.use((req, res, next) => {
  const accept = req.headers['accept-encoding'] || '';
  if (!accept.includes('gzip')) return next();

  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (
      res.headersSent ||
      res.getHeader('Content-Encoding') ||
      typeof body !== 'string' ||
      Buffer.byteLength(body) < 1024
    ) {
      return origSend(body);
    }
    zlib.gzip(Buffer.from(body), (err, compressed) => {
      if (err || res.headersSent) return origSend(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      return origSend(compressed);
    });
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // HTML 入口禁止强缓存，使用 ETag 协商缓存，确保发布新版前端后用户刷新立即生效
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use((req, res, next) => {
  req._rid = Math.random().toString(36).slice(2, 8);
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      console.log(`[${new Date().toISOString()}][${req._rid}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});


// ══════════════════════════════════════
//  § 0.  安全防护（分级限流 + 深度 SSRF 防护）
// ══════════════════════════════════════

const rateLimitMap = new Map();
const searchLimitMap = new Map();
setInterval(() => {
  rateLimitMap.clear();
  searchLimitMap.clear();
}, 1000).unref();

app.use((req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (req.path === '/api/search') {
    const sc = (searchLimitMap.get(ip) || 0) + 1;
    searchLimitMap.set(ip, sc);
    if (sc > 8) return res.status(429).json({ error: '搜索过于频繁，请稍后再试' });
  }
  const count = (rateLimitMap.get(ip) || 0) + 1;
  rateLimitMap.set(ip, count);
  if (count > 60) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  next();
});

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

const BLOCKED_EXT = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.dll',
  '.scr', '.vbs', '.wsf', '.hta', '.cpl', '.reg', '.inf',
]);

const BLOCKED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/x-sh',
];
const AES_KEY_BYTES = 16;
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;

function isMediaContentType(contentType) {
  return /^(video|audio|image)\//.test(contentType) && !contentType.includes('mpegurl');
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIP(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(clean)) return isPrivateIPv4(clean);
  if (net.isIPv6(clean)) {
    if (clean === '::1' || clean === '::') return true;
    const v4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
    if (clean.startsWith('::ffff:')) return true;
    if (/^(fc|fd|fe[89ab]|ff)/.test(clean)) return true;
    return false;
  }
  return true;
}

function validateUrlSyntax(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return '缺少 URL 参数';
  if (targetUrl.length > 2048) return 'URL 过长';
  if (/[<>'"]/.test(targetUrl) || /javascript:/i.test(targetUrl)) return 'URL 包含可疑内容';

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return '无效 URL';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '仅允许 http/https 协议';

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return '禁止访问内网或受保护主机';
  }
  if (net.isIP(host) && isPrivateIP(host)) {
    return '禁止访问内网 IP 地址';
  }

  const pathnameLower = parsed.pathname.toLowerCase();
  for (const ext of BLOCKED_EXT) {
    if (pathnameLower.endsWith(ext)) return `禁止代理 ${ext} 文件`;
  }
  return null;
}

const dnsSafetyCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dnsSafetyCache) {
    if (now - v.ts > 60_000) dnsSafetyCache.delete(k);
  }
}, 60_000).unref();

async function validateUrlDeep(targetUrl) {
  const syntaxErr = validateUrlSyntax(targetUrl);
  if (syntaxErr) return syntaxErr;

  const parsed = new URL(targetUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return null;

  const cached = dnsSafetyCache.get(host);
  if (cached && Date.now() - cached.ts < 60_000) return cached.err;

  try {
    const records = await dns.lookup(host, { all: true });
    if (!records || !records.length) {
      dnsSafetyCache.set(host, { err: '域名无法解析', ts: Date.now() });
      return '域名无法解析';
    }
    for (const rec of records) {
      if (isPrivateIP(rec.address)) {
        const err = '禁止访问解析到内网的域名';
        dnsSafetyCache.set(host, { err, ts: Date.now() });
        return err;
      }
    }
    dnsSafetyCache.set(host, { err: null, ts: Date.now() });
    return null;
  } catch {
    return '域名解析失败';
  }
}

/**
 * 上游 GET/HEAD 请求：逐跳校验重定向目标，保留上游状态码以识别死链。
 */
async function requestUpstream(initialUrl, options = {}, maxHops = 5) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    options.signal?.throwIfAborted();
    const secErr = await validateUrlDeep(currentUrl);
    options.signal?.throwIfAborted();
    if (secErr) {
      const err = new Error(secErr);
      err.statusCode = 403;
      throw err;
    }

    const resp = await axios.request({
      ...options,
      url: currentUrl,
      maxRedirects: 0,
      validateStatus: () => true,
    });

    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      if (options.responseType === 'stream' && resp.data?.destroy) resp.data.destroy();
      currentUrl = new URL(resp.headers.location, currentUrl).href;
      continue;
    }

    if (resp.status < 200 || resp.status >= 300) {
      if (options.responseType === 'stream' && resp.data?.destroy) resp.data.destroy();
      const err = new Error(`Upstream HTTP ${resp.status}`);
      err.upstreamStatus = resp.status;
      // 404 / 410 明确标记为死链 (410 Gone)，便于前端毫秒级跳源
      err.statusCode = (resp.status === 404 || resp.status === 410) ? 410 : 502;
      err.dead = resp.status === 404 || resp.status === 410;
      throw err;
    }

    return { resp, finalUrl: currentUrl };
  }
  const err = new Error('重定向次数过多');
  err.statusCode = 502;
  throw err;
}

function getProxyBase(req) {
  if (SERVER_HOST) {
    return /^https?:\/\//i.test(SERVER_HOST) ? SERVER_HOST : `${req.protocol}://${SERVER_HOST}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

function normalizeProxyTarget(raw) {
  let url = String(raw || '').trim();
  let guard = 0;
  while (url.includes('%25') && guard++ < 3) {
    try { url = decodeURIComponent(url); } catch { break; }
  }
  return url;
}


// ══════════════════════════════════════
//  § 1.  规则加载 + 缓存 + 站点健康
// ══════════════════════════════════════

const RULE_PATH = path.join(__dirname, 'rules.json');
let rules = { sites: [] };
let cacheGeneration = 0;
const pendingRequests = new Map();

const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;

const probeCache = new Map();
const PROBE_CACHE_TTL = 3 * 60 * 1000;
const PROBE_CACHE_MAX = 500;
const PROBE_TIMEOUT = 2800;
const PROBE_PLAYLIST_MAX_BYTES = 1024 * 1024;

let latestCache = { data: null, time: 0 };
const LATEST_CACHE_TTL = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) {
    if (now - v.time > SEARCH_CACHE_TTL) searchCache.delete(k);
  }
  for (const [k, v] of probeCache) {
    if (now - v.time > PROBE_CACHE_TTL) probeCache.delete(k);
  }
}, 3 * 60 * 1000).unref();

function cacheResult(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, { ...value, time: Date.now() });
  if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function shareRequest(key, load) {
  const pending = pendingRequests.get(key);
  if (pending) return pending;

  const job = Promise.resolve().then(load).finally(() => {
    // 规则重载后，相同 key 可能已经有一条新请求。
    if (pendingRequests.get(key) === job) pendingRequests.delete(key);
  });
  pendingRequests.set(key, job);
  return job;
}

function loadRules() {
  try {
    const raw = fs.readFileSync(RULE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    rules.sites = (data.sites || [])
      .filter(s => s.enabled !== false && s.site_name && s.search_url)
      .sort((a, b) => (b.priority || 50) - (a.priority || 50));
    console.log(`[rules] Loaded ${rules.sites.length} site(s)`);
  } catch (err) {
    console.error('[rules] Failed to load:', err.message);
  }
}
loadRules();

const siteHealth = {};
function recordSiteHealth(siteId, success, errMsg = '') {
  const h = siteHealth[siteId] || { successes: 0, failures: 0, consecutiveFails: 0, lastError: '', lastSuccess: 0, lastFail: 0 };
  if (success) {
    h.successes++;
    h.lastSuccess = Date.now();
    h.consecutiveFails = 0;
    h.lastError = '';
  } else {
    h.failures++;
    h.consecutiveFails = (h.consecutiveFails || 0) + 1;
    h.lastFail = Date.now();
    h.lastError = errMsg || 'error';
  }
  siteHealth[siteId] = h;
}

function getActiveSites() {
  const now = Date.now();
  return rules.sites.filter(s => {
    if (s.enabled === false) return false;
    const h = siteHealth[s.site_name];
    if (h && h.consecutiveFails >= 5 && now - (h.lastFail || 0) < 15 * 60 * 1000) return false;
    return true;
  });
}


// ══════════════════════════════════════
//  § 2.  视频链接解析 + 搜索引擎 + 最新推荐
// ══════════════════════════════════════

function encodeUrlProperly(url) {
  try {
    return new URL(url).href;
  } catch {
    return url.replace(/[^\x20-\x7E]/g, ch => encodeURIComponent(ch));
  }
}

function isDirectPlayableUrl(url) {
  const lower = url.toLowerCase();
  if (/\.m3u8(\?|$|#)/.test(lower)) return 2;
  if (/\.(mp4|webm|flv|mov|mkv)(\?|$|#)/.test(lower)) return 1;
  return 0;
}

function parsePlayUrls(raw, playFromRaw = '') {
  if (!raw || typeof raw !== 'string') return [];
  const blocks = raw.split('$$$').filter(Boolean);
  const fromNames = (playFromRaw || '').split('$$$');

  const parsedLines = blocks.map((block, idx) => {
    const eps = [];
    let m3u8Count = 0;
    let directCount = 0;

    for (const part of block.split('#')) {
      const sep = part.indexOf('$');
      let label = '';
      let url = '';
      if (sep === -1) {
        url = part.trim();
        label = `第${eps.length + 1}集`;
      } else {
        label = part.substring(0, sep).trim() || `第${eps.length + 1}集`;
        url = part.substring(sep + 1).trim();
      }
      if (!url || !/^https?:\/\//i.test(url)) continue;

      const score = isDirectPlayableUrl(url);
      if (score === 2) m3u8Count++;
      if (score >= 1) directCount++;
      eps.push({ label, url: encodeUrlProperly(url), _score: score });
    }

    const fromName = (fromNames[idx] || '').toLowerCase();
    const isM3u8LineName = fromName.includes('m3u8');
    return { eps, m3u8Count, directCount, isM3u8LineName };
  }).filter(line => line.eps.length > 0);

  if (!parsedLines.length) return [];

  const directLines = parsedLines.filter(l => l.directCount > 0);
  if (directLines.length > 0) {
    directLines.sort((a, b) => {
      if (b.m3u8Count !== a.m3u8Count) return b.m3u8Count - a.m3u8Count;
      if (b.isM3u8LineName !== a.isM3u8LineName) return b.isM3u8LineName ? 1 : -1;
      return b.directCount - a.directCount;
    });
    return directLines[0].eps
      .filter(e => e._score >= 1)
      .map(({ label, url }) => ({ label, url }));
  }

  return [];
}

function cleanBlurb(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function classifyType(typeName = '') {
  const t = String(typeName);
  if (/动漫|动画|番剧|少儿/.test(t)) return 'anime';
  if (/综艺|真人秀|脱口秀|纪录|记录/.test(t)) return 'variety';
  if (/剧|连续|韩剧|美剧|日剧|泰剧|港剧|台剧|国产剧|欧美剧|内地剧|大陆剧|海外剧/.test(t)) return 'series';
  if (/片|电影/.test(t)) return 'movie';
  return 'other';
}

// ── 搜索相关性与噪点过滤 ──
const ADULT_RE      = /伦理|福利|里番|情色|成人|午夜|写真|三级片|限制级/i;
const COMMENTARY_RE = /电影解说|短剧解说|影视解说|\[解说\]|（解说）|\(解说\)|解说版|预告片|先导片|花絮|幕后特辑/i;
const SPORTS_RE     = /体育|篮球|足球|赛事|NBA|CBA|英超|西甲|意甲|德甲|法甲|欧冠|常规赛|季后赛/i;
const SHORT_DRAMA_RE = /女频恋爱|男频|反转爽剧|爽文短剧|爽文|言情总裁|脑洞悬疑|年代穿越|古装仙侠|现代都市|重生民国|短剧|微剧/i;

function normalizeSearchStr(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[\s\u3000·•・：:，,。\.！!？\?、\-—_~～\/\\|'"“”‘’()（）\[\]【】《》<>]/g, '');
}

function isBlockedNoise(item, keyword = '', isLatestFeed = false) {
  const type  = String(item.type || '');
  const title = String(item.title || '');
  const kw    = String(keyword || '');

  // 1. 成人/伦理/里番/福利：始终过滤
  if (ADULT_RE.test(type) || ADULT_RE.test(title)) return true;

  // 2. 电影解说/预告/花絮：除非用户明确搜了这些词
  if (!/解说|预告|花絮/.test(kw) && (COMMENTARY_RE.test(type) || COMMENTARY_RE.test(title))) {
    return true;
  }

  // 3. 体育赛事录像：除非用户搜体育词
  if (!/nba|cba|足球|篮球|体育|英超|欧冠|赛事|比赛|世界杯|奥运/i.test(kw)) {
    if (SPORTS_RE.test(type) || /\b(NBA|CBA)\b|常规赛|季后赛|\sVS\s/i.test(title)) return true;
  }

  // 4. 首页最新推荐中直接过滤土味微短剧，保持高质量观影入口
  if (isLatestFeed && SHORT_DRAMA_RE.test(type)) return true;

  return false;
}

function calcRelevance(item, kwNorm, tokens, wantsAnimatedComic) {
  if (!kwNorm) return 0;

  const rawTitle  = String(item.title || '');
  const titleNorm = normalizeSearchStr(rawTitle);
  const titleCore = normalizeSearchStr(rawTitle.replace(/[\(（\[【].*?[\)）\]】]/g, ''));

  let score = 0;

  if (titleCore === kwNorm || titleNorm === kwNorm) {
    score = 100;
  } else if (titleCore.startsWith(kwNorm) || titleNorm.startsWith(kwNorm)) {
    const diff = Math.max(0, (titleCore || titleNorm).length - kwNorm.length);
    score = 92 - Math.min(12, diff);
  } else if (titleNorm.includes(kwNorm)) {
    const diff = Math.max(0, titleNorm.length - kwNorm.length);
    score = 76 - Math.min(14, Math.floor(diff / 2));
  } else {
    // 多词搜索（如 "哈利波特 火焰杯" 或 "蜘蛛侠 2021"）
    const subNorm = normalizeSearchStr(item._sub || '');
    const titlePlusSub = `${titleNorm} ${subNorm} ${item.year || ''}`;
    if (tokens.length >= 2 && tokens.every(tk => titlePlusSub.includes(tk))) {
      score = 72;
    } else if (subNorm && subNorm.includes(kwNorm)) {
      score = 60;
    } else if (kwNorm.length >= 2 && normalizeSearchStr(`${item._actor || ''} ${item._director || ''}`).includes(kwNorm)) {
      // 演员 / 导演精确命中（如搜 "周星驰"、"宫崎骏"）
      score = 48;
    }
  }

  if (score === 0) return 0;

  // 微短剧 / 动态漫降权（不排在正规电影/剧集前面）
  const type = String(item.type || '');
  if (SHORT_DRAMA_RE.test(type)) score = Math.max(10, score - 22);
  if (!wantsAnimatedComic && /动态漫|有声动漫/.test(rawTitle + type)) score = Math.max(15, score - 12);

  return score;
}

function formatCmsItem(item, site) {
  const episodes = parsePlayUrls(item.vod_play_url, item.vod_play_from);
  return {
    title:       (item.vod_name || item.vod_title || '未知').trim(),
    cover:       item.vod_pic || item.vod_pic_thumb || null,
    year:        item.vod_year || '',
    type:        item.type_name || '',
    category:    classifyType(item.type_name),
    remarks:     item.vod_remarks || '',
    snippet:     [item.vod_year, item.vod_area, item.type_name].filter(Boolean).join(' · '),
    blurb:       cleanBlurb(item.vod_blurb || item.vod_content),
    site:        site.site_name,
    priority:    site.priority ?? 50,
    preferProxy: Boolean(site.prefer_proxy),
    episodes,
    _sub:        item.vod_sub || '',
    _actor:      item.vod_actor || '',
    _director:   item.vod_director || '',
  };
}

function stripInternalFields(item) {
  const { _sub, _actor, _director, ...pub } = item;
  return pub;
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function searchSite(keyword, site, signal) {
  const url = site.search_url
    .replace(/\{keyword\}/g, encodeURIComponent(keyword))
    .replace(/\{page\}/g, '1');

  const resp = await axios.get(url, {
    timeout: site.timeout_ms || 8000,
    signal,
    responseType: site.mode === 'api' ? 'json' : 'text',
    headers: DEFAULT_HEADERS,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  if (site.mode === 'api') {
    const list = resp.data?.list || resp.data?.data?.list || [];
    return list
      .map(item => formatCmsItem(item, site))
      .filter(item => item.episodes.length > 0);
  }

  const cheerio = require('cheerio');
  const $ = cheerio.load(resp.data);
  const items = [];
  $(site.list_selector).each((_, el) => {
    const $el = $(el);
    const title = $el.find(site.title_selector).text().trim();
    let link = $el.find(site.link_selector).attr('href') || '';
    if (link && !link.startsWith('http')) link = new URL(link, site.base_url).href;
    const cover = site.cover_selector ? $el.find(site.cover_selector).attr('src') : null;
    if (title) {
      items.push({
        title, cover, year: '', type: '', category: 'other', remarks: '', snippet: '', blurb: '',
        site: site.site_name, priority: site.priority ?? 50, preferProxy: Boolean(site.prefer_proxy),
        episodes: [], _detailUrl: link,
      });
    }
  });
  return items;
}

async function fetchLatestSite(site) {
  let latestUrl = site.latest_url;
  if (!latestUrl && site.mode === 'api') {
    try {
      const u = new URL(site.search_url.replace(/\{keyword\}/g, '').replace(/\{page\}/g, '1'));
      u.searchParams.delete('wd');
      u.searchParams.set('ac', 'detail');
      u.searchParams.set('pg', '1');
      latestUrl = u.href;
    } catch {
      return [];
    }
  }
  if (!latestUrl) return [];

  const resp = await axios.get(latestUrl, {
    timeout: Math.min(site.timeout_ms || 7000, 7000),
    responseType: 'json',
    headers: DEFAULT_HEADERS,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  const list = resp.data?.list || resp.data?.data?.list || [];
  return list
    .map(item => formatCmsItem(item, site))
    .filter(item => item.episodes.length > 0 && item.cover && !isBlockedNoise(item, '', true))
    .map(stripInternalFields);
}

async function aggregateSearch(keyword, showAll, enabled, generation) {
  const settled = await Promise.allSettled(enabled.map(site => {
    const timeout = (site.timeout_ms || 8000) + 1200;
    const controller = new AbortController();
    let timer;
    return Promise.race([
      searchSite(keyword, site, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
          controller.abort();
        }, timeout);
      }),
    ]).finally(() => clearTimeout(timer));
  }));

  const rawMerged = [];
  settled.forEach((r, i) => {
    const siteId = enabled[i].site_name;
    if (r.status === 'fulfilled' && r.value.length > 0) {
      rawMerged.push(...r.value);
      if (generation === cacheGeneration) recordSiteHealth(siteId, true);
    } else if (r.status === 'rejected') {
      if (generation === cacheGeneration) recordSiteHealth(siteId, false, r.reason?.message);
      console.error(`[search] ${siteId}: ${r.reason?.message}`);
    }
  });

  // 相关性评分 + 噪点过滤（剔除站点胡乱吐出的无关短剧/NBA/解说/伦理/纯简介误匹配）
  const kwNorm = normalizeSearchStr(keyword);
  const tokens = keyword.split(/\s+/).map(normalizeSearchStr).filter(Boolean);
  const wantsAnimatedComic = /动态漫/.test(keyword);
  let filtered = rawMerged
    .filter(item => showAll ? !ADULT_RE.test(`${item.type} ${item.title}`) : !isBlockedNoise(item, keyword, false))
    .map(item => ({ ...item, relevance: calcRelevance(item, kwNorm, tokens, wantsAnimatedComic) }))
    .filter(item => item.relevance > 0);

  // 极端兜底：如果用户输了错别字/生僻词导致精确过滤为 0，做宽松有序子串匹配
  if (!filtered.length && rawMerged.length > 0) {
    const kwChars = [...kwNorm];
    if (kwChars.length >= 2) {
      filtered = rawMerged
        .filter(item => !isBlockedNoise(item, keyword, false))
        .map(item => {
          const tn = normalizeSearchStr(item.title);
          let hit = 0, pos = 0;
          for (const ch of kwChars) {
            const idx = tn.indexOf(ch, pos);
            if (idx >= 0) { hit++; pos = idx + 1; }
          }
          const ratio = hit / kwChars.length;
          return { ...item, relevance: ratio >= 0.65 ? Math.round(ratio * 40) : 0 };
        })
        .filter(item => item.relevance > 0);
    }
  }

  filtered.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (!!b.cover !== !!a.cover) return b.cover ? 1 : -1;
    if ((b.priority || 50) !== (a.priority || 50)) return (b.priority || 50) - (a.priority || 50);
    return (b.episodes?.length || 0) - (a.episodes?.length || 0);
  });

  const cleanList = filtered.map(stripInternalFields);
  return {
    keyword,
    total: cleanList.length,
    filteredOut: Math.max(0, rawMerged.length - cleanList.length),
    results: cleanList,
  };
}

app.get('/api/search', async (req, res, next) => {
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim().slice(0, 60) : '';
  if (!keyword) return res.status(400).json({ error: '请输入搜索关键词' });
  const force = req.query.force === '1';
  const showAll = req.query.all === '1';

  const cacheKey = `${keyword.toLowerCase()}|${showAll ? 'all' : 'clean'}`;
  const cached = searchCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.time < SEARCH_CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const enabled = getActiveSites();
  if (!enabled.length) return res.status(500).json({ error: '暂无可用资源站点' });

  const generation = cacheGeneration;
  try {
    const data = await shareRequest(`search:${keyword}|${showAll}`, async () => {
      const result = await aggregateSearch(keyword, showAll, enabled, generation);
      if (result.total && generation === cacheGeneration) {
        cacheResult(searchCache, cacheKey, { data: result }, SEARCH_CACHE_MAX);
      }
      return result;
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

async function aggregateLatest(generation) {
  // 取前 6 个最高优先级的健康直连站拉最新更新
  const enabled = getActiveSites().filter(s => s.mode === 'api' && (s.priority ?? 50) >= 70).slice(0, 6);
  const settled = await Promise.allSettled(enabled.map(site => fetchLatestSite(site)));

  const merged = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      merged.push(...r.value);
      if (generation === cacheGeneration) recordSiteHealth(enabled[i].site_name, true);
    } else if (r.status === 'rejected') {
      if (generation === cacheGeneration) recordSiteHealth(enabled[i].site_name, false, r.reason?.message);
    }
  });

  return { total: merged.length, results: merged };
}

app.get('/api/latest', async (req, res, next) => {
  const force = req.query.force === '1';
  if (!force && latestCache.data && Date.now() - latestCache.time < LATEST_CACHE_TTL) {
    return res.json({ ...latestCache.data, cached: true });
  }

  const generation = cacheGeneration;
  try {
    const data = await shareRequest('latest', async () => {
      const result = await aggregateLatest(generation);
      if (result.total && generation === cacheGeneration) {
        latestCache = { data: result, time: Date.now() };
      }
      return result;
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});


// ══════════════════════════════════════
//  § 2.5  播放前并发线路体检 (/api/probe)
//  实测 m3u8 存活、分辨率、首片 TS 连通性与 CORS，彻底跳过死链
// ══════════════════════════════════════

function formatResolutionLabel(resStr) {
  if (!resStr) return '';
  const m = resStr.match(/(\d+)x(\d+)/i);
  if (!m) return '';
  const maxDim = Math.max(parseInt(m[1], 10), parseInt(m[2], 10));
  const minDim = Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
  if (maxDim >= 3800 || minDim >= 2100) return '4K';
  if (maxDim >= 1800 || minDim >= 1000) return '1080P';
  if (maxDim >= 1200 || minDim >= 700)  return '720P';
  if (maxDim >= 800  || minDim >= 480)  return '540P';
  return `${minDim}P`;
}

async function probeMediaHead(url, origin, signal) {
  const { resp } = await requestUpstream(url, {
    method: 'head',
    signal,
    responseType: 'stream',
    decompress: false,
    headers: { ...DEFAULT_HEADERS, ...(origin ? { Origin: origin } : {}) },
  });
  resp.data?.destroy?.();
  return resp.headers;
}

async function readPlaylistUpstream(url, { maxBytes = PLAYLIST_MAX_BYTES, ...options }) {
  const { resp, finalUrl } = await requestUpstream(url, {
    ...options,
    responseType: 'stream',
  });
  const stream = resp.data;
  const contentType = String(resp.headers['content-type'] || '').trim().toLowerCase();
  const chunks = [];
  let length = 0;
  let prefix = Buffer.alloc(0);
  let foundHeader = false;

  try {
    if (isMediaContentType(contentType)) return { body: '', finalUrl };
    for await (const chunk of stream) {
      if (!foundHeader) {
        // 尽早停止读取伪装成清单的响应，避免下载媒体正文。
        prefix = Buffer.concat([prefix, chunk.subarray(0, 1024 - prefix.length)]);
        const header = prefix.toString('utf8').trimStart();
        foundHeader = header.startsWith('#EXT');
        if (!foundHeader && (header.length >= 4 || prefix.length === 1024)) return { body: '', finalUrl };
      }
      length += chunk.length;
      if (length > maxBytes) throw new Error('m3u8 清单超过大小上限');
      chunks.push(chunk);
    }

    return { body: foundHeader ? Buffer.concat(chunks, length).toString('utf8') : '', finalUrl };
  } finally {
    stream.destroy();
  }
}

function readProbePlaylist(url, signal) {
  const referer = safeOriginReferer(url);
  return readPlaylistUpstream(url, {
    signal,
    maxBytes: PROBE_PLAYLIST_MAX_BYTES,
    headers: { ...DEFAULT_HEADERS, ...(referer ? { Referer: referer } : {}) },
  });
}

async function inspectProbe(url, origin, signal) {
  if (!/\.m3u8(\?|$|#)/i.test(url)) {
    await probeMediaHead(url, '', signal);
    return { ok: true, resolution: '', needProxy: false };
  }

  let playlist = await readProbePlaylist(url, signal);
  if (!playlist.body.includes('#EXTM3U')) return { dead: true, reason: 'invalid_m3u8' };

  const lines = playlist.body.split(/\r?\n/).map(line => line.trim());
  const streamInf = lines.find(line => line.toUpperCase().startsWith('#EXT-X-STREAM-INF'));
  const resolution = formatResolutionLabel(streamInf?.match(/RESOLUTION=(\d+x\d+)/i)?.[1]);
  let firstMedia = lines.find(line => line && !line.startsWith('#'));
  if (streamInf && firstMedia) {
    const subUrl = safeResolveUrl(firstMedia, playlist.finalUrl);
    playlist = await readProbePlaylist(subUrl, signal);
    if (!playlist.body.includes('#EXTM3U')) return { dead: true, reason: 'invalid_m3u8' };
    firstMedia = playlist.body.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
  }
  if (!firstMedia) return { dead: true, reason: 'empty_playlist' };

  const mediaUrl = safeResolveUrl(firstMedia, playlist.finalUrl);
  try {
    const headers = await probeMediaHead(mediaUrl, origin, signal);
    const allowedOrigin = String(headers['access-control-allow-origin'] || '').trim();
    if (allowedOrigin && (allowedOrigin === '*' || allowedOrigin === origin)) {
      return { ok: true, resolution };
    }
    return { reason: 'no_cors_direct', resolution };
  } catch (err) {
    // 有些 CDN 对 HEAD 和播放用的 GET 返回不同结果。
    if (err.dead) return { dead: true, reason: 'ts_404' };
    return { reason: 'head_unverified', resolution };
  }
}

function probeSingleUrl(rawUrl, origin) {
  const url = normalizeProxyTarget(rawUrl);
  const key = `${origin}\n${url}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.time < PROBE_CACHE_TTL) return cached.result;

  const generation = cacheGeneration;
  return shareRequest(`probe:${key}`, async () => {
    const started = Date.now();
    const controller = new AbortController();
    let timer;
    try {
      const outcome = await Promise.race([
        inspectProbe(url, origin, controller.signal).catch(err => ({
          dead: Boolean(err.dead),
          reason: err.upstreamStatus ? `HTTP_${err.upstreamStatus}` : (err.code || err.message || 'error').slice(0, 30),
        })),
        new Promise(resolve => {
          timer = setTimeout(() => {
            resolve({ reason: 'probe_timeout' });
            controller.abort();
          }, PROBE_TIMEOUT);
        }),
      ]);
      const result = { url, ok: false, dead: false, ms: Date.now() - started, ...outcome };
      if (generation === cacheGeneration) cacheResult(probeCache, key, { result }, PROBE_CACHE_MAX);
      return result;
    } finally {
      clearTimeout(timer);
    }
  });
}

app.post('/api/probe', async (req, res, next) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 12) : [];
  if (!urls.length) return res.status(400).json({ error: 'Missing urls array' });

  const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
  try {
    const results = await Promise.all(urls.map(url => probeSingleUrl(url, origin)));
    res.json({ results });
  } catch (err) {
    next(err);
  }
});


// ══════════════════════════════════════
//  § 3.  M3U8 智能去广告 + 递归重写（完整支持 Master Playlist）
// ══════════════════════════════════════

function looksLikePlaylist(absUrl) {
  try {
    const p = new URL(absUrl).pathname.toLowerCase();
    return p.endsWith('.m3u8') || p.endsWith('.m3u');
  } catch {
    return /\.m3u8(\?|$)/i.test(absUrl);
  }
}

function safeResolveUrl(rel, base) {
  try { return new URL(rel, base).href; } catch { return rel; }
}

function safeOriginReferer(urlStr) {
  try { return new URL(urlStr).origin + '/'; } catch { return ''; }
}

function getDirPrefix(absUrl) {
  try {
    const u = new URL(absUrl);
    return u.origin + u.pathname.replace(/[^/]*$/, '');
  } catch {
    return '';
  }
}

/**
 * 智能过滤 #EXT-X-DISCONTINUITY 插入广告切片（零误杀 + 完整保留 AES KEY 继承）：
 *  - 规则 A（异路径短广告）：若主目录占比 >= 55%，某个被 DISCONTINUITY 隔开的短块（<=15片 且 <=45s）目录异于主目录 → 剔除
 *  - 规则 B（同目录夹心短插播）：总时长 > 240s 时，夹在两个 >90s 大块之间的短块（2~8片 且 5~32s）→ 剔除
 */
function stripAdSegments(body, baseUrlStr) {
  const rawLines = String(body).split(/\r?\n/);
  if (body.includes('#EXT-X-STREAM-INF') || !body.includes('#EXT-X-DISCONTINUITY')) {
    return { text: body, removedAds: 0 };
  }

  const headerLines = [];
  const blocks = [];
  const footerLines = [];
  let inMedia = false;
  let currentBlock = null;
  let pendingEntryLines = [];
  let activeKeyLine = '';
  let activeMapLine = '';

  function ensureBlock() {
    if (!currentBlock) {
      currentBlock = {
        entries: [],
        segs: 0,
        duration: 0,
        dirCounts: new Map(),
        entryKeyLine: activeKeyLine,
        entryMapLine: activeMapLine,
        hasExplicitKey: false,
      };
      blocks.push(currentBlock);
    }
  }

  for (const line of rawLines) {
    const t = line.trim();
    if (!t) continue;

    const upper = t.toUpperCase();
    if (upper === '#EXT-X-ENDLIST') {
      footerLines.push(line);
      continue;
    }

    if (upper === '#EXT-X-DISCONTINUITY') {
      inMedia = true;
      if (currentBlock && currentBlock.segs > 0) {
        currentBlock = null;
      }
      continue;
    }

    if (!inMedia && t.startsWith('#') && !upper.startsWith('#EXTINF:') && !upper.startsWith('#EXT-X-KEY') && !upper.startsWith('#EXT-X-MAP') && !upper.startsWith('#EXT-X-BYTERANGE')) {
      headerLines.push(line);
      continue;
    }

    inMedia = true;
    ensureBlock();

    if (t.startsWith('#')) {
      if (upper.startsWith('#EXTINF:')) {
        currentBlock.duration += parseFloat(t.slice(8)) || 0;
      } else if (upper.startsWith('#EXT-X-KEY')) {
        activeKeyLine = line;
        if (currentBlock.segs === 0) currentBlock.hasExplicitKey = true;
      } else if (upper.startsWith('#EXT-X-MAP')) {
        activeMapLine = line;
      }
      pendingEntryLines.push(line);
    } else {
      const abs = safeResolveUrl(t, baseUrlStr);
      const dir = getDirPrefix(abs);
      currentBlock.dirCounts.set(dir, (currentBlock.dirCounts.get(dir) || 0) + 1);
      currentBlock.segs++;
      pendingEntryLines.push(line);
      currentBlock.entries.push(pendingEntryLines);
      pendingEntryLines = [];
    }
  }

  if (pendingEntryLines.length && currentBlock) {
    currentBlock.entries.push(pendingEntryLines);
  }

  const totalSegs = blocks.reduce((a, b) => a + b.segs, 0);
  const totalDur  = blocks.reduce((a, b) => a + b.duration, 0);
  if (totalSegs < 15 || blocks.length < 2) {
    return { text: body, removedAds: 0 };
  }

  const globalDirCounts = new Map();
  for (const b of blocks) {
    for (const [d, c] of b.dirCounts) {
      globalDirCounts.set(d, (globalDirCounts.get(d) || 0) + c);
    }
  }
  let mainDir = '';
  let mainDirCount = 0;
  for (const [d, c] of globalDirCounts) {
    if (c > mainDirCount) { mainDir = d; mainDirCount = c; }
  }
  const hasDominantDir = mainDir && (mainDirCount / totalSegs) >= 0.55;

  let removedAds = 0;
  const keptBlocks = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.segs === 0) continue;

    let blockDir = '';
    let blockDirCount = 0;
    for (const [d, c] of b.dirCounts) {
      if (c > blockDirCount) { blockDir = d; blockDirCount = c; }
    }

    const isForeignAd = hasDominantDir && blockDir !== mainDir && b.segs <= 15 && b.duration <= 45;
    const prevBlock = blocks[i - 1];
    const nextBlock = blocks[i + 1];
    const isMidAd = totalDur > 240 &&
      i > 0 && i < blocks.length - 1 &&
      b.segs >= 2 && b.segs <= 8 &&
      b.duration >= 5 && b.duration <= 32 &&
      prevBlock && prevBlock.duration > 90 &&
      nextBlock && nextBlock.duration > 90;

    if (isForeignAd || isMidAd) {
      removedAds++;
      continue;
    }

    keptBlocks.push(b);
  }

  if (removedAds === 0 || !keptBlocks.length) {
    return { text: body, removedAds: 0 };
  }

  const out = [...headerLines];
  let emittedKeyLine = '';
  keptBlocks.forEach((b, idx) => {
    if (idx > 0) out.push('#EXT-X-DISCONTINUITY');
    // 防止被删广告块带走正片所需的有效 AES KEY
    if (!b.hasExplicitKey && b.entryKeyLine && b.entryKeyLine !== emittedKeyLine) {
      out.push(b.entryKeyLine);
      emittedKeyLine = b.entryKeyLine;
    }
    for (const entry of b.entries) {
      for (const l of entry) {
        if (l.trim().toUpperCase().startsWith('#EXT-X-KEY')) emittedKeyLine = l;
        out.push(l);
      }
    }
  });
  out.push(...footerLines);
  return { text: out.join('\n'), removedAds };
}

function rewriteM3u8Content(body, baseUrlStr, proxyBase) {
  const filtered = stripAdSegments(body, baseUrlStr);
  const lines = String(filtered.text).split(/\r?\n/);
  let nextUriType = '';

  const rewritten = lines.map(line => {
    const t = line.trim();
    if (!t) return line;

    if (t.startsWith('#')) {
      const tag = t.split(':', 1)[0].toUpperCase();
      if (tag === '#EXT-X-STREAM-INF') nextUriType = 'playlist';
      if (tag === '#EXTINF') nextUriType = 'segment';

      let endpoint;
      if (tag === '#EXT-X-KEY' || tag === '#EXT-X-SESSION-KEY') {
        const keyFormat = t.match(/[:,]\s*KEYFORMAT="([^"]+)"/i)?.[1] || 'identity';
        if (keyFormat === 'identity' && /[:,]\s*METHOD=(AES-128|SAMPLE-AES|SAMPLE-AES-CTR)(?=\s*(?:,|$))/i.test(t)) {
          endpoint = 'key';
        }
      } else if (tag === '#EXT-X-MEDIA' || tag === '#EXT-X-I-FRAME-STREAM-INF' || tag === '#EXT-X-IMAGE-STREAM-INF') {
        endpoint = 'm3u8';
      }

      return line.replace(/([:,]\s*)URI="([^"]+)"/gi, (_, prefix, uri) => {
        const abs = safeResolveUrl(uri, baseUrlStr);
        const target = endpoint && /^https?:\/\//i.test(abs)
          ? `${proxyBase}/api/${endpoint}?url=${encodeURIComponent(abs)}`
          : abs;
        return `${prefix}URI="${target}"`;
      });
    }

    const abs = safeResolveUrl(t, baseUrlStr);
    const isSubM3u8 = nextUriType === 'playlist' || (nextUriType !== 'segment' && looksLikePlaylist(abs));
    nextUriType = '';

    if (isSubM3u8) {
      return `${proxyBase}/api/m3u8?url=${encodeURIComponent(abs)}`;
    }

    // 媒体分片由浏览器直接请求 CDN。
    return abs;
  }).join('\n');

  return { rewritten, removedAds: filtered.removedAds };
}

app.get('/api/parse', async (req, res) => {
  const targetUrl = normalizeProxyTarget(req.query.url);
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });

  try {
    const { body, finalUrl } = await readPlaylistUpstream(targetUrl, {
      timeout: 8000,
      headers: DEFAULT_HEADERS,
    });

    if (!body) {
      return res.json({ url: finalUrl, type: 'direct' });
    }

    const proxyBase = getProxyBase(req);
    const { rewritten, removedAds } = rewriteM3u8Content(body, finalUrl, proxyBase);
    const isMaster = body.includes('#EXT-X-STREAM-INF');
    const variants = isMaster
      ? rewritten.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).map(l => l.trim())
      : [];

    res.json({
      url: finalUrl,
      type: isMaster ? 'master' : 'media',
      variants,
      removedAds,
      content: rewritten,
      traffic_bytes: Buffer.byteLength(rewritten),
    });
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: 'Failed to fetch m3u8', detail: err.message, dead: Boolean(err.dead) });
  }
});

app.get('/api/m3u8', async (req, res) => {
  const targetUrl = normalizeProxyTarget(req.query.url);
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    const { body, finalUrl } = await shareRequest(`playlist:${targetUrl}`, () => {
      const referer = safeOriginReferer(targetUrl);
      return readPlaylistUpstream(targetUrl, {
        timeout: 10000,
        headers: { ...DEFAULT_HEADERS, ...(referer ? { Referer: referer } : {}) },
      });
    });

    if (!body) {
      return res.status(410).json({ error: '上游返回的不是有效 m3u8 清单', dead: true });
    }

    const proxyBase = getProxyBase(req);
    const { rewritten, removedAds } = rewriteM3u8Content(body, finalUrl, proxyBase);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Ads-Removed');
    res.setHeader('X-Ads-Removed', String(removedAds));
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (err) {
    res.status(err.statusCode || 502).json({
      error: 'm3u8 fetch failed',
      detail: err.message,
      upstreamStatus: err.upstreamStatus || null,
      dead: Boolean(err.dead),
    });
  }
});

// 仅返回 16 字节的 HLS AES 密钥。
app.get('/api/key', async (req, res) => {
  const targetUrl = normalizeProxyTarget(req.query.url);
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    const originReferer = safeOriginReferer(targetUrl);
    const { resp } = await requestUpstream(targetUrl, {
      timeout: 8000,
      responseType: 'stream',
      headers: { ...DEFAULT_HEADERS, 'Accept-Encoding': 'identity', ...(originReferer ? { Referer: originReferer } : {}) },
    });

    const stream = resp.data;
    const ct = String(resp.headers['content-type'] || '').trim().toLowerCase();
    const key = Buffer.alloc(AES_KEY_BYTES);
    let length = 0;
    try {
      if (isMediaContentType(ct) || BLOCKED_CONTENT_TYPES.some(bad => ct.includes(bad))) {
        return res.status(403).json({ error: '禁止代理非密钥内容' });
      }
      for await (const chunk of stream) {
        const offset = length;
        length += chunk.length;
        if (length > AES_KEY_BYTES) break;
        chunk.copy(key, offset);
      }
      if (length !== AES_KEY_BYTES) {
        return res.status(502).json({ error: '上游返回的 AES 密钥必须恰好为 16 字节' });
      }
    } finally {
      stream.destroy();
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(key);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: 'key fetch failed', detail: err.message });
  }
});


// ══════════════════════════════════════
//  § 4.  辅助与管理接口
// ══════════════════════════════════════

app.get('/api/info', (_req, res) => {
  res.json({
    name: 'GetVideo',
    version: '4.3.0',
    mode: '纯零流量直连',
    uptime: Math.floor(process.uptime()) + 's',
    memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1) + ' MB',
    sites: rules.sites.map(s => {
      const h = siteHealth[s.site_name] || {};
      return {
        name: s.site_name,
        priority: s.priority ?? 50,
        enabled: s.enabled !== false,
        health: h.consecutiveFails >= 5 ? 'DOWN' : h.consecutiveFails >= 2 ? 'DEGRADED' : 'OK',
        successes: h.successes || 0,
        failures: h.failures || 0,
      };
    }),
    endpoints: {
      search: 'GET /api/search?keyword=xxx',
      latest: 'GET /api/latest',
      probe:  'POST /api/probe { urls: [...] }',
      m3u8:   'GET /api/m3u8?url=xxx',
      key:    'GET /api/key?url=xxx',
      parse:  'GET /api/parse?url=xxx',
      reload: 'POST /api/rules/reload (localhost or ADMIN_TOKEN)',
      info:   'GET /api/info',
    },
  });
});

app.post('/api/rules/reload', (req, res) => {
  const remoteIp = req.socket?.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp) && !req.headers['x-forwarded-for'];
  const authHeader = req.headers['authorization'] || '';
  const tokenOk = ADMIN_TOKEN && authHeader === `Bearer ${ADMIN_TOKEN}`;

  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: '仅允许服务器本机或携带有效 ADMIN_TOKEN 重载规则' });
  }

  loadRules();
  cacheGeneration++;
  pendingRequests.clear();
  searchCache.clear();
  probeCache.clear();
  latestCache = { data: null, time: 0 };
  res.json({ message: 'Reloaded', count: rules.sites.length });
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  GetVideo v4.3 — 纯零流量直连模式           ║
║  Port: ${String(PORT).padEnd(37)}║
║  Sites: ${String(rules.sites.length).padEnd(36)}║
╚══════════════════════════════════════════════╝
  `);
});

function shutdown(sig) {
  console.log(`[server] Received ${sig}, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});
