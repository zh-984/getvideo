/**
 * GetVideo — 规则解耦影视聚合搜索 + 零流量穿透
 *
 * 设计原则：
 *   1. 所有站点逻辑从 rules.json 动态加载，主程序零硬编码
 *   2. 服务器只解析 m3u8 文本并重写相对 URL，不中转视频数据
 *   3. 前端通过 no-referrer + hls.js 直连 CDN 拉取 .ts 分片
 *   4. 服务器流量 ≈ 几 KB/次（仅搜索 JSON + m3u8 文本），视频流量为零
 */

const express = require('express');
const path    = require('path');
const axios   = require('axios');
const cors    = require('cors');
const fs      = require('fs');
const { URL } = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 中间件 ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => {
  req._rid = Math.random().toString(36).slice(2, 8);
  console.log(`[${new Date().toISOString()}][${req._rid}] ${req.method} ${req.url}`);
  next();
});


// ──────────────────────────────────────────────
// 安全中间件
// ──────────────────────────────────────────────

// 1) 频率限制：每 IP 每秒最多 20 次请求
const rateLimitMap = new Map();
setInterval(() => rateLimitMap.clear(), 1000);

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const count = (rateLimitMap.get(ip) || 0) + 1;
  rateLimitMap.set(ip, count);
  if (count > 20) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  next();
});

// 2) URL 安全校验函数
const BLOCKED_HOSTS = new Set(['localhost','127.0.0.1','0.0.0.0','::1','metadata.google.internal']);
const BLOCKED_EXT = new Set(['.exe','.bat','.cmd','.sh','.ps1','.msi','.dll','.scr','.js','.vbs','.wsf','.hta','.cpl','.reg','.inf']);

function validateUrl(targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { return '无效 URL'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '仅允许 http/https';
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return '禁止访问内网地址';
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return '禁止访问内网地址';
  for (const ext of BLOCKED_EXT) {
    if (parsed.pathname.toLowerCase().endsWith(ext)) return `禁止代理 ${ext} 文件`;
  }
  if (/[<>'"]/.test(targetUrl) || /javascript:/i.test(targetUrl)) return 'URL 包含可疑内容';
  if (targetUrl.length > 2048) return 'URL 过长';
  return null;
}


// ══════════════════════════════════════
//  § 1.  规则加载
// ══════════════════════════════════════

const RULE_PATH = path.join(__dirname, 'rules.json');
let rules = { sites: [] };

function loadRules() {
  try {
    const raw = fs.readFileSync(RULE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    rules.sites = (data.sites || []).filter(s => s.enabled !== false && s.site_name && s.search_url);
    console.log(`[rules] Loaded ${rules.sites.length} site(s)`);
  } catch (err) {
    console.error('[rules] Failed to load:', err.message);
  }
}
loadRules();


// ══════════════════════════════════════
//  § 2.  搜索引擎（API 模式 + HTML 模式）
// ══════════════════════════════════════

/**
 * 解析 CMS API 的 vod_play_url 字段
 * 格式：源1标题$url1#第2集$url2$$$源2标题$url3#第4集$url4
 */
function parsePlayUrls(raw) {
  if (!raw) return [];
  const sources = [];
  for (const block of raw.split('$$$')) {
    for (const part of block.split('#')) {
      const idx = part.indexOf('$');
      if (idx === -1) continue;
      const label = part.substring(0, idx).trim();
      let url   = part.substring(idx + 1).trim();
      if (url && !url.startsWith('javascript:')) {
        // ★ 确保 URL 中的中文字符被正确编码（避免前端二次编码）
        url = encodeUrlProperly(url);
        sources.push({ label, url });
      }
    }
  }
  return sources;
}

/**
 * 确保 URL 被正确编码：
 * - 如果 URL 已经编码过（含 %XX），保持不变
 * - 如果 URL 含未编码的中文字符，编码路径部分
 */
function encodeUrlProperly(url) {
  try {
    // 尝试解析，如果含未编码中文会自动处理
    const parsed = new URL(url);
    // 重新构建 URL（自动编码中文字符）
    return parsed.href;
  } catch {
    // 如果解析失败，手动编码非 ASCII 字符
    return url.replace(/[一-鿿　-〿＀-￯]/g, ch =>
      encodeURIComponent(ch)
    );
  }
}

/**
 * 单站搜索
 */
async function searchSite(keyword, site) {
  const url = site.search_url.replace('{keyword}', encodeURIComponent(keyword)).replace('{page}', '1');

  const resp = await axios.get(url, {
    timeout: site.timeout_ms || 10000,
    responseType: site.mode === 'api' ? 'json' : 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  // ── CMS API 模式 ──
  if (site.mode === 'api') {
    const list = resp.data?.list || resp.data?.data?.list || [];
    return list.map(item => ({
      title:    item.vod_name || item.vod_title || '未知',
      cover:    item.vod_pic  || item.vod_pic_thumb || null,
      year:     item.vod_year || '',
      snippet:  [item.vod_year, item.vod_area, item.type_name].filter(Boolean).join('·'),
      site:     site.site_name,
      episodes: parsePlayUrls(item.vod_play_url),
    }));
  }

  // ── HTML 抓取模式 ──
  const cheerio = require('cheerio');
  const $ = cheerio.load(resp.data);
  const items = [];
  $(site.list_selector).each((_, el) => {
    const $el = $(el);
    const title = $el.find(site.title_selector).text().trim();
    let link = $el.find(site.link_selector).attr('href') || '';
    if (link && !link.startsWith('http')) link = new URL(link, site.base_url).href;
    const cover = site.cover_selector ? $el.find(site.cover_selector).attr('src') : null;
    if (title) items.push({ title, cover, year: '', snippet: '', site: site.site_name, episodes: [], _detailUrl: link });
  });
  return items;
}

/**
 * 聚合搜索：并发扫描所有站点
 */
app.get('/api/search', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'Missing keyword' });

  const enabled = rules.sites.filter(s => s.enabled !== false);
  if (!enabled.length) return res.status(500).json({ error: 'No enabled sites in rules.json' });

  const results = await Promise.allSettled(enabled.map(site => searchSite(keyword, site)));

  const merged = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      merged.push(...r.value);
    } else {
      console.error(`[search] ${enabled[i].site_name}: ${r.reason?.message}`);
    }
  });

  res.json({ keyword, total: merged.length, results: merged });
});


// ══════════════════════════════════════
//  § 3.  M3U8 解析与 URL 重写（零流量穿透核心）
//
//  服务器只下载 m3u8 文本（几 KB），把相对 URL 重写为绝对 URL，
//  前端 hls.js 直接从 CDN 拉取 .ts 视频分片，不经过服务器。
// ══════════════════════════════════════

app.get('/api/parse', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });
  while (targetUrl.includes('%25')) targetUrl = decodeURIComponent(targetUrl);
  const secErr = validateUrl(targetUrl);
  if (secErr) return res.status(403).json({ error: secErr });

  let parsed;
  try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Only http/https allowed' });

  const baseUrl = parsed.origin + parsed.pathname.replace(/[^/]*$/, '');

  try {
    const resp = await axios.get(targetUrl, {
      timeout: 8000,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      maxRedirects: 5,
    });

    const body = resp.data;

    // 不是 m3u8 → 直接返回原始 URL
    if (!body.includes('#EXTM3U') && !body.includes('#EXT')) {
      return res.json({ url: targetUrl, type: 'direct' });
    }

    // ★ 核心：重写 m3u8 内的 URL
    //   - m3u8 自身 → 通过 /api/m3u8 代理（绕 CORS，几 KB）
    //   - AES key   → 通过 /api/key 代理（绕防盗链，16 字节）
    //   - .ts 分片  → 保持绝对 URL，前端直连 CDN（零流量）
    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const rewritten = body.split('\n').map(line => {
      const trimmed = line.trim();

      // #EXT-X-KEY:URI="..." → 代理 key 文件
      if (trimmed.startsWith('#') && trimmed.includes('URI=') && trimmed.toUpperCase().includes('KEY')) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
          const abs = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
          return `URI="${proxyBase}/api/key?url=${encodeURIComponent(abs)}"`;
        });
      }

      // #EXT-X-MAP:URI="..." → 代理 init segment
      if (trimmed.startsWith('#') && trimmed.includes('URI=') && trimmed.toUpperCase().includes('MAP')) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
          const abs = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
          return `URI="${proxyBase}/api/key?url=${encodeURIComponent(abs)}"`;
        });
      }

      // 其他标签中的 URI → 保持绝对 URL
      if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
          const abs = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
          return `URI="${abs}"`;
        });
      }

      // 非 # 行 → .ts 分片 URL，保持绝对，前端直连 CDN
      if (trimmed && !trimmed.startsWith('#')) {
        return trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
      }

      return line;
    }).join('\n');

    const isMaster = body.includes('#EXT-X-STREAM-INF');

    // 如果是 Master Playlist，提取所有码率变体的绝对 URL
    let variants = [];
    if (isMaster) {
      variants = rewritten.split('\n')
        .filter(l => l.trim() && !l.trim().startsWith('#'))
        .map(l => l.trim());
    }

    res.json({
      url: targetUrl,
      type: isMaster ? 'master' : 'media',
      variants,
      content: rewritten,       // 重写后的 m3u8 文本
      traffic_bytes: Buffer.byteLength(rewritten),  // 本次传输字节数
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch m3u8', detail: err.message });
  }
});


// ══════════════════════════════════════
//  § 3.5  轻量代理：m3u8 文本 + AES 密钥
//
//  只代理 m3u8 文本和 key 文件（几 KB），视频 .ts 直连 CDN
//  服务器流量 ≈ 每部电影几 KB（不是几百 MB）
// ══════════════════════════════════════

// 代理 m3u8 文本
//   /api/m3u8?url=xxx       → 仅代理 key，.ts 直连（省流量）
//   /api/m3u8?url=xxx&full=1 → 全部代理，.ts 也走服务器（保成功）
app.get('/api/m3u8', async (req, res) => {
  let targetUrl = req.query.url;
  const fullMode = req.query.full === '1';
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

  // ★ 修复双重编码
  while (targetUrl.includes('%25')) { targetUrl = decodeURIComponent(targetUrl); }
  const secErr = validateUrl(targetUrl);
  if (secErr) return res.status(403).json({ error: secErr });

  try {
    const resp = await axios.get(targetUrl, {
      timeout: 8000, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const baseUrl = new URL(targetUrl);
    const proxyBase = `${req.protocol}://${req.get('host')}`;

    const rewritten = resp.data.split('\n').map(line => {
      const t = line.trim();

      // #EXT-X-KEY / #EXT-X-MAP 中的 URI → 始终走代理
      if (t.startsWith('#') && t.includes('URI=') && (t.toUpperCase().includes('KEY') || t.toUpperCase().includes('MAP'))) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
          const abs = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
          return `URI="${proxyBase}/api/key?url=${encodeURIComponent(abs)}"`;
        });
      }

      // 非 # 行 → .ts 分片 URL
      if (t && !t.startsWith('#')) {
        const abs = t.startsWith('http') ? t : new URL(t, baseUrl).href;
        if (fullMode) {
          // ★ 全代理模式：.ts 也走服务器
          return `${proxyBase}/api/ts?url=${encodeURIComponent(abs)}`;
        }
        // 节流模式：.ts 直连 CDN
        return abs;
      }

      return line;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch (err) {
    res.status(502).json({ error: 'm3u8 fetch failed', detail: err.message });
  }
});

// .ts 分片代理（全代理模式用，stream pipe 零缓存）
app.get('/api/ts', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });
  while (targetUrl.includes('%25')) targetUrl = decodeURIComponent(targetUrl);
  const secErr = validateUrl(targetUrl);
  if (secErr) return res.status(403).json({ error: secErr });

  try {
    const resp = await axios.get(targetUrl, {
      timeout: 15000, responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': new URL(targetUrl).origin + '/',
      },
    });
    if (resp.headers['content-type']) res.setHeader('Content-Type', resp.headers['content-type']);
    if (resp.headers['content-length']) res.setHeader('Content-Length', resp.headers['content-length']);
    res.setHeader('Access-Control-Allow-Origin', '*');
    resp.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: 'ts fetch failed' });
  }
});

// 代理 AES-128 密钥文件（16 字节）和 init segment（几 KB）
app.get('/api/key', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });
  while (targetUrl.includes('%25')) targetUrl = decodeURIComponent(targetUrl);
  const secErr = validateUrl(targetUrl);
  if (secErr) return res.status(403).json({ error: secErr });

  try {
    const resp = await axios.get(targetUrl, {
      timeout: 5000, responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    // 转发 Content-Type（key 是 application/octet-stream，init 是 video/mp2t）
    if (resp.headers['content-type']) res.setHeader('Content-Type', resp.headers['content-type']);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(resp.data));
  } catch (err) {
    res.status(502).json({ error: 'key fetch failed', detail: err.message });
  }
});


// ══════════════════════════════════════
//  § 4.  辅助接口
// ══════════════════════════════════════

app.get('/api/info', (_req, res) => {
  res.json({
    name: 'GetVideo',
    version: '2.0.0',
    mode: '零流量穿透',
    uptime: Math.floor(process.uptime()) + 's',
    memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + ' MB',
    sites: rules.sites.map(s => ({ name: s.site_name, enabled: s.enabled !== false })),
    endpoints: {
      search: 'GET /api/search?keyword=xxx',
      parse:  'GET /api/parse?url=xxx',
      info:   'GET /api/info',
    },
  });
});

app.post('/api/rules/reload', (_req, res) => {
  loadRules();
  res.json({ message: 'Reloaded', count: rules.sites.length });
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  GetVideo v2.0 — 零流量穿透模式             ║
║  Port: ${String(PORT).padEnd(37)}║
║  Sites: ${String(rules.sites.length).padEnd(36)}║
╚══════════════════════════════════════════════╝

  视频流量：零（前端直连 CDN）
  服务器流量：仅搜索 JSON + m3u8 文本（几 KB/次）
  `);
});
