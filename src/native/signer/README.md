# src/native/signer

字节系（红果 / 番茄小说）App 接口的请求签名实现。

官方 App 接口要求每个请求携带五个由时间戳和请求内容共同导出的签名头。
缺少或算错任何一个，服务端都会**静默丢弃**——返回 `HTTP 200` + `0 字节`，
不报错、不给错误码。所以排查「接口没数据」时，第一件事是看字节数而不是状态码。

## 产出的请求头

| 头 | 算法 | 来源模块 |
|---|---|---|
| `x-gorgon` | MD5 摘要 + RC4 变种混淆 | `xgorgon.js` |
| `x-argus` | 自研 f13 哈希（三分支） | `xargus.js` |
| `x-ladon` | 时间戳的 base64 | `index.js` |
| `x-helios` | 34 轮扩散哈希 | `medusa.js` |
| `x-medusa` | protobuf 打包 + SM3 变换 + AES 变体 | `medusa.js` |

## 用法

```js
const signer = require('./signer');

// POST：payload 会被序列化成 Buffer，签名与发送的是同一份字节
const payload = Buffer.from(JSON.stringify({ biz_param, dr_scene, series_id }));
const { url, headers } = signer.signPost('/novel/player/multi_video_detail/v1/', payload);

await axios.post(url, payload, { headers });
```

`signGet(pathname)` 用于 GET。

## 三条不能违反的约束

1. **签完不能再动 url 和 body。** 签名是「URL 查询串 + body 字节 + 时间戳」的联合
   函数，改任何一个字节（包括 query 参数顺序、URL 编码方式）都会失配。
2. **常量不能改。** `constants.js` 里的值是黑盒实测产物，与服务端一一对应。
   「顺手优化」一个魔数，症状就是全量接口返回空响应且不报错。
3. **设备档案要整体替换。** `device.js` 里的 `VIDEO_DEVICE` 与 `VIDEO_UA` 必须
   成对使用：Medusa 会把 `device_id` / `version_name` 写进密文，服务端两边比对。

## `_rticket` 为什么要抖动

X-Argus 有 0 / 1 / 2 三个分支，分支由 query、body、时间戳共同决定。
服务端不受理 branch 1。`resolveTicket()` 会逐毫秒递增 `_rticket` 重新签名，
直到落在一个服务端接受的分支上，最多试 32 次——正常情况下第一次就命中。

## CDN 侧注意

视频直链所在的 `qznovelvod.com` 对**任何带 `Referer` 的请求直接返回 403**
（openresty 拒绝）。取到 URL 后下载时不要带 Referer，只带 App UA 即可。
仓库里 `hongguo.js` 的 `VIDEO_REFERER` 常量仅供官网兜底链路和 403 重试使用。

## 依赖

`node:crypto` 的 SM3（需要 Node ≥ 18 / OpenSSL 3.x）。低版本会在
`primitives.js` 的 `sm3()` 里显式抛错，而不是让签名静默出错。

## 来源

移植自 [woshishiq1/drpys](https://github.com/woshishiq1/drpys) 的
`spider/js/红果果[短].js`（提交 `22261ad`，GPL-3.0）。算法逻辑为 1:1 移植，
本项目仅做了模块拆分与注释补充。详见 `THIRD-PARTY-NOTICES.md`。
