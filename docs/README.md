# Cloudflare Worker 多域名 DDNS 中继方案

## 技术文档 v1.1

---

## 目录

1. [方案概述](#1-方案概述)
2. [架构设计](#2-架构设计)
3. [前置准备](#3-前置准备)
4. [部署步骤](#4-部署步骤)
5. [Worker 代码](#5-worker-代码)
6. [客户端脚本](#6-客户端脚本)
7. [API 参考](#7-api-参考)
8. [运维操作](#8-运维操作)
9. [安全设计](#9-安全设计)
10. [故障排查](#10-故障排查)
11. [扩展指南](#11-扩展指南)

---

## 1. 方案概述

### 1.1 背景

家用宽带使用动态公网 IP,需要通过 DDNS 将固定域名解析到当前 IP,以便从外网访问家中服务(NAS、远程桌面、自建服务等)。直接在家用机器上存放 Cloudflare API Token 存在以下问题:

- API Token 泄露后攻击者可操作整个 zone 的全部 DNS 记录
- 多台家用设备需要分别配置 Token,管理麻烦
- Token 轮换需要逐台修改

### 1.2 设计目标

| 目标 | 实现方式 |
|---|---|
| API Token 不下放到家庭机器 | Token 仅存在 Cloudflare Worker 环境变量中 |
| 客户端配置极简 | 客户端只需 URL + 共享 secret |
| 限制操作范围到具体域名 | Worker 维护域名白名单(ALLOWED_DOMAINS) |
| 用户配置零心智 | zone_id 由 Worker 自动反查并缓存 |
| 支持多域名、多 zone | 单 CF 账号下任意 zone 自动支持 |
| IP 获取免依赖第三方 | Worker 从 `CF-Connecting-IP` 自动读取 |
| 支持 IPv4 / IPv6 | 根据 IP 形态自动选择 A / AAAA |
| 零成本运行 | 利用 Cloudflare Worker 免费额度(10 万次/天) |

### 1.3 适用场景

- 一个或多个家庭 / 远程站点,每个站点动态公网 IP
- 单个 Cloudflare 账号下的一个或多个域名
- 通过 cron / 计划任务定期(5 分钟)上报 IP

### 1.4 不适用场景

- DNS 不在 Cloudflare 托管(请使用对应服务商方案)
- 跨多个 CF 账号(需要见 11.5 多 Token 改造)
- 需要在 Worker 之外做复杂记录管理(请考虑独立后端服务)
- 客户端无法访问公网(Worker 必须可达)

### 1.5 v1.0 → v1.1 变更

| 项目 | v1.0 | v1.1 |
|---|---|---|
| 用户配置 | 域名 + zone_id 一对一映射 | 只配域名列表,zone_id 自动反查 |
| 配置变量 | `DOMAIN_MAP`(JSON 对象) | `ALLOWED_DOMAINS`(JSON 数组) |
| Token 权限 | `Zone:DNS:Edit` | `Zone:DNS:Edit` + `Zone:Zone:Read` |
| 新增域名 | 手动查 zone_id 填入 | 加一项到列表即可 |

---

## 2. 架构设计

### 2.1 拓扑

```
┌──────────────────┐      HTTPS         ┌────────────────────────┐
│  家庭设备 / 脚本  │ ─────────────────> │  Cloudflare Worker     │
│   cron 5min      │  Header: secret    │  (持有 CF API Token)   │
│   (Linux/Mac/Win)│  ?name=xxx&ip=xxx  │  (持有 ALLOWED_DOMAINS)│
└──────────────────┘                    │  (zone_id 缓存)         │
                                        └───────────┬────────────┘
                                                    │
                                                    │ Cloudflare DNS API
                                                    │ (查 zone / 查/创/改 record)
                                                    ▼
                                        ┌────────────────────────┐
                                        │  CF 托管的 DNS Zone    │
                                        │  - example.com         │
                                        │  - another.com         │
                                        └────────────────────────┘
```

### 2.2 关键组件

| 组件 | 职责 |
|---|---|
| **客户端脚本** | 定时调用 Worker,可携带显式域名/IP,不持有 CF Token |
| **Cloudflare Worker** | 鉴权、白名单校验、zone 自动反查、调用 CF DNS API |
| **环境变量** | 加密存储 CF Token 和 SHARED_SECRET |
| **ALLOWED_DOMAINS** | JSON 数组,规定"哪些域名可被更新" |
| **zone_id 缓存** | Worker 内存中的 Map,跨请求复用 zone 反查结果 |
| **CF DNS Zone** | 实际生效的 DNS 记录 |

### 2.3 请求处理流程

```
请求到达 Worker
   │
   ├─ ① 校验 HTTP 方法 (POST/GET)
   │     失败 → 405
   │
   ├─ ② 校验 SHARED_SECRET (Header 或 query)
   │     失败 → 401
   │
   ├─ ③ 解析 ALLOWED_DOMAINS (JSON 数组)
   │     失败 → 500 (配置错误)
   │
   ├─ ④ 确定目标域名 (?name= 或数组第一个元素)
   │
   ├─ ⑤ 白名单校验:精确匹配 ALLOWED_DOMAINS
   │     失败 → 403
   │
   ├─ ⑥ 确定客户端 IP (?ip= 或 CF-Connecting-IP)
   │     失败 → 400
   │
   ├─ ⑦ 判断记录类型 (A / AAAA)
   │     失败 → 400
   │
   ├─ ⑧ 自动反查 zone_id
   │     先查 zoneIdCache,命中 → 直接用
   │     未命中 → 从 FQDN 逐级剥离,试 GET /zones?name=<candidate>
   │     仍未命中 → 502
   │
   ├─ ⑨ 调用 CF API 查询现有记录
   │     ├─ 不存在 → 创建 (POST) → 返回 "created"
   │     ├─ 存在且 IP 相同 → 跳过 → 返回 "unchanged"
   │     └─ 存在且 IP 不同 → 更新 (PUT) → 返回 "updated"
   │
   └─ 返回 JSON 响应
```

### 2.4 zone_id 自动反查机制

**反查策略**:从完整域名(FQDN)逐级剥离子域,直到匹配到一个 zone。

例如 `a1.home.example.com`:

```
尝试 1: GET /zones?name=a1.home.example.com  →  []        未命中
尝试 2: GET /zones?name=home.example.com     →  []        未命中
尝试 3: GET /zones?name=example.com          →  [{id:abc, name:'example.com'}]  ✅
       缓存 {'example.com' → 'abc'}
       返回 zone_id = 'abc'
```

**缓存策略**:

- 缓存键是 **zone 名称**(`example.com`),不是 FQDN
- 后续查询 `nas.example.com` 时:遍历缓存,发现 FQDN 是 `example.com` 的子域 → 直接命中
- 缓存生命周期 = Worker isolate 生命周期(通常几小时到几天)
- isolate 重启后缓存丢失,首次查询再付一次反查代价

**为什么不用 KV 持久化**:zone_id 几乎不变,且每个 isolate 自己缓存就够用。引入 KV 增加复杂度但收益甚微。

### 2.5 数据流安全边界

| 数据 | 存储位置 |
|---|---|
| CF API Token | ✅ 仅 Worker 加密环境变量 |
| SHARED_SECRET | ✅ Worker 加密环境变量 + 客户端 |
| ALLOWED_DOMAINS | ✅ Worker 明文环境变量 |
| zone_id 缓存 | ⚠ Worker isolate 内存(非敏感,即使泄露也无意义) |
| 当前公网 IP | ⚠ 客户端可见(脚本本身知道) / CF 网络可见 |
| 域名列表 | ⚠ 客户端可见(脚本调用时使用) |

家庭客户端**永远不接触 CF API Token**,即使被入侵也只能操作白名单内的域名。

---

## 3. 前置准备

### 3.1 准备清单

- [x] 已注册 Cloudflare 账号
- [x] 至少一个域名已托管到 Cloudflare(NS 已切换并生效)
- [x] 能登录 Cloudflare Dashboard
- [x] 家庭设备能访问 `*.workers.dev`(国内一般可访问)

### 3.2 生成 Cloudflare API Token

1. 登录 Cloudflare Dashboard
2. 右上角头像 → **My Profile** → **API Tokens** → **Create Token**
3. 选择模板 **"Edit zone DNS"**
4. 配置 Token:

| 项 | 配置 |
|---|---|
| Token name | `ddns-relay-token` |
| Permissions | `Zone` - `DNS` - `Edit`(模板已预填),**点击 + Add more**,再加 `Zone` - `Zone` - `Read` |
| Zone Resources | `Include` - `Specific zone` → 勾选所有要管理的 zone(可多选) |
| Client IP Address Filtering | 留空(Worker 出口 IP 不固定) |
| TTL | 留空(永不过期)或按需 |

> ⚠ **重要变更**:相比 v1.0,Token 需要新增 **`Zone:Zone:Read`** 权限。Worker 通过这个权限自动反查 zone_id,使用户配置只需要域名列表。

5. **Continue to summary** → **Create Token**
6. **立即复制并保存 Token**(关闭后无法再查看)

> 推荐做法:为这套 DDNS 系统单独建一个 Token,与个人其他自动化分开,出问题时可单独吊销。

### 3.3 (可选)验证 Token 权限

```bash
# 验证 Zone:Read 权限
curl https://api.cloudflare.com/client/v4/zones?name=example.com \
  -H "Authorization: Bearer <TOKEN>"
# 期望返回该 zone 的详细信息(包含 id)

# 验证 Zone:DNS:Edit 权限(可选,部署后用真实 zone 测)
```

### 3.4 生成 SHARED_SECRET

任选一种方式生成一串高熵字符串:

```bash
# Linux / macOS
openssl rand -hex 32

# PowerShell
[Convert]::ToBase64String((1..32 | %{Get-Random -Maximum 256}))
```

保存这个字符串,后续 Worker 和客户端都要用到。

### 3.5 规划 ALLOWED_DOMAINS

提前列出所有需要 DDNS 的完整域名:

```
home.example.com
nas.example.com
qb.another.com
```

> 注意:**不必预先在 CF Dashboard 创建 A 记录**,Worker 第一次调用时会自动创建。

> 注意:这些域名所属的 zone 必须都在 **同一个 CF 账号** 且 **都在 Token 的 Zone Resources** 授权范围内。

---

## 4. 部署步骤

### 4.1 创建 Worker

**方式 A:Dashboard 在线创建(推荐新手)**

1. Dashboard 左侧栏 → **Workers & Pages**
2. **Create** → **Create Worker**
3. Worker 名称:`ddns-relay`(这将决定 URL:`https://ddns-relay.<子域>.workers.dev`)
4. **Deploy** → 创建一个默认 Hello World Worker
5. 部署完成后 → **Edit code**

**方式 B:Wrangler CLI(推荐有开发环境的用户)**

```bash
# 安装(需 Node.js 16+)
npm install -g wrangler

# 登录
wrangler login

# 进入项目目录
cd worker/

# 部署
wrangler deploy

# 设置 Secret
wrangler secret put CF_API_TOKEN
wrangler secret put SHARED_SECRET
```

### 4.2 粘贴 Worker 代码

在 Worker 编辑器中清空默认内容,粘贴 [worker/worker.js](../worker/worker.js) 的完整代码 → **Deploy**。

### 4.3 配置环境变量

进入 Worker 详情页 → **Settings** → **Variables and Secrets** → **Add variable**:

| 变量名 | Type | 值 |
|---|---|---|
| `CF_API_TOKEN` | **Secret**(选 Encrypt) | 3.2 中生成的 API Token |
| `SHARED_SECRET` | **Secret**(选 Encrypt) | 3.4 中生成的 secret |
| `ALLOWED_DOMAINS` | Plaintext | JSON 数组(见下) |

`ALLOWED_DOMAINS` 的值(**一行,不要换行**):

```json
["home.example.com","nas.example.com","qb.another.com"]
```

> ⚠ **重要**:`Secret` 类型加密存储且 Dashboard 中不可回显,只能重新设置;`Plaintext` 类型可在 Dashboard 中查看和修改。

保存后 Worker 自动重新部署,新变量立即生效。

### 4.4 验证部署

复制 Worker URL(形如 `https://ddns-relay.your-subdomain.workers.dev`)。

**测试 1:未鉴权应被拒绝**

```bash
curl -i https://ddns-relay.your-subdomain.workers.dev/
# 期望: HTTP/2 401  {"ok":false,"error":"unauthorized"}
```

**测试 2:鉴权成功,使用默认域名,验证 zone 自动反查**

```bash
curl -X POST https://ddns-relay.your-subdomain.workers.dev/ \
     -H "X-DDNS-Secret: 你的_SHARED_SECRET"

# 期望:
# {"ok":true,"action":"created","name":"home.example.com","type":"A",
#  "ip":"x.x.x.x","zone":"example.com"}
#
# 注意响应里有 "zone" 字段,确认 Worker 成功反查到了 zone
```

**测试 3:再调用一次,应跳过 + 命中 zone 缓存**

```bash
curl -X POST https://ddns-relay.your-subdomain.workers.dev/ \
     -H "X-DDNS-Secret: 你的_SHARED_SECRET"

# 期望: {"ok":true,"action":"unchanged",...}
# 此次没有调用 GET /zones,因为命中了进程内缓存
```

**测试 4:不在白名单的域名应被拒绝**

```bash
curl -X POST "https://ddns-relay.your-subdomain.workers.dev/?name=hack.example.com" \
     -H "X-DDNS-Secret: 你的_SHARED_SECRET"

# 期望: {"ok":false,"error":"domain not allowed: hack.example.com",...}
# 即使 hack.example.com 在 example.com zone 内,白名单没列出就拒绝
```

**测试 5:CF Dashboard 验证**

进入 `example.com` → DNS → Records,应能看到自动创建的 `home` A 记录,IP 为你的家庭公网 IP。

### 4.5 (可选)配置自定义域名

默认 URL `*.workers.dev` 偶有抽风,可绑定自己的子域名:

1. Worker 详情 → **Settings** → **Triggers** → **Custom Domains** → **Add Custom Domain**
2. 输入 `ddns-api.example.com`(前提:`example.com` 已托管在 CF)
3. CF 自动签发证书,几秒内生效

之后客户端使用 `https://ddns-api.example.com` 即可。

---

## 5. Worker 代码

代码见 [worker/worker.js](../worker/worker.js)。

核心逻辑:

- **入口**:`export default { fetch }` 形式的 ES Modules Worker
- **鉴权**:对比 `X-DDNS-Secret` Header(或 `?secret=` query)与环境变量
- **白名单**:在 `ALLOWED_DOMAINS` JSON 数组中精确匹配域名
- **zone 反查**:`resolveZoneId(fqdn)` 函数从 FQDN 逐级剥离子域名,试 `GET /zones?name=<candidate>` 找到 zone
- **缓存**:全局 `zoneIdCache` Map,以 zone 名称为 key
- **IP 自动获取**:`request.headers.get('CF-Connecting-IP')`
- **类型判断**:IPv4 → A,IPv6 → AAAA
- **决策**:CF API 查询 → 不存在则创建、IP 相同则跳过、不同则更新

---

## 6. 客户端脚本

### 6.1 Linux / macOS Bash 脚本

脚本见 [client/ddns-update.sh](../client/ddns-update.sh)。

部署:

```bash
sudo cp client/ddns-update.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/ddns-update.sh
sudo vim /usr/local/bin/ddns-update.sh   # 修改 WORKER_URL 和 SECRET
sudo touch /var/log/ddns.log
sudo chmod 644 /var/log/ddns.log

# 手动测试
/usr/local/bin/ddns-update.sh
cat /var/log/ddns.log
```

加入 cron:

```bash
crontab -e
```

添加:

```
*/5 * * * * /usr/local/bin/ddns-update.sh
```

### 6.2 Windows PowerShell 脚本

脚本见 [client/ddns-update.ps1](../client/ddns-update.ps1)。

部署(在脚本顶部注释中有完整的计划任务注册命令)。

### 6.3 Docker 部署

`Dockerfile` 和 `docker-compose.yml` 见 [client/](../client/) 目录。

```bash
cd client/
docker compose up -d
docker logs -f ddns-client
```

> 注意:Docker 容器内调用 Worker 时,`CF-Connecting-IP` 是 **容器宿主出公网时的 IP**(也就是家里的公网 IP),与裸机一致。

---

## 7. API 参考

### 7.1 端点

```
POST  https://<worker-url>/
GET   https://<worker-url>/      (兼容简单场景)
```

### 7.2 认证

| 方式 | 位置 | 字段 |
|---|---|---|
| HTTP Header(推荐) | Request Header | `X-DDNS-Secret: <SHARED_SECRET>` |
| Query 参数(兜底) | URL | `?secret=<SHARED_SECRET>` |

### 7.3 请求参数

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | 否 | string | 要更新的完整域名;不传则使用 `ALLOWED_DOMAINS` 的第一个 |
| `ip` | 否 | string | 显式 IP;不传则使用 `CF-Connecting-IP` 自动获取 |
| `secret` | 见上 | string | 共享 secret(不建议放 query,建议用 Header) |

### 7.4 响应

成功:

```json
{
  "ok": true,
  "action": "updated" | "created" | "unchanged",
  "name": "home.example.com",
  "type": "A" | "AAAA",
  "ip": "1.2.3.4",
  "zone": "example.com",
  "previous_ip": "1.2.3.0"
}
```

- `zone` 字段:本次操作所属的 zone 名称(由自动反查得到)
- `previous_ip`:仅 `action=updated` 时返回

失败:

```json
{
  "ok": false,
  "error": "错误描述",
  "detail": [...]
}
```

`detail` 在 CF API 返回错误时附带。

### 7.5 HTTP 状态码

| 状态码 | 含义 |
|---|---|
| 200 | 操作成功(包括 unchanged) |
| 400 | 请求参数错误(IP 不合法、缺少域名) |
| 401 | secret 错误或缺失 |
| 403 | 域名不在 `ALLOWED_DOMAINS` 白名单 |
| 405 | 使用了非 POST/GET 方法 |
| 500 | Worker 自身配置错误(`ALLOWED_DOMAINS` JSON 无效) |
| 502 | CF API 调用失败(包括 zone 反查失败) |

### 7.6 调用示例

```bash
# 1. 自动域名 + 自动 IP
curl -X POST https://w.example.com/ \
     -H "X-DDNS-Secret: $SECRET"

# 2. 显式域名,自动 IP
curl -X POST "https://w.example.com/?name=nas.example.com" \
     -H "X-DDNS-Secret: $SECRET"

# 3. 显式域名 + 显式 IP
curl -X POST "https://w.example.com/?name=nas.example.com&ip=1.2.3.4" \
     -H "X-DDNS-Secret: $SECRET"

# 4. GET 简易调用(便于路由器固件、嵌入式)
curl "https://w.example.com/?name=nas.example.com&secret=$SECRET"
```

---

## 8. 运维操作

### 8.1 新增一个域名

**v1.1 简化后只需一步**:

1. 编辑 Worker `ALLOWED_DOMAINS` 环境变量,加一项:

```json
["home.example.com","nas.example.com","new.example.com"]
```

2. 保存,Worker 自动重新部署
3. 客户端脚本的 `DOMAINS` 数组加一行(可选)
4. 等下次 cron 触发,或手动跑一次验证

**不需要做**:
- ❌ 不需要查 zone_id
- ❌ 不需要改 Worker 代码
- ❌ 不需要在 CF Dashboard 预建 A 记录

**前提**:新域名所属的 zone 必须在 Token 的 Zone Resources 授权范围内。如果是全新的 zone,需要先更新 Token 权限(见 8.6)。

### 8.2 删除一个域名

1. 从 `ALLOWED_DOMAINS` 移除该 key,保存
2. (可选)去 CF Dashboard 手动删除该 DNS 记录
3. 客户端脚本移除对应条目

### 8.3 轮换 SHARED_SECRET

1. 生成新 secret:`openssl rand -hex 32`
2. Worker `Settings → Variables and Secrets` → 编辑 `SHARED_SECRET` → 粘贴新值 → 保存
3. **同步更新所有客户端脚本中的 secret**
4. 旧 secret 即时失效,迁移期间客户端可能短暂报 401

### 8.4 轮换 CF_API_TOKEN

1. CF Dashboard `My Profile → API Tokens` → 创建新 Token(同样授权 `Zone:DNS:Edit` + `Zone:Zone:Read`)
2. Worker 环境变量 `CF_API_TOKEN` 替换为新 Token
3. 验证 Worker 工作正常
4. 回到 API Tokens 页面 → **吊销**旧 Token

### 8.5 查看 Worker 实时日志

**方式 1:Dashboard**

Worker 详情 → **Logs** → **Begin log stream**,实时查看所有请求和 console 输出。

**方式 2:Wrangler CLI**

```bash
wrangler tail ddns-relay
```

**方式 3:增加结构化日志**(可选改造)

在 Worker 关键节点加 `console.log`,会自动进入 Logs:

```javascript
console.log(JSON.stringify({
  event: 'ddns_update',
  name: recordName,
  zone: zoneName,
  ip: clientIP,
  action: 'updated'
}));
```

### 8.6 扩展到新 zone

如果新域名属于一个**目前 Token 未授权**的 zone:

1. CF Dashboard `My Profile → API Tokens` → 编辑现有 Token
2. **Zone Resources** → 新增勾选该 zone
3. 保存
4. 把新域名加入 `ALLOWED_DOMAINS`

> 注意:CF 的 API Token **不能在创建后修改 Zone Resources**(只能修改其他字段)。如需扩展授权 zone,需要**新建一个 Token 替换旧的**。这是 CF 的产品限制。

### 8.7 配置备份建议

`ALLOWED_DOMAINS`、`SHARED_SECRET`、`CF_API_TOKEN` 三项关键配置,建议在密码管理器(1Password / Bitwarden 等)中保存一份副本,并标注:

```
ddns-relay Worker
├── URL: https://ddns-relay.xxx.workers.dev
├── CF_API_TOKEN: (该 Token 的权限范围:edit DNS + read zone for X, Y)
├── SHARED_SECRET: ...
└── ALLOWED_DOMAINS: [...]
```

---

## 9. 安全设计

### 9.1 威胁模型与对策

| 威胁 | 影响 | 对策 |
|---|---|---|
| 家庭设备被入侵,secret 泄露 | 攻击者可修改白名单内域名的 IP | `ALLOWED_DOMAINS` 白名单限定操作范围;轮换 secret 后立即失效 |
| Worker URL 泄露 | 仍需 secret 才能调用 | secret 应足够长(≥32 字节随机) |
| CF Token 泄露(理论上仅泄露场景:Dashboard 被入侵) | 攻击者可操作授权范围内全部 DNS | Token 仅授权特定 zone;及时轮换 |
| 中间人篡改请求 | 篡改 IP / 域名 | HTTPS 全程加密;CF 不接受非 TLS 流量 |
| 重放攻击 | 重发旧请求 | DDNS 场景下重放等同于"再上报一次相同 IP",影响可忽略 |
| Worker 被高频调用刷流量 | 超过免费额度(10 万/天) | 加 IP / 频率限制(见 11.2) |
| 攻击者拿到 secret 后尝试操作 zone 内其他记录 | 即使域名属于授权 zone,白名单外仍被拒 | `ALLOWED_DOMAINS` 严格精确匹配 |

### 9.2 关于白名单的重要性

v1.1 的 zone_id 由 Worker 自动反查,这意味着如果**没有** `ALLOWED_DOMAINS` 白名单,攻击者拿到 secret 后只要传一个属于授权 zone 的任意域名,就能修改它。

因此 **`ALLOWED_DOMAINS` 是关键安全防线**——它和 zone_id 解耦后,这层防御绝对不能放宽:

- ✅ 精确匹配:`allowedDomains.includes(recordName)`
- ❌ 不要做后缀匹配:不要写成 "凡是 `*.example.com` 都允许"
- ❌ 不要做正则:容易写错放过攻击者

### 9.3 安全配置清单

- [x] API Token 授予 **Zone:DNS:Edit** + **Zone:Zone:Read**,且 **Zone Resources 限定到特定 zone**
- [x] SHARED_SECRET ≥ 32 字节随机熵,使用 `openssl rand` 等密码学安全 RNG 生成
- [x] CF_API_TOKEN 和 SHARED_SECRET 设置为 **Secret 类型**(加密)
- [x] ALLOWED_DOMAINS 严格列出允许的完整域名(精确匹配,不要用通配符)
- [x] 客户端脚本文件权限 600(只有 owner 可读),防止其他用户读取
- [x] 不要把 SHARED_SECRET 提交到 git 仓库
- [x] 定期(如每年)轮换 SHARED_SECRET 和 CF_API_TOKEN

### 9.4 关于 IP 信任

`CF-Connecting-IP` 由 Cloudflare 边缘节点注入,**客户端无法伪造**,可信任。

但如果客户端通过 `?ip=` 显式传 IP,Worker 接受该值——这是有意设计,允许从代理后面或脚本所在机器并非家庭网络时上报。如果你不希望客户端覆盖 IP,可移除代码中 `const explicitIP = url.searchParams.get('ip');` 这一行。

---

## 10. 故障排查

### 10.1 常见问题对照

| 现象 | 可能原因 | 排查 |
|---|---|---|
| 401 unauthorized | secret 不匹配 | 检查脚本和 Worker 变量是否一致;Header 拼写 `X-DDNS-Secret` |
| 403 domain not allowed | 域名未在 ALLOWED_DOMAINS | 检查 JSON 数组是否包含该域名(精确匹配) |
| 500 ALLOWED_DOMAINS must be JSON array | 配置格式错误 | 必须是 `["a","b"]` 形式的 JSON 数组,不是 `{"a":"b"}` 对象 |
| 502 resolve zone failed: no zone found | Worker 无法反查 zone | 检查域名所属 zone 是否在 Token 的 Zone Resources 内 |
| 502 resolve zone failed: 9109/9007 | Token 权限不足 | 检查 Token 是否有 `Zone:Zone:Read` 权限 |
| 502 list/create/update failed | CF API 调用失败 | 看 `detail` 字段;常见为 Token 权限或 zone 状态 |
| 客户端 curl 报超时 | Worker URL 访问不通 | 试 `curl -v https://<url>`;检查家庭网络对 workers.dev 的访问 |
| `CF-Connecting-IP` 取到内网 IP | 客户端通过隧道/VPN 出网 | 用 `?ip=` 显式传或调整出网路径 |
| Worker 显示 "Internal error" | 代码运行抛异常 | 看 Logs 实时流;一般是 fetch 抛 timeout |

### 10.2 排查命令清单

**Worker 是否能联通:**

```bash
curl -i https://ddns-relay.xxx.workers.dev/ -H "X-DDNS-Secret: $SECRET"
```

**当前从家里看到的公网 IP:**

```bash
curl https://www.cloudflare.com/cdn-cgi/trace | grep ^ip=
```

**直接测试 Token 的 Zone:Read 权限:**

```bash
curl "https://api.cloudflare.com/client/v4/zones?name=example.com" \
  -H "Authorization: Bearer $CF_API_TOKEN"
# 成功 → 应返回该 zone 的详细信息
# 失败 (code 9109) → Token 缺少 Zone:Zone:Read 权限,需新建 Token
```

**直接测试 Token 的 Zone:DNS:Edit 权限:**

```bash
curl "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN"
# 成功 → DNS 编辑权限正常
```

**查看 DNS 实际生效:**

```bash
dig home.example.com +short
# 或
nslookup home.example.com 1.1.1.1
```

### 10.3 客户端日志解读

```
2026-05-19 10:00:01 OK   [home.example.com]: created -> 1.2.3.4
2026-05-19 14:00:01 OK   [home.example.com]: updated -> 1.2.3.99
2026-05-19 14:05:01 FAIL [home.example.com]: empty response
```

频繁出现 FAIL → 检查家庭出网、CF 节点可达性。

---

## 11. 扩展指南

### 11.1 同时维护 IPv4 和 IPv6

调用两次,分别强制 IPv4 / IPv6 出网:

```bash
curl -4 -X POST "https://w.example.com/?name=home.example.com" \
     -H "X-DDNS-Secret: $SECRET"
curl -6 -X POST "https://w.example.com/?name=home.example.com" \
     -H "X-DDNS-Secret: $SECRET"
```

Worker 会根据 `CF-Connecting-IP` 自动识别为 A / AAAA。

### 11.2 增加频率限制

利用 Cloudflare KV 存储记录每个 secret 的最近调用时间:

```javascript
// 在 Worker 顶部加,需先在 Settings → Bindings 绑定 KV namespace 为 RATE_KV
const minIntervalMs = 30 * 1000;
const lastKey = `last:${hashSecret(secret)}`;
const last = await env.RATE_KV.get(lastKey);
if (last && Date.now() - parseInt(last) < minIntervalMs) {
  return json({ ok: false, error: 'too frequent' }, 429);
}
await env.RATE_KV.put(lastKey, Date.now().toString(), { expirationTtl: 3600 });
```

### 11.3 IP 变更通知(企业微信 / Server酱)

在 Worker 的 `action: 'updated'` 分支后,异步调用 webhook:

```javascript
if (action === 'updated' && env.NOTIFY_WEBHOOK) {
  ctx.waitUntil(fetch(env.NOTIFY_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: `[DDNS] ${recordName} 已更新: ${record.content} → ${clientIP}` }
    })
  }));
}
```

并在 Worker 加 `NOTIFY_WEBHOOK` 环境变量。

### 11.4 dry-run 模式

调试时只想看 Worker 会做什么、不真改 DNS:

```javascript
const dryRun = url.searchParams.get('dryRun') === 'true';
// ... 反查 zone 后:
if (dryRun) {
  return json({
    ok: true,
    action: 'dryrun',
    wouldDo: { name: recordName, zone: zoneName, ip: clientIP },
  });
}
```

### 11.5 跨 CF 账号的多 Token 场景

v1.1 默认设计假设所有域名属于**单个 CF 账号**。如果你有跨账号的需求,需要给每个 zone 配单独的 Token。

把 `ALLOWED_DOMAINS` 改造成对象形式:

```json
{
  "home.example.com": "CF_TOKEN_A",
  "qb.another.com":   "CF_TOKEN_B"
}
```

Worker 代码相应调整:

```javascript
const tokenVar = allowedDomains[recordName];
const apiToken = env[tokenVar];
```

并新增 `CF_TOKEN_A`、`CF_TOKEN_B` 两个 Secret。zone 反查时分别用对应 Token。

### 11.6 KV 持久化 zone 缓存

如果 Worker isolate 经常重启(高频部署、流量稀少),反查代价积累起来不小。可以用 KV 持久化:

```javascript
// 反查前先查 KV
const cached = await env.ZONE_KV.get(`zone:${candidate}`);
if (cached) return JSON.parse(cached);

// 查到后写入 KV(7 天 TTL)
await env.ZONE_KV.put(`zone:${zoneName}`, JSON.stringify({ zoneId, zoneName }),
                     { expirationTtl: 7 * 24 * 3600 });
```

实际 DDNS 场景下进程内 Map 足够,这个改造仅在极端场景下有意义。

---

## 附录 A:文件清单

```
ddns-relay/
├── README.md                  # 项目概览
├── worker/
│   ├── worker.js              # Worker 主代码
│   └── wrangler.toml          # Wrangler 配置
├── client/
│   ├── ddns-update.sh         # Linux/macOS 客户端
│   ├── ddns-update.ps1        # Windows 客户端
│   ├── Dockerfile             # 容器化客户端
│   └── docker-compose.yml
└── docs/
    └── README.md              # 完整技术文档
```

## 附录 B:版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-05-19 | 初始版本,支持多域名映射(`DOMAIN_MAP` 域名→zone_id)、IPv4/IPv6、白名单 |
| 1.1 | 2026-05-19 | zone_id 自动反查并缓存;配置简化为 `ALLOWED_DOMAINS` 域名列表;Token 新增 `Zone:Zone:Read` 权限 |

## 附录 C:从 v1.0 升级到 v1.1

如果你已经部署了 v1.0,升级步骤:

1. **更新 CF API Token 权限**:CF 不支持修改已有 Token 的 Zone Resources,但可以**加权限**:
   - Dashboard → API Tokens → 编辑现有 Token → Permissions → + Add more → `Zone` - `Zone` - `Read` → 保存
2. **替换 Worker 代码**:用本仓库 `worker/worker.js` 的最新代码
3. **修改环境变量**:
   - 删除 `DOMAIN_MAP`
   - 新增 `ALLOWED_DOMAINS`,值为 `DOMAIN_MAP` 的所有 key 组成的 JSON 数组
4. **客户端无需改动**:协议完全兼容

回滚:把 Worker 代码恢复到 v1.0,删除 `ALLOWED_DOMAINS`,恢复 `DOMAIN_MAP`。

## 附录 D:许可与免责

- 本方案使用 Cloudflare Workers 免费计划,请遵守 [Cloudflare Workers 服务条款](https://www.cloudflare.com/terms/)
- 本方案不为 DNS 生效时间提供 SLA;`TTL=60` 仅供参考,实际生效受 resolver 缓存影响