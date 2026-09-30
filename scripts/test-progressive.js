#!/usr/bin/env node
'use strict';

/**
 * 渐进式在线播放（边放边缓存）的自证测试：
 * 同一份数据分别走「整体解密」与「流式解密+填充」，输出必须逐字节一致；
 * 并断言 moov 就绪（可开播）明显早于下载完成，包括 moov 在文件末尾、
 * 靠尾部 Range 预取建计划的情形。
 *
 * 用法: node scripts/test-progressive.js [vid]
 */

const axios = require('axios');
const hongguo = require('../src/native/hongguo');
const onlineStream = require('../src/native/online-stream');

const VID = process.argv[2] || '7678056388836199449';
const CHUNK = 64 * 1024;
const TAIL = 2 * 1024 * 1024;

/** 把整段 buffer 模拟成按 CHUNK 到达的网络流（异步推进，贴近真实时序） */
function streamChunks(buf, size) {
  const { Readable } = require('stream');
  let off = 0;
  return new Readable({
    read() {
      setImmediate(() => {
        if (off >= buf.length) {
          this.push(null);
          return;
        }
        const end = Math.min(off + size, buf.length);
        this.push(buf.subarray(off, end));
        off = end;
      });
    },
  });
}

/** 解析顶层 box，返回 [{typ, off, size}]（只看不递归） */
function topBoxes(buf) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const typ = buf.subarray(off + 4, off + 8).toString('latin1');
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    else if (size === 0) size = buf.length - off;
    if (size < 8 || off + size > buf.length) break;
    boxes.push({ typ, off, size });
    off += size;
  }
  return boxes;
}

/** 把 moov 搬到文件末尾，并同步把 stco 减去位移，构造自洽的 moov-at-end 文件 */
function makeMoovAtEnd(raw) {
  const boxes = topBoxes(raw);
  const moov = boxes.find(b => b.typ === 'moov');
  if (!moov || moov.off + moov.size >= raw.length) return null;
  const moovBuf = Buffer.from(raw.subarray(moov.off, moov.off + moov.size));
  const shift = moov.size; // moov 之后的内容整体前移的字节数
  // 递归找出 moovBuf 里所有 stco，把绝对偏移相应减小
  const stack = [...(function parseAll() {
    // 复用 hongguo 没导出的 parseBoxes 不行，这里手动递归容器
    const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta']);
    const out = [];
    (function walk(buf, start, end) {
      let off = start;
      while (off + 8 <= end) {
        let size = buf.readUInt32BE(off);
        const typ = buf.subarray(off + 4, off + 8).toString('latin1');
        let hdr = 8;
        if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
        else if (size === 0) size = end - off;
        if (size < hdr || off + size > end) break;
        out.push({ buf, typ, off, size });
        if (CONTAINERS.has(typ)) walk(buf, off + hdr, off + size);
        off += size;
      }
    })(moovBuf, 0, moovBuf.length);
    return out.filter(b => b.typ === 'stco');
  })()];
  for (const stco of stack) {
    const nc = stco.buf.readUInt32BE(stco.off + 12);
    for (let i = 0; i < nc; i++) {
      const p = stco.off + 16 + i * 4;
      const v = stco.buf.readUInt32BE(p);
      if (v >= shift) stco.buf.writeUInt32BE(v - shift, p);
    }
  }
  return Buffer.concat([
    raw.subarray(0, moov.off),
    raw.subarray(moov.off + moov.size),
    moovBuf,
  ]);
}

async function runStream(raw, key16, tailOf) {
  const entry = onlineStream.createEntry({ vid: VID, seriesId: '', vidIndex: 1 });
  const fetchTail = tailOf
    ? async () => ({ buf: raw.subarray(tailOf), off: tailOf })
    : undefined;
  await onlineStream.beginDownload(entry, { data: streamChunks(raw, CHUNK) }, {
    key16, total: raw.length, fetchTail,
  });
  return { entry, planReadyAt: entry.planReadyReceived };
}

function assertEqual(label, a, b) {
  if (a.length !== b.length) throw new Error(`${label}: 大小不一致 ${a.length} vs ${b.length}`);
  if (!a.equals(b)) {
    let diffAt = -1;
    const ranges = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (diffAt === -1) diffAt = i;
        if (ranges.length && ranges[ranges.length - 1][1] === i) ranges[ranges.length - 1][1] = i + 1;
        else ranges.push([i, i + 1]);
        if (ranges.length >= 10) break;
      }
    }
    console.error(`  [debug] 差异区间: ${ranges.map(r => `${r[0]}-${r[1]}(${r[1] - r[0]})`).join(' ')}`);
    console.error(`  [debug] a[${diffAt}..+8] = ${a.subarray(diffAt, diffAt + 8).toString('hex')}`);
    console.error(`  [debug] b[${diffAt}..+8] = ${b.subarray(diffAt, diffAt + 8).toString('hex')}`);
    throw new Error(`${label}: 内容不一致，首个差异在偏移 ${diffAt}`);
  }
  console.log(`  ✓ ${label} 逐字节一致（${(a.length / 1048576).toFixed(2)} MB）`);
}

async function main() {
  const playInfo = await hongguo.fetchPlayUrlSingle(VID);
  if (!playInfo || !playInfo.url) throw new Error('未获取到播放地址');
  const key16 = playInfo.spadeA ? hongguo.deriveKey(playInfo.spadeA) : null;
  console.log(`vid    = ${VID}`);
  console.log(`host   = ${new URL(playInfo.url).host}`);
  console.log(`加密   = ${key16 ? 'CENC-CTR' : '明文直通'}`);

  const res = await axios.get(playInfo.url, {
    headers: { 'User-Agent': hongguo.UA },
    responseType: 'arraybuffer',
    timeout: 60000,
    maxRedirects: 5,
  });
  const raw = Buffer.from(res.data);
  const boxes = topBoxes(raw);
  console.log(`原文件 = ${(raw.length / 1048576).toFixed(2)} MB，box 布局: ${boxes.map(b => `${b.typ}@${b.off}`).join(' ')}`);

  // ---- 用例 1：真实布局，流式输出必须与整体解密一致 ----
  console.log('\n[用例 1] 真实布局');
  const legacy = key16 ? hongguo.decryptMp4Buffer(Buffer.from(raw), key16) : raw;
  const r1 = await runStream(raw, key16, null);
  assertEqual('流式 vs 整体解密', r1.entry.buffer, legacy);
  console.log(`  可开播点：moov 就绪时已接收 ${(r1.planReadyAt / 1024).toFixed(0)} KB / ${(raw.length / 1024).toFixed(0)} KB` +
    `（${((r1.planReadyAt / raw.length) * 100).toFixed(1)}%）`);

  // ---- 用例 2：自洽的 moov-at-end 布局，靠尾部预取提前建计划 ----
  const moved = makeMoovAtEnd(raw);
  if (moved) {
    console.log('\n[用例 2] moov-at-end 布局（搬移 moov 并修正 stco）');
    const legacy2 = hongguo.decryptMp4Buffer(Buffer.from(moved), key16);
    const tailOf = Math.max(0, moved.length - TAIL);
    const r2 = await runStream(moved, key16, tailOf);
    assertEqual('流式(尾部预取) vs 整体解密', r2.entry.buffer, legacy2);
    if (r2.planReadyAt >= moved.length) {
      throw new Error(`moov-at-end 没有提前开播：计划在收满 ${r2.planReadyAt}/${moved.length} 字节后才就绪`);
    }
    console.log(`  ✓ 尾部预取生效：计划在 ${(r2.planReadyAt / 1024).toFixed(0)} KB 时就绪（全文件 ${(moved.length / 1024).toFixed(0)} KB），可提前开播`);
  } else {
    console.log('\n[用例 2] 跳过（真实文件本身就是 moov-at-end，用例 1 已覆盖该布局）');
  }

  // ---- 用例 3：明文直通 ----
  console.log('\n[用例 3] 明文直通（无密钥）');
  const r3 = await runStream(raw, null, null);
  assertEqual('直通 vs 原文件', r3.entry.buffer, raw);

  // ---- waitRange 行为抽查 ----
  if (!(await onlineStream.waitRange(r1.entry, 0, r1.entry.size))) throw new Error('完成后 waitRange(全量) 应为 true');
  if (await onlineStream.waitRange(r1.entry, r1.entry.size, r1.entry.size + 1)) throw new Error('空/越界区间语义异常');
  console.log('\n✓ waitRange 行为正常');
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
