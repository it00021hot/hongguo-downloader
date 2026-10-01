import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { toast as sonnerToast } from 'sonner';
import { Check, Download, ExternalLink, Film, Play, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

/**
 * Browse —— 分类淘剧
 *
 * 数据链路：
 *   内嵌浏览器嗅探分类页 -> 卡片(series_id/剧名/封面/集数/标签)
 *   点卡片 -> 复用 search-resolve 拉全集并写入短剧档案
 *         -> 复用 get-series-episodes 拿到每集「已下载/下载中/未下载」状态
 *         -> 跳播放器 或 走既有批量下载
 */
function Browse({ onNavigate }) {
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('real-drama');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);

  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0, genres: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 详情抽屉
  const [detail, setDetail] = useState(null); // { series_id, series_title, cover, episodes: [...] }
  const [detailLoading, setDetailLoading] = useState(false);
  const [rangeInput, setRangeInput] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);

  // 已下载统计（按 series_id -> 已下载集数）
  const [downloadedMap, setDownloadedMap] = useState({});

  const showToast = useCallback((text, type = 'success') => {
    if (type === 'error') sonnerToast.error(text);
    else sonnerToast.success(text);
  }, []);

  const loadDownloadedMap = useCallback(async () => {
    try {
      const list = (await window.electronAPI.getSeriesList()) || [];
      const map = {};
      for (const s of list) {
        const res = await window.electronAPI.getSeriesEpisodes(s.series_id);
        if (res && res.success) {
          map[String(s.series_id)] = {
            completed: res.data.completedCount,
            total: res.data.total,
          };
        }
      }
      setDownloadedMap(map);
    } catch (_) {}
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const list = await window.electronAPI.browseCategories();
      if (Array.isArray(list) && list.length) {
        setCategories(list);
      }
    } catch (_) {}
  }, []);

  const loadList = useCallback(async (cat, gen, pg) => {
    setLoading(true);
    setError('');
    try {
      const res = await window.electronAPI.browseList({ category: cat, genre: gen, page: pg });
      if (!res || !res.success) {
        setError((res && res.error) || '加载失败，请重试');
        setResults([]);
      } else {
        setResults(res.results || []);
        setMeta({ total: res.total || 0, totalPages: res.totalPages || 0, genres: res.genres || [] });
        if (!res.results || res.results.length === 0) {
          setError('这一页没有取到内容，可试试换分类或「显示浏览器窗口」手动操作');
        }
      }
    } catch (e) {
      setError('加载异常: ' + e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategories();
    loadDownloadedMap();
  }, [loadCategories, loadDownloadedMap]);

  useEffect(() => {
    loadList(category, genre, page);
  }, [category, genre, page, loadList]);

  const switchCategory = (slug) => {
    if (slug === category) return;
    setCategory(slug);
    setGenre('');
    setPage(1);
    setResults([]);
  };

  const switchGenre = (slug) => {
    if (slug === genre) return;
    setGenre(slug);
    setPage(1);
    setResults([]);
  };

  const gotoPage = (p) => {
    const max = meta.totalPages || 1;
    const next = Math.min(Math.max(1, p), max);
    if (next === page) return;
    setPage(next);
  };

  // ===== 打开某部剧 =====
  const openSeries = async (item) => {
    setDetailLoading(true);
    setDetail(null);
    setSelectedIdx(new Set());
    setRangeInput('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (!res || !res.success) {
        showToast((res && res.error) || '拉取分集失败', 'error');
        return;
      }
      const data = res.data;
      // 合并下载状态
      const epRes = await window.electronAPI.getSeriesEpisodes(item.series_id);
      const statusMap = {};
      if (epRes && epRes.success) {
        for (const e of epRes.data.episodes) statusMap[e.vid_index] = e;
      }
      const episodes = data.episodes.map((ep) => ({
        ...ep,
        status: statusMap[ep.vid_index] ? statusMap[ep.vid_index].status : 'missing',
        progress: statusMap[ep.vid_index] ? statusMap[ep.vid_index].progress : 0,
        fileUrl: statusMap[ep.vid_index] ? statusMap[ep.vid_index].fileUrl : null,
      }));
      setDetail({
        ...data,
        episodes,
        completedCount: episodes.filter((e) => e.status === 'completed').length,
      });
      // 默认全选未下载的
      setSelectedIdx(new Set(episodes.filter((e) => e.status !== 'completed').map((e) => e.vid_index)));
    } catch (e) {
      showToast('打开失败: ' + e.message, 'error');
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleIdx = (idx) => {
    const next = new Set(selectedIdx);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelectedIdx(next);
  };

  // 区间快选：1-50 / 前10 / 后30 / 全选 / 清空
  const applyRange = (expr) => {
    if (!detail) return;
    const total = detail.episodes.length;
    const nums = new Set();
    const push = (n) => {
      if (n >= 1 && n <= total) nums.add(n);
    };
    const parse = (s) => {
      const text = String(s || '').trim();
      if (!text) return;
      for (const part of text.split(/[,，]/)) {
        const p = part.trim();
        if (!p) continue;
        const m = p.match(/^(\d+)\s*[-~]\s*(\d+)$/);
        if (m) {
          const a = parseInt(m[1], 10);
          const b = parseInt(m[2], 10);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) push(i);
        } else if (/^\d+$/.test(p)) {
          push(parseInt(p, 10));
        }
      }
    };
    parse(expr);
    setSelectedIdx(nums);
  };

  const downloadSelected = async () => {
    if (!detail || selectedIdx.size === 0) return;
    setSubmitting(true);
    try {
      const eps = detail.episodes.filter((e) => selectedIdx.has(e.vid_index));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: detail.series_id,
        seriesTitle: detail.series_title,
        episodes: eps,
      });
      if (res && res.success) {
        showToast(`已加入下载队列：${res.count} 集`);
        setDetail(null);
        if (onNavigate) onNavigate('manager');
      } else {
        showToast((res && res.error) || '提交下载失败', 'error');
      }
    } catch (e) {
      showToast('提交异常: ' + e.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 立即播放：优先从第一集已下载的开始
  const playNow = async () => {
    if (!detail) return;
    const first = detail.episodes.find((e) => e.status === 'completed');
    if (!first) {
      showToast('这一集还没下载，先点「下载选中」再播放', 'error');
      return;
    }
    await window.electronAPI.playSeries({ seriesId: detail.series_id, vidIndex: first.vid_index });
    setDetail(null);
  };

  const showBrowser = async () => {
    await window.electronAPI.searchWindowShow(true);
    showToast('已打开浏览器窗口，可手动操作；关闭后回到本页继续');
  };

  const totalPages = meta.totalPages || 0;
  const pageNumbers = useMemo(() => {
    if (!totalPages) return [];
    const out = [];
    const cur = page;
    const push = (n) => {
      if (n >= 1 && n <= totalPages && !out.includes(n)) out.push(n);
    };
    out.push(1);
    for (let i = cur - 1; i <= cur + 1; i++) push(i);
    out.push(totalPages);
    return out.sort((a, b) => a - b);
  }, [totalPages, page]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {meta.total > 0 ? `共 ${meta.total} 部` : '从分类里挑一部想看的短剧'}
        </p>
        <Button variant="outline" size="sm" onClick={showBrowser}>
          <ExternalLink />
          显示浏览器窗口
        </Button>
      </div>

      {/* 分类 tab */}
      <Tabs value={category} onValueChange={switchCategory}>
        <TabsList>
          {(categories.length ? categories : [{ slug: 'real-drama', label: '真人剧' }]).map((c) => (
            <TabsTrigger key={c.slug} value={c.slug}>
              {c.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* 题材 chips */}
      {meta.genres.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Badge
            variant={genre === '' ? 'default' : 'secondary'}
            className="cursor-pointer"
            onClick={() => switchGenre('')}
          >
            全部
          </Badge>
          {meta.genres.map((g) => (
            <Badge
              key={g.slug}
              variant={genre === g.slug ? 'default' : 'secondary'}
              className="cursor-pointer"
              onClick={() => switchGenre(g.slug)}
            >
              {g.label}
            </Badge>
          ))}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="aspect-3/4 w-full rounded-lg" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {results.map((item) => {
            const dl = downloadedMap[String(item.series_id)];
            return (
              <button
                key={item.series_id}
                type="button"
                onClick={() => openSeries(item)}
                className="group flex flex-col gap-2 text-start"
                title={item.series_title}
              >
                <div className="relative aspect-3/4 overflow-hidden rounded-lg border bg-muted">
                  {item.cover ? (
                    <img
                      src={item.cover}
                      alt={item.series_title}
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="grid size-full place-items-center text-muted-foreground">
                      <Film className="size-6" />
                    </div>
                  )}
                  {item.episode_count > 0 && (
                    <Badge variant="secondary" className="absolute top-1.5 right-1.5">
                      全{item.episode_count}集
                    </Badge>
                  )}
                  {dl && dl.completed > 0 && (
                    <Badge className="absolute top-1.5 left-1.5 gap-1">
                      <Check className="size-3" />
                      {dl.completed}/{dl.total}
                    </Badge>
                  )}
                  <div className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-white">
                      <Play className="size-4" />
                      {dl && dl.completed > 0 ? '播放' : '查看'}
                    </span>
                  </div>
                </div>
                <span className="line-clamp-2 text-sm font-medium">{item.series_title}</span>
                {item.tags && item.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {item.tags.slice(0, 3).map((t) => (
                      <Badge key={t} variant="outline" className="text-xs font-normal">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1">
          <Button
            variant="outline"
            size="icon"
            disabled={page <= 1}
            onClick={() => gotoPage(page - 1)}
            aria-label="上一页"
          >
            ‹
          </Button>
          {pageNumbers.map((n, i) => (
            <React.Fragment key={n}>
              {i > 0 && n - pageNumbers[i - 1] > 1 && <span className="px-1 text-muted-foreground">…</span>}
              <Button
                variant={n === page ? 'default' : 'outline'}
                size="icon"
                onClick={() => gotoPage(n)}
              >
                {n}
              </Button>
            </React.Fragment>
          ))}
          <Button
            variant="outline"
            size="icon"
            disabled={page >= totalPages}
            onClick={() => gotoPage(page + 1)}
            aria-label="下一页"
          >
            ›
          </Button>
        </div>
      )}

      {/* ===== 剧集详情抽屉 ===== */}
      <Sheet
        open={Boolean(detail || detailLoading)}
        onOpenChange={(open) => {
          if (!open && !detailLoading) setDetail(null);
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="truncate">
              {detail ? `《${detail.series_title}》` : '加载中…'}
            </SheetTitle>
            <SheetDescription>勾选要下载的集数，可直接下载或播放已下载的集</SheetDescription>
          </SheetHeader>

          {detailLoading && (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="size-4 animate-spin" />
              正在拉取全集…
            </div>
          )}

          {detail && (
            <>
              <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
                <div className="flex gap-4">
                  {detail.cover && (
                    <img
                      src={detail.cover}
                      alt=""
                      className="aspect-3/4 w-24 shrink-0 rounded-lg border object-cover"
                    />
                  )}
                  <div className="flex flex-1 flex-col gap-2">
                    <p className="text-sm text-muted-foreground">
                      共 {detail.total} 集 · 已下载 <b className="text-foreground">{detail.completedCount}</b> 集
                    </p>
                    <p className="text-sm text-muted-foreground">
                      选中 <b className="text-foreground">{selectedIdx.size}</b> 集待下载
                    </p>
                    <div className="flex gap-2">
                      <Input
                        placeholder="区间，如 1-50 或 1,3,5"
                        value={rangeInput}
                        onChange={(e) => setRangeInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && applyRange(rangeInput)}
                      />
                      <Button variant="outline" size="sm" onClick={() => applyRange(rangeInput)}>
                        应用
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => applyRange(`1-${Math.min(10, detail.total)}`)}
                      >
                        前10集
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => applyRange(`1-${Math.min(30, detail.total)}`)}
                      >
                        前30集
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          applyRange(`${Math.max(1, detail.total - 29)}-${detail.total}`)
                        }
                      >
                        后30集
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          setSelectedIdx(new Set(detail.episodes.map((e) => e.vid_index)))
                        }
                      >
                        全选
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setSelectedIdx(new Set())}>
                        清空
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
                  {detail.episodes.map((ep) => {
                    const picked = selectedIdx.has(ep.vid_index);
                    const done = ep.status === 'completed';
                    return (
                      <Button
                        key={ep.vid_index}
                        type="button"
                        size="sm"
                        variant={picked ? 'default' : done ? 'secondary' : 'outline'}
                        className="relative h-9 gap-1 px-1"
                        onClick={() => toggleIdx(ep.vid_index)}
                        title={ep.title || `第 ${ep.vid_index} 集`}
                      >
                        {done && <Check className="size-3" />}
                        <span className="tabular-nums">{ep.vid_index}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              <SheetFooter className="gap-2 sm:justify-between">
                <Button variant="outline" onClick={playNow}>
                  <Play />
                  立即播放
                </Button>
                <Button disabled={submitting || selectedIdx.size === 0} onClick={downloadSelected}>
                  <Download />
                  下载选中 ({selectedIdx.size})
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default Browse;
