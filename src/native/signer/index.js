'use strict';

const { md5Raw, md5HexUpper, sm3, be32, le32 } = require('./primitives');
const { xGorgon } = require('./xgorgon');
const { branchOf } = require('./xargus');
const { buildMedusa, helios } = require('./medusa');
const { VIDEO_DEVICE, VIDEO_UA } = require('./device');

// ============================================================================
// 字节系请求签名 —— 对外统一入口
//
// 产出五个必带头：x-gorgon / x-argus / x-ladon / x-helios / x-medusa
//
// 用法：
//   const { url, headers, body } = signPost('/novel/player/multi_video_model/v1/', payloadBuffer)
//
// ⚠️ 签名是「URL + body + 时间戳」三者的联合函数，任一处在发出前被改动
//    （包括 query 参数顺序、URL 编码方式、body 的字节内容）都会导致签名失配，
//    服务端静默丢弃（HTTP 200 + 空 body）。请勿在签完名之后再动 url / body。
// ============================================================================

const API_ORIGIN = 'https://api5-normal-sinfonlineb.fqnovel.com';

/** 查询串编码：与 Python 的 urlencode 行为一致（对 !'() 做百分号转义） */
function encodeQuery(values) {
  const encode = (item) =>
    encodeURIComponent(String(item == null ? '' : item)).replace(
      /[!'()]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
    );
  return Object.entries(values)
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join('&');
}

/**
 * 挑一个服务端接受的分支。
 *
 * X-Argus 有 3 个分支，服务端对 branch === 1 的那一档不受理（表现为空响应）。
 * 逐毫秒抖动 _rticket 会改变签名摘要，从而改变分支判定，因此这里最多试 32 个
 * 偏移去找一个可用分支。正常情况下第 1 次就命中，失败率极低。
 */
function resolveTicket(pathname, body, device, baseTicket) {
  for (let offset = 0; offset < 32; offset += 1) {
    const ticket = baseTicket + offset;
    const khronos = Math.floor(ticket / 1000);
    const query = encodeQuery({ ...device, ts: String(khronos), _rticket: String(ticket) });
    const url = `${API_ORIGIN}${pathname}?${query}`;
    const bodyMd5 = body ? md5Raw(body) : Buffer.alloc(16);
    if (branchOf(sm3(query), bodyMd5, le32(khronos)) !== 1) {
      return { url, query, ticket, khronos };
    }
  }
  const ticket = baseTicket + 31;
  const khronos = Math.floor(ticket / 1000);
  const query = encodeQuery({ ...device, ts: String(khronos), _rticket: String(ticket) });
  return { url: `${API_ORIGIN}${pathname}?${query}`, query, ticket, khronos };
}

/**
 * 给一个请求补齐全部签名头。
 *
 * @param {object}      options
 * @param {string}      options.pathname  以 '/' 开头的接口路径
 * @param {Buffer|string} [options.body]  请求体；GET 时省略
 * @param {object}      [options.device]  设备档案，默认 VIDEO_DEVICE
 * @param {object}      [options.headers] 额外要带的头
 * @returns {{url: string, headers: object, body: Buffer|null}}
 */
function signRequest(options) {
  const { pathname, device = VIDEO_DEVICE, headers: extra = {} } = options;
  const body =
    options.body == null
      ? null
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(String(options.body));

  const { url, query, ticket, khronos } = resolveTicket(
    pathname,
    body,
    device,
    Date.now()
  );

  const random = Math.floor(Math.random() * 65536);

  const headers = {
    'User-Agent': VIDEO_UA,
    Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'x-xs-from-web': '0',
    'x-ss-req-ticket': String(ticket),
    'x-tt-request-tag': 't=0;n=0',
    'sdk-version': '2',
    'passport-sdk-version': '50561',
    'x-vc-bdturing-sdk-version': '3.7.2.cn',
    'x-khronos': String(khronos),
    // x-ladon / x-argus 目前都直接用时间戳，保留字段位置以兼容后续协议变更
    'x-ladon': be32(khronos).toString('base64'),
    'x-argus': le32(khronos).toString('base64'),
    'x-gorgon': xGorgon(query, body, khronos, random),
    'x-helios': helios(khronos),
    'x-medusa': buildMedusa(url, body, khronos, device),
    'x-tt-dt': '',
    ...extra,
  };

  if (body) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    headers['x-ss-stub'] = md5HexUpper(body);
  }

  return { url, headers, body };
}

/** POST + 签名 */
function signPost(pathname, payload, options = {}) {
  return signRequest({ ...options, pathname, body: payload });
}

/** GET + 签名 */
function signGet(pathname, options = {}) {
  return signRequest({ ...options, pathname, body: null });
}

module.exports = {
  signRequest,
  signPost,
  signGet,
  encodeQuery,
  API_ORIGIN,
  VIDEO_DEVICE,
  VIDEO_UA,
  // 供测试与探针使用
  _internals: { xGorgon, buildMedusa, helios, branchOf, sm3 },
};
