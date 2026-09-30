# 第三方组件许可说明

本软件（红果短剧下载器）使用了以下第三方组件。各组件的版权归其各自作者所有，
本软件对这些组件的使用均遵循其原始许可证。

---

## 运行时依赖

| 组件 | 版本 | 许可证 | 项目地址 |
|---|---|---|---|
| Electron | 28.3.3 | MIT | https://github.com/electron/electron |
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| axios | ^1.13.2 | MIT | https://github.com/axios/axios |

Electron 打包产物中已包含 Chromium 与 Node.js 的许可声明：

- `LICENSE.electron.txt`
- `LICENSES.chromium.html`

---

## 内置可执行程序

### FFmpeg（GPLv3）

| 项 | 说明 |
|---|---|
| 文件 | `resources/bin/ffmpeg[.exe]`、`resources/bin/ffprobe[.exe]` |
| 版本 | Windows：FFmpeg 7.1 essentials；macOS：按构建机器架构选用静态 FFmpeg/FFprobe |
| 来源 | Windows：https://www.gyan.dev/ffmpeg/builds/；macOS：https://github.com/eugeneware/ffmpeg-static 和 https://evermeet.cx/ffmpeg/ |
| 构建参数 | 各平台构建参数见随包附带的 FFmpeg README |
| **许可证** | **GNU General Public License v3.0** |
| 源码 | https://ffmpeg.org/download.html · https://github.com/FFmpeg/FFmpeg |

用途：为「一键合并」提供分片拼接，为「兼容模式」提供格式转码
（解决部分电脑无法硬件解码 HEVC 导致的「黑屏有声」）。

随软件分发的许可证全文位于 `resources/bin/`：

- `COPYING.GPLv3` —— GPLv3 全文（本构建适用的主许可证）
- `COPYING.GPLv2` —— GPLv2 全文
- `COPYING.LGPLv2.1` —— LGPLv2.1 全文
- `LICENSE.md` —— FFmpeg 官方许可证说明
- `FFMPEG-NOTICE.txt` —— 本项目的补充说明与源码获取方式
- `LICENSE-ffmpeg-static.txt`、`README-ffmpeg-static.md`、`FFPROBE-NOTICE.txt` —— macOS 二进制的许可证和构建信息

FFmpeg 是独立的第三方程序，本软件仅通过命令行调用其公开接口，未修改其源码。

---

## 移植的第三方源码

### 字节系请求签名实现

`src/native/signer/` 下的签名模块移植自开源项目 **woshishiq1/drpys** 的
`spider/js/红果果[短].js`（固定提交 `22261adfa31435e3b3ef5a730b8a2a75bcaf1715`）。

| 项 | 说明 |
|---|---|
| 来源 | https://github.com/woshishiq1/drpys |
| 固定提交 | `22261adfa31435e3b3ef5a730b8a2a75bcaf1715` |
| 上游许可证 | **GNU General Public License v3.0** |
| 移植范围 | `x-gorgon` / `x-argus`(f13) / `x-medusa` / `x-helios` 四个头的计算逻辑，以及配套的 SM3、变种 MD5、手写 protobuf 与 AES 变体实现 |

移植时保留的全部常量（`src/native/signer/constants.js`）均由上游源文件
原样提取，未做任何数值改动。上游文件自身的头部注释写明
「算法块自实测可用的 Fastify 版(1:1)移植，勿随意改动常量与位运算顺序」，
本项目沿用同一条约束。

本项目对该部分做的改动仅限于工程化整理：拆分为 `primitives` / `protobuf` /
`device` / `xgorgon` / `xargus` / `medusa` / `index` 七个模块、补齐注释与类型说明、
把设备档案提取为可配置对象，并新增了 `_rticket` 抖动选分支的封装。

由于上游为 GPL-3.0、本项目亦为 GPL-3.0，此处移植在许可证上兼容。
上游许可证全文见仓库根目录 `LICENSE`（GPL-3.0）。

---

## 开发依赖

构建期使用以下工具（不随软件分发）：

| 组件 | 许可证 |
|---|---|
| Vite | MIT |
| electron-builder | MIT |
| @vitejs/plugin-react | MIT |
| concurrently | MIT |
| wait-on | MIT |

---

## 本软件自身

本软件基于上游项目二次开发，整体以 **GNU General Public License v3.0** 发布，
详见仓库根目录的 `LICENSE` 与 `NOTICE`。
