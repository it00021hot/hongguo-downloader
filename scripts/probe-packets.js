#!/usr/bin/env node
'use strict';
/** 用 ffprobe 读解密后文件的 packet 表，验证样本表（调试用，临时脚本） */
const axios = require('axios');
const hongguo = require('../src/native/hongguo');
const fs = require('fs');
const { execFileSync } = require('child_process');

const FFPROBE = process.env.FFPROBE || './build/ffmpeg/ffprobe';
const VID = process.argv[2] || '7678056388836199449';

(async () => {
  const playInfo = await hongguo.fetchPlayUrlSingle(VID);
  const key = hongguo.deriveKey(playInfo.spadeA);
  const res = await axios.get(playInfo.url, {
    headers: { 'User-Agent': hongguo.UA }, responseType: 'arraybuffer', timeout: 60000,
  });
  const raw = Buffer.from(res.data);
  fs.writeFileSync('/tmp/hg-enc.mp4', raw);
  const plain = hongguo.decryptMp4Buffer(Buffer.from(raw), key);
  fs.writeFileSync('/tmp/hg-probe.mp4', plain);

  // plan 的样本表
  const plan = hongguo.planStreamingDecrypt(raw, raw.length, key);
  const samples = plan.ops.filter(o => o.kind === 'sample');
  console.log(`plan 样本数: ${samples.length}，首样本: ${samples[0].inOff}+${samples[0].len}`);

  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-show_packets',
    '-show_entries', 'packet=pos,size,stream_index',
    '-of', 'csv', '/tmp/hg-probe.mp4',
  ]).toString();
  const packets = out.trim().split('\n').map((l) => l.split(','));
  console.log('ffprobe packets:', packets.length);
  for (const si of [0, 1]) {
    const pkts = packets.filter((f) => f[1] === String(si));
    console.log(`流${si}: ${pkts.length} 包，前6: ${pkts.slice(0, 6).map((f) => `${f[2]}+${f[3]}`).join(' ')}`);
    // 与 plan 的同流样本对齐：ffprobe 没有 vid 信息，用总包数对比
  }
  // 总数对比
  console.log(`plan 总样本 ${samples.length} vs ffprobe 总包 ${packets.length}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
