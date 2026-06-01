# GetVideo

规则解耦影视聚合搜索与 H5 播放器 — 零流量穿透 + no-referrer 破防盗链

## 功能特性

- **聚合搜索**：7 个资源站并发搜索，去重排序，搜索结果缓存
- **零流量穿透**：服务器只转发 m3u8 文本（几 KB），视频 .ts 分片从 CDN 直连浏览器
- **规则解耦**：所有站点配置在 `rules.json`，主程序零硬编码，热更新无需重启
- **马卡龙色系 H5 播放器**：ArtPlayer + hls.js，支持倍速、全屏、选集、画质切换
- **智能降级**：直连失败 → 自动切源 → 全代理模式（50MB 熔断保护）
- **搜索建议**：输入时联想历史记录 + 热门词
- **播放进度记忆**：自动保存，下次打开自动续播
- **预取下一集**：当前播放时静默预取下一集 m3u8，切集秒播
- **站点健康检测**：自动追踪每个站的成功/失败，连续失败自动跳过
- **安全防护**：SSRF 防护、频率限制、文件类型拦截、URL 校验、Gzip 压缩

## 快速开始

```bash
# 安装依赖
npm install

# 启动
npm start

# 打开浏览器
# http://localhost:3000
```

## 项目结构

```
Getvideo/
├── server.js          ← 后端（Express + 搜索 + m3u8 代理 + 安全防护）
├── rules.json         ← 资源站规则（添加/禁用站点只改这里）
├── public/
│   └── index.html     ← H5 播放器（马卡龙色系 + no-referrer）
├── package.json
├── deploy.sh          ← 服务器一键部署脚本
├── .env.example       ← 配置模板
├── LICENSE            ← MIT
└── README.md
```

## 接口文档

| 接口 | 说明 |
|------|------|
| `GET /api/search?keyword=xxx` | 聚合搜索（支持缓存） |
| `GET /api/m3u8?url=xxx` | m3u8 代理（节流模式，.ts 直连 CDN） |
| `GET /api/m3u8?url=xxx&full=1` | m3u8 代理（全代理模式，50MB 熔断） |
| `GET /api/key?url=xxx` | AES 密钥代理（16 字节） |
| `GET /api/ts?url=xxx` | .ts 分片代理（全代理模式用） |
| `GET /api/parse?url=xxx` | m3u8 解析 + URL 重写 |
| `GET /api/sites` | 已配置站点列表 |
| `GET /api/info` | 服务器状态 + 站点健康 |
| `POST /api/rules/reload` | 热更新规则文件 |

## 规则配置

编辑 `rules.json`，CMS API 模式示例：

```json
{
  "site_name": "站点名称",
  "enabled": true,
  "mode": "api",
  "base_url": "https://example.com",
  "search_url": "https://example.com/api.php/provide/vod/?ac=detail&wd={keyword}&pg={page}",
  "timeout_ms": 10000
}
```

大部分免费影视站使用同一套 CMS 后台，API 格式相同。

## 零流量穿透原理

```
搜索：浏览器 → 服务器（几 KB JSON）→ 资源站 API → 返回影片列表
播放：浏览器 → 服务器（m3u8 文本几 KB）→ 重写 URL
       ↓
       hls.js 直连 CDN 拉取 .ts 分片（不经过服务器）
       ↓
       AES 密钥通过服务器代理（绕防盗链，16 字节）
```

服务器每部电影只消耗 **几 KB** 流量。

## 播放降级策略

```
直连失败 → 自动切下一集 → 全代理模式（50MB 熔断）→ 提示用户
```

## 部署

```bash
# 上传项目
scp -r . ubuntu@your-server:/home/ubuntu/getvideo/

# SSH 登录
ssh ubuntu@your-server

# 安装 + 启动
cd /home/ubuntu/getvideo
npm install --production
npm install -g pm2
pm2 start server.js --name getvideo
pm2 save
pm2 startup
```

## 技术栈

- **后端**：Node.js + Express + Axios + Cheerio
- **前端**：原生 HTML/CSS/JS + ArtPlayer + hls.js
- **协议**：HLS (m3u8) + AES-128

## 安全防护

- SSRF 防护（禁止访问内网）
- 文件类型拦截（.exe/.bat/.sh 等）
- Content-Type 白名单（仅视频/音频/m3u8）
- 脚本注入检测
- 频率限制（每 IP 每秒 20 次）
- URL 长度限制（2048 字符）
- 站点健康检测（连续失败自动跳过）

## License

[MIT](LICENSE)
