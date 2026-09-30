'use strict';

const crypto = require('crypto');
const { sm3Sync } = require('./sm3');

// 启动时探测一次原生 SM3 是否可用，避免每次摘要都走 try/catch
const nativeSm3Available = (() => {
  try {
    return crypto.createHash('sm3').update('probe').digest('hex').length === 64;
  } catch {
    return false;
  }
})();

// ============================================================================
// 字节 / 位运算原语
//
// X-Gorgon、X-Argus、Medusa 三个签名都建立在这组原语之上。
// 所有函数刻意保持与原始实现完全一致的位宽与环绕语义（u32 / 64 位 BigInt），
// 不要用 `| 0` 或 `<<` 简化——那会改变 32 位溢出行为，导致签名失配。
// ============================================================================

// ---------------------------------------------------------------- 整数与位运算

/** 归一为无符号 32 位 */
function u32(value) {
  return Number(value) >>> 0;
}

/** 32 位循环左移 */
function rol32(value, count) {
  const n = count & 31;
  const x = u32(value);
  return u32((x << n) | (x >>> (32 - n)));
}

/** 32 位循环右移 */
function ror32(value, count) {
  const n = count & 31;
  const x = u32(value);
  return u32((x >>> n) | (x << (32 - n)));
}

/** 64 位循环右移（BigInt 模 2^64） */
function ror64(value, count) {
  const n = BigInt(count) & 63n;
  const x = BigInt.asUintN(64, BigInt(value));
  return BigInt.asUintN(64, (x >> n) | (x << (64n - n)));
}

/** ZigZag 编码，用于 protobuf sint32 */
function zigzag(value) {
  const n = BigInt(value);
  return n < 0n ? -n * 2n - 1n : n * 2n;
}

// ---------------------------------------------------------------- 字节序

/** 小端 4 字节 */
function le32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(u32(value));
  return b;
}

/** 大端 4 字节 */
function be32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(u32(value));
  return b;
}

// ---------------------------------------------------------------- 缓冲操作

/** 逐字节异或，长度取较短者 */
function bxor(a, b) {
  const out = Buffer.alloc(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

/** 逐字节异或，长度取 a，密钥循环使用 */
function xorBytes(a, b) {
  const out = Buffer.from(a);
  for (let i = 0; i < out.length; i += 1) out[i] ^= b[i % b.length];
  return out;
}

/** 8 位比特序反转 */
function reverseBits(value) {
  let result = 0;
  for (let i = 0; i < 8; i += 1) result = (result << 1) | ((value >> i) & 1);
  return result;
}

// ---------------------------------------------------------------- 哈希

/** MD5 原始摘要（16 字节） */
function md5Raw(value) {
  return crypto.createHash('md5').update(value).digest();
}

/** MD5 大写十六进制串（用于 x-ss-stub 头） */
function md5HexUpper(value) {
  return crypto.createHash('md5').update(value).digest('hex').toUpperCase();
}

/**
 * SM3 摘要（32 字节）。
 *
 * 优先用 Node 原生实现（更快），但原生路径依赖 OpenSSL 3.x——
 * Electron 28 内置的 Node 18.18 + OpenSSL 1.1.1 没有 SM3，
 * 因此这里在原生不可用时回退到纯 JS 实现（`sm3.js`），使签名不依赖宿主环境。
 *
 * 两条路径结果一致，由 `scripts/verify-episode.js` 与自校验向量共同保证。
 */
function sm3(value) {
  if (nativeSm3Available) {
    try {
      return crypto.createHash('sm3').update(value).digest();
    } catch (err) {
      // 运行期才失败（例如 OpenSSL 关掉了该摘要）时也走兜底
      if (!err || !/digest|not supported/i.test(String(err.message))) throw err;
    }
  }
  return sm3Sync(value);
}

// ---------------------------------------------------------------- 变种 MD5 累加器
//
// X-Argus 的分支选择与校验和都依赖这两个非标准函数，
// 它们是自研哈希的组成部分，不能用标准 MD5 替代。

/** 分支判定的初始向量递推 */
function getIv(iv, data) {
  let value = u32(iv);
  for (let i = 0; i < data.length; i += 1) {
    if ((i & 1) === 0) {
      value = u32((value >>> 4) ^ value ^ (value << 6) ^ data[i]);
    } else {
      value = u32(~((value >>> 7) ^ value ^ (data[i] | (value << 12))));
    }
  }
  return value;
}

/** 自定义累加和，返回 32 位 */
function sumMd5(data) {
  let check = 0x20220420;
  for (let i = 0; i < 12; i += 1) {
    const temp = (i & 1) === 0 ? (check >>> 3) ^ check : (check >>> 5) ^ check;
    check = (i & 1) === 0 ? data[i] ^ (check << 7) : data[i] | (check << 11);
    if ((i & 1) !== 0) check = ~check;
    check = u32(check ^ temp);
  }
  return u32((check | 4) ^ 0x1000000);
}

module.exports = {
  u32,
  rol32,
  ror32,
  ror64,
  zigzag,
  le32,
  be32,
  bxor,
  xorBytes,
  reverseBits,
  md5Raw,
  md5HexUpper,
  sm3,
  sm3Sync,
  nativeSm3Available,
  getIv,
  sumMd5,
};
