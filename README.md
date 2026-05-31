# GetVideo

规则解耦影视聚合搜索与 H5 播放器 — 零流量穿透 + no-referrer 破防盗链

## 功能

- 聚合多个第三方资源站，搜索即看
- 零流量穿透：服务器只转发 m3u8 文本（几 KB），视频从 CDN 直连浏览器
- 规则解耦：所有站点配置在 `rules.json`，主程序零硬编码
- 马卡龙色系 H5 播放器，支持倍速、全屏、选集
- 智能降级：直连失败 → 全代理 → 自动换源
- 安全防护：SSRF 防护、频率限制、文件类型拦截

## 快速开始

```bash
# 安装依赖
npm install

# 启动
npm start

# 浏览器打开 http://localhost:3000
```

## 项目结构

```
Getvideo/
├── server.js          ← 后端（Express + 搜索 + m3u8 代理）
├── rules.json         ← 资源站规则配置
├── public/
│   └── index.html     ← H5 播放器
├── package.json
├── .env.example       ← 配置模板
├── deploy.sh          ← 服务器部署脚本
├── LICENSE            ← MIT License
└── README.md
```

## 部署到服务器

```bash
# 1. 上传项目文件到服务器
scp -r . ubuntu@your-server-ip:/home/ubuntu/getvideo/

# 2. SSH 登录服务器
ssh ubuntu@your-server-ip

# 3. 安装依赖并启动
cd /home/ubuntu/getvideo
npm install --production
npm install -g pm2
pm2 start server.js --name getvideo
pm2 save
pm2 startup
```

详细部署指南见 `deploy.sh`。

## 配置

### 环境变量

```bash
cp .env.example .env
# 编辑 .env 填入你的配置
```

### 添加资源站

编辑 `rules.json`，在 `sites` 数组中添加：

```json
{
  "site_name": "站点名称",
  "enabled": true,
  "mode": "api",
  "base_url": "https://example.com",
  "search_url": "https://example.com/api.php/provide/vod/?ac=detail&wd={keyword}&pg={page}",
  "list_selector": null,
  "title_selector": null,
  "link_selector": null,
  "cover_field": "vod_pic",
  "video_url_regex": null,
  "timeout_ms": 10000
}
```

热加载：`POST /api/rules/reload`

## API 接口

| 接口 | 说明 |
|------|------|
| `GET /api/search?keyword=xxx` | 聚合搜索 |
| `GET /api/m3u8?url=xxx` | m3u8 代理（节流模式） |
| `GET /api/m3u8?url=xxx&full=1` | m3u8 代理（全代理模式） |
| `GET /api/key?url=xxx` | AES 密钥代理 |
| `GET /api/ts?url=xxx` | .ts 分片代理 |
| `GET /api/parse?url=xxx` | m3u8 解析 |
| `GET /api/info` | 服务器状态 |
| `POST /api/rules/reload` | 热更新规则 |

## 播放原理

```
搜索：浏览器 → 服务器（几 KB JSON）→ 资源站 API → 返回影片列表
播放：浏览器 → 服务器（m3u8 文本几 KB）→ 重写 URL
       ↓
       hls.js 直连 CDN 拉取 .ts 分片（不经过服务器）
       ↓
       AES 密钥通过服务器代理（绕防盗链）
```

## 安全防护

- SSRF 防护（禁止访问内网）
- 文件类型拦截（.exe/.bat/.sh 等）
- Content-Type 白名单（仅视频/音频/m3u8）
- 脚本注入检测
- 频率限制（每 IP 每秒 20 次）
- URL 长度限制（2048 字符）

## 技术栈

- 后端：Node.js + Express + Axios + Cheerio
- 前端：原生 HTML/CSS/JS + ArtPlayer + hls.js
- 部署：PM2 + iptables

## License

[MIT](LICENSE)
