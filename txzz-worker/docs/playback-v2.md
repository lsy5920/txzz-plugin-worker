# 播放会话 v2.1 与购买安全 schema v3

## 契约

`POST /v2/playback/session` 接收 `movieId`、`requestId`，以及可选的 `movieTitle`、`forceRefresh`、`bootstrapSession`。成功时返回：

```text
session
├── id / revision / movieId / title / phase
├── sources[]: id / label / url / protocol / role / health / media
├── decision: recommendedSourceId / reasonCodes / policyVersion
├── account: 脱敏账号摘要
├── acquisition: cache / direct / purchase + attempts
└── fetchedAt / expiresAt
```

扩展不得根据旧详情字段自行猜测购买状态；线路决策和获取摘要均以本会话为准。

## 唯一取源顺序

1. 读取 schema v3 且未过期的详情缓存。
2. 对全部可用账号逐一检查直链。
3. 任意账号出现有效主线或备用线，立即返回并禁止购买。
4. 汇总仍锁定的账号，从最低金币账号组随机选一个。
5. 获取数据库互斥锁并创建/读取幂等账本。
6. 购买成功先写 `charged`，再用原账号刷新详情。
7. 刷新成功写 `resolved` 并更新缓存；刷新失败写 `uncertain` 并停止。

返回会话前会并行探测最多 12 条候选线路。若地址是主清单，则继续解析变体清单；两条可用线路的覆盖时长差值同时超过 90 秒和短线路的 8% 时，优先较长线路。该规则比较同一视频的候选线路，不假设某个固定“完整时长”。普通 HTML 200、JSON 页面或未确认字段不会进入 `sources`；但疑似权益字段仍会阻止购买，避免因探测失败改用其他账号扣费。

## 账本状态

| 状态 | 含义 | 后续动作 |
| --- | --- | --- |
| `pending` | 已占用购买意图，尚未确认扣费 | 同请求继续；并发请求返回进行中 |
| `charged` | 上游已确认购买成功 | 只能用原账号刷新/对账 |
| `resolved` | 购买后详情已验证并返回线路 | 直接复用结果或缓存 |
| `failed_before_charge` | 已确认在扣费前失败 | 可以选择下一候选账号 |
| `uncertain` | 无法确认扣费或扣费后详情失败 | 只能人工或原账号对账，禁止二次购买 |

未知网络异常不能推断为购买前失败，必须写 `uncertain`。只有上游明确拒绝且确认未扣费时，才允许进入 `failed_before_charge`。

## 迁移与门禁

生产升级先确保 v2 已执行，再以事务执行 `migrations/2026-07-27-playback-v3.sql`。v3 新增 `txzz_purchase_attempts`、`attempt_id` 主键、`(request_id, movie_id, account_id)` 唯一约束、原子 begin/transition/expire RPC、旧账本镜像触发器和 schema v3 深度门禁，不删除旧缓存或旧账本。

合法数据库迁移固定为：

```text
pending → charged / failed_before_charge / uncertain
charged → resolved / uncertain
uncertain → resolved
resolved / failed_before_charge → 终态
```

超过 90 秒的 `pending` 自动转为 `uncertain`，不能推断为购买前失败。扣费后只有媒体探测确认并生成播放会话成功，才能写 `resolved`。

缺少迁移时：

- 现有直链仍可播放；
- 购买被禁用；
- `/v2/health` 返回 `ready: false`；
- `/v1/diagnostics` 增加高优先级迁移建议；
- GitHub Actions 发布门禁失败。

## v1 兼容期

`POST /v1/movie/full-detail` 调用同一个 PlaybackService，再映射旧字段。兼容响应带 Deprecation、Sunset 和 successor Link；Sunset 为 2026-08-26，删除适配器应单独发版，并以调用量归零为前提。

## 安全对账 API

- `GET /v2/purchases/reconciliation`：返回 `pending / charged / uncertain` 脱敏列表，不包含凭据、完整详情或原始签名 URL。
- `POST /v2/purchases/reconcile`：接收 `attemptId` 与 `reconciliationId`，只使用账本中的原账号重新请求详情，绝不调用 `doBuy`。
- 对账成功返回播放会话并转 `resolved`；失败继续保持 `uncertain`（或已有终态），错误只返回脱敏摘要与请求编号。

[2026-07-27 01:00] 新增播放会话 v2 与购买安全文档。
[2026-07-27 08:51] Worker 2.0.1 新增返回前 HLS 主/变体清单探测、相对时长完整线路选择与缓存决定纠偏。
[2026-07-27 10:15] Worker 2.0.2 新增完整 HLS 文本探测（已识别清单不发送 Range，无扩展名签名清单遇到 206 后自动无 Range 重取）、嵌套 `lines[]` 候选收集和按实际时长的主备线路重排。
[2026-07-27 19:25] Worker 2.1.0 / schema v3 新增请求级幂等 attempts、五态单向 RPC、stale pending 过期、旧账本镜像、原账号安全对账，以及 source media/revision/policyVersion；普通 HTML URL 与探测确认媒体正式分离。
