# GetVideo v4.3

规则解耦影视聚合搜索与 H5 播放器 — **媒体直连 CDN + `no-referrer` + 并发体检选优**

## 核心特性

- **媒体直连 CDN**：视频、音频及初始化分片均由浏览器直连 CDN。播放代理只转发 m3u8 清单和 16 字节 AES 密钥，能否直连取决于片源 CDN 的访问规则
- **多站并发聚合 & 智能换源**：聚合 10 个支持跨域直连的资源站，同名影片按「片名+分类」合并为多条可选线路；自动按相关性打分并过滤无关短剧/解说/赛事/违规噪点；播放失败自动秒切下一条直连线路
- **并发链路体检选优**：多源影片开播前并发检查清单、画质和 CORS；直链视频和分片只请求 HEAD 响应头，确认失效的线路会被跳过，待验证线路仍可由浏览器尝试直连
- **嵌套 Master Playlist 递归重写**：完整支持多码率 `EXT-X-STREAM-INF` 与多音轨子 m3u8
- **现代观影体验**：浅色马卡龙 / 深色观影双主题、首页「继续观看」+「最新更新（分类筛选）」、自动连播、选集正/倒序、倍速、PC 键盘快捷键
- **深度安全防护**：DNS 解析 + 逐跳重定向 SSRF 防护（拦截私网、IPv6 映射及云主机元数据 `169.254.169.254`）、分级限流、Content-Type 拦截、热重载鉴权

---

## 部署环境

| 项目 | 值 |
|------|-----|
| 服务器 | Ubuntu 22.04 或相容环境 |
| 运行环境 | Node.js 20.18.1 或更高版本 |
| 进程管理 | `systemd` (`getvideo.service`，开机自启、崩溃重启、`MemoryMax=256M`) |
| 反向代理示例 | Nginx 将 `location /` 转发至 `127.0.0.1:3000` |

---

## 后端接口

| 接口 | 说明 |
|------|------|
| `GET /api/search?keyword=xxx` | 聚合搜索（相关性打分 + 噪点过滤，5 分钟缓存） |
| `GET /api/latest` | 各站最新更新聚合（15 分钟缓存，支持分类筛选） |
| `POST /api/probe` | 并发线路体检（存活、延迟、画质、CORS 直连检测） |
| `GET /api/m3u8?url=xxx` | m3u8 递归重写（清单上限 4 MiB，媒体分片直连 CDN） |
| `GET /api/key?url=xxx` | HLS AES 密钥代理（仅接受 16 字节密钥） |
| `GET /api/parse?url=xxx` | m3u8 解析与重写调试接口 |
| `GET /api/info` | 服务版本、内存占用与站点健康状态 |
| `POST /api/rules/reload` | 热更新 `rules.json`（仅允许本机回环或携带 `Authorization: Bearer <ADMIN_TOKEN>`） |

---

## 本地开发

```powershell
cd getvideo
npm ci
npm start
# 浏览器打开 http://localhost:3000
```

---

## 部署到服务器

```bash
git clone https://github.com/zh-984/getvideo.git
cd getvideo
cp .env.example .env
APP_DIR="$PWD" bash deploy.sh
```

更新已有的 Git 部署时，在服务器的项目目录中执行以下命令。

```bash
git pull --ff-only
npm ci --omit=dev
sudo systemctl restart getvideo
```

---

## 常用运维命令

```bash
# 查看状态 / 重启 / 停止
sudo systemctl status getvideo
sudo systemctl restart getvideo
sudo systemctl stop getvideo

# 查看实时日志
sudo journalctl -u getvideo -f

# 热重载 rules.json（无需重启服务）
curl -X POST http://127.0.0.1:3000/api/rules/reload

# 查看站点健康状态
curl -s http://127.0.0.1:3000/api/info
```
