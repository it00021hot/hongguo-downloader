#!/usr/bin/env node
'use strict';

/**
 * 官方 App 接口连通性探针
 *
 * 用法：
 *   node scripts/probe-api.js [seriesId] [vid]
 *
 * 逐个候选端点发一次带签名请求，打印 HTTP 状态 / 字节数 / 解析出的集数，
 * 用来判断签名是否生效、以及哪个端点当前可用。
 *
 * 关键：不带签名时服务端返回 HTTP 200 + 0 字节（静默丢弃），
 * 所以「字节数」比状态码更能说明问题。
 */

const axios = require('axios');
const signer = require('../src/native/signer');

const SERIES_ID = process.argv[2] || '7677996311081143358';
const VID = process.argv[3] || '7678056423409863705';

const DETAIL_BIZ = {
  detail_page_version: 0,
  disable_digg_stat: false,
  need_all_video_definition: false,
  need_mp4_align: false,
  screen_width_px: '1080',
  source: 7,
  use_os_player: false,
  use_server_dns: false,
};

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

const DETAIL_PATHS = [
  '/novel/player/multi_video_detail/v1/',
  '/novel/player/multi_video_detail/preload/v1',
];

const MODEL_PATHS = [
  '/novel/player/multi_video_model/v1/',
  '/novel/player/multi_video_model/preload/v1',
];

/**
 * 发一次带签名请求并记录结果。
 *
 * @param {string} pathname 接口路径
 * @param {object} payload  请求体（会被序列化成 Buffer 后参与签名）
 * @returns {Promise<{status:number,bytes:number,logid:string,json:object|null,error:string|null}>}
 */
async function probe(pathname, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const { url, headers } = signer.signPost(pathname, body);

  try {
    const res = await axios.post(url, body, {
      headers,
      timeout: 25000,
      responseType: 'arraybuffer',
      transformResponse: [(d) => d],
      validateStatus: () => true,
    });

    const buf = Buffer.from(res.data || []);
    let json = null;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      json = null;
    }

    return {
      status: res.status,
      bytes: buf.length,
      logid: res.headers['x-tt-logid'] || '',
      json,
      error: null,
    };
  } catch (err) {
    return { status: 0, bytes: 0, logid: '', json: null, error: err.message };
  }
}

/** 从 detail 响应里数出分集数 */
function countEpisodes(json) {
  if (!json) return 0;
  const data = json.data || {};
  for (const value of Object.values(data)) {
    const list = value?.video_data?.video_list;
    if (Array.isArray(list)) return list.length;
  }
  return 0;
}

/** 从 model 响应里看是否拿到可播流 */
function inspectModel(json) {
  if (!json) return '无 JSON';
  const data = json.data || {};
  const entry = Object.values(data).find((v) => v && typeof v === 'object');
  if (!entry) return '无条目';
  let model;
  try {
    model = JSON.parse(entry.video_model);
  } catch {
    return 'video_model 非 JSON';
  }
  const list = model?.video_list || [];
  const usable = list.filter((v) => v.main_url);
  if (!usable.length) return `video_list ${list.length} 条，0 条有直链`;
  const first = usable[0];
  const codec = first.video_meta?.codec_type || '?';
  const def = first.video_meta?.definition || '?';
  const encrypted = Boolean(first.encrypt_info?.spade_a);
  return `${usable.length}/${list.length} 条有直链 · ${def}/${codec} · ${encrypted ? 'CENC 加密' : '明文'}`;
}

function fmt(ok, text) {
  return `${ok ? '✓' : '✗'} ${text}`;
}

async function main() {
  console.log(`seriesId = ${SERIES_ID}`);
  console.log(`vid      = ${VID}`);
  console.log(`设备     = ${signer.VIDEO_DEVICE.device_id} / ${signer.VIDEO_DEVICE.version_name}`);
  console.log('');

  console.log('── 分集详情 ──');
  for (const path of DETAIL_PATHS) {
    const r = await probe(path, { biz_param: DETAIL_BIZ, dr_scene: 'preload', series_id: SERIES_ID });
    if (r.error) {
      console.log(fmt(false, `${path}  →  ${r.error}`));
      continue;
    }
    const n = countEpisodes(r.json);
    console.log(
      fmt(
        r.bytes > 0,
        `${path}  →  HTTP ${r.status}  ${r.bytes}B  集数=${n}  logid=${r.logid}`
      )
    );
  }

  console.log('');
  console.log('── 视频模型 ──');
  for (const path of MODEL_PATHS) {
    const r = await probe(path, {
      biz_param: MODEL_BIZ,
      dr_scene: 'preload',
      mixed_video_id_map: { 1004: [VID] },
    });
    if (r.error) {
      console.log(fmt(false, `${path}  →  ${r.error}`));
      continue;
    }
    console.log(
      fmt(
        r.bytes > 0,
        `${path}  →  HTTP ${r.status}  ${r.bytes}B  ${inspectModel(r.json)}  logid=${r.logid}`
      )
    );
  }
}

main().catch((err) => {
  console.error('探针异常：', err);
  process.exitCode = 1;
});
