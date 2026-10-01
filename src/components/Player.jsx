import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast as sonnerToast } from 'sonner';
import {
  Check,
  ChevronDown,
  Download,
  Film,
  Layers,
  Play,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

// ===== 播放倍速 =====
// 自动连播切集时，canPlay 会短暂变 false（转在线播放、等下载、转兼容模式），
// 而 JSX 是 `{canPlay ? <video/> : <div/>}` —— video 元素会被整个卸载再重建。
// 新建元素的 playbackRate 恒为 1，所以用户设的倍速会在每次切集后「被重置」。
//
// 这里把倍速持久化，并在每次渲染后恢复到当前元素上，
// 覆盖「切集 → 卸载 → 重建」的全部路径。
const RATE_KEY = 'hongguo.playbackRate';
const VOLUME_KEY = 'hongguo.volume';
const MUTED_KEY = 'hongguo.muted';
const MIN_RATE = 0.25;
const MAX_RATE = 4;

function readStoredNumber(key, fallback, min, max) {
  try {
    const v = parseFloat(window.localStorage.getItem(key));
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  } catch {
    return fallback; // 隐私模式 / localStorage 不可用时退回默认
  }
}

function writeStoredNumber(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* 存不下就算了，本次会话内 ref 仍然有效 */
  }
}

/**
 * Player —— 内置播放器
 *
 * 设计要点：
 *  - 直接播本地 file:// 文件（实测支持 seek），无需流服务器
 *  - 「边下边看」：下一集若还在下载，显示等待态并轮询，下完自动接上
 *  - 断点续播：按 series_id 记住看到第几集、第几秒
 */
function Player({ target, onNavigate }) {
  const [seriesList, setSeriesList] = useState([]);
  const [activeSeriesId, setActiveSeriesId] = useState('');
  const [detail, setDetail] = useState(null); // { series_title, episodes: [...], total, completedCount }
  const [currentIndex, setCurrentIndex] = useState(1);
  const [autoNext, setAutoNext] = useState(true);
  const [waitingFor, setWaitingFor] = useState(null); // 正在等待下载的集号
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);   // 剧集选择面板
  const [pickerQuery, setPickerQuery] = useState('');
  const [dismissedCount, setDismissedCount] = useState(0);

  // 在线播放（内存缓存，不落盘）
  const [onlineVid, setOnlineVid] = useState(null);
  const [onlineUrl, setOnlineUrl] = useState('');
  const [onlineProgress, setOnlineProgress] = useState(null); // {percent, phase}
  const [cacheInfo, setCacheInfo] = useState({ count: 0, bytes: 0 });
  const [downloadedMap, setDownloadedMap] = useState({}); // series_id -> {completed,total}
  const [storageMap, setStorageMap] = useState({});       // series_id -> {files,bytes}
  const [storageTotal, setStorageTotal] = useState({ files: 0, bytes: 0 });
  const [autoDelete, setAutoDelete] = useState(false);    // 看完自动删本地文件
  const [confirmAsk, setConfirmAsk] = useState(null);     // {title, message, danger, onOk}

  // 兼容模式：本机解不了 HEVC 时转码为 H.264
  const [autoCompat, setAutoCompat] = useState(true);
  const [compatMap, setCompatMap] = useState({});         // vidIndex -> 转码后 url
  const [compatProgress, setCompatProgress] = useState(null); // {vidIndex, percent}
  const [decodeFailed, setDecodeFailed] = useState(false);    // 当前集解不出画面
  const [compatCache, setCompatCache] = useState({ files: 0, bytes: 0 });
  const [mergeAsk, setMergeAsk] = useState(false);            // 合并格式选择

  const videoRef = useRef(null);
  const pendingSeekRef = useRef(0); // 切集后要跳转的秒数
  const lastSavedRef = useRef(0);
  const playbackRateRef = useRef(readStoredNumber(RATE_KEY, 1, MIN_RATE, MAX_RATE));
  const volumeRef = useRef(readStoredNumber(VOLUME_KEY, 1, 0, 1)); // 音量同理会被重置
  // 静音是独立状态：用户主动静音后 volume 仍是原值，
  // 不能用「volume === 0」反推，否则恢复时会把静音悄悄取消。
  const mutedRef = useRef(readStoredNumber(MUTED_KEY, 0, 0, 1) === 1);
  const stateRef = useRef({ currentIndex, autoNext, activeSeriesId });
  stateRef.current = { currentIndex, autoNext, activeSeriesId };

  const showToast = useCallback((text) => {
    sonnerToast.success(text);
  }, []);

  // 载入已登记的剧集列表
  const loadSeriesList = useCallback(async () => {
    const list = (await window.electronAPI.getSeriesList()) || [];
    setSeriesList(list);
    return list;
  }, []);

  // 载入某剧的分集状态
  const loadDetail = useCallback(async (seriesId, opts = {}) => {
    if (!seriesId) return null;
    const res = await window.electronAPI.getSeriesEpisodes(seriesId);
    if (!res || !res.success) return null;
    setDetail(res.data);
    return res.data;
  }, []);

  const refreshCacheInfo = useCallback(async () => {
    try {
      const res = await window.electronAPI.onlineCacheStatus();
      if (res && res.success) setCacheInfo({ count: res.count, bytes: res.bytes });
      const dc = await window.electronAPI.dismissedCount();
      setDismissedCount(dc || 0);
      const st = await window.electronAPI.getStorageUsage();
      if (st && st.success) {
        const map = {};
        for (const s of st.series) map[String(s.series_id)] = { files: s.files, bytes: s.bytes, merged: s.merged };
        setStorageMap(map);
        setStorageTotal({ files: st.totalFiles, bytes: st.totalBytes });
      }
    } catch (_) {}
  }, []);

  const fmtSize = (b) => {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  };

  useEffect(() => {
    refreshCacheInfo();
    window.electronAPI.getSettings().then((s) => {
      if (s) {
        setAutoDelete(s.auto_delete_watched === true);
        setAutoCompat(s.compat_mode !== false); // 默认开启
      }
    });
    window.electronAPI.compatCacheStatus().then((r) => {
      if (r && r.success) setCompatCache({ files: r.files, bytes: r.bytes });
    });
  }, [refreshCacheInfo]);

  useEffect(() => {
    if (!window.electronAPI.onTranscodeProgress) return undefined;
    return window.electronAPI.onTranscodeProgress((d) => {
      if (d.done) return;
      setCompatProgress({ vidIndex: d.vidIndex, percent: d.percent || 0 });
    });
  }, []);

  /**
   * 注意：以下三个用到 episodes 的函数必须定义在 episodes 之后。
   * useCallback 的依赖数组在「定义时」就会求值，若提前引用后声明的 const
   * 会触发 TDZ（Cannot access 'X' before initialization）导致整页白屏。
   */
  const toggleAutoCompat = async () => {
    const next = !autoCompat;
    setAutoCompat(next);
    try {
      const s = await window.electronAPI.getSettings();
      await window.electronAPI.saveSettings({ ...s, compat_mode: next });
      showToast(next ? '兼容模式已开启：无法解码时自动转码' : '兼容模式已关闭');
    } catch (_) {}
  };

  const toggleAutoDelete = async () => {
    const next = !autoDelete;
    setAutoDelete(next);
    try {
      const s = await window.electronAPI.getSettings();
      await window.electronAPI.saveSettings({ ...s, auto_delete_watched: next });
      showToast(next ? '已开启：看完一集自动删除本地文件' : '已关闭自动删除');
    } catch (_) {}
  };

  // 打开剧集面板时，补全各剧的下载进度（只拉一次）
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      const map = {};
      for (const s of seriesList) {
        try {
          const res = await window.electronAPI.getSeriesEpisodes(s.series_id);
          if (res && res.success) map[String(s.series_id)] = { completed: res.data.completedCount, total: res.data.total };
        } catch (_) {}
        if (cancelled) return;
      }
      if (!cancelled) setDownloadedMap(map);
    })();
    return () => { cancelled = true; };
  }, [pickerOpen, seriesList]);

  useEffect(() => {
    if (!window.electronAPI.onOnlinePlayProgress) return undefined;
    return window.electronAPI.onOnlinePlayProgress((d) => {
      setOnlineProgress({
        vid: d.vid,
        percent: d.percent || 0,
        phase: d.phase || 'downloading',
        received: d.received,
        total: d.total,
      });
    });
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const list = await loadSeriesList();
      if (list.length) {
        // 浏览页点播时优先用指定剧，否则选最近更新的那部
        const wanted = target && target.seriesId ? String(target.seriesId) : '';
        const exists = wanted && list.some((s) => String(s.series_id) === wanted);
        const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const sid = exists ? wanted : sorted[0].series_id;
        setActiveSeriesId(sid);
        const d = await loadDetail(sid);

        if (exists && target.vidIndex) {
          // 点播指定集：优先播它（若尚未下载则交给等待逻辑）
          setCurrentIndex(target.vidIndex);
          const ep = d && d.episodes.find((e) => e.vid_index === target.vidIndex);
          if (ep && ep.status !== 'completed') setWaitingFor(target.vidIndex);
        } else {
          // 恢复断点
          const saved = await window.electronAPI.getPlaybackPosition(sid);
          if (saved && saved.vid_index) setCurrentIndex(saved.vid_index);
          else if (d) {
            const firstPlayable = d.episodes.find((e) => e.status === 'completed');
            setCurrentIndex(firstPlayable ? firstPlayable.vid_index : 1);
          }
          pendingSeekRef.current = saved ? saved.currentTime || 0 : 0;
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSeriesList, loadDetail]);

  // 浏览页再次点播（组件已挂载时）
  const handledTargetRef = useRef(0);
  useEffect(() => {
    if (!target || !target.seriesId || !target.ts) return;
    if (handledTargetRef.current === target.ts) return;
    handledTargetRef.current = target.ts;
    (async () => {
      const list = await loadSeriesList();
      const wanted = String(target.seriesId);
      if (!list.some((s) => String(s.series_id) === wanted)) return;
      setActiveSeriesId(wanted);
      setWaitingFor(null);
      pendingSeekRef.current = 0;
      const d = await loadDetail(wanted);
      if (target.vidIndex) {
        setCurrentIndex(target.vidIndex);
        const ep = d && d.episodes.find((e) => e.vid_index === target.vidIndex);
        if (ep && ep.status !== 'completed') setWaitingFor(target.vidIndex);
      } else if (d) {
        const firstPlayable = d.episodes.find((e) => e.status === 'completed');
        setCurrentIndex(firstPlayable ? firstPlayable.vid_index : 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target && target.ts]);

  // 轮询：让「正在下载」的集实时更新，并在等待时自动接上
  useEffect(() => {
    if (!activeSeriesId) return;
    const timer = setInterval(async () => {
      const d = await loadDetail(activeSeriesId);
      if (!d) return;
      const { waitingFor: wf } = stateRef.current;
      if (wf != null) {
        const ep = d.episodes.find((e) => e.vid_index === wf);
        if (ep && ep.status === 'completed') {
          // 等待中的下一集下好了 -> 自动切过去
          setWaitingFor(null);
          goToEpisode(wf, true);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeriesId, loadDetail]);

  const episodes = detail ? detail.episodes : [];
  const current = useMemo(
    () => episodes.find((e) => e.vid_index === currentIndex) || null,
    [episodes, currentIndex]
  );

  const playableCount = episodes.filter((e) => e.status === 'completed').length;

  /** 转码当前集为 H.264 后播放（解决本机无法解码 HEVC 的黑屏问题） */
  const startCompatPlay = useCallback(
    async (vidIndex) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (!ep) return;
      setCompatProgress({ vidIndex, percent: 0 });
      try {
        const res = await window.electronAPI.transcodeForPlayback({
          seriesId: activeSeriesId,
          vidIndex,
          vid: ep.vid,
          filePath: ep.savePath || null,
        });
        if (res && res.success) {
          setCompatMap((prev) => ({ ...prev, [vidIndex]: res.url }));
          setDecodeFailed(false);
          setCompatProgress(null);
          showToast(res.cached ? '已切换为兼容格式播放' : `已转码为兼容格式（用时 ${res.elapsed}s），开始播放`);
          window.electronAPI.compatCacheStatus().then((r) => {
            if (r && r.success) setCompatCache({ files: r.files, bytes: r.bytes });
          });
        } else {
          setCompatProgress(null);
          showToast((res && res.error) || '转码失败');
        }
      } catch (e) {
        setCompatProgress(null);
        showToast('转码异常: ' + e.message);
      }
    },
    [episodes, activeSeriesId, showToast]
  );

  const clearCompatCache = async () => {
    const r = await window.electronAPI.clearCompatCache();
    setCompatCache({ files: 0, bytes: 0 });
    showToast(r && r.count > 0 ? `已清理转码缓存，释放 ${fmtSize(r.freed)}` : '转码缓存已是空的');
  };

  // 播放中若始终解不出画面（videoWidth 一直为 0），判定为解码不兼容。
  // 必须定义在早返回之前 —— hooks 不能出现在条件分支之后。
  const handlePlaying = useCallback(() => {
    setDecodeFailed(false);
    const idx = currentIndex;
    setTimeout(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.videoWidth === 0 && !v.paused && v.currentTime > 0.3) {
        setDecodeFailed(true);
        if (autoCompat && !compatMap[idx]) {
          showToast('该视频格式（HEVC）本机无法解码，正在转码为兼容格式…');
          startCompatPlay(idx);
        }
      }
    }, 2600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCompat, compatMap, currentIndex, startCompatPlay, showToast]);

  /**
   * 在线播放：让主进程把该集下载+解密到内存，拿回可播放的流地址。
   * 不写本地文件、不占用下载目录，看完可选择清理内存缓存。
   *
   * opts.startAt：显式指定起播秒数（连播传 0）。省略则读这一集自己的续播点，
   * 与本地集的 goToEpisode 行为对齐 —— 点没下载过的集也能接着上次看。
   * 续播点必须在流 URL 就位前写入 pendingSeekRef，否则 loadedmetadata
   * 先触发，进度就接不上了。
   */
  const startOnlinePlay = useCallback(
    async (vidIndex, opts = {}) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (!ep || !ep.vid) {
        showToast('这一集缺少 vid，无法在线播放');
        return;
      }
      setCurrentIndex(vidIndex);
      setWaitingFor(null);
      setOnlineProgress({ vid: ep.vid, percent: 0, phase: 'downloading' });
      setOnlineVid(ep.vid);
      setOnlineUrl('');
      if (typeof opts.startAt === 'number') {
        pendingSeekRef.current = opts.startAt;
      } else {
        try {
          const saved = await window.electronAPI.getPlaybackPosition(activeSeriesId, vidIndex);
          // 等待期间可能又点了别的集，丢弃过期结果
          if (stateRef.current.currentIndex !== vidIndex) return;
          pendingSeekRef.current = saved ? saved.currentTime || 0 : 0;
        } catch {
          pendingSeekRef.current = 0;
        }
      }
      try {
        const res = await window.electronAPI.prepareOnlinePlay({
          vid: ep.vid,
          seriesId: activeSeriesId,
          vidIndex,
        });
        if (!res || !res.success) {
          showToast((res && res.error) || '在线播放准备失败');
          setOnlineVid(null);
          setOnlineProgress(null);
          return;
        }
        setOnlineUrl(res.url);
        setOnlineProgress(null);
        refreshCacheInfo();
      } catch (e) {
        showToast('在线播放失败: ' + e.message);
        setOnlineVid(null);
        setOnlineProgress(null);
      }
    },
    [episodes, activeSeriesId, showToast, refreshCacheInfo]
  );

  // 切集
  // resume = false 用于「刚看完这集、接着播下一集」：那时进度应当归零。
  const goToEpisode = useCallback(
    (vidIndex, keepPlaying = true, resume = true) => {
      setCurrentIndex(vidIndex);
      setWaitingFor(null);

      // 换集时清掉上一集的在线流（下载好的集直接走本地文件）
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (!ep || ep.status === 'completed') {
        setOnlineVid(null);
        setOnlineUrl('');
        setOnlineProgress(null);
      }

      // 读这一集自己的续播点。必须在设置 video src 之前拿到，
      // 否则 src 先就位、loadedmetadata 先触发，进度就接不上了。
      if (resume) {
        const sid = activeSeriesId;
        (async () => {
          try {
            const saved = await window.electronAPI.getPlaybackPosition(sid, vidIndex);
            // 期间可能又切到别的集了，丢弃过期结果
            if (stateRef.current.currentIndex !== vidIndex) return;
            pendingSeekRef.current = saved ? saved.currentTime || 0 : 0;
          } catch {
            pendingSeekRef.current = 0;
          }
        })();
      } else {
        pendingSeekRef.current = 0;
      }

      const v = videoRef.current;
      if (v && keepPlaying) {
        // 等 src 更新后再播
        setTimeout(() => {
          v.play().catch(() => {});
        }, 80);
      }
    },
    [episodes, activeSeriesId]
  );

  // 找下一集（按集号顺序）
  const findNext = useCallback(
    (fromIndex) => {
      const idx = episodes.findIndex((e) => e.vid_index === fromIndex);
      if (idx === -1 || idx + 1 >= episodes.length) return null;
      return episodes[idx + 1];
    },
    [episodes]
  );
  const findPrev = useCallback(
    (fromIndex) => {
      const idx = episodes.findIndex((e) => e.vid_index === fromIndex);
      if (idx <= 0) return null;
      return episodes[idx - 1];
    },
    [episodes]
  );

  // 播放结束 -> 连播（未下载的集自动转在线播放，做到「不下载也能连着看」）
  const handleEnded = useCallback(() => {
    const { currentIndex: ci, autoNext: an, activeSeriesId: sid } = stateRef.current;
    const finished = episodes.find((e) => e.vid_index === ci);

    // 看完自动删：先把刚看完这集的本地文件清掉，再决定下一集怎么播
    if (autoDelete && finished && finished.status === 'completed' && sid) {
      window.electronAPI.deleteEpisodeFile(sid, ci).then((r) => {
        if (r && r.success && r.count > 0) {
          showToast(`第 ${ci} 集已看完，自动删除本地文件（释放 ${fmtSize(r.freed)}）`);
          refreshCacheInfo();
          loadDetail(sid);
        }
      });
    }

    if (!an) return;
    const next = findNext(ci);
    if (!next) {
      showToast('已经是最后一集');
      return;
    }
    if (sid) window.electronAPI.savePlaybackPosition(sid, next.vid_index, 0);

    const nextIsLocal = next.status === 'completed' && next.fileUrl && !(autoDelete && finished && finished.status === 'completed');
    if (nextIsLocal) {
      goToEpisode(next.vid_index, true, false); // 接着播下一集，从头开始
    } else if (next.status === 'downloading' || next.status === 'pending') {
      // 正在下载：等它下完自动接上
      setWaitingFor(next.vid_index);
      setCurrentIndex(next.vid_index);
      showToast(`第 ${next.vid_index} 集正在下载，完成后自动播放`);
    } else {
      // 未下载（或被自动删了）-> 直接在线播放
      // startAt 显式传 0：上面刚以 0 保存过下一集，但那次写入是异步的，
      // 若在这里读续播点可能读到旧值，导致连播跳回上一回看到的位置。
      showToast(`第 ${next.vid_index} 集转在线播放`);
      startOnlinePlay(next.vid_index, { startAt: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findNext, goToEpisode, showToast, startOnlinePlay, autoDelete, episodes, refreshCacheInfo, loadDetail]);

  // 记住播放进度（每 5 秒 + 切集时）
  const persistPosition = useCallback(() => {
    const v = videoRef.current;
    const { activeSeriesId: sid, currentIndex: ci } = stateRef.current;
    if (!v || !sid) return;
    if (Math.abs(v.currentTime - lastSavedRef.current) < 3) return;
    lastSavedRef.current = v.currentTime;
    window.electronAPI.savePlaybackPosition(sid, ci, v.currentTime);
  }, []);

  useEffect(() => {
    const timer = setInterval(persistPosition, 5000);
    return () => {
      clearInterval(timer);
      persistPosition();
    };
  }, [persistPosition]);

  // 恢复倍速 / 音量：每次渲染后都把当前 video 元素的播放状态拉回记录值。
  // 刻意不设依赖数组 —— 新的 video 元素挂载后的下一次渲染就会执行，
  // 正好覆盖「切集 → 卸载 → 重建」。设置这两个属性不会触发 React 重渲染，
  // 因此不存在循环。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.playbackRate - playbackRateRef.current) > 0.001) {
      v.playbackRate = playbackRateRef.current;
    }
    if (Math.abs(v.volume - volumeRef.current) > 0.001) {
      v.volume = volumeRef.current;
    }
    if (v.muted !== mutedRef.current) {
      v.muted = mutedRef.current;
    }
  });

  // 记录用户改动的倍速 / 音量（原生 controls 菜单触发）
  const handleRateChange = useCallback((e) => {
    const r = e.currentTarget.playbackRate;
    if (Number.isFinite(r) && r > 0) {
      playbackRateRef.current = r;
      writeStoredNumber(RATE_KEY, r);
    }
  }, []);

  const handleVolumeChange = useCallback((e) => {
    const el = e.currentTarget;
    // muted 变化也会触发 volumechange，所以两项一起记
    if (Number.isFinite(el.volume) && el.volume >= 0 && el.volume <= 1) {
      volumeRef.current = el.volume;
      writeStoredNumber(VOLUME_KEY, el.volume);
    }
    if (el.muted !== mutedRef.current) {
      mutedRef.current = el.muted;
      writeStoredNumber(MUTED_KEY, el.muted ? 1 : 0);
    }
  }, []);


  // 快捷键
  useEffect(() => {
    const onKey = (e) => {
      const v = videoRef.current;
      if (!v || e.target.tagName === 'INPUT') return;
      const { currentIndex: ci, activeSeriesId: sid, autoNext: an } = stateRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        v.paused ? v.play().catch(() => {}) : v.pause();
      } else if (e.key === 'ArrowRight') {
        v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        v.currentTime = Math.max(0, v.currentTime - 5);
      } else if (e.key === 'ArrowUp') {
        const p = findPrev(ci);
        if (p) {
          if (sid) window.electronAPI.savePlaybackPosition(sid, ci, v.currentTime);
          goToEpisode(p.vid_index, true);
        }
      } else if (e.key === 'ArrowDown') {
        const n = findNext(ci);
        if (n && n.status === 'completed') goToEpisode(n.vid_index, true);
        else if (n) setWaitingFor(n.vid_index);
      } else if (e.key.toLowerCase() === 'a') {
        setAutoNext(!an);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findNext, findPrev, goToEpisode]);

  const switchSeries = async (sid) => {
    persistPosition();
    setActiveSeriesId(sid);
    setDetail(null);
    setWaitingFor(null);
    setOnlineVid(null);
    setOnlineUrl('');
    setOnlineProgress(null);
    const d = await loadDetail(sid);
    const saved = await window.electronAPI.getPlaybackPosition(sid);
    if (saved && saved.vid_index) setCurrentIndex(saved.vid_index);
    else if (d) {
      const firstPlayable = d.episodes.find((e) => e.status === 'completed');
      setCurrentIndex(firstPlayable ? firstPlayable.vid_index : 1);
    }
    pendingSeekRef.current = saved ? saved.currentTime || 0 : 0;
  };

  // 从列表移除一部短剧（只取消登记，不删本地文件）
  const removeSeries = async (sid, title) => {
    const res = await window.electronAPI.removeSeries(sid);
    if (!res || !res.success) {
      showToast((res && res.error) || '移除失败');
      return;
    }
    showToast(`已从列表移除《${title}》（本地文件保留）`);
    const list = await loadSeriesList();
    refreshCacheInfo();
    if (String(sid) === String(activeSeriesId)) {
      const next = list[0];
      if (next) await switchSeries(next.series_id);
      else {
        setActiveSeriesId('');
        setDetail(null);
      }
    }
  };

  const purgeEmpty = async () => {
    const res = await window.electronAPI.purgeEmptySeries();
    if (res && res.success) {
      showToast(res.count > 0 ? `已清理 ${res.count} 部未下载的剧` : '没有可清理的剧');
      const list = await loadSeriesList();
      refreshCacheInfo();
      if (!list.some((s) => String(s.series_id) === String(activeSeriesId))) {
        if (list[0]) await switchSeries(list[0].series_id);
      }
    }
  };

  const restoreDismissed = async () => {
    const res = await window.electronAPI.restoreDismissedSeries();
    if (res && res.success) {
      showToast(res.count > 0 ? `已恢复 ${res.count} 部被移除的剧` : '没有被移除的剧');
      await loadSeriesList();
      refreshCacheInfo();
    }
  };

  const clearCache = async () => {
    await window.electronAPI.clearOnlineCache();
    refreshCacheInfo();
    showToast('已清空在线播放缓存');
  };

  const downloadEpisode = async (vidIndex) => {
    const res = await window.electronAPI.downloadSingleEpisode(activeSeriesId, vidIndex);
    if (res && res.success) {
      showToast(res.count > 0 ? `第 ${vidIndex} 集已加入下载队列` : `第 ${vidIndex} 集已在队列中`);
      if (currentIndex === vidIndex) setWaitingFor(vidIndex);
    } else {
      showToast((res && res.error) || '加入下载失败');
    }
  };

  const downloadMissing = async () => {
    const missing = episodes.filter((e) => e.status !== 'completed');
    if (!missing.length) {
      showToast('全部已下载');
      return;
    }
    let ok = 0;
    for (const ep of missing) {
      const r = await window.electronAPI.downloadSingleEpisode(activeSeriesId, ep.vid_index);
      if (r && r.success) ok++;
    }
    showToast(`已把 ${ok} 集加入下载队列`);
  };

  // 一键合并当前这部剧（弹出格式选择）
  const mergeThisSeries = async (compatible) => {
    setMerging(true);
    setMergeAsk(false);
    try {
      const res = await window.electronAPI.mergeSeries(activeSeriesId, '', { compatible });
      if (!res || !res.success) {
        showToast((res && res.error) || '合并失败');
        return;
      }
      const tip = compatible
        ? `开始兼容格式合并 ${res.count} 集（H.264，耗时较长）`
        : `开始合并 ${res.count} 集，约 ${(res.totalBytes / 1073741824).toFixed(2)} GB`;
      showToast(`${tip}，可在「下载管理」查看进度`);
      if (res.codecWarning) showToast(res.codecWarning);
    } catch (e) {
      showToast('合并异常: ' + e.message);
    } finally {
      setMerging(false);
    }
  };

  // ===== 渲染 =====
  if (loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">加载中…</p>;
  }

  if (!seriesList.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <Film className="size-10 text-muted-foreground" />
        <p className="text-sm">还没有可播放的短剧</p>
        <p className="text-xs text-muted-foreground">
          去「浏览」挑一部，点开即可在线播放，无需先下载
        </p>
        {onNavigate && (
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => onNavigate('browse')}>去浏览剧集</Button>
            <Button variant="outline" onClick={() => onNavigate('download')}>
              去搜索 / 粘贴链接
            </Button>
          </div>
        )}
        {dismissedCount > 0 && (
          <Button variant="outline" size="sm" onClick={restoreDismissed}>
            恢复已移除的 {dismissedCount} 部
          </Button>
        )}
      </div>
    );
  }

  // 可播放：本地已下载走 file://，否则走在线内存流；兼容模式下优先用转码后的文件
  const compatUrl = current ? compatMap[current.vid_index] : null;
  const isOnlinePlaying = onlineVid && current && current.vid === onlineVid && onlineUrl;
  const canPlay = !!(current && (compatUrl || (current.status === 'completed' && current.fileUrl) || isOnlinePlaying));
  const videoSrc = compatUrl || (isOnlinePlaying ? onlineUrl : (current && current.fileUrl) || '');

  // 切集 / 恢复断点
  //
  // 依赖 videoSrc（真正喂给 <video> 的地址）而不是 current.fileUrl：
  // 在线播放时 fileUrl 为空，用它当依赖会完全捕捉不到源的到来。
  // 同时不再要求 status === 'completed' —— 未下载走在线播放同样要能续播。
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc || !current) return;
    const seekTo = pendingSeekRef.current || 0;
    const onLoaded = () => {
      if (seekTo > 0 && seekTo < v.duration - 3) {
        v.currentTime = seekTo;
        showToast(`从 ${Math.floor(seekTo / 60)}:${String(Math.floor(seekTo % 60)).padStart(2, '0')} 继续播放`);
      }
      pendingSeekRef.current = 0;
      v.play().catch(() => {});
    };
    // src 已经就位时 loadedmetadata 不会再触发，补一次尝试
    if (v.readyState >= 1) onLoaded();
    else v.addEventListener('loadedmetadata', onLoaded, { once: true });
    return () => v.removeEventListener('loadedmetadata', onLoaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc]);

  return (
    <div className="flex flex-col gap-4 pb-10">
      {/* 全局操作条 */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          已下载 {playableCount} / {episodes.length || 0} 集
        </Badge>
        <Button
          variant={autoNext ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAutoNext(!autoNext)}
          title="播完自动播放下一集（快捷键 A）"
        >
          <Layers />
          连播 {autoNext ? '开' : '关'}
        </Button>
        <Button
          variant={autoCompat ? 'default' : 'outline'}
          size="sm"
          onClick={toggleAutoCompat}
          title="本机无法解码 HEVC 时自动转码为 H.264 播放（解决黑屏有声）"
        >
          <Zap />
          兼容模式 {autoCompat ? '开' : '关'}
        </Button>
        <Button
          variant={autoDelete ? 'default' : 'outline'}
          size="sm"
          onClick={toggleAutoDelete}
          title="看完一集后自动删除该集的本地文件（边看边清，不占磁盘）"
        >
          <Trash2 />
          看完自动删 {autoDelete ? '开' : '关'}
        </Button>
        <Button variant="outline" size="sm" onClick={downloadMissing}>
          <Download />
          下载未完成集
        </Button>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => setMergeAsk(true)}
          disabled={merging || playableCount === 0}
          title="把已下载的分集合并成单个 mp4，方便一次性看完"
        >
          <Layers />
          {merging ? '提交中...' : '合并导出全集'}
        </Button>
      </div>

      {/* 剧集选择：当前剧 + 抽屉管理面板 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <div className="grid gap-0.5">
          <span className="text-xs text-muted-foreground">正在播放</span>
          <span className="truncate font-medium" title={detail ? detail.series_title : ''}>
            {detail ? detail.series_title : '—'}
          </span>
        </div>
        <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
          <Button variant="outline" onClick={() => setPickerOpen(true)}>
            切换剧集
            <Badge variant="secondary">{seriesList.length}</Badge>
            <ChevronDown />
          </Button>
          <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>切换剧集</SheetTitle>
              <SheetDescription>
                共 {seriesList.length} 部，本地已占用 {fmtSize(storageTotal.bytes)} / {storageTotal.files} 个文件
              </SheetDescription>
            </SheetHeader>

            <div className="px-4">
              <Input
                placeholder="搜索剧名…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
              />
            </div>

            <ScrollArea className="flex-1 px-4">
              {seriesList.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">还没有剧集</p>
              ) : (
                <div className="flex flex-col gap-2 py-2">
                  {seriesList
                    .filter((s) => !pickerQuery.trim() || (s.series_title || '').includes(pickerQuery.trim()))
                    .map((s) => {
                      const isActive = String(s.series_id) === String(activeSeriesId);
                      const dl = downloadedMap[String(s.series_id)];
                      const st = storageMap[String(s.series_id)];
                      const hasFiles = st && st.files > 0;
                      return (
                        <div
                          key={s.series_id}
                          className={`flex items-center gap-3 rounded-lg border p-2 transition-colors ${
                            isActive ? 'bg-accent' : 'hover:bg-accent/50'
                          }`}
                          onClick={() => {
                            if (!isActive) switchSeries(s.series_id);
                            setPickerOpen(false);
                          }}
                        >
                          <div className="grid aspect-3/4 w-9 shrink-0 place-items-center overflow-hidden rounded border bg-muted text-muted-foreground">
                            {s.cover ? (
                              <img src={s.cover} alt="" loading="lazy" className="size-full object-cover" />
                            ) : (
                              <Film className="size-4" />
                            )}
                          </div>
                          <div className="grid flex-1 gap-0.5">
                            <span className="truncate text-sm font-medium">{s.series_title}</span>
                            <span className="text-xs text-muted-foreground">
                              {dl && dl.completed > 0
                                ? `已下载 ${dl.completed}/${dl.total} 集`
                                : `共 ${(s.episodes || []).length} 集 · 未下载`}
                            </span>
                          </div>
                          {isActive && <Badge>播放中</Badge>}
                          <div className="flex shrink-0 gap-1">
                            {hasFiles && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title={`删除本地文件（${st.files} 个 · ${fmtSize(st.bytes)}）`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmAsk({
                                    title: '删除本地文件',
                                    message: `将删除《${s.series_title}》已下载的 ${st.files} 个文件，释放 ${fmtSize(st.bytes)}。\n剧集仍保留在列表中，之后可以随时在线播放或重新下载。`,
                                    okText: '删除文件',
                                    danger: true,
                                    onOk: async () => {
                                      const r = await window.electronAPI.deleteSeriesFiles(s.series_id);
                                      if (r && r.success) {
                                        showToast(`已删除 ${r.count} 个文件，释放 ${fmtSize(r.freed)}`);
                                        await loadDetail(activeSeriesId);
                                        refreshCacheInfo();
                                      } else {
                                        showToast((r && r.error) || '删除失败');
                                      }
                                    },
                                  });
                                }}
                              >
                                <Trash2 className="text-destructive" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              title="从列表移除（不删除本地文件）"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeSeries(s.series_id, s.series_title);
                              }}
                            >
                              <X />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </ScrollArea>

            <div className="flex flex-wrap items-center gap-2 border-t p-4">
              <Button
                variant="outline"
                size="sm"
                onClick={purgeEmpty}
                title="把没有下载过任何一集的剧从列表中移除"
              >
                <Trash2 />
                清理未下载的剧
              </Button>
              {dismissedCount > 0 && (
                <Button variant="outline" size="sm" onClick={restoreDismissed}>
                  恢复已移除 ({dismissedCount})
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={clearCache}
                title="释放在线播放占用的内存"
              >
                <Zap />
                清空播放缓存{cacheInfo.count > 0 ? ` (${cacheInfo.count})` : ''}
              </Button>
              {compatCache.files > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearCompatCache}
                  title="删除转码产生的兼容格式文件"
                >
                  <Trash2 />
                  清空转码缓存 ({fmtSize(compatCache.bytes)})
                </Button>
              )}
              {storageTotal.files > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  title="删除所有已下载的本地文件"
                  onClick={() => {
                    setConfirmAsk({
                      title: '删除全部本地文件',
                      message: `将删除所有已下载的剧集文件，共 ${storageTotal.files} 个文件、${fmtSize(storageTotal.bytes)}。\n剧集列表与分集信息会保留，之后仍可在线播放或重新下载。`,
                      okText: '全部删除',
                      danger: true,
                      onOk: async () => {
                        const r = await window.electronAPI.deleteAllDownloaded();
                        if (r && r.success) {
                          showToast(`已删除 ${r.count} 个文件，释放 ${fmtSize(r.freed)}`);
                          await loadDetail(activeSeriesId);
                          refreshCacheInfo();
                        } else {
                          showToast((r && r.error) || '删除失败');
                        }
                      },
                    });
                  }}
                >
                  删除全部已下载
                </Button>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* 播放区 */}
      <div className="relative overflow-hidden rounded-lg border bg-black">
        {canPlay ? (
          <video
            ref={videoRef}
            src={videoSrc}
            className="aspect-video w-full"
            controls
            autoPlay
            onEnded={handleEnded}
            onPause={persistPosition}
            onPlaying={handlePlaying}
            onRateChange={handleRateChange}
            onVolumeChange={handleVolumeChange}
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-neutral-400">
            {onlineProgress && onlineProgress.vid && (!current || current.vid === onlineProgress.vid) ? (
              <>
                <RefreshCw className="size-8 animate-spin" />
                <p>
                  {onlineProgress.phase === 'decrypting' ? '正在解密…' : '正在缓冲在线播放…'}
                </p>
                <div className="flex w-full max-w-sm items-center gap-2">
                  <Progress value={onlineProgress.percent || 0} className="h-1.5" />
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums">
                    {onlineProgress.percent || 0}%
                  </span>
                </div>
                <span className="text-xs">
                  {onlineProgress.total
                    ? `${(onlineProgress.received / 1048576).toFixed(1)} / ${(onlineProgress.total / 1048576).toFixed(1)} MB · `
                    : ''}
                  不写入本地磁盘，仅占用内存
                </span>
              </>
            ) : waitingFor != null ? (
              <>
                <RefreshCw className="size-8 animate-spin" />
                <p>第 {waitingFor} 集正在下载，完成后自动播放…</p>
                {(() => {
                  const ep = episodes.find((e) => e.vid_index === waitingFor);
                  return ep && ep.status === 'downloading' ? (
                    <Progress value={ep.progress || 0} className="h-1.5 w-full max-w-sm" />
                  ) : null;
                })()}
                <span className="text-xs">也可以直接在线播放这一集</span>
              </>
            ) : current ? (
              <>
                <Film className="size-8" />
                <p>
                  第 {current.vid_index} 集
                  {current.status === 'downloading'
                    ? '正在下载'
                    : current.status === 'pending'
                      ? '排队中'
                      : '尚未下载'}
                </p>
                {current.status === 'downloading' && (
                  <Progress value={current.progress || 0} className="h-1.5 w-full max-w-sm" />
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => startOnlinePlay(current.vid_index)}>
                    <Play />
                    在线播放（不下载）
                  </Button>
                  <Button variant="outline" onClick={() => downloadEpisode(current.vid_index)}>
                    <Download />
                    下载本集
                  </Button>
                </div>
                <span className="text-xs">在线播放会临时缓存在内存中，不占用你的下载目录</span>
              </>
            ) : (
              <>
                <Film className="size-8" />
                <p>请选择一集开始播放</p>
              </>
            )}
          </div>
        )}

        {/* 兼容模式浮层：解码失败提示 / 转码进度 */}
        {compatProgress && compatProgress.vidIndex === currentIndex && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 p-6 text-center text-sm text-neutral-200">
            <RefreshCw className="size-6 animate-spin" />
            <p>正在转码为兼容格式（H.264）…</p>
            <div className="flex w-full max-w-sm items-center gap-2">
              <Progress value={compatProgress.percent || 0} className="h-1.5" />
              <span className="w-10 shrink-0 text-right text-xs tabular-nums">
                {compatProgress.percent || 0}%
              </span>
            </div>
            <span className="text-xs text-neutral-400">
              本机无法解码 HEVC，转码一次后可正常播放与拖动
            </span>
          </div>
        )}

        {!compatProgress && decodeFailed && canPlay && !compatUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 p-6 text-center text-sm text-neutral-200">
            <Film className="size-7" />
            <p>画面无法显示（有声音）</p>
            <span className="max-w-sm text-xs text-neutral-400">
              本机不支持该视频的编码格式（HEVC）。转码为 H.264 后即可正常播放。
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => startCompatPlay(currentIndex)}>
                <Zap />
                转码后播放
              </Button>
              <Button variant="outline" onClick={toggleAutoCompat}>
                {autoCompat ? '关闭自动转码' : '开启自动转码'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 播放中的集信息 */}
      {current && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            《{detail ? detail.series_title : ''}》第 {current.vid_index} 集
          </span>
          {current.title && <span className="text-muted-foreground">{current.title}</span>}
          <Badge variant="secondary" className="ml-auto">
            {current.status === 'completed'
              ? '可播放'
              : current.status === 'downloading'
                ? `下载中 ${current.progress || 0}%`
                : current.status === 'pending'
                  ? '排队中'
                  : '未下载'}
          </Badge>
        </div>
      )}

      {/* 分集列表 */}
      <div className="grid grid-cols-6 gap-2 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12">
        {episodes.map((ep) => {
          const isCurrent = ep.vid_index === currentIndex;
          return (
            <Button
              key={ep.vid_index}
              type="button"
              size="sm"
              variant={isCurrent ? 'default' : ep.status === 'completed' ? 'secondary' : 'outline'}
              className="relative h-9 gap-1 overflow-hidden px-1"
              onClick={() => {
                if (ep.status === 'completed') goToEpisode(ep.vid_index, true);
                else if (ep.status === 'downloading' || ep.status === 'pending') {
                  setWaitingFor(ep.vid_index);
                  setCurrentIndex(ep.vid_index);
                } else {
                  // 未下载：直接在线播放，不必先下载
                  startOnlinePlay(ep.vid_index);
                }
              }}
              onDoubleClick={() => ep.status !== 'completed' && downloadEpisode(ep.vid_index)}
              title={
                ep.status === 'completed'
                  ? '点击播放（本地）'
                  : ep.status === 'downloading' || ep.status === 'pending'
                    ? '正在下载，完成后自动播放'
                    : '点击在线播放（不下载）· 双击加入下载'
              }
            >
              {ep.status === 'completed' && <Check className="size-3" />}
              <span className="tabular-nums">{ep.vid_index}</span>
              {ep.status === 'downloading' && (
                <span
                  className="absolute bottom-0 left-0 h-0.5 bg-foreground/60"
                  style={{ width: `${ep.progress || 0}%` }}
                />
              )}
              {onlineVid === ep.vid && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-destructive" />
              )}
            </Button>
          );
        })}
      </div>

      <Card>
        <CardContent className="py-3 text-xs text-muted-foreground">
          <Separator className="mb-3" />
          快捷键：空格 播放/暂停 · ← → 快退/快进 5 秒 · ↑ ↓ 上一集/下一集 · A 切换连播。
          <br />
          <b className="text-foreground">灰色分集点一下即可在线播放</b>（不下载、不占下载目录，缓存在内存中）；双击才加入下载队列。连播时遇到未下载的集会自动转在线播放。
        </CardContent>
      </Card>

      {/* 合并格式选择 */}
      <AlertDialog open={mergeAsk} onOpenChange={setMergeAsk}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>合并导出全集</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                <span>
                  把《{detail ? detail.series_title : ''}》已下载的 {playableCount} 集合并为一个 mp4。
                </span>
                <span>
                  <b>快速合并</b>：原画质直接拼接，秒级完成，但格式仍是 HEVC —— 在部分电脑上可能黑屏有声。
                </span>
                <span>
                  <b>兼容合并</b>：转码为 H.264，任何电脑/播放器都能播，但速度慢（约每分钟视频需数秒）。
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button variant="outline" onClick={() => mergeThisSeries(true)} disabled={merging}>
              兼容合并（H.264）
            </Button>
            <AlertDialogAction onClick={() => mergeThisSeries(false)} disabled={merging}>
              快速合并
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除确认 */}
      <AlertDialog
        open={Boolean(confirmAsk)}
        onOpenChange={(open) => {
          if (!open) setConfirmAsk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAsk && confirmAsk.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-1">
                {confirmAsk &&
                  String(confirmAsk.message)
                    .split('\n')
                    .map((line, i) => <span key={i}>{line}</span>)}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={confirmAsk && confirmAsk.danger ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
              onClick={async () => {
                const fn = confirmAsk.onOk;
                setConfirmAsk(null);
                await fn();
              }}
            >
              {confirmAsk && (confirmAsk.okText || '确定')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default Player;
