# GetVideo

规则解耦影视聚合搜索与 H5 播放器 — 零流量穿透 + no-referrer 破防盗链

## 功能

- 聚合 5 个第三方资源站，搜索即看
- 零流量穿透：服务器只转发 m3u8 文本（几 KB），视频从 CDN 直连浏览器
- 规则解耦：所有站点配置在 `rules.json`，主程序零硬编码
- 马卡龙色系 H5 播放器，支持倍速、全屏、选集
- 智能降级：直连失败 → 全代理 → 自动换源
- 安全防护：SSRF 防护、频率限制、文件类型拦截、URL 校验

---

## 当前部署信息

| 项目 | 值 |
|------|-----|
| 服务器 | AWS 新加坡 EC2 |
| 公网 IP | `52.221.181.170` |
| 访问地址 | `http://52.221.181.170` |
| SSH 用户 | `ubuntu` |
| SSH 密钥 | `D:\翻墙\AWS2Singapore.pem` |
| 项目路径 | `/home/ubuntu/getvideo` |
| 进程管理 | PM2（开机自启已配置） |
| 端口 | 80 → 3000（iptables 转发，已持久化） |
| GitHub | https://github.com/zh-984/getvideo |

---

## 每次使用启动步骤

### 终端 1：启动服务器（本地开发用，已部署到 EC2 则跳过）

```powershell
cd d:\wyproject_intresting\Getvideo
npm start
```

### 终端 2：启动公网隧道（可选，同 WiFi 不需要）

```powershell
& "C:\Users\31054\AppData\Local\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe" tunnel --url http://localhost:3000
```

### 关闭

两个终端都按 `Ctrl + C`。

---

## 首次安装（只需一次）

```powershell
cd d:\wyproject_intresting\Getvideo
npm install
```

---

## 项目文件结构

```
Getvideo/
├── server.js          ← 后端（Express + 搜索 + m3u8 代理 + 安全防护）
├── rules.json         ← 资源站规则（添加/禁用站点只改这里）
├── public/
│   └── index.html     ← H5 播放器（马卡龙色系 + no-referrer 破防盗链）
├── package.json       ← 依赖声明
├── package-lock.json  ← 依赖锁定
├── deploy.sh          ← 服务器一键部署脚本
├── .env.example       ← 配置模板
├── LICENSE            ← MIT 开源协议
└── README.md          ← 本文件
```

---

## 后端接口

| 接口 | 说明 | 流量 |
|------|------|------|
| `GET /api/search?keyword=xxx` | 聚合搜索 | 几 KB |
| `GET /api/m3u8?url=xxx` | m3u8 代理（节流模式） | 几 KB |
| `GET /api/m3u8?url=xxx&full=1` | m3u8 代理（全代理模式） | 几 KB |
| `GET /api/key?url=xxx` | AES 密钥代理 | 16 字节 |
| `GET /api/ts?url=xxx` | .ts 分片代理 | 几百 KB |
| `GET /api/parse?url=xxx` | m3u8 解析 + URL 重写 | 几 KB |
| `GET /api/info` | 服务器状态 | <1KB |
| `POST /api/rules/reload` | 热更新规则 | <1KB |

---

## 播放原理

```
搜索：浏览器 → 服务器（几 KB JSON）→ 5 个资源站 API → 返回影片列表
播放：浏览器 → 服务器（m3u8 文本几 KB）→ 重写 URL
       ↓
       hls.js 直连 CDN 拉取 .ts 分片（不经过服务器）
       ↓
       AES 密钥通过服务器代理（绕防盗链）
       ↓
       失败自动降级：直连 → 全代理 → 换下一集
```

---

## 已配置资源站

| 站点 | ID | 模式 |
|------|----|------|
| 暴风资源 | bfzyapi | CMS API |
| 360资源 | 360zy | CMS API |
| 非凡资源 | ffzy | CMS API |
| iKun资源 | ikunzy | CMS API |
| 素材采集 | subocaiji | CMS API |

### 添加新站点

编辑 `rules.json`，在 `sites` 数组中加一个对象：

```json
{
  "site_name": "新站点",
  "enabled": true,
  "mode": "api",
  "base_url": "https://新域名",
  "search_url": "https://新域名/api.php/provide/vod/?ac=detail&wd={keyword}&pg={page}",
  "list_selector": null,
  "title_selector": null,
  "link_selector": null,
  "cover_field": "vod_pic",
  "video_url_regex": null,
  "timeout_ms": 10000
}
```

加完后热加载：`POST /api/rules/reload` 或重启服务器。

---

## 部署到服务器

### 首次部署

```powershell
# 1. 打包
cd d:\wyproject_intresting\Getvideo
Compress-Archive -Path "server.js","rules.json","package.json","package-lock.json","public","deploy.sh" -DestinationPath "project.zip" -Force

# 2. 上传
scp -i "D:\翻墙\AWS2Singapore.pem" "d:\wyproject_intresting\Getvideo\project.zip" ubuntu@52.221.181.170:/home/ubuntu/

# 3. SSH 登录 + 初始化
ssh -i "D:\翻墙\AWS2Singapore.pem" ubuntu@52.221.181.170
# 登录后执行：
cd /home/ubuntu
mkdir -p getvideo
unzip -o project.zip -d getvideo/
cd getvideo
bash deploy.sh
```

### 更新代码

```powershell
cd d:\wyproject_intresting\Getvideo
Remove-Item "project.zip" -ErrorAction SilentlyContinue
Compress-Archive -Path "server.js","rules.json","package.json","package-lock.json","public","deploy.sh" -DestinationPath "project.zip" -Force
scp -i "D:\翻墙\AWS2Singapore.pem" "project.zip" ubuntu@52.221.181.170:/home/ubuntu/
ssh -i "D:\翻墙\AWS2Singapore.pem" ubuntu@52.221.181.170 "cd /home/ubuntu && unzip -o project.zip -d getvideo/ > /dev/null 2>&1 && cd getvideo && npm install --production 2>&1 | tail -1 && pm2 restart getvideo"
```

---

## 服务器运维命令

```powershell
# SSH 登录
ssh -i "D:\翻墙\AWS2Singapore.pem" ubuntu@52.221.181.170

# 登录后常用：
pm2 status              # 查看进程状态
pm2 logs getvideo       # 实时日志（Ctrl+C 退出）
pm2 logs getvideo --lines 50  # 最近 50 行
pm2 restart getvideo    # 重启服务
pm2 stop getvideo       # 停止服务
pm2 start getvideo      # 启动服务
pm2 flush               # 清理日志文件

# 服务器资源
htop                    # CPU/内存（先 apt install htop）
df -h                   # 磁盘使用
free -h                 # 内存使用
uptime                  # 运行时间 + 负载

# 测试 API
curl http://localhost:3000/api/info
curl "http://localhost:3000/api/search?keyword=电影"

# 端口检查
sudo netstat -tlnp | grep -E '80|3000'
sudo iptables -t nat -L PREROUTING -n

# 端口转发规则恢复（如果丢失）
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000
sudo netfilter-persistent save
```

---

## 费用清单

### 当前（AWS 免费期内）

| 项目 | 免费额度 | 你的情况 | 超出费用 |
|------|---------|---------|---------|
| EC2 实例 | 750 小时/月（第一年） | ✅ 免费 | ~$8-15/月 |
| 出站流量 | 100GB/月 | ✅ 几乎不消耗 | $0.09/GB |
| EBS 存储 | 30GB/月（第一年） | ✅ 够用 | $0.10/GB/月 |
| 弹性 IP | 实例运行时免费 | ✅ 免费 | 停机后 $0.005/小时 |

### 免费期到期后

| 方案 | 费用 | 说明 |
|------|------|------|
| 继续用 AWS | ~$8-15/月 | t3.micro 最便宜 |
| 迁移到 Oracle Cloud | **永久免费** | Always Free 实例 |
| 迁移到国内云 | ~¥30-50/月 | 需要 ICP 备案 |

### 查看免费期剩余时间

1. 登录 https://console.aws.amazon.com/billing
2. 左侧点 **Bills** → 查看每月账单
3. 左侧点 **Free tier** → 查看各项免费额度和到期时间

---

## 续费与维护清单

### 每月必做（5 分钟）

| # | 操作 | 怎么做 | 不做会怎样 |
|---|------|--------|-----------|
| 1 | 查 AWS 账单 | AWS 控制台 → Billing | 可能被意外扣费 |
| 2 | 确认实例在运行 | AWS → EC2 → Instances → 看状态 | 实例停了网站打不开 |
| 3 | 测试网站 | 手机打开 `http://52.221.181.170` 搜一部电影 | 发现问题及时处理 |

### 每周可选（2 分钟）

| # | 操作 | 怎么做 |
|---|------|--------|
| 1 | 检查资源站 | 搜索几部不同电影看有没有结果 |
| 2 | 查看日志 | SSH → `pm2 logs getvideo --lines 20` |
| 3 | 检查磁盘 | SSH → `df -h` |

### 每季度可选（10 分钟）

| # | 操作 | 怎么做 |
|---|------|--------|
| 1 | 系统更新 | SSH → `sudo apt update && sudo apt upgrade -y` |
| 2 | 清理日志 | SSH → `pm2 flush` |
| 3 | 检查 Node 版本 | SSH → `node --version` |

### 时间线提醒

| 时间点 | 操作 |
|--------|------|
| **现在** | 确认 AWS 免费期到期日（Billing → Free tier） |
| **现在** | 把 SSH 密钥备份一份到 U 盘 |
| **每月 1 号** | 查账单 + 测试网站 |
| **免费期到期前 1 个月** | 决定续费还是迁移 |
| **搜索结果变少时** | 检查资源站，更新 rules.json |
| **网站打不开时** | 按下方排查步骤处理 |

---

## 资源站维护

### 为什么会失效

- 站点域名更换（最常见）
- API 接口变更
- 站点被关站
- CDN 域名被封

### 如何判断哪个站失效

```bash
# SSH 登录后测试
curl -s "http://localhost:3000/api/search?keyword=电影" | node -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  JSON.parse(d).results.forEach(s=>
    console.log(s.site+': '+s.results.length+'条'+(s.error?' ⚠'+s.error:' ✓'))
  );
})"
```

### 禁用失效站点

编辑 `rules.json`，把 `"enabled": true` 改为 `"enabled": false`，然后 `POST /api/rules/reload`。

---

## AWS 控制台操作

### 查看实例状态

1. 登录 https://console.aws.amazon.com/ec2
2. 左侧 **Instances** → 找到 IP `52.221.181.170`
3. **Instance state** = `Running` 即正常

### 停止/启动实例（省费用）

- 选中实例 → **Instance state** → **Stop instance**
- 停止后不计费 EC2 计算费用
- 要用时：**Start instance**
- ⚠️ 启动后 IP 可能会变

### 安全组配置

当前开放端口：

| 端口 | 协议 | 来源 | 用途 |
|------|------|------|------|
| 22 | TCP | 0.0.0.0/0 | SSH 登录 |
| 80 | TCP | 0.0.0.0/0 | HTTP 访问 |
| 3000 | TCP | 0.0.0.0/0 | 备用 HTTP |

修改：EC2 → Security groups → 选中 → **Edit inbound rules**

### 释放弹性 IP（不用时）

EC2 → Elastic IPs → 选中 → **Release**（不释放会收费）

---

## 安全防护

| 防护项 | 说明 |
|--------|------|
| SSRF 防护 | 禁止代理内网地址（127.0.0.1、192.168.*） |
| 文件类型拦截 | 禁止代理 .exe/.bat/.sh 等 |
| 协议限制 | 仅 http/https |
| Content-Type 白名单 | 仅视频/音频/m3u8 |
| 脚本注入检测 | URL 含 `<script>` 等拒绝 |
| 频率限制 | 每 IP 每秒 20 次 |
| URL 长度限制 | 最长 2048 字符 |

### SSH 密钥保管

- `D:\翻墙\AWS2Singapore.pem` 是唯一能登录服务器的密钥
- **丢了 = 永久失去服务器访问权**，需在 AWS 控制台重新生成
- **备份一份到 U 盘或网盘**

---

## 常见问题处理

### 网站打不开

```
1. ping 52.221.181.170           → 不通 = 网络问题或实例关了
2. AWS 控制台看实例状态           → 不是 Running = 启动实例
3. SSH 登录                       → 连不上 = 安全组没开 22 端口
4. pm2 status                     → 不是 online = pm2 start getvideo
5. curl http://localhost:3000/api/info → 不通 = 代码报错
6. pm2 logs getvideo --lines 20  → 看具体错误
```

### 搜索没有结果

```
1. SSH 登录
2. curl "http://localhost:3000/api/search?keyword=电影"
3. 全部 0 条 → 资源站可能全挂了，更新 rules.json
4. 部分 0 条 → 禁用失效站点
```

### 视频播放不了

```
1. 展开页面底部「调试日志」看具体错误
2. 系统自动：直连 → 全代理 → 换下一集
3. 全部失败 → 换一部影片
```

### SSH 密钥权限错误

```powershell
icacls "D:\翻墙\AWS2Singapore.pem" /inheritance:r
icacls "D:\翻墙\AWS2Singapore.pem" /grant:r "31054:F"
```

### PM2 进程不见了

```bash
cd /home/ubuntu/getvideo
pm2 start server.js --name getvideo
pm2 save
pm2 startup
```

### 端口 80 不通

```bash
sudo iptables -t nat -L PREROUTING -n
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000
sudo netfilter-persistent save
```

### 磁盘满了

```bash
df -h
pm2 flush
sudo apt autoremove -y
sudo apt clean
```

---

## 灾备与迁移

### 备份

```bash
cd /home/ubuntu
tar czf getvideo-backup-$(date +%Y%m%d).tar.gz getvideo/
```

### 迁移到 Oracle Cloud（永久免费）

1. 注册 https://cloud.oracle.com
2. 创建 Always Free 实例（Ubuntu，2C1G）
3. 上传 `project.zip` → 解压 → `deploy.sh`

### 迁移到其他服务器

只要装了 Node.js 18+，上传解压 → `npm install` → `pm2 start server.js` 即可。

---

## 更新 GitHub

```powershell
cd d:\wyproject_intresting\Getvideo
git add .
git commit -m "说明"
git push
```
