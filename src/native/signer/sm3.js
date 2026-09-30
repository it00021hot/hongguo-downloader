'use strict';

// ============================================================================
// SM3 密码杂凑（GB/T 32905-2016）
//
// 字节系签名的三处核心计算都要 SM3（xargus 的 query 摘要、medusa 的 keyHash、
// 以及 buildMedusa 里的 queryHash）。
//
// Node 原生 `crypto.createHash('sm3')` 需要 OpenSSL 3.x。但 Electron 28 内置的
// 是 Node 18.18 + OpenSSL 1.1.1，没有 SM3——直接抛 "Digest method not supported"，
// 签名整条链路会静默降级。这里提供纯 JS 实现作为兜底，使签名不再依赖宿主环境。
//
// 自校验向量：SM3("abc") = 66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0
// ============================================================================

const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

// 轮常数 Tj：0..15 用 T0，16..63 用 T1
const T0 = 0x79cc4519;
const T1 = 0x7a879d8a;

function rotl(x, n) {
  const s = n & 31;
  return ((x << s) | (x >>> (32 - s))) >>> 0;
}

/** 置换 P0：非线性变换 */
function p0(x) {
  return (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
}

/** 置换 P1：线性变换 */
function p1(x) {
  return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
}

function ff(j, x, y, z) {
  return j < 16 ? (x ^ y ^ z) >>> 0 : (((x & y) | (x & z) | (y & z)) >>> 0);
}

function gg(j, x, y, z) {
  return j < 16 ? (x ^ y ^ z) >>> 0 : (((x & y) | (~x & z)) >>> 0);
}

/**
 * 分组压缩。
 *
 * @param {number[]} v  8 个字的工作状态（原地会被覆盖）
 * @param {Buffer}  block  64 字节分组
 */
function compress(v, block) {
  const w = new Array(68);
  for (let i = 0; i < 16; i += 1) w[i] = block.readUInt32BE(i * 4);

  for (let j = 16; j < 68; j += 1) {
    w[j] = (p1((w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) >>> 0) ^
      rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0;
  }

  const w1 = new Array(64);
  for (let j = 0; j < 64; j += 1) w1[j] = (w[j] ^ w[j + 4]) >>> 0;

  let a = v[0], b = v[1], c = v[2], d = v[3];
  let e = v[4], f = v[5], g = v[6], h = v[7];

  for (let j = 0; j < 64; j += 1) {
    const t = j < 16 ? T0 : T1;
    const a12 = rotl(a, 12);
    const ss1 = rotl((a12 + e + rotl(t, j)) >>> 0, 7);
    const ss2 = (ss1 ^ a12) >>> 0;
    const tt1 = (ff(j, a, b, c) + d + ss2 + w1[j]) >>> 0;
    const tt2 = (gg(j, e, f, g) + h + ss1 + w[j]) >>> 0;

    d = c;
    c = rotl(b, 9);
    b = a;
    a = tt1;
    h = g;
    // 注意：19 位旋转作用在 G 上（不是 F），随后 F ← E。
    // 写成 F = rotl(e, 19) 会得到自洽但错误的摘要——与 OpenSSL/Node/Python 均不符。
    g = rotl(f, 19);
    f = e;
    e = p0(tt2);
  }

  v[0] = (v[0] ^ a) >>> 0;
  v[1] = (v[1] ^ b) >>> 0;
  v[2] = (v[2] ^ c) >>> 0;
  v[3] = (v[3] ^ d) >>> 0;
  v[4] = (v[4] ^ e) >>> 0;
  v[5] = (v[5] ^ f) >>> 0;
  v[6] = (v[6] ^ g) >>> 0;
  v[7] = (v[7] ^ h) >>> 0;
}

/**
 * 计算 SM3 摘要。
 *
 * 填充规则与 SHA-256 一致：追加 0x80、补 0 至长度 ≡ 56 (mod 64)、
 * 再追加 64 位大端比特长度。
 *
 * @param {Buffer|string} input
 * @returns {Buffer} 32 字节
 */
function sm3Sync(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const bitLen = BigInt(msg.length) * 8n;

  const padLen = ((56 - ((msg.length + 1) % 64)) + 64) % 64;
  const padded = Buffer.concat([
    msg,
    Buffer.from([0x80]),
    Buffer.alloc(padLen),
    (() => {
      const len = Buffer.alloc(8);
      len.writeBigUInt64BE(bitLen);
      return len;
    })(),
  ]);

  const v = IV.slice();
  for (let off = 0; off < padded.length; off += 64) {
    compress(v, padded.subarray(off, off + 64));
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i += 1) out.writeUInt32BE(v[i], i * 4);
  return out;
}

module.exports = { sm3Sync, IV };
