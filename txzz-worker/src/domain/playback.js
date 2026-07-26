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
  if (!value || bucket.length >= 16) return bucket;
  if (typeof value === "string") {
    const keyHint = trail.join(".").toLowerCase();
    const explicitPlaybackField = /play|backup|m3u8|mp4|video|media|source|src|link|file/.test(keyHint);
    const genericUrlField = /url/.test(keyHint);
    // 普通 url 字段仍要求明确的视频特征，避免把封面地址误判为播放线路。
    if ((explicitPlaybackField && hasReturnedPlayLink(value)) || (genericUrlField && looksPlayableLink(value))) {
      bucket.push({ key: keyHint, url: value.trim() });
    }
    return bucket;
  }
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) => collectPlayableLinks(item, bucket, [...trail, String(index)]));
    return bucket;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (bucket.length >= 16) break;
      collectPlayableLinks(item, bucket, [...trail, key]);
    }
  }
  return bucket;
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
    detail.url,
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

function isLockedCoinVideo(detail = null) {
  const normalized = normalizeFullDetail(detail);
  // 有播放地址时，即使 has_buy 不是 y 也属于 VIP 可直看场景，严禁触发购买。
  if (playableDetailReady(normalized)) return false;
  return normalized?.has_buy !== "y" && normalized?.layer_type === "money" && Number(normalized?.money || 0) > 0;
}

export {
  collectPlayableLinks,
  hasReturnedPlayLink,
  isLockedCoinVideo,
  looksPlayableLink,
  normalizeFullDetail,
  normalizeFullSummary,
  playableDetailReady
};
