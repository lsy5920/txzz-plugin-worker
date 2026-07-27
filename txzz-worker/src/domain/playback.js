"use strict";

function looksPlayableLink(value) {
  const text = String(value || "").trim();
  return /(?:\.m3u8|\.mp4|\/m3u8\/|\/h5\/m3u8\/|\/vod\/|\/video\/|\/media\/|\/link\/)/i.test(text);
}

/**
 * VIP 线路可能是无扩展名签名地址。为避免误扣金币，只排除空值和常见占位值，
 * 不能把“必须包含 .m3u8”当作已解锁的判断条件。
 */
function hasReturnedPlayLink(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return Boolean(text && !/^(?:null|undefined|false|none|nil|0|n|no|暂无|无|未购买|未解锁)$/i.test(text));
}

function collectPlayableLinks(value, bucket = [], trail = []) {
  // 完整线路常在详情末尾的 lines/sourceList 中。限制过小会先被封面或推荐媒体
  // 占满，64 条既能覆盖真实响应，也能约束异常深层对象的扫描成本。
  if (!value || bucket.length >= 64) return bucket;
  if (typeof value === "string") {
    const keyHint = trail.join(".").toLowerCase();
    const explicitPlaybackField = /play|backup|m3u8|mp4|video|media|source|src|file|lines?|streams?/.test(keyHint);
    const genericUrlField = /url/.test(keyHint);
    // 普通 url 字段仍要求明确的视频特征，避免把封面地址误判为播放线路。
    if ((explicitPlaybackField && hasReturnedPlayLink(value)) || (genericUrlField && looksPlayableLink(value))) {
      bucket.push({ key: keyHint, url: value.trim() });
    }
    return bucket;
  }
  if (Array.isArray(value)) {
    value.slice(0, 48).forEach((item, index) => collectPlayableLinks(item, bucket, [...trail, String(index)]));
    return bucket;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (bucket.length >= 64) break;
      collectPlayableLinks(item, bucket, [...trail, key]);
    }
  }
  return bucket;
}

function playbackCandidatePriority(key = "") {
  const hint = String(key || "").toLowerCase();
  let score = 0;
  if (/play[_-]?link|playurl|main|primary/.test(hint)) score += 120;
  if (/backup|second|spare|mirror|line/.test(hint)) score += 90;
  if (/m3u8|mp4|video|media|source|src|link|file/.test(hint)) score += 40;
  // 试看地址仍可播放，但不能压过同一详情中的完整线路。
  if (/preview|trailer|sample|clip|trial|试看|片段/.test(hint)) score -= 180;
  return score;
}

function collectPlaybackCandidates(detail = {}, summary = {}) {
  const rows = collectPlayableLinks({ ...detail, summary });
  const seen = new Set();
  return rows
    .map((row) => ({ ...row, priority: playbackCandidatePriority(row.key) }))
    .filter((row) => {
      const url = String(row.url || "").trim();
      if (!hasReturnedPlayLink(url) || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .sort((left, right) => right.priority - left.priority);
}

function normalizeFullDetail(detail = null) {
  if (!detail || typeof detail !== "object") return detail;
  const links = collectPlayableLinks(detail);
  const directPlay = [
    detail.play_link,
    detail.playLink,
    detail.play_url,
    detail.playUrl,
    detail.m3u8,
    detail.m3u8_url,
    detail.m3u8Url,
    detail.video_url,
    detail.videoUrl,
    detail.media_url,
    detail.mediaUrl,
    looksPlayableLink(detail.url) ? detail.url : "",
    detail.src,
    detail.source,
    detail.file
  ].find(hasReturnedPlayLink);
  const directBackup = [
    detail.backup_link,
    detail.backupLink,
    detail.backup_url,
    detail.backupUrl,
    detail.second_play_link,
    detail.secondPlayLink
  ].find(hasReturnedPlayLink);
  // 占位字符串不能遮住其他真实线路，因此必须先通过有效性判断再选字段。
  const playLink = directPlay || links.find((item) => /play|m3u8|mp4|video|media|source|src|url|link|file/.test(item.key))?.url || "";
  const backupLink = directBackup || links.find((item) => /backup|second|spare|mirror/.test(item.key))?.url || "";
  return {
    ...detail,
    play_link: playLink,
    backup_link: backupLink
  };
}

function normalizeFullSummary(summary = {}, detail = null) {
  return {
    ...summary,
    playLink: hasReturnedPlayLink(summary.playLink) ? summary.playLink : detail?.play_link || "",
    backupLink: hasReturnedPlayLink(summary.backupLink) ? summary.backupLink : detail?.backup_link || ""
  };
}

function playableDetailReady(detail = null) {
  const normalized = normalizeFullDetail(detail);
  return Boolean(hasReturnedPlayLink(normalized?.play_link) || hasReturnedPlayLink(normalized?.backup_link));
}

/**
 * 疑似播放字段只用于“禁止购买”，不能直接进入播放器。这样即使上游给出无扩展名
 * 或暂时失效的权益链接，也不会因为探测失败而误触发金币购买。
 */
function hasPotentialPlaybackEntitlement(detail = null) {
  if (!detail || typeof detail !== "object") return false;
  const directKeys = [
    "play_link", "playLink", "play_url", "playUrl", "m3u8", "m3u8_url", "m3u8Url",
    "video_url", "videoUrl", "media_url", "mediaUrl", "backup_link", "backupLink",
    "backup_url", "backupUrl", "second_play_link", "secondPlayLink", "url", "src", "source", "file"
  ];
  if (directKeys.some((key) => hasReturnedPlayLink(detail[key]))) return true;
  return collectPlayableLinks(detail).length > 0;
}

function isLockedCoinVideo(detail = null) {
  const normalized = normalizeFullDetail(detail);
  // 有播放地址时，即使 has_buy 不是 y 也属于 VIP 可直看场景，严禁触发购买。
  if (playableDetailReady(normalized) || hasPotentialPlaybackEntitlement(detail)) return false;
  return normalized?.has_buy !== "y" && normalized?.layer_type === "money" && Number(normalized?.money || 0) > 0;
}

function playbackProtocol(url = "") {
  const value = String(url || "").toLowerCase();
  if (value.includes("m3u8")) return "hls";
  if (/\.(?:mp4|webm|m4v)(?:[?#]|$)/i.test(value)) return "progressive";
  return "unknown";
}

function sourceHealth(stat = null) {
  if (!stat) return { state: "unknown" };
  return {
    state: stat.error ? "failed" : stat.pending ? "probing" : stat.ok === false ? "degraded" : "healthy",
    status: stat.status,
    latencyMs: stat.latencyMs,
    segments: stat.segments,
    duration: stat.duration,
    score: stat.score,
    error: stat.error,
    checkedAt: stat.checkedAt
  };
}

function playbackSourceScore(source = null) {
  if (!source?.url || source.health?.state === "failed" || source.health?.error) return -10000;
  const explicit = Number(source.health?.score);
  if (Number.isFinite(explicit)) return explicit;
  let score = source.health?.state === "healthy" ? 160 : source.health?.state === "degraded" ? 80 : source.health?.state === "probing" ? 35 : 20;
  const status = Number(source.health?.status || 0);
  if (status >= 200 && status < 400) score += 40;
  else if (status > 0) score -= 80;
  score += Math.min(35, Number(source.health?.segments || 0) / 4);
  score += Math.min(25, Number(source.health?.duration || 0) / 30);
  const latency = Number(source.health?.latencyMs || 0);
  if (latency > 0) score -= Math.min(30, latency / 100);
  return score;
}

function playbackSourceDuration(source = null) {
  const duration = Number(source?.health?.duration || 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/**
 * 主备线路都可访问时，播放清单覆盖时长比延迟更能代表“是否为完整版”。
 * 仅在差值同时超过 90 秒和短线路的 8% 时判定，避免编码误差导致频繁改选。
 */
function isMeaningfullyLongerSource(candidate = null, baseline = null) {
  const candidateDuration = playbackSourceDuration(candidate);
  const baselineDuration = playbackSourceDuration(baseline);
  if (!candidateDuration || !baselineDuration || candidateDuration <= baselineDuration) return false;
  return candidateDuration - baselineDuration >= Math.max(90, baselineDuration * 0.08);
}

function comparePlaybackSources(left, right) {
  const leftScore = playbackSourceScore(left);
  const rightScore = playbackSourceScore(right);
  const leftUsable = leftScore > -10000;
  const rightUsable = rightScore > -10000;
  if (leftUsable !== rightUsable) return leftUsable ? -1 : 1;
  if (leftUsable && rightUsable) {
    if (isMeaningfullyLongerSource(left, right)) return -1;
    if (isMeaningfullyLongerSource(right, left)) return 1;
  }
  const scoreDiff = rightScore - leftScore;
  if (scoreDiff) return scoreDiff;
  if (left.id === "primary") return -1;
  if (right.id === "primary") return 1;
  return String(left.id).localeCompare(String(right.id));
}

function buildPlaybackSources(detail = {}, summary = {}, absoluteUrl = (value) => String(value || "")) {
  const normalized = normalizeFullDetail(detail) || {};
  const probedRows = Array.isArray(summary.probedSources) ? summary.probedSources.slice(0, 12) : [];
  const rows = probedRows.length ? probedRows.map((row, index) => ({
    id: row.id || (index === 0 ? "primary" : index === 1 ? "backup" : `alternate-${index + 1}`),
    label: row.label || (index === 0 ? "推荐线路" : index === 1 ? "备用线路" : `候选线路 ${index + 1}`),
    url: row.url,
    stat: row.stat,
    role: row.role || (index === 0 ? "primary" : index === 1 ? "backup" : "alternate")
  })) : [
    { id: "primary", label: "主线路", url: normalized.play_link || summary.playLink || "", stat: summary.fullStat, role: "primary" },
    { id: "backup", label: "备用线路", url: normalized.backup_link || summary.backupLink || "", stat: summary.backupStat, role: "backup" }
  ];
  return rows
    .map((row) => ({
      id: row.id,
      label: row.label,
      url: absoluteUrl(row.url),
      protocol: row.stat?.protocol || playbackProtocol(row.url),
      role: row.role,
      health: sourceHealth(row.stat),
      media: {
        durationSeconds: Number(row.stat?.duration || 0),
        container: row.stat?.container || (playbackProtocol(row.url) === "progressive" ? "progressive" : "unknown"),
        live: Boolean(row.stat?.live),
        audioMode: row.stat?.audioMode || "unknown",
        variants: Array.isArray(row.stat?.variants) ? row.stat.variants : []
      }
    }))
    .filter((source) => hasReturnedPlayLink(source.url));
}

function playbackRevision(session) {
  const value = JSON.stringify({
    movieId: session.movieId,
    recommended: session.decision?.recommendedSourceId,
    sources: (session.sources || []).map((source) => [source.id, source.url, source.health?.duration])
  });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `playback-2.1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function recommendedPlaybackSource(sources = []) {
  return [...sources].sort(comparePlaybackSources)[0] || null;
}

function createPlaybackSession(options = {}) {
  const {
    movieId,
    movieTitle,
    detail,
    summary = {},
    account = {},
    acquisition = { mode: "direct", attempts: 1 },
    absoluteUrl = (value) => String(value || ""),
    now = new Date(),
    sessionId = crypto.randomUUID()
  } = options;
  const sources = buildPlaybackSources(detail, summary, absoluteUrl);
  const recommended = recommendedPlaybackSource(sources);
  const recommendedForCompleteness = Boolean(
    recommended && sources.some((source) => source.id !== recommended.id && isMeaningfullyLongerSource(recommended, source))
  );
  const fetchedAt = now.toISOString();
  const session = {
    id: sessionId,
    movieId: String(movieId || ""),
    title: String(movieTitle || summary.movieTitle || summary.title || `视频 ${movieId}`),
    phase: "ready",
    sources,
    decision: {
      recommendedSourceId: recommended?.id || sources[0]?.id || "",
      reasonCodes: recommended
        ? [
          ...(recommendedForCompleteness ? ["longer-playlist-duration"] : []),
          recommended.health.state === "healthy" ? "healthy-source" : "best-available-source"
        ]
        : ["no-playable-source"],
      failoverAllowed: sources.length > 1,
      policyVersion: "2.1"
    },
    account: { id: account.id, label: account.label },
    acquisition,
    fetchedAt,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString()
  };
  session.revision = playbackRevision(session);
  return session;
}

function legacyResponseFromPlayback(result = {}) {
  const session = result.session || {};
  const primary = session.sources?.find((source) => source.id === session.decision?.recommendedSourceId)
    || session.sources?.[0]
    || null;
  const backup = session.sources?.find((source) => source.id !== primary?.id) || null;
  const summary = {
    movieId: session.movieId,
    movieTitle: session.title,
    action: session.acquisition?.mode === "purchased" ? "buy_then_full_detail" : "direct_full_detail",
    accountId: session.account?.id,
    accountLabel: session.account?.label,
    hasBuy: result.detail?.has_buy,
    playLink: primary?.url || "",
    backupLink: backup?.url || "",
    fullStat: primary ? { url: primary.url, ...primary.health, pending: primary.health?.state === "probing" } : null,
    backupStat: backup ? { url: backup.url, ...backup.health, pending: backup.health?.state === "probing" } : null,
    fetchedAt: session.fetchedAt,
    rotation: {
      tried: session.acquisition?.attempts || 1,
      failed: session.acquisition?.failed || [],
      purchasePolicy: session.acquisition?.mode === "purchased" ? "all_accounts_checked_then_lowest_coin" : undefined
    }
  };
  return {
    ok: true,
    detail: result.detail,
    data: result.detail,
    summary,
    account: result.account,
    state: result.state
  };
}

export {
  collectPlayableLinks,
  collectPlaybackCandidates,
  hasReturnedPlayLink,
  hasPotentialPlaybackEntitlement,
  isLockedCoinVideo,
  looksPlayableLink,
  buildPlaybackSources,
  createPlaybackSession,
  legacyResponseFromPlayback,
  normalizeFullDetail,
  normalizeFullSummary,
  playableDetailReady,
  playbackProtocol,
  playbackSourceDuration,
  playbackSourceScore,
  comparePlaybackSources,
  isMeaningfullyLongerSource,
  recommendedPlaybackSource,
  sourceHealth
};
