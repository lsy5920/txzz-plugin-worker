# 远程账号池 Worker

远程账号池 Worker 是「糖心志者」插件的服务端中间层，负责账号凭据加密保存、云端账号摘要读取、账号轮换、完整详情请求和账号权益摘要返回。

## 项目介绍

浏览器插件不适合直接保存完整账号凭据和服务端密钥。本 Worker 将敏感逻辑移到 Cloudflare，使用 Supabase 存储加密后的账号凭据，并向插件返回脱敏数据。插件只需要保存 Worker 地址，即可使用云端账号池能力。

## 环境要求

- Node.js `22.16.0` 及以上
- npm `10.0.0` 及以上
- Wrangler `4.98.0`
- Cloudflare Worker
- Supabase
- PowerShell `5.1` 及以上
- 文件编码：UTF-8

## 核心功能

- `/v1/health` 健康检查和运行时密钥状态诊断
- `/v1/accounts` 云端账号池读取和管理写入
- `/v1/accounts/client-upload` 插件侧本地账号上传云端
- `/v1/accounts/seed` 从环境变量写入默认账号池
- `/v1/accounts/verify` 验证指定账号可用性
- `/v1/movie/full-detail` 获取完整详情并返回给插件
- `/v1/media/proxy` 可选媒体代理接口
- 账号凭据 AES-GCM 加密保存
- 云端账号状态摘要脱敏返回
- 固定账号、随机轮换和坏账号跳过策略

## 项目目录结构

```text
txzz-worker/
├── src/
│   └── worker.js          # Worker 主入口和全部接口逻辑
├── schema.sql             # Supabase 表结构和索引
├── package.json           # npm 脚本和固定依赖版本
├── wrangler.toml          # Cloudflare Worker 配置
├── .dev.vars.example      # 本地环境变量示例
└── README.md              # 当前文档
```

## 安装依赖

```powershell
cd .\txzz-worker
npm install
npm run check
```

`package.json` 已固定依赖：

```json
{
  "devDependencies": {
    "wrangler": "4.98.0"
  }
}
```

## Supabase 初始化

1. 打开 Supabase 控制台。
2. 进入目标项目。
3. 打开 SQL Editor。
4. 复制 `schema.sql` 全部内容。
5. 粘贴并执行。

主要数据表：

| 表名 | 用途 |
| --- | --- |
| `txzz_accounts` | 保存云端账号摘要和加密凭据。 |
| `txzz_full_detail_cache` | 缓存完整详情结果，降低重复请求。 |
| `txzz_audit_logs` | 保存账号验证、详情获取和接口调用审计记录。 |

## 环境变量

### 必填变量

| 变量名 | 说明 |
| --- | --- |
| `SUPABASE_URL` | Supabase 项目地址。 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务端密钥，只能放在 Worker 侧。 |
| `TXZZ_API_AES_KEY` | 目标接口加密密钥。 |
| `TXZZ_CREDENTIAL_KEY` | 账号凭据加密口令，建议使用高强度随机值。 |

### 可选变量

| 变量名 | 说明 |
| --- | --- |
| `TXZZ_PROXY_SIGNING_KEY` | 媒体代理签名密钥。 |
| `TXZZ_SEED_ACCOUNTS_JSON` | 默认账号池 JSON，用于 `/v1/accounts/seed`。 |
| `TXZZ_TARGET_BASE_URL` | 目标接口基础地址，默认在 `wrangler.toml` 中配置。 |
| `TXZZ_API_VERSION` | 接口版本号。 |
| `TXZZ_API_SOURCE` | 接口来源标识。 |
| `TXZZ_CACHE_TTL_SECONDS` | 完整详情缓存时间。 |
| `TXZZ_PROXY_MEDIA` | 是否启用媒体代理。 |

## 本地配置

复制示例文件：

```powershell
Copy-Item .\.dev.vars.example .\.dev.vars
```

`.dev.vars` 示例：

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=只填写 Supabase service_role
TXZZ_API_AES_KEY=目标接口加密密钥
TXZZ_CREDENTIAL_KEY=随机高强度账号凭据加密口令
TXZZ_SEED_ACCOUNTS_JSON=[{"id":"full-demo","label":"示例完整账号","username":"demo","password":"demo-password"}]
```

生成随机令牌示例：

```powershell
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

## 本地运行

```powershell
npm run dev
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/health
```

同步账号池：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/accounts
```

写入种子账号：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/accounts/seed
```

## 部署到 Cloudflare

设置生产环境密钥：

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TXZZ_API_AES_KEY
npx wrangler secret put TXZZ_CREDENTIAL_KEY
npx wrangler secret put TXZZ_PROXY_SIGNING_KEY
npx wrangler secret put TXZZ_SEED_ACCOUNTS_JSON
```

发布：

```powershell
npm run deploy
```

发布后访问：

```text
https://<你的服务名>.<你的账号>.workers.dev/v1/health
```

## GitHub Actions 部署

如果通过仓库根目录的 GitHub Actions 部署，需要在 GitHub Secrets 中配置：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TXZZ_API_AES_KEY
TXZZ_CREDENTIAL_KEY
TXZZ_PROXY_SIGNING_KEY
TXZZ_SEED_ACCOUNTS_JSON
```

部署成功后，在 Actions Summary 中查看 Worker 地址。

## 接口说明

### `GET /v1/health`

用于健康检查和运行时诊断。

返回内容包含：

- 服务状态
- 构建标识
- 必填密钥是否存在
- 当前缓存和配置摘要

不会返回任何密钥明文。

### `GET /v1/accounts`

读取云端账号池摘要。

无需请求头。

返回内容只包含脱敏摘要，例如账号 ID、显示名称、状态、是否有密码、是否有二维码凭证、普通 VIP、尤物圈和金币余额，不返回凭证明文。

### `POST /v1/accounts`

管理端写入或更新云端账号。

无需请求头。

示例：

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{
    account = @{
      id = "full-demo"
      label = "示例账号"
      username = "demo"
      password = "demo-password"
      enabled = $true
      source = "password"
      notes = "示例账号"
    }
  } | ConvertTo-Json -Depth 5) `
  -Uri http://127.0.0.1:8787/v1/accounts
```

### `POST /v1/accounts/client-upload`

插件侧上传本地账号到云端。

无需请求头。

上传成功后，账号凭据会加密保存，插件再次同步时只看到云端摘要。
云端摘要会返回 `hasPassword`、`hasQrcode`、`hasToken` 等凭据类型标记，但不会返回任何凭证明文。

### `POST /v1/accounts/seed`

将 `TXZZ_SEED_ACCOUNTS_JSON` 中的默认账号写入 Supabase。

无需请求头。

### `POST /v1/accounts/verify`

验证指定账号是否可用，并更新账号摘要中的普通 VIP、尤物圈和金币余额。无需请求头。

### `POST /v1/movie/full-detail`

由插件调用，用于获取完整详情。

无需请求头。

常见请求字段：

```json
{
  "movieId": "12345",
  "accountMode": "cloud",
  "accountId": ""
}
```

账号模式：

| 模式 | 说明 |
| --- | --- |
| `cloud` | 云端随机轮换，选中账号只作为优先尝试对象。 |
| `cloud-fixed` | 固定使用指定账号。 |
| `cloud-first` | 云端优先，插件侧可进行本地兜底。 |

### `GET /v1/media/proxy`

可选媒体代理接口。是否启用由 `TXZZ_PROXY_MEDIA` 控制。

## 账号加密说明

账号凭据不会明文写入 Supabase。Worker 使用 `TXZZ_CREDENTIAL_KEY` 对凭据进行 AES-GCM 加密，写入字段为 `secret_box`。插件读取账号池时，只能获得脱敏摘要。

建议：

- `TXZZ_CREDENTIAL_KEY` 使用独立高强度随机值。
- 密钥泄露后立即轮换。
- 轮换密钥后，需要重新上传云端账号凭据。

## 常见问题排查

### `/v1/health` 提示缺少密钥

1. 确认本地 `.dev.vars` 或 Cloudflare Secrets 已配置对应变量。
2. 重新运行 `npm run dev` 或重新部署 Worker。
3. 如果使用 GitHub Actions，确认 GitHub Secrets 没有漏填。

### `/v1/accounts` 返回空或请求失败

1. 确认 Supabase 已执行 `schema.sql`。
2. 访问 `/v1/health` 查看必填变量是否齐全。
3. 确认 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 没有填错。

### 账号池为空

1. 确认 Supabase 已执行 `schema.sql`。
2. 调用 `/v1/accounts/seed` 写入默认账号。
3. 检查 `TXZZ_SEED_ACCOUNTS_JSON` 是否为合法 JSON。
4. 检查 `txzz_accounts` 表中是否有启用账号。

### 完整详情获取失败

1. 检查账号摘要状态是否为可用。
2. 如果固定账号失败，切换为云端随机轮换再试。
3. 查看 Worker 日志中的接口错误。
4. 检查目标接口基础地址和接口密钥配置是否正确。

## 安全与隐私

- `.dev.vars` 不要提交到 GitHub。
- Supabase `service_role` 只能放在 Worker 侧。
- 完整账号密码、二维码凭证、token、deviceId 不要写入公开仓库。
- 日志中不要打印完整凭据。
- 已经暴露过的密钥应立即轮换。

## 版本说明

| 组件 | 版本 |
| --- | --- |
| Worker | `1.0.2` |
| Wrangler | `4.98.0` |
| Node.js | `22.16.0` 及以上 |
| 数据库 | Supabase |

## 更新日志

2026-06-09 16:08 【新增】新增远程 Worker 二维码凭证账号恢复能力，账号池可保存二维码凭证并在服务端恢复账号会话；同步固定 Wrangler 依赖版本为 `4.98.0`。
2026-06-09 16:21 【修复】优化云端账号轮换策略，非固定模式下选中账号只作为优先尝试对象，失败后继续轮换其他启用账号；新增 `cloud-fixed` 固定账号模式。
2026-06-09 19:47 【新增】新增 `/v1/health` 运行时诊断字段，返回构建标识和必填密钥存在状态，诊断结果不返回任何密钥明文。
2026-06-09 19:54 【修复】修复 Worker 发布后运行时密钥未注入的问题，GitHub Actions 改为使用 `wrangler deploy --secrets-file` 发布。
2026-06-09 21:35 【新增】新增 `/v1/accounts/client-upload` 客户端上传接口，插件可将本地完整账号上传为云端加密凭证；同时默认轮换跳过错误状态账号。
2026-06-12 23:36 【优化】重写 Worker README 为 GitHub 风格文档，补充环境变量、部署教程、接口说明、账号加密说明、常见问题、安全说明和版本说明。
2026-06-13 00:13 【修复】优化云端账号摘要兼容逻辑，确保上传后的账号返回凭据类型标记。
2026-06-13 00:27 【优化】放开插件常用接口的令牌填写要求，账号同步、账号上传、账号验证和完整详情获取只需 Worker 地址；云端账号摘要补充普通 VIP、尤物圈和金币余额字段。
