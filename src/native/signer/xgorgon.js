'use strict';

const { md5Raw, be32, u32, reverseBits } = require('./primitives');
const { GORGON_SDK_VERSION, GORGON_PREFIX } = require('./constants');

// ============================================================================
// X-Gorgon
//
// 历史最久的一代签名，对 query + body 做摘要后用 RC4 变种混淆。
// 现在仍然必带，但服务端实际校验强度弱于 X-Argus / Medusa。
// ============================================================================

/**
 * RC4 变种混淆。
 *
 * 与标准 RC4 的差异：KSA 阶段交换写法不同，且 PRGA 阶段用 `s[(y+y) & 255]`
 * 而非 `s[(s[i]+s[j]) & 255]`。这个非标准取样是签名匹配的关键。
 *
 * @param {number[]|Buffer} data
 * @param {number[]|Buffer} key
 * @returns {Buffer}
 */
function rc4Gorgon(data, key) {
  const s = Array.from({ length: 256 }, (_v, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    s[i] = s[j];
  }

  let i = 0;
  j = 0;
  return Buffer.from(
    data.map((value) => {
      i += 1;
      const x = s[i];
      j += x;
      const y = s[j & 255];
      s[i] = y;
      return value ^ s[(y + y) & 255];
    })
  );
}

/**
 * 计算 x-gorgon 请求头。
 *
 * 组成：[md5(query)[0:4] | md5(body)[0:4] | 4B 空 | sdkVersion(4B LE) | khronos(4B BE)]
 *        → RC4 混淆 → 逐字节 nibble 交换 + 邻位异或 + 取反
 *        → 前缀 '8404' + 2 字节随机种子 + 标志位 + 密文，整体 hex 编码
 *
 * @param {string} query     URL 查询串（不含 '?'）
 * @param {Buffer|null} body 请求体；GET 时传 null
 * @param {number}  khronos  服务端时间戳（秒）
 * @param {number}  random   0..65535 的随机种子
 * @returns {string} hex 字符串
 */
function xGorgon(query, body, khronos, random) {
  const sdk = Buffer.alloc(4);
  sdk.writeUInt32LE(GORGON_SDK_VERSION);

  const input = Buffer.concat([
    md5Raw(query).subarray(0, 4),
    body ? md5Raw(body).subarray(0, 4) : Buffer.alloc(4),
    Buffer.alloc(4),
    sdk,
    be32(khronos),
  ]);

  const key = [0x4a, 0x40, 0x16, (random >> 8) & 255, 0x47, 0x6c, 0x01, random & 255];
  const out = rc4Gorgon(input, key);

  for (let i = 0; i < out.length; i += 1) {
    const value = out[i];
    const swapped = ((value >> 4) | (value << 4)) & 255;
    const next = i + 1 < out.length ? out[i + 1] : out[0];
    out[i] = u32(~(reverseBits((next ^ swapped) & 255) ^ 20)) & 255;
  }

  return Buffer.concat([
    GORGON_PREFIX,
    Buffer.from([random & 255, (random >> 8) & 255, 0x40, 0x01]),
    out,
  ]).toString('hex');
}

module.exports = { rc4Gorgon, xGorgon };
