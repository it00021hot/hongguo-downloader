'use strict';

const { proto } = require('./protobuf');

// ============================================================================
// 设备指纹
//
// 签名头与 query 参数必须来自同一份设备档案：Medusa 会把 device_id 和
// version_name 打进密文，服务端两边比对，不一致直接判为伪造。
//
// ⚠️ 这是一组固定的实测设备参数。改这里等于换设备，换了之后签名仍然自洽，
//    但服务端可能对该档案做更严格的风控。建议整组一起替换，不要只改一两个字段。
// ============================================================================

/** 短剧播放接口（video_model / video_detail）使用的设备档案 */
const VIDEO_DEVICE = {
  iid: '1905892595382586',
  device_id: '1905892595378490',
  ac: 'wifi',
  channel: 'update_64',
  aid: '8662',
  app_name: 'novelread',
  version_code: '71332',
  version_name: '7.1.3.32',
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  device_type: '25053RT47C',
  device_brand: 'Redmi',
  language: 'zh',
  os_api: '36',
  os_version: '16',
  manifest_version_code: '71332',
  resolution: '1280*2772',
  dpi: '520',
  update_version_code: '71332',
  host_abi: 'arm64-v8a',
  dragon_device_type: 'phone',
  pv_player: '71332',
  compliance_status: '0',
  need_personal_recommend: '1',
  player_so_load: '1',
  is_android_pad_screen: '0',
};

/** 与 VIDEO_DEVICE 配套的 UA，二者的系统版本号必须一致 */
const VIDEO_UA =
  'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; ' +
  'Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 ' +
  'QuicVersion:c67e9834 2025-09-08)';

/** 应用 id 与渠道号，Medusa 密文里硬编码 */
const APP_ID = '8662';
const CHANNEL_ID = '1588093228';

/**
 * 构造设备信息 protobuf（Medusa message 的 field 12）。
 *
 * 除了 device_id 与 version_name 之外全部为固定值——这些是采集自真机的
 * 传感器读数、区域设置与机型标识，签名侧只做搬运，不做计算。
 *
 * @param {string} deviceId
 * @param {string} versionName
 * @returns {Buffer}
 */
function deviceProto(deviceId, versionName) {
  return proto([
    [1, 1, 'sint'],
    [2, 2, 'sint'],
    [3, APP_ID],
    [4, deviceId],
    [5, 'Ai6svO3PyrwDOUSmO6ZcResxu'],
    [6, '!noperm!'],
    [7, -888888, 'sint'],
    [8, -888888, 'sint'],
    [9, 3, 'sint'],
    [10, -888888, 'sint'],
    [11, '!notset!'],
    [12, 'Asia/Shanghai,8'],
    [13, 'zh_CN'],
    [14, 4, 'sint'],
    [16, 255.24993896484375, 'float'],
    [17, 35.58599090576172, 'float'],
    [18, 3.467449188232422, 'float'],
    [19, 3.467449188232422, 'float'],
    [20, 255.1754913330078, 'float'],
    [21, 42.17544174194336, 'float'],
    [22, '16'],
    [23, 41, 'sint'],
    [24, 36, 'sint'],
    [25, 1728388016635, 'sint'],
    [26, 1728388016635, 'sint'],
    [27, 1728388016635, 'sint'],
    [28, 1728388016637, 'sint'],
    [29, -1, 'sint'],
    [30, '25053RT47C'],
    [31, 'Redmi'],
    [32, '25053RT47C'],
    [33, '25053RT47C'],
    [34, 'Xiaomi'],
    [35, 'Redmi'],
    [36, 'Redmi'],
    [38, 31, 'sint'],
  ]);
}

module.exports = { VIDEO_DEVICE, VIDEO_UA, APP_ID, CHANNEL_ID, deviceProto };
