import test from "node:test";
import assert from "node:assert/strict";
import { statM3u8Quick } from "../src/worker.js";

const partialManifest = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:4.0,
segment-1.ts
#EXTINF:4.0,
segment-2.ts
`;

const fullManifest = `${partialManifest}#EXTINF:4.0,
segment-3.ts
#EXTINF:4.0,
segment-4.ts
#EXT-X-ENDLIST
`;

test("无扩展名签名 HLS 收到 206 后无 Range 重取完整清单", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options = {}) => {
    requests.push(options);
    if (requests.length === 1) {
      return new Response(partialManifest, {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes 0-${partialManifest.length - 1}/${fullManifest.length}`
        }
      });
    }
    return new Response(fullManifest, {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" }
    });
  };

  try {
    const result = await statM3u8Quick("https://media.example/signed-playback-token", {}, 1_000);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.range, "bytes=0-524287");
    assert.equal(requests[1].headers.range, undefined);
    assert.equal(result.segments, 4);
    assert.equal(result.duration, 16);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
