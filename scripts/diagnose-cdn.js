#!/usr/bin/env node
'use strict';

/**
 * CDN 403 归因：区分「缺请求头」与「权益校验拒绝」
 *
 * 用法：node scripts/diagnose-cdn.js <vid>
 *
 * 同一 URL 换 referer / UA / 完整浏览器头各试一次，并打印响应体，
 * 用来判断 403 是可以靠补头解决的，还是内容侧真的不放行。
 */

const axios = require('axios');
const signer = require('../src/native/signer');
const { parseModelVideo } = require('../src/native/hongguo');

const VID = process.argv[2] || '7678056388836199449';

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

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CANDIDATES = [
  { name: '无任何头', headers: {} },
  { name: '仅 App UA', headers: { 'User-Agent': signer.VIDEO_UA } },
  { name: 'App UA + novelquickapp referer', headers: { 'User-Agent': signer.VIDEO_UA, Referer: 'https://novelquickapp.com/' } },
  { name: 'App UA + fqnovel referer', headers: { 'User-Agent': signer.VIDEO_UA, Referer: 'https://www.fqnovel.com/' } },
  { name: '浏览器 UA + novelquickapp', headers: { 'User-Agent': BROWSER_UA, Referer: 'https://novelquickapp.com/' } },
  {
    name: '浏览器全套头',
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: 'https://novelquickapp.com/',
      Origin: 'https://novelquickapp.com',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    },
  },
];

async function getPlayUrl(vid) {
  const payload = Buffer.from(
    JSON.stringify({
      biz_param: MODEL_BIZ,
      dr_scene: 'preload',
      mixed_video_id_map: { 1004: [vid] },
    })
  );
  const { url, headers } = signer.signPost('/novel/player/multi_video_model/v1/', payload);
  const res = await axios.post(url, payload, { headers, timeout: 25000, responseType: 'text' });
  const json = JSON.parse(res.data);
  const entry = json?.data?.[vid] || Object.values(json?.data || {})[0];
  return parseModelVideo(entry.video_model)[0];
}

async function main() {
  const playUrl = await getPlayUrl(VID);
  const host = new URL(playUrl).host;
  console.log(`vid  = ${VID}`);
  console.log(`host = ${host}`);
  console.log(`参数 = ${new URL(playUrl).search}`);
  console.log('');

  for (const c of CANDIDATES) {
    const res = await axios.get(playUrl, {
      headers: { ...c.headers, Range: 'bytes=0-1023' },
      timeout: 20000,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const body = Buffer.from(res.data || []);
    const text = body.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim();
    const ok = res.status === 200 || res.status === 206;
    console.log(`${ok ? '✓' : '✗'} ${c.name}`);
    console.log(`    HTTP ${res.status}  ${body.length}B  type=${res.headers['content-type'] || '-'}`);
    if (text) console.log(`    body: ${text}`);
  }
}

main().catch((err) => {
  console.error('诊断异常：', err.message);
  process.exitCode = 1;
});
