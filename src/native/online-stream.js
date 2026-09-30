/**
 * online-stream.js - 在线播放的渐进式缓存（边放边缓存）
 *
 * 之前的做法是把整集下载+解密完才把流地址交给 <video>，观感就是
 * 「缓存完了才播放」。这里把流程拆开：
 *   1. 顺序流收头部的 moov 就能建解密计划（planStreamingDecrypt）；
 *      有些 CDN 节点的 moov 在文件末尾，此时收满 tailAfter 字节后并行
 *      发一个尾部 Range 预取，用 planFromTail 提前建计划；
 *   2. 按计划把「最终明文文件」的缓冲边收边填：样本段齐一段解一段、
 *      box 头等空隙原样拷贝；moov 段在建计划时就位（尾部预取的场景
 *      等于在输出里提前挖好了洞）；
 *   3. 已填充区域用区间列表表达（前缀 + 可能的 moov 洞），流协议按
 *      Range 查覆盖，取到未填充区间就挂起，填到即返回。
 *
 * entry.buffer 在 done 之前是「部分可播」的，done 之后与整体解密结果
 * 逐字节一致（scripts/test-progressive.js 自证）。
 */
const hongguo = require('./hongguo');

function createEntry({ vid, seriesId, vidIndex }) {
  const entry = {
    vid: String(vid),
    seriesId: seriesId ? String(seriesId) : '',
    vidIndex: Number(vidIndex) || 0,
    lastUsed: Date.now(),
    // 最终明文文件的缓冲与总大小（计划就绪前为 null/0）
    buffer: null,
    size: 0,
    plan: null,
    key16: null,
    passthrough: false,
    total: 0,
    received: 0,
    chunks: [], // [{ off, data }] 未消费的原始密文分块
    filled: [], // 已填充的输出区间 [[start, end), ...]，按序合并
    done: false,
    failed: null,
    tailTried: false,
    waiters: [], // waitRange 的挂起者 [{ start, end, resolve }]
    whenPlanReady: null,
    whenComplete: null,
  };
  entry.whenPlanReady = new Promise((res, rej) => {
    entry._planReadyResolve = res;
    entry._planReadyReject = rej;
  });
  entry.whenComplete = new Promise((res, rej) => {
    entry._completeResolve = res;
    entry._completeReject = rej;
  });
  return entry;
}

// ===== 区间填充追踪 =====

function markFilled(entry, start, end) {
  if (end <= start) return;
  const out = [];
  let s = start;
  let e = end;
  let placed = false;
  for (const [a, b] of entry.filled) {
    if (b < s) {
      out.push([a, b]); // 完全在前
    } else if (a > e) {
      if (!placed) {
        out.push([s, e]);
        placed = true;
      }
      out.push([a, b]); // 完全在后
    } else {
      s = Math.min(s, a); // 相交，合并
      e = Math.max(e, b);
    }
  }
  if (!placed) out.push([s, e]);
  out.sort((x, y) => x[0] - y[0]);
  entry.filled = out;
}

function isReady(entry, start, end) {
  if (end <= start) return true;
  for (const [s, e] of entry.filled) {
    if (s > start) return false;
    if (e >= end) return true;
    if (e > start) start = e; // 连上一段继续看
  }
  return false;
}

/** 从 from 开始、已填充区间能连续覆盖到哪个位置 */
function readyEnd(entry, from) {
  let covered = from;
  for (const [s, e] of entry.filled) {
    if (s > covered) break;
    if (e > covered) covered = e;
  }
  return covered;
}

function filledBytes(entry) {
  let t = 0;
  for (const [s, e] of entry.filled) t += e - s;
  return t;
}

function flushWaiters(entry) {
  if (!entry.waiters.length) return;
  const remain = [];
  for (const w of entry.waiters) {
    if (isReady(entry, w.start, w.end)) w.resolve(true);
    else if (entry.failed || entry.done) w.resolve(false);
    else remain.push(w);
  }
  entry.waiters = remain;
}

/** 等输出缓冲的 [start, end) 填充完成；false 表示流失败或已结束仍不够 */
function waitRange(entry, start, end) {
  if (entry.failed) return Promise.resolve(false);
  if (isReady(entry, start, end)) return Promise.resolve(true);
  if (entry.done) return Promise.resolve(false);
  return new Promise((resolve) => entry.waiters.push({ start, end, resolve }));
}

// ===== 读取与填充 =====

/** 读取已接收原始数据中 [start, end) 的内容（跨分块拼接） */
function readInput(entry, start, end) {
  const parts = [];
  for (const ch of entry.chunks) {
    const s = Math.max(ch.off, start);
    const e = Math.min(ch.off + ch.data.length, end);
    if (e > s) parts.push(ch.data.subarray(s - ch.off, e - ch.off));
    if (ch.off + ch.data.length >= end) break;
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

/** 丢弃已被填充计划越过的分块，控制内存驻留 */
function compactChunks(entry) {
  // 水位 = 尚未执行的操作里最小的输入起点（依赖串链可能让靠后的段先走）
  let watermark = entry.received;
  const ops = (entry.plan && entry.plan.ops) || [];
  for (const op of ops) {
    if (op.done || op.kind === 'moov') continue;
    if (op.inOff < watermark) watermark = op.inOff;
  }
  while (entry.chunks.length && entry.chunks[0].off + entry.chunks[0].data.length <= watermark) {
    entry.chunks.shift();
  }
}

/** 执行单个填充段。样本段要复刻 legacy 的就地串链：重叠处读已写入的明文 */
function executeOp(entry, plan, op) {
  if (op.kind === 'sample') {
    const raw = readInput(entry, op.inOff, op.inOff + op.len);
    let cipher = raw;
    if (op.deps) {
      cipher = Buffer.from(raw);
      for (const [s, e] of entry.filled) {
        const a = Math.max(s, op.outOff);
        const b = Math.min(e, op.outOff + op.len);
        if (b > a) entry.buffer.copy(cipher, a - op.outOff, a, b);
      }
    }
    const plain = hongguo.decryptSample(plan.key16, op.iv, cipher);
    plain.copy(entry.buffer, op.outOff);
  } else {
    const src = readInput(entry, op.inOff, op.inOff + op.len);
    src.copy(entry.buffer, op.outOff);
  }
  markFilled(entry, op.outOff, op.outOff + op.len);
}

/**
 * 按计划填充所有「可以执行」的段：
 *  - 字节齐了（received >= need）；
 *  - 串链依赖的前序样本已写入（ops 里样本保持 legacy 的轨序，重叠处结果才一致）。
 * 反复扫描直到没有可推进的段。
 */
function fillAvailable(entry) {
  const plan = entry.plan;
  if (!plan || entry.passthrough || !entry.buffer) return;
  const ops = plan.ops;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const op of ops) {
      if (op.done || op.kind === 'moov') continue; // moov 段在 applyPlan 时已就位
      if (entry.received < op.need) continue;
      if (op.deps && !op.deps.every((d) => ops[d].done)) continue;
      executeOp(entry, plan, op);
      op.done = true;
      progressed = true;
    }
  }
  compactChunks(entry);
  flushWaiters(entry);
}

// ===== 建计划 =====

function applyPlan(entry, plan) {
  entry.plan = plan;
  entry.buffer = Buffer.allocUnsafe(plan.outSize);
  entry.size = plan.outSize;
  entry.planReadyReceived = entry.received; // 量化「可开播时机」用
  // moov 段立刻就位：头部场景它本来就到了；尾部预取场景等于提前填洞
  const moovOp = plan.ops.find(op => op.kind === 'moov');
  if (moovOp && plan.newMoov) {
    plan.newMoov.copy(entry.buffer, moovOp.outOff);
    markFilled(entry, moovOp.outOff, moovOp.outOff + plan.newMoov.length);
  }
  entry._planReadyResolve();
}

/** 顺序头部的 moov 齐了就能建计划；返回是否建成 */
function tryPlanHead(entry) {
  if (entry.plan || entry.failed) return !!entry.plan;
  const headerBuf = readInput(entry, 0, entry.received);
  const plan = hongguo.planStreamingDecrypt(headerBuf, entry.total, entry.key16);
  if (!plan) return false;
  applyPlan(entry, plan);
  return true;
}

/** 在尾部预取缓冲里定位 moov box 并建计划（容忍 mdat 数据里的伪 fourcc） */
function tryPlanTail(entry, tailBuf, tailOff) {
  if (entry.plan || entry.failed) return !!entry.plan;
  const MOOV = Buffer.from('moov', 'latin1');
  let p = 0;
  for (;;) {
    const idx = tailBuf.indexOf(MOOV, p);
    if (idx === -1 || idx < 4) return false;
    const size = tailBuf.readUInt32BE(idx - 4);
    const abs = tailOff + idx - 4;
    const plausible = size >= 8 && size <= 64 * 1024 * 1024
      && abs + size <= entry.total && idx - 4 + size <= tailBuf.length;
    if (plausible) {
      const plan = hongguo.planFromMoov(tailBuf.subarray(idx - 4, idx - 4 + size), abs, entry.total, entry.key16);
      if (plan) {
        applyPlan(entry, plan);
        return true;
      }
    }
    p = idx + 1;
  }
}

// ===== 下载消费 =====

/**
 * 消费一个 axios stream 响应，边收边填充 entry.buffer。
 * key16 为空表示明文直通（无 CENC 加密），布局与原文件一致。
 * fetchTail 用于 moov 在文件末尾的 CDN：收满 tailAfter 字节还没建出计划
 * 时并行取一次文件尾部。返回下载完成时 resolve 的 Promise。
 */
function beginDownload(entry, response, { key16, total, onProgress, fetchTail, tailAfter }) {
  entry.total = total;
  if (!key16) {
    entry.passthrough = true;
    entry.buffer = Buffer.allocUnsafe(total);
    entry.size = total;
    entry.plan = { outSize: total, newMoov: null, key16: null, ops: [] };
    entry._planReadyResolve();
  } else {
    entry.key16 = key16;
  }

  const maybeFetchTail = () => {
    if (!fetchTail || entry.plan || entry.failed || entry.tailTried) return;
    if (entry.received < (tailAfter || 512 * 1024)) return;
    entry.tailTried = true;
    Promise.resolve()
      .then(fetchTail)
      .then(({ buf, off }) => {
        if (!entry.plan && !entry.failed && buf && buf.length) tryPlanTail(entry, buf, off);
      })
      .catch(() => {});
  };

  return new Promise((resolve, reject) => {
    response.data.on('data', (c) => {
      if (entry.failed) return;
      const off = entry.received;
      entry.received += c.length;
      if (entry.passthrough) {
        c.copy(entry.buffer, off);
        markFilled(entry, off, entry.received);
      } else {
        entry.chunks.push({ off, data: c });
        if (!entry.plan) tryPlanHead(entry);
        fillAvailable(entry);
        maybeFetchTail();
      }
      if (onProgress) onProgress(entry.received, total, 'downloading');
    });
    response.data.on('error', (e) => {
      failEntry(entry, e.message);
      reject(e);
    });
    response.data.on('end', () => {
      try {
        if (!entry.passthrough && !entry.failed) {
          if (!entry.plan) {
            // 整个流收完都没拿到 moov（异常文件）：退回整体解密
            const whole = readInput(entry, 0, entry.received);
            const buf = hongguo.decryptMp4Buffer(whole, entry.key16);
            entry.plan = { outSize: buf.length, newMoov: null, key16: null, ops: [] };
            entry.buffer = buf;
            entry.size = buf.length;
            entry.filled = [[0, buf.length]];
            entry._planReadyResolve();
          } else {
            fillAvailable(entry);
            if (filledBytes(entry) !== entry.size) {
              throw new Error(`填充不完整（${filledBytes(entry)}/${entry.size} 字节），流可能被截断`);
            }
          }
        } else if (entry.passthrough && filledBytes(entry) !== entry.size) {
          throw new Error(`数据不完整（${filledBytes(entry)}/${entry.size} 字节），流可能被截断`);
        }
        entry.chunks = [];
        entry.done = true;
        flushWaiters(entry);
        entry._completeResolve(entry.buffer);
        resolve(entry.buffer);
      } catch (e) {
        failEntry(entry, e.message);
        reject(e);
      }
    });
  });
}

/** CDN 不给 Content-Length 等异常场景：外部整段解密后一次性注入 */
function completeWithBuffer(entry, buf) {
  if (entry.failed) return;
  entry.plan = { outSize: buf.length, newMoov: null, key16: null, ops: [] };
  entry.buffer = buf;
  entry.size = buf.length;
  entry.filled = [[0, buf.length]];
  entry.chunks = [];
  entry.done = true;
  entry._planReadyResolve();
  entry._completeResolve(buf);
  flushWaiters(entry);
}

function failEntry(entry, message) {
  if (entry.failed) return;
  entry.failed = message || '在线播放失败';
  entry.chunks = [];
  entry._planReadyReject(new Error(entry.failed));
  entry._completeReject(new Error(entry.failed));
  flushWaiters(entry);
}

/** 等解密计划就绪（moov 解析完成）；失败时 reject */
function waitPlanReady(entry) {
  return entry.whenPlanReady;
}

module.exports = {
  createEntry,
  beginDownload,
  completeWithBuffer,
  failEntry,
  waitPlanReady,
  waitRange,
  readyEnd,
  isReady,
};
