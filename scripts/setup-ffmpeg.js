/**
 * setup-ffmpeg.js —— 打包前置：下载并放置内置 ffmpeg
 *
 * 为什么需要：
 *   一键合并功能依赖 ffmpeg，但它体积较大（约 167MB），不纳入版本管理。
 *   clone 仓库后执行一次本脚本，即可把 ffmpeg / ffprobe 放到
 *   build/ffmpeg/，之后 electron-builder 会通过 extraResources 打进安装包。
 *
 * 若下载失败，也可以自行从 https://www.gyan.dev/ffmpeg/builds/ 下载
 * essentials 版，把 bin 目录里的 ffmpeg.exe 与 ffprobe.exe 复制到
 * build/ffmpeg/ 即可。
 *
 * 用法：node scripts/setup-ffmpeg.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'build', 'ffmpeg');
const ZIP = path.join(ROOT, 'build', 'ffmpeg-essentials.zip');
const TMP = path.join(ROOT, 'build', '_ffmpeg_tmp');

const URL =
  process.env.FFMPEG_ZIP_URL ||
  'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip';

function exists(p) {
  try { return fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024; } catch (_) { return false; }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向过多'));
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        let lastPct = -1;
        const ws = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            if (pct >= lastPct + 10) { lastPct = pct; console.log(`  下载中 ${pct}%`); }
          }
        });
        res.pipe(ws);
        ws.on('finish', () => resolve());
        ws.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(DEST, { recursive: true });

  if (process.platform === 'darwin') {
    const ffmpegSource = require('ffmpeg-static');
    const ffprobeInstaller = require('ffprobe-installer');
    const ffprobeSource = ffprobeInstaller.path;
    if (!ffmpegSource || !ffprobeSource || !fs.existsSync(ffmpegSource) || !fs.existsSync(ffprobeSource)) {
      throw new Error(`未找到当前 macOS 架构 (${process.arch}) 对应的 ffmpeg / ffprobe`);
    }

    const ffmpegDest = path.join(DEST, 'ffmpeg');
    const ffprobeDest = path.join(DEST, 'ffprobe');
    const archStamp = path.join(DEST, '.darwin-arch');
    if (
      fs.existsSync(ffmpegDest) && fs.existsSync(ffprobeDest) &&
      fs.existsSync(path.join(DEST, 'FFPROBE-NOTICE.txt')) &&
      fs.existsSync(archStamp) &&
      fs.readFileSync(archStamp, 'utf8').trim() === process.arch
    ) {
      console.log(`macOS ${process.arch} ffmpeg 已就绪：${DEST}`);
      return;
    }
    fs.copyFileSync(ffmpegSource, ffmpegDest);
    fs.copyFileSync(ffprobeSource, ffprobeDest);
    fs.chmodSync(ffmpegDest, 0o755);
    fs.chmodSync(ffprobeDest, 0o755);
    fs.writeFileSync(archStamp, process.arch + '\n');
    const ffmpegLicense = path.join(path.dirname(ffmpegSource), 'ffmpeg.LICENSE');
    const ffmpegReadme = path.join(path.dirname(ffmpegSource), 'ffmpeg.README');
    if (fs.existsSync(ffmpegLicense)) fs.copyFileSync(ffmpegLicense, path.join(DEST, 'LICENSE-ffmpeg-static.txt'));
    if (fs.existsSync(ffmpegReadme)) fs.copyFileSync(ffmpegReadme, path.join(DEST, 'README-ffmpeg-static.md'));
    const ffprobeReadme = path.join(path.dirname(ffprobeSource), 'README.md');
    if (fs.existsSync(ffprobeReadme)) fs.copyFileSync(ffprobeReadme, path.join(DEST, 'README-ffprobe-installer.md'));
    const ffprobePackagePath = path.join(path.dirname(ffprobeSource), 'package.json');
    const ffprobePackage = JSON.parse(fs.readFileSync(ffprobePackagePath, 'utf8'));
    fs.writeFileSync(path.join(DEST, 'FFPROBE-NOTICE.txt'), [
      'FFprobe macOS binary',
      `Package: ${ffprobePackage.name}@${ffprobePackage.version}`,
      `Build: ${ffprobeInstaller.version}`,
      `License: ${ffprobePackage.license}`,
      `Source: ${ffprobePackage.homepage || 'https://evermeet.cx/ffmpeg/'}`,
      '',
    ].join('\n'));
    console.log(`macOS ${process.arch} ffmpeg 已就绪：${DEST}`);
    return;
  }

  const ffmpegExe = path.join(DEST, 'ffmpeg.exe');
  const ffprobeExe = path.join(DEST, 'ffprobe.exe');

  // 许可证文本随源码入库，这里只做一次存在性校验（合规需要）
  const requiredLicenses = ['COPYING.GPLv3', 'COPYING.GPLv2', 'COPYING.LGPLv2.1', 'LICENSE.md', 'FFMPEG-NOTICE.txt'];
  const missing = requiredLicenses.filter((f) => !fs.existsSync(path.join(DEST, f)));
  if (missing.length) {
    console.warn('警告：build/ffmpeg/ 缺少以下许可文件，分发前请补回：');
    missing.forEach((f) => console.warn('  - ' + f));
  }

  if (exists(ffmpegExe) && exists(ffprobeExe)) {
    console.log('ffmpeg 已就绪：' + DEST);
    return;
  }

  fs.mkdirSync(path.dirname(ZIP), { recursive: true });

  console.log('正在下载 ffmpeg essentials（约 88MB）…');
  await download(URL, ZIP);
  console.log('下载完成：' + (fs.statSync(ZIP).size / 1048576).toFixed(1) + 'MB');

  console.log('正在解压…');
  fs.rmSync(TMP, { recursive: true, force: true });
  // 用 PowerShell 解压（Windows 自带，无需额外依赖）
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${TMP}' -Force`,
  ], { stdio: 'inherit' });

  const find = (dir, name) => {
    let out = null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name) return p;
      if (e.isDirectory()) { const r = find(p, name); if (r) return r; }
    }
    return out;
  };

  const srcFf = find(TMP, 'ffmpeg.exe');
  const srcFp = find(TMP, 'ffprobe.exe');
  if (!srcFf || !srcFp) throw new Error('压缩包里没找到 ffmpeg.exe / ffprobe.exe');

  fs.copyFileSync(srcFf, ffmpegExe);
  fs.copyFileSync(srcFp, ffprobeExe);

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });

  console.log('完成：');
  console.log('  ' + ffmpegExe + '  ' + (fs.statSync(ffmpegExe).size / 1048576).toFixed(1) + 'MB');
  console.log('  ' + ffprobeExe + '  ' + (fs.statSync(ffprobeExe).size / 1048576).toFixed(1) + 'MB');
})().catch((e) => {
  console.error('失败：' + e.message);
  console.error('请确认 build/ffmpeg/ 中已准备好当前平台的 ffmpeg 与 ffprobe。');
  process.exit(1);
});
