'use strict';

const {
  u32,
  ror64,
  le32,
  xorBytes,
  md5Raw,
  sm3,
} = require('./primitives');
const { proto } = require('./protobuf');
const { hashF13 } = require('./xargus');
const {
  SBOX,
  MEDUSA_SIGN_KEY,
  MEDUSA_AES_KEY,
  MEDUSA_AES_IV,
} = require('./constants');
const { APP_ID, CHANNEL_ID, deviceProto } = require('./device');

// ============================================================================
// Medusa
//
// 当代主力签名。流程：
//   1. 把「设备指纹 + query/body 摘要 + 时间戳」编成 protobuf message
//   2. 用 SM3 派生的 key 逐字节变换
//   3. 整体反序 + 掩码异或
//   4. 自研 AES 变体加密（不是标准 AES，密钥扩展和轮函数都被改过）
//   5. 拼 20 字节版本前缀，base64 输出
// ============================================================================

/** AES 变体按 khronos 低 2 位选择的参数组 */
const CON = [
  [1, 0, 2, 3],
  [1, 3, 0, 2],
  [0, 1, 3, 2],
  [1, 0, 2, 3],
];
const CON2 = [
  [1, 0, 2, 3],
  [2, 0, 3, 1],
  [0, 1, 3, 2],
  [1, 0, 2, 3],
];
const ORDER = [
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
  [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
  [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
];
const INIT_WORD = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f];

// ---------------------------------------------------------------- AES 变体

/**
 * 字节流加密用的 AES 变体。
 *
 * 与标准 AES 的差异集中在三处：
 *   - S-Box 表按 khronos 低 2 位整体平移（从 4 张表里取一段）
 *   - 密钥扩展第 4/8/12 轮用改写的字节选择
 *   - 加密前后各有一层手写的位打包/位解包，不是标准的 ShiftRows
 *
 * 所以不能直接换成 Node 的 crypto.createCipheriv('aes-...')。
 */
class AesV3 {
  constructor(key, khronos) {
    this.wordSize = khronos & 3;
    this.box = SBOX.subarray(this.wordSize * 256, (this.wordSize + 1) * 256);
    this.con = CON[this.wordSize];
    this.con2 = CON2[this.wordSize];
    this.order = ORDER[this.wordSize];
    this.keys = this.expand(key);
  }

  /** 密钥扩展：12 组 4 字节轮密钥 */
  expand(key) {
    const init = INIT_WORD[this.wordSize];

    const initial = Buffer.alloc(16);
    for (let i = 0; i < 4; i += 1) initial.writeUInt32LE(init, i * 4);

    const expanded = Buffer.concat([xorBytes(initial, key), Buffer.alloc(32)]);
    let rounds = 8;

    for (let i = 4; i < 12; i += 1) {
      const at = 4 * (i - 1);
      let a = expanded[at];
      let b = expanded[at + 1];
      let c = expanded[at + 2];
      let d = expanded[at + 3];

      if ((i & 3) === 0) {
        const t = (u32(init >> (rounds & 24)) ^ this.box[b]) & 255;
        b = this.box[c];
        c = this.box[d];
        d = this.box[a];
        a = t;
      }
      rounds += 2;

      expanded[at + 4] = a ^ expanded[at - 12];
      expanded[at + 5] = b ^ expanded[at - 11];
      expanded[at + 6] = c ^ expanded[at - 10];
      expanded[at + 7] = d ^ expanded[at - 9];
    }

    return Array.from({ length: 12 }, (_v, i) =>
      Array.from(expanded.subarray(i * 4, i * 4 + 4))
    );
  }

  // ---- 4x4 状态矩阵操作 ----

  addKey(state, key) {
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) state[i][j] ^= key[i][j];
  }

  addCon(state, keys) {
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) state[i][j] ^= keys[i][this.con2[j]];
  }

  sub(state) {
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) state[i][j] = this.box[state[i][j]];
    const old = state.map((row) => row.slice());
    for (let i = 0; i < 4; i += 1) state[i] = old[this.con2[i]];
  }

  shift(state) {
    const flat = Buffer.from(state.flat());
    for (let i = 0; i < 16; i += 1) state[Math.floor(i / 4)][i % 4] = flat[this.order[i]];
  }

  shiftCon(state) {
    const old = state.map((row) => row.slice());
    for (let i = 0; i < 4; i += 1) state[i] = this.con2.map((x) => old[i][x]);
  }

  /** 单个 16 字节块 */
  block(value) {
    const state = Array.from({ length: 4 }, (_v, i) =>
      Array.from(value.subarray(i * 4, i * 4 + 4))
    );

    this.addCon(state, this.keys.slice(0, 4));
    for (let i = 1; i < 3; i += 1) {
      this.sub(state);
      this.shift(state);
      if (i === 1) {
        this.shiftCon(state);
        mixColumns(state);
      }
      this.addCon(state, this.keys.slice(i * 4));
    }
    this.addKey(state, this.keys.slice(4));

    return Buffer.from(state.flat());
  }

  /**
   * 加密任意长度输入。
   *
   * 先把源数据按 8 字节一组做位重排压成 32 字节，末尾补 0x01 标记，
   * 再按 16 字节分块 CBC 加密（IV 来自调用方，且每块用上一块密文）。
   * 最后把派生出的 32 字节 keystream 反向掩码回源数据的保留位。
   */
  encrypt(data, iv) {
    const source = Buffer.from(data);

    // 位打包：每 8 字节输入压成 1 字节有效负载
    const plaintext = Buffer.alloc(32);
    for (let i = 0; i < 31; i += 1) {
      const at = i * 8;
      const n0 = (source[at] >> 4) & 2;
      const n1 = n0 | (source[at + 1] & 64);
      const n2 = n1 | ((source[at + 2] >> 2) & 1);
      const n3 = n2 | ((source[at + 3] << 3) & 128);
      const n4 = n3 | ((source[at + 4] >> 1) & 4);
      const n5 = n4 | ((source[at + 5] << 3) & 16);
      const n6 = n5 | ((source[at + 6] << 5) & 32);
      plaintext[i] = n6 | ((source[at + 7] >> 4) & 8);
    }
    plaintext[31] = 1;

    const blocks = [];
    let previous = Buffer.from(iv);
    for (let i = 0; i < plaintext.length; i += 16) {
      const value = this.block(xorBytes(plaintext.subarray(i, i + 16), previous));
      blocks.push(value);
      previous = value;
    }
    const key = Buffer.concat(blocks);

    // 把 keystream 的字节拆回源数据的保留位
    const out = Buffer.from(source);
    for (let i = 0; i < 31; i += 1) {
      const at = i * 8;
      const k = key[i];
      out[at] &= 0xdf; out[at] |= (k << 4) & 32;
      out[at + 1] &= 0xbf; out[at + 1] |= k & 64;
      out[at + 2] &= 0xfb; out[at + 2] |= (k << 2) & 4;
      out[at + 3] &= 0xef; out[at + 3] |= (k >> 3) & 16;
      out[at + 4] &= 0xf7; out[at + 4] |= (k + k) & 8;
      out[at + 5] &= 0xfd; out[at + 5] |= (k >> 3) & 2;
      out[at + 6] &= 0xfe; out[at + 6] |= (k >> 5) & 1;
      out[at + 7] &= 0x7f; out[at + 7] |= (k << 4) & 128;
    }

    return Buffer.concat([key.subarray(-1), out]);
  }
}

/** GF(2^8) 混合列变换 */
function mixColumns(state) {
  for (let i = 0; i < 4; i += 1) {
    const t = state[0][i] ^ state[1][i] ^ state[2][i] ^ state[3][i];
    const u = state[0][i];
    const xt = (x) => ((x << 1) ^ ((x & 128) ? 0x1b : 0)) & 255;

    state[0][i] ^= t ^ xt(state[0][i] ^ state[1][i]);
    state[1][i] ^= t ^ xt(state[1][i] ^ state[2][i]);
    state[2][i] ^= t ^ xt(state[2][i] ^ state[3][i]);
    state[3][i] ^= t ^ xt(state[3][i] ^ u);
  }
}

// ---------------------------------------------------------------- message 变换

/** 用 SM3 派生的 key 对 message 做逐字节置换 */
function xmxor(data, key) {
  const encoded = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const at = (i * 4) & 28;
    const d0 = key[at];
    const d1 = key[at + 1];
    let d2 = (((((data[i] << 4) | (data[i] >>> 4)) & 255) + d0));
    d2 = ~d2 ^ d1;
    d2 = ((((d2 & 255) << 3) | ((d2 & 255) >>> 5)) & 255);
    d2 = (d2 + d1) & 255;
    d2 = (d2 ^ d0) & 255;
    encoded[data.length - i - 1] = ~d2 & 255;
  }

  let last = encoded[encoded.length - 1] ^ encoded[encoded.length - 2];
  const first = encoded[0];
  encoded[0] = (~last + first) & 255;
  encoded[1] = ((encoded[0] ^ encoded[encoded.length - 1] ^ 254) + encoded[1]) & 255;
  // 注意运算顺序：异或先算，再与 encoded[2] 相加
  const fix2 = (last - first) ^ ((((encoded[1] << 3) | ((encoded[1] >>> 5)) & 255) ^ 2));
  encoded[2] = (encoded[2] + fix2) & 255;

  for (let i = 0; i < encoded.length - 4; i += 1) {
    const temp = (((encoded[i + 2] << 3) | ((encoded[i + 2] >>> 5)) & 255) ^ encoded[i + 1] ^ (i + 3));
    encoded[i + 3] = (~temp + encoded[i + 3]) & 255;
  }

  encoded[encoded.length - 1] ^= encoded[encoded.length - 2];
  let sum = 0;
  for (let i = 0; i < encoded.length - 1; i += 1) sum += encoded[i + 1];
  encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;

  return encoded;
}

/** 由签名主密钥 + 随机数派生 (hash, seed) */
function keyHash(signKey, random) {
  const hash = sm3(Buffer.concat([signKey, le32(random), signKey]));

  const d1 = (random >> 16) & 255;
  let d2 = ((d1 << 11) | (random >>> 24)) ^ (d1 >> 5) ^ d1;
  d2 = ~d2 >>> 0;

  return [hash, le32(d2)];
}

const rand32 = () => Math.floor(Math.random() * 0x100000000);

// ---------------------------------------------------------------- 公开接口

/**
 * 构造 x-medusa 头。
 *
 * @param {string}     url     完整 URL（含 query），只取 '?' 之后的部分参与签名
 * @param {Buffer|null} body   请求体；GET 传 null
 * @param {number}     khronos 秒级时间戳
 * @param {object}     device  设备档案，需含 device_id / version_name
 * @returns {string} base64 字符串
 */
function buildMedusa(url, body, khronos, device) {
  const bodyMd5 = body ? md5Raw(body) : Buffer.alloc(16);
  const queryRaw = url.split('?')[1];
  const querySm3 = sm3(queryRaw);
  const ts = le32(khronos);

  const queryBodyTs = hashF13(querySm3, bodyMd5, ts, khronos);

  const nested = proto([
    [1, 111, 'sint'],
    [2, 10, 'sint'],
    [3, 694367, 'sint'],
    [5, 586952199, 'sint'],
  ]);

  // 运行环境描述：进程启动次数 / 运行时长 / 设备信息
  const envLaunch = Math.floor(Math.random() * 21) + 100;
  const envPid = Math.floor(Math.random() * 2000) + 10001;
  const env = proto([
    [1, envLaunch, 'sint'],
    [2, 146331399, 'sint'],
    [3, 146331396, 'sint'],
    [5, 7, 'sint'],
    [6, 'v04.06.04.03-bugfix'],
    [7, envPid, 'sint'],
    [12, deviceProto(device.device_id, device.version_name), 'message'],
    [13, proto([
      [1, Math.floor(Date.now() / 1000), 'sint'],
      [2, -2, 'sint'],
      [4, 200, 'sint'],
    ]), 'message'],
    [14, device.version_name],
  ]);

  const queryHash = sm3(
    Buffer.concat([Buffer.from(queryRaw), bodyMd5, Buffer.from('none')])
  );

  const message = proto([
    [1, Buffer.from('f7e85ffad7d7dc3bd62ac87057cf6118', 'hex'), 'bytes'],
    [2, 3, 'sint'],
    [3, rand32(), 'sint'],
    [4, APP_ID],
    [5, device.device_id],
    [6, CHANNEL_ID],
    [7, device.version_name],
    [8, 'v04.06.04-ml-android'],
    [9, 67503104, 'sint'],
    [10, Buffer.from('4001000000000000', 'hex'), 'bytes'],
    [12, khronos, 'sint'],
    [13, queryBodyTs, 'bytes'],
    [14, querySm3.subarray(0, 6), 'bytes'],
    [15, nested, 'message'],
    [16, 'AXYQOS6n2m60x1fVZHIrH3iol'],
    [17, khronos, 'sint'],
    [19, queryHash, 'bytes'],
    [20, 'none'],
    [21, 312, 'sint'],
    [23, env, 'message'],
    [24, '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}'],
  ]);

  const random = rand32();
  const [hash, seed] = keyHash(MEDUSA_SIGN_KEY, random);

  let transformed = xmxor(message, hash);
  transformed = Buffer.concat([Buffer.from('4001000000000000', 'hex'), transformed]).reverse();
  for (let i = 0; i < transformed.length; i += 1) transformed[i] ^= seed[(~i) & 3];

  const check =
    ((querySm3[0] & 63) << 14) | 0x18000001 | ((queryBodyTs[0] & 63) << 8);

  const packed = Buffer.concat([
    Buffer.from([0x35]),
    le32(rand32()),
    le32(check),
    transformed,
    Buffer.from([random >> 16, random >> 24]),
  ]);

  const encrypted = new AesV3(MEDUSA_AES_KEY, khronos).encrypt(packed, MEDUSA_AES_IV);

  // 版本前缀：每 4 字节与 khronos 异或
  const version = Buffer.from('03000000f7e85ffad7d7dc3bd62ac87057cf6118', 'hex');
  const prefix = Buffer.alloc(20);
  for (let i = 0; i < 20; i += 4) {
    prefix.writeUInt32LE(u32(version.readUInt32LE(i) ^ khronos), i);
  }

  return Buffer.concat([
    prefix,
    Buffer.from([random & 255, (random >> 8) & 255, 0, 1]),
    encrypted,
  ]).toString('base64');
}

/**
 * 构造 x-helios 头。
 *
 * 一次 Merkle–Damgård 风格的双分支扩散，扩散 34 轮后与时间戳绑定。
 */
function helios(khronos) {
  const random = rand32();
  const digest = md5Raw(Buffer.concat([le32(random), Buffer.from(APP_ID)]));
  const ascii = Buffer.from(digest.toString('hex'), 'ascii');

  const words = [];
  for (let i = 0; i < 4; i += 1) words.push(ascii.readBigUInt64LE(i * 8));

  const table = [words[0]];
  let b0 = words[0];
  let b8 = words[1];
  words.splice(0, 2);

  for (let i = 0; i < 34; i += 1) {
    let x8 = BigInt.asUintN(64, ror64(b8, 8) + b0);
    x8 = BigInt.asUintN(64, x8 ^ BigInt(i));
    words.push(x8);
    x8 = BigInt.asUintN(64, x8 ^ ror64(b0, 61));
    table.push(x8);
    b0 = x8;
    b8 = words.shift();
  }

  const text = Buffer.from(`${khronos}-${CHANNEL_ID}-${APP_ID}`);
  const pad = Buffer.alloc(Math.ceil((text.length + 1) / 16) * 16, 16 - (text.length % 16));
  text.copy(pad);

  const output = [];
  for (let at = 0; at < pad.length; at += 16) {
    let a = pad.readBigUInt64LE(at);
    let b = pad.readBigUInt64LE(at + 8);
    for (let i = 0; i < 34; i += 1) {
      b = BigInt.asUintN(64, table[i] ^ (a + ror64(b, 8)));
      a = BigInt.asUintN(64, b ^ ror64(a, 61));
    }
    const block = Buffer.alloc(16);
    block.writeBigUInt64LE(a);
    block.writeBigUInt64LE(b, 8);
    output.push(block);
  }

  return Buffer.concat([le32(random), ...output]).toString('base64');
}

module.exports = { AesV3, buildMedusa, helios };
