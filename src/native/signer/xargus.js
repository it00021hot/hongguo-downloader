'use strict';

const {
  u32,
  rol32,
  ror32,
  le32,
  bxor,
  sm3,
  getIv,
  sumMd5,
} = require('./primitives');
const { BRANCH2_SV, BRANCH2_ORDERS } = require('./constants');

// ============================================================================
// X-Argus 用的自研哈希（f13）
//
// 服务端用 query / body / 时间戳推导出 3 个分支之一，客户端必须算出同一个分支，
// 算错分支等于没签名。三个分支的分布由 `branch` 决定：
//
//   branch === 0 → 重量级路径：112 轮消息扩展 + 变体轮函数（本文件主体）
//   branch === 2 → 变种 MD5 路径
//   其它          → 直通路径：拼 sm3 前 16 字节 + body 摘要
//
// 另外 exported 的 `branchOf` 可以在发请求前预判分支，避免踩到服务端拒绝的
// 那个分支（见 index.js 里的 _rticket 抖动）。
// ============================================================================

/** 分支 0 的 6 组轮常量与轮数/索引表，按 ivV0 选择 */
const BRANCH0_IV = [0xc4a78580, 0xb3c0fd39, 0xc58c5686, 0xc9aa3ba7, 0xf5a7adf2, 0x963c2ed1];

const BRANCH0_TT = [
  0xebb64faf, 0x7aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
  0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
  0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
  0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
  0x617ce2a6, 0xe423417e, 0xa40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x5b23bb3,
  0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
  0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
  0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x284ba7, 0x8387cfa, 0x5fb37586,
];

const BRANCH0_INIT = [
  0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 984304912, 3005047866, 2874125293, 2152413264,
];

/**
 * 每档的 [轮数, …8 个操作数下标]。
 * 这些下标是一张固定的「指令表」，决定轮函数读取 state 的哪几个槽位。
 */
const BRANCH0_ROUNDS = [
  [101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3],
  [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4],
  [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5],
  [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6],
  [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4],
  [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5],
];

// ---------------------------------------------------------------- 分支判定

/**
 * 判定给定请求落在哪个分支（0 / 1 / 2）。
 *
 * 只需要 query 串、body 和时间戳，可用于发请求前预判。
 *
 * @returns {0|1|2}
 */
function branchOf(query, bodyMd5, tsBytes) {
  const iv = getIv(getIv(getIv(0x20230928, query), bodyMd5), tsBytes);
  const low = iv & 15;
  return low - ((low * 171) >> 9) * 3;
}

// ---------------------------------------------------------------- 分支 2：变种 MD5

function md5V3Step(kind, a, b, c, d, m, shift, constant) {
  let f;
  if (kind === 0) f = (b & c) | (~b & d);
  else if (kind === 1) f = (b & d) | (c & ~d);
  else if (kind === 2) f = b ^ c ^ d;
  else f = c ^ (b | ~d);
  return u32(b + rol32(u32(a + f + m + constant), shift));
}

/**
 * 变种 MD5：四组不同非线性函数 / 移位表依次跑 16 轮，
 * 末尾附加一个自定义累加和。
 */
function md5SumV3(message, countV2, orders, countV1) {
  const sv = BRANCH2_SV.map((value) => ror32(value, countV1));
  const start = [
    ror32(0x79e0f2fb, countV2),
    ror32(0xc8b52570, countV2),
    ror32(0xebc2f8cd, countV2),
    ror32(0x7c104d93, countV2),
  ];
  const endCount = (countV2 + 6) & 255;
  const end = [
    ror32(0x19be4866, endCount),
    ror32(0xe85986b4, endCount),
    ror32(0xe19b326e, endCount),
    ror32(0x71d1d7d4, endCount),
  ];

  const m = [];
  for (let i = 0; i < 16; i += 1) m.push(message.readUInt32LE(i * 4));

  let [a, b, c, d] = start;

  const run = (kind, shifts, offset) => {
    for (let i = 0; i < 16; i += 1) {
      const phase = i & 3;
      const w = m[orders[offset + i]];
      const k = sv[offset + i];
      let next;
      if (phase === 0) next = md5V3Step(kind, a, b, c, d, w, shifts[i], k);
      else if (phase === 1) next = md5V3Step(kind, d, a, b, c, w, shifts[i], k);
      else if (phase === 2) next = md5V3Step(kind, c, d, a, b, w, shifts[i], k);
      else next = md5V3Step(kind, b, c, d, a, w, shifts[i], k);

      if (phase === 0) a = next;
      else if (phase === 1) d = next;
      else if (phase === 2) c = next;
      else b = next;
    }
  };

  run(0, [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22], 0);
  run(1, [5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20], 16);
  run(2, [4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23], 32);
  run(3, [6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21], 48);

  const ret = Buffer.alloc(16);
  ret.writeUInt32LE(u32((start[0] + a) ^ end[0]), 0);
  ret.writeUInt32LE(u32((start[1] + b) ^ end[1]), 4);
  ret.writeUInt32LE(u32((start[2] + c) ^ end[2]), 8);
  ret.writeUInt32LE(u32((start[3] + d) ^ end[3]), 12);
  return Buffer.concat([ret, le32(sumMd5(ret))]);
}

function branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos) {
  const v = (iv & 13) * 86;
  const ivV0 = ((v >>> 15) & 255) + ((v >>> 8) & 255);
  const n1 = [0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4][ivV0];

  const countV1 = (n1 + khronos + 1) & 255;
  const countV2 = u32(n1 + khronos);
  const shift = (countV2 + 5) & 7;

  const seed = [0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];
  const pad = Buffer.from(seed.map((value) => ((value | (value << 8)) >> shift) & 255));

  const input = Buffer.concat([
    querySm3,
    bodyMd5,
    tsBytes,
    pad,
    Buffer.from('a0010000', 'hex'),
  ]);

  return md5SumV3(
    input,
    countV2,
    BRANCH2_ORDERS.subarray(ivV0 << 6, (ivV0 + 1) << 6),
    countV1
  );
}

// ---------------------------------------------------------------- 分支 0：重量级路径

/** 112 轮消息扩展 */
function expandWords(data) {
  const di = [];
  for (let i = 0; i < data.length; i += 4) di.push(data.readUInt32BE(i));

  let di0 = di[0];
  for (let i = 0; i < 112; i += 1) {
    const di1 = di[i + 1];
    const di14 = di[i + 14];
    const r1 = rol32(di1, 14) ^ rol32(di1, 25) ^ (di1 >>> 3);
    const r2 = rol32(di14, 13) ^ rol32(di14, 15) ^ (di14 >>> 10);
    di.push(u32(di0 + di[i + 9] + r1 + r2));
    di0 = di1;
  }
  return di;
}

/**
 * 变体轮函数。
 *
 * 每一轮从 state 的固定槽位取值做混合，然后整体循环左移一格再写回两个槽位。
 * 下标全部来自 BRANCH0_ROUNDS，不要改成顺序取用。
 */
function mixRounds(state, rounds, di, tt, ivV1) {
  const d = state.slice();

  for (let i = 0; i < rounds[0]; i += 1) {
    const base = ivV1 + i;
    const w = di[base & 127];

    const n1 = ((d[rounds[3]] ^ d[rounds[4]]) & d[rounds[1]]) ^ d[rounds[3]];
    const n2 =
      rol32(d[rounds[1]], 26) ^ rol32(d[rounds[1]], 21) ^ rol32(d[rounds[1]], 7);
    const n4 = u32(w + n1 + n2 + tt[base & 63] + d[rounds[5]]);

    const n5 =
      rol32(d[rounds[2]], 30) ^ rol32(d[rounds[2]], 19) ^ rol32(d[rounds[2]], 10);
    const n6 =
      (d[rounds[2]] & d[rounds[6]]) | ((d[rounds[2]] | d[rounds[6]]) & d[rounds[7]]);
    const n7 = u32(n5 + n6);

    const old = d[rounds[9]];
    d.unshift(d.pop());
    d[rounds[10]] = u32(n7 + n4);
    d[rounds[8]] = u32(old + n4);
  }

  return d;
}

function branch0F13(iv, querySm3, bodyMd5, tsBytes, khronos, ivV0) {
  const ivV1 = BRANCH0_IV[ivV0];
  const countV1 = (ivV1 + khronos + 1) & 255;
  const countV2 = u32(ivV1 + khronos);

  const tt = BRANCH0_TT.map((value) => ror32(value, countV1));

  const n0 = (countV2 + 2) & 7;
  const seed = [0xfa, 0x45, 0x61, 0xd7];
  const pad = Buffer.from(seed.map((value) => ((value | (value << 8)) >> n0) & 255));

  const data = Buffer.concat([
    querySm3,
    bodyMd5,
    tsBytes,
    pad,
    Buffer.from('00000000000001a0', 'hex'),
  ]);

  const di = expandWords(data);
  const init = BRANCH0_INIT.map((v) => ror32(v, countV2 & 31));
  const d = mixRounds(init, BRANCH0_ROUNDS[ivV0], di, tt, ivV1);

  const ret = Buffer.alloc(32);
  for (let i = 0; i < 8; i += 1) ret.writeUInt32BE(u32(d[i] + init[i]), i * 4);

  // 高低 16 字节折叠，再附累加和
  const folded = bxor(ret.subarray(0, 16), ret.subarray(16));
  folded.copy(ret, 0);
  return Buffer.concat([ret.subarray(0, 16), le32(sumMd5(ret.subarray(0, 16)))]);
}

// ---------------------------------------------------------------- 统一入口

/**
 * 计算 f13 摘要（最终作为 x-argus 头的负载）。
 *
 * @param {Buffer} querySm3  query 串的 SM3 摘要
 * @param {Buffer} bodyMd5  body 的 MD5 摘要；GET 时传 16 个 0
 * @param {Buffer} tsBytes  小端 4 字节 khronos
 * @param {number} khronos  秒级时间戳
 * @returns {Buffer} 20 字节
 */
function hashF13(querySm3, bodyMd5, tsBytes, khronos) {
  const iv = getIv(getIv(getIv(0x20230928, querySm3), bodyMd5), tsBytes);
  const low = iv & 15;
  const ivV0 = (low * 171) >> 9;
  const branch = low - ivV0 * 3;

  if (branch === 2) return branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos);

  if (branch !== 0) {
    return Buffer.concat([
      querySm3.subarray(0, 16),
      bodyMd5,
      le32(sumMd5(Buffer.concat([querySm3, bodyMd5]))),
    ]);
  }

  return branch0F13(iv, querySm3, bodyMd5, tsBytes, khronos, ivV0);
}

module.exports = { hashF13, branchOf };
