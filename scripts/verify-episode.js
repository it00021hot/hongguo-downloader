#!/usr/bin/env node
'use strict';

/**
 * 单集端到端可下载性验证
 *
 * 用法：node scripts/verify-episode.js <vid> [referer]
 *
 * 验证链路（对应「签名接口返回了流」到「本地真的能存出可播放文件」之间的每一环）：
 *   1. 带签名请求 video_model，确认拿到 main_url 与 spade_a
 *   2. 派生 16 字节 CENC 内容密钥
 *   3. 按 Range 拉取 MP4 头部
 *   4. 判定明文 / CENC 加密
 *   5. 若是 CENC，用 sample table 逐样本解密，检查产出是否为合法 MP4
 *
 * 「接口返回了 URL」与「本地能存出可播文件」是两件事，本脚本专门验证后者。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const signer = require('../src/native/signer');
const {
  deriveKey,
  decryptMp4Buffer,
  streamScore,
  parseModelVideo,
} = require('../src/native/hongguo');

const VID = process.argv[2] || '7678056388836199449';
const REF = process.argv[3] || 'https://novelquickapp.com/';


const MODEL_BIZ = {
  detail_page_version: 0,
  device_level: 3,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024,
};

/** 读 MP4 顶层的 box 列表（只做粗扫，用于判断文件类型） */
function topBoxes(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = buf.length - off;
    }
    if (size < hdr || off + size > buf.length) break;
    out.push(type);
    off += size;
  }
  return out;
}

/** 递归找 box 路径里是否出现指定类型 */
function findBox(buf, path, type) {
  function walk(start, end) {
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const t = buf.subarray(off + 4, off + 8).toString('latin1');
      let hdr = 8;
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(off + 8));
        hdr = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < hdr || off + size > end) break;
      const here = path.concat(t);
      if (t === type) return here.join('/');
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf'].includes(t)) {
        const hit = walk(off + hdr, off + size);
        if (hit) return hit;
      }
      off += size;
    }
    return null;
  }
  return walk(0, buf.length);
}

/**
 * 列出所有 stsd 的样本条目类型。
 *
 * stsd 是 full box：8 字节版本/标志 + 4 字节条目数，之后才是条目，
 * 不能当普通容器走，所以单独解析。样本条目类型决定了文件能否被普通播放器识别
 * （hvc1/hev1 = HEVC，avc1 = H.264，mp4a = AAC）。
 */
function stsdEntries(buf) {
  const out = [];

  const walk = (start, end) => {
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const t = buf.subarray(off + 4, off + 8).toString('latin1');
      let hdr = 8;
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(off + 8));
        hdr = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < hdr || off + size > end) break;

      if (t === 'stsd') {
        const count = buf.readUInt32BE(off + 12);
        let p = off + 16;
        for (let i = 0; i < count; i += 1) {
          const esize = buf.readUInt32BE(p);
          out.push(buf.subarray(p + 4, p + 8).toString('latin1'));
          p += esize;
        }
        return;
      }

      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(t)) {
        walk(off + hdr, off + size);
        if (out.length) return;
      }
      off += size;
    }
  };

  walk(0, buf.length);
  return out;
}

/** 统计顶层 box 体积占比 */
function boxSizes(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = buf.length - off;
    }
    if (size < hdr || off + size > buf.length) break;
    out.push({ type, size });
    off += size;
  }
  return out;
}

async function main() {
  console.log(`vid = ${VID}`);
  console.log(`referer = ${REF}`);
  console.log('');

  // ---- 1. 取流 ----
  const payload = Buffer.from(
    JSON.stringify({
      biz_param: MODEL_BIZ,
      dr_scene: 'preload',
      mixed_video_id_map: { 1004: [VID] },
    })
  );
  const { url: apiUrl, headers } = signer.signPost('/novel/player/multi_video_model/v1/', payload);
  const res = await axios.post(apiUrl, payload, {
    headers,
    timeout: 25000,
    responseType: 'text',
    validateStatus: () => true,
  });
  const json = JSON.parse(res.data);
  const entry = json?.data?.[VID] || Object.values(json?.data || {})[0];
  if (!entry) {
    console.log('✗ video_model 无条目');
    process.exitCode = 1;
    return;
  }

  const model = JSON.parse(entry.video_model);
  const streams = (model.video_list || []).filter((v) => v.main_url);
  console.log(`1. video_model → ${streams.length} 条流`);

  // 复用生产代码的选流逻辑，避免探针与实际下载行为不一致
  const [playUrl, spadeA, codec] = parseModelVideo(entry.video_model);
  if (!playUrl) {
    console.log('   ✗ 未选出可用流');
    process.exitCode = 1;
    return;
  }
  const best = streams.find((v) => v.main_url === playUrl) || streams[0];

  const meta = best.video_meta || {};
  console.log(
    `   选定流: ${meta.definition || '?'} ${meta.vwidth}x${meta.vheight} ` +
      `${Math.round((meta.bitrate || 0) / 1000)}kbps codec=${codec || meta.codec_type}`
  );
  console.log(`   spade_a: ${spadeA ? '有' : '无'}`);
  console.log('');

  // ---- 2. 派生密钥 ----
  const key = deriveKey(spadeA);
  console.log(`2. CENC key → ${key ? key.toString('hex') : '派生失败'}`);
  console.log('');

  // ---- 3. 下载整集 ----
  // 注意：CDN 对带 Referer 的请求直接 403（openresty），必须不带 Referer。
  // 老代码里的 VIDEO_REFERER 常量会在这里导致 403。
  const headersOut = { 'User-Agent': signer.VIDEO_UA };
  if (process.env.HG_REFERER) headersOut.Referer = process.env.HG_REFERER;

  const head = await axios.head(playUrl, {
    headers: headersOut,
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  const total = Number(head.headers['content-length'] || 0);

  const dl = await axios.get(playUrl, {
    headers: headersOut,
    timeout: 120000,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    validateStatus: () => true,
  });
  const buf = Buffer.from(dl.data || []);
  console.log(
    `3. 下载 → HTTP ${dl.status}  ${(buf.length / 1048576).toFixed(2)} MB` +
      (total ? ` / 总 ${(total / 1048576).toFixed(2)} MB` : '')
  );
  if (buf.length === 0) {
    console.log('   ✗ CDN 拒绝（URL 存在但不可下载）');
    process.exitCode = 1;
    return;
  }
  console.log(`   顶层 box: ${topBoxes(buf).join(' ')}`);
  console.log(`   box 体积: ${boxSizes(buf).map((b) => `${b.type}=${(b.size / 1024).toFixed(0)}K`).join(' ')}`);
  console.log('');

  // ---- 4. 判定加密 ----
  const sencPath = findBox(buf, [], 'senc');
  const encvPath = findBox(buf, [], 'encv');
  const encType = findBox(buf, [], 'enca');
  console.log(`4. 加密判定 → senc=${sencPath || '无'}  encv=${encvPath || '无'}  enca=${encType || '无'}`);

  const encrypted = Boolean(sencPath || encvPath || encType);
  if (!encrypted) {
    console.log('   ✓ 明文 MP4，可直接播放/保存');
    return;
  }
  if (!key) {
    console.log('   ✗ CENC 加密且无法派生密钥');
    process.exitCode = 1;
    return;
  }
  console.log('');

  // ---- 5. 解密 ----
  const moovAt = findBox(buf, [], 'moov');
  console.log(`5. 解密 → moov 位置: ${moovAt || '不在前 2MB（可能为 fMP4 分片，本地脚本仅支持完整 moov 文件）'}`);

  if (!moovAt) {
    console.log('   ⚠ 取回的是 fMP4 分片，decryptMp4Buffer 需要完整文件，无法在此片段上验证');
    return;
  }

  const tmp = path.join(os.tmpdir(), `hg-probe-${VID}.mp4`);
  fs.writeFileSync(tmp, buf);
  try {
    const plain = decryptMp4Buffer(Buffer.from(buf), key);
    const types = topBoxes(plain);
    const entries = stsdEntries(plain);
    console.log(`   解密后 ${plain.length} 字节  顶层 box: ${types.join(' ')}`);
    console.log(`   样本条目: ${entries.join(' ') || '未找到'}`);

    const known = entries.filter((e) => ['hvc1', 'hev1', 'avc1', 'mp4a'].includes(e));
    const verdict =
      types.includes('moov') && types.includes('mdat') && known.length === entries.length
        ? '✓ 产出是结构完整、编码可识别的解密 MP4'
        : '✗ 产出结构或编码异常';
    console.log(`   ${verdict}`);
  } catch (err) {
    console.log(`   ✗ 解密失败：${err.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exitCode = 1;
});
