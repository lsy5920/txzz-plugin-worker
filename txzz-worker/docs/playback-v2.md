# 播放会话 v2 与购买安全

## 契约

`POST /v2/playback/session` 接收 `movieId`、`requestId`，以及可选的 `movieTitle`、`forceRefresh`、`bootstrapSession`。成功时返回：

```text
session
├── id / movieId / title / phase
├── sources[]: id / label / url / protocol / health
├── decision: recommendedSourceId / reason
├── account: 脱敏账号摘要
├── acquisition: cache / direct / purchase + attempts
└── fetchedAt / expiresAt
```

扩展不得根据旧详情字段自行猜测购买状态；线路决策和获取摘要均以本会话为准。

## 唯一取源顺序

1. 读取 schema v2 且未过期的详情缓存。
2. 对全部可用账号逐一检查直链。
3. 任意账号出现有效主线或备用线，立即返回并禁止购买。
4. 汇总仍锁定的账号，从最低金币账号组随机选一个。
5. 获取数据库互斥锁并创建/读取幂等账本。
6. 购买成功先写 `charged`，再用原账号刷新详情。
7. 刷新成功写 `resolved` 并更新缓存；刷新失败写 `uncertain` 并停止。

返回会话前会并行探测主备 HLS。若地址是主清单，则继续解析最多四个变体清单；两条可用线路的覆盖时长差值同时超过 90 秒和短线路的 8% 时，优先较长线路。该规则比较同一视频的候选线路，不假设某个固定“完整时长”。缓存命中只跳过账号与详情请求，仍会重新核对线路完整度，避免沿用旧的短线决定。

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

生产升级先执行 `migrations/2026-07-27-playback-v2.sql`。迁移新增缓存版本/过期列、`txzz_purchase_locks`、跨实例锁 RPC、`txzz_purchase_ledger`、索引、RLS、更新时间触发器和 `txzz_playback_schema_status()`，不删除旧缓存。

缺少迁移时：

- 现有直链仍可播放；
- 购买被禁用；
- `/v2/health` 返回 `ready: false`；
- `/v1/diagnostics` 增加高优先级迁移建议；
- GitHub Actions 发布门禁失败。

## v1 兼容期

`POST /v1/movie/full-detail` 调用同一个 PlaybackService，再映射旧字段。兼容响应带 Deprecation、Sunset 和 successor Link；Sunset 为 2026-08-26，删除适配器应单独发版，并以调用量归零为前提。

[2026-07-27 01:00] 新增播放会话 v2 与购买安全文档。
[2026-07-27 08:51] Worker 2.0.1 新增返回前 HLS 主/变体清单探测、相对时长完整线路选择与缓存决定纠偏。
