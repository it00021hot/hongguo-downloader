'use strict';

const { zigzag } = require('./primitives');

// ============================================================================
// 极简 protobuf 编码
//
// Medusa 签名把设备指纹包成 protobuf message 再加密。只需要 wire format 的
// 编码侧（不解析、不支持 packed repeated / map），因此这里不做完整实现。
// ============================================================================

/** 变长整数（varint） */
function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 127n) {
    out.push(Number((n & 127n) | 128n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

/**
 * 编码单个字段。
 *
 * @param {number} tag       字段号
 * @param {*}      value     值；undefined / null / '' 直接跳过
 * @param {string} type      string | bytes | message | sint | float
 * @returns {Buffer}
 */
function protoField(tag, value, type = 'string') {
  if (value === undefined || value === null || value === '') return Buffer.alloc(0);

  if (type === 'bytes' || type === 'string' || type === 'message') {
    const body =
      type === 'bytes'
        ? Buffer.from(value)
        : type === 'message'
          ? value
          : Buffer.from(String(value));
    return Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(body.length), body]);
  }

  if (type === 'float') {
    const body = Buffer.alloc(4);
    body.writeFloatLE(Number(value));
    return Buffer.concat([varint((BigInt(tag) << 3n) | 5n), body]);
  }

  return Buffer.concat([
    varint(BigInt(tag) << 3n),
    varint(type === 'sint' ? zigzag(value) : value),
  ]);
}

/**
 * 编码一组字段。
 *
 * @param {Array<[number, *, string?]>} fields
 * @returns {Buffer}
 */
function proto(fields) {
  return Buffer.concat(fields.map(([tag, value, type]) => protoField(tag, value, type)));
}

module.exports = { varint, protoField, proto };
