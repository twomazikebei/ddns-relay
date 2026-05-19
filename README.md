# ddns-relay

> 基于 Cloudflare Worker 的零成本、多域名 DDNS 中继服务。

## 这是什么

家用宽带的动态公网 IP,要解析到固定域名。传统做法是在家里的机器上放一份 CF API Token,定时调 CF API 更新。这个方案有两个缺点:

- Token 一旦泄露,整个 zone 都能被改
- 多台设备需要分别配置 Token

本项目把 Token 放进 Cloudflare Worker(由 CF 加密托管),家里只需要一个**只能操作白名单域名**的 secret。

```
家里脚本 ──(HTTPS + secret)──> CF Worker ──(CF API Token)──> 你的 DNS Zone
                                   │
                                   ├─ ALLOWED_DOMAINS 白名单
                                   └─ zone_id 自动反查
```

## 核心特性

- 🔐 **API Token 不下放**:Token 仅存在 Worker 加密环境变量
- 🛡️ **域名白名单**:`ALLOWED_DOMAINS` 限定可被更新的域名,泄露 secret 也只能操作白名单内域名
- ⚙️ **零配置 zone**:zone_id 由 Worker 自动反查并缓存,用户只需配置域名列表
- 🌐 **多域名 + 多 zone**:一个 Worker 自动支持单个 CF 账号下任意 zone 的任意子域名
- 🤖 **自动获取 IP**:Worker 从 `CF-Connecting-IP` 自动读取,客户端无需 curl 外部 IP 服务
- 🔀 **IPv4 / IPv6 自适应**:根据 IP 形态自动选择 A / AAAA 记录类型
- 💰 **零成本**:Cloudflare Worker 免费版 10 万次/天,远超 DDNS 需求

## 快速开始

### 1. 准备 CF API Token

`CF Dashboard → My Profile → API Tokens → Create Token` → 选 **"Edit zone DNS"** 模板,然后:

- 在 Permissions 区 **+ Add more**,加一行 `Zone` - `Zone` - `Read`(自动反查 zone_id 需要)
- Zone Resources:`Include` - `Specific zone` → 勾选所有要管理的 zone

保存 Token,只显示一次。

### 2. 部署 Worker

```bash
# 使用 Wrangler CLI
cd worker/
wrangler login
wrangler deploy
wrangler secret put CF_API_TOKEN     # 粘贴上一步生成的 Token
wrangler secret put SHARED_SECRET    # 粘贴你生成的 secret (openssl rand -hex 32)
```

或在 Cloudflare Dashboard 中粘贴 [worker/worker.js](worker/worker.js) 的代码。

### 3. 配置环境变量

在 Worker `Settings → Variables and Secrets` 设置:

| 变量名 | 类型 | 值 |
|---|---|---|
| `CF_API_TOKEN` | Secret | CF API Token(`Zone:DNS:Edit` + `Zone:Zone:Read`) |
| `SHARED_SECRET` | Secret | 客户端共享 secret(`openssl rand -hex 32`) |
| `ALLOWED_DOMAINS` | Plaintext | `["home.example.com","nas.example.com"]` |

### 4. 测试

```bash
curl -X POST https://ddns-relay.your-subdomain.workers.dev/ \
     -H "X-DDNS-Secret: <你的 SHARED_SECRET>"

# 期望: {"ok":true,"action":"created","name":"home.example.com","zone":"example.com",...}
```

### 5. 部署客户端

**Linux / macOS:**

```bash
sudo cp client/ddns-update.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/ddns-update.sh
sudo vim /usr/local/bin/ddns-update.sh    # 修改 WORKER_URL, SECRET, DOMAINS

# 加入 cron
(crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/ddns-update.sh") | crontab -
```

**Windows:** 见 [client/ddns-update.ps1](client/ddns-update.ps1) 顶部说明。

**Docker:** 见 [client/Dockerfile](client/Dockerfile)。

## API 速查

```
POST https://<worker-url>/[?name=<domain>][&ip=<ip>]
Header: X-DDNS-Secret: <SHARED_SECRET>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `name` | 否 | 要更新的完整域名,缺省取 ALLOWED_DOMAINS 首个 |
| `ip` | 否 | 显式 IP,缺省用 CF-Connecting-IP |

响应:

```json
{
  "ok": true,
  "action": "created" | "updated" | "unchanged",
  "name": "home.example.com",
  "type": "A",
  "ip": "1.2.3.4",
  "zone": "example.com"
}
```

## 新增一个域名

只需一步:把域名加入 Worker 的 `ALLOWED_DOMAINS`。

不需要查 zone_id,不需要改 Worker 代码,不需要在 CF Dashboard 预建 A 记录(Worker 首次调用时会自动创建)。

## 项目结构

```
ddns-relay/
├── README.md                  # 本文件
├── worker/
│   ├── worker.js              # Worker 主代码
│   └── wrangler.toml          # Wrangler 部署配置
├── client/
│   ├── ddns-update.sh         # Linux/macOS 客户端
│   ├── ddns-update.ps1        # Windows 客户端
│   ├── Dockerfile             # 容器化客户端
│   └── docker-compose.yml
└── docs/
    └── README.md              # 完整技术文档(部署、架构、运维、故障排查)
```

## 完整文档

详见 [docs/README.md](docs/README.md),包含:

- 架构设计与请求流程
- 完整部署步骤(Dashboard / Wrangler 两种方式)
- API 参考
- 运维操作(新增域名、轮换 secret、查看日志)
- 安全设计(威胁模型、配置清单)
- 故障排查
- 扩展指南(IPv6、频率限制、通知、多账号)

## 后续规划

如果未来需要更复杂的功能(多用户管理、配额、审计日志、跨多家 DNS 服务商如阿里云/腾讯云),可迁移到独立后端服务 **homing**——本项目客户端协议设计上已经预留了平滑迁移能力。

## License

MIT