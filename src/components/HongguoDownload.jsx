import React, { useState } from 'react';
import { Download, Film, FolderOpen, RefreshCw, Search, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import SearchPanel from './SearchPanel';

const QUICK_SELECTS = [
  { type: 'first10', label: '前 10 集' },
  { type: 'first30', label: '前 30 集' },
  { type: 'last30', label: '后 30 集' },
];

function HongguoDownload({ onNavigate }) {
  const [tab, setTab] = useState('search'); // 'search' | 'input'
  const [inputUrl, setInputUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // 短剧解析结果
  const [seriesData, setSeriesData] = useState(null); // { series_id, series_title, cover, total, episodes: [...] }
  const [selectedVids, setSelectedVids] = useState(new Set());
  const [rangeInput, setRangeInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 搜索选中一部剧后：复用既有的选集下载界面
  const handleSeriesFromSearch = (data) => {
    setErrorMsg('');
    setTab('input');
    setSeriesData(data);
    setSelectedVids(new Set(data.episodes.map((ep) => ep.vid)));
    setSuccessMsg(`已选中《${data.series_title}》共 ${data.total} 集，可直接提交下载`);
  };

  // 解析红果短剧
  const handleResolve = async () => {
    if (!inputUrl.trim()) {
      setErrorMsg('请输入红果短剧分享链接或 series_id');
      return;
    }
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    setSeriesData(null);
    setSelectedVids(new Set());

    try {
      const res = await window.electronAPI.hongguoResolve(inputUrl.trim());
      if (res.success && res.data) {
        setSeriesData(res.data);
        // 默认全选
        const allVids = new Set(res.data.episodes.map((ep) => ep.vid));
        setSelectedVids(allVids);
        setSuccessMsg(`解析成功！找到《${res.data.series_title}》共 ${res.data.total} 集`);
      } else {
        setErrorMsg(res.error || '解析失败，请检查链接或网络');
      }
    } catch (err) {
      setErrorMsg('解析过程出现错误: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // 勾选/取消勾选单集
  const toggleVid = (vid) => {
    const next = new Set(selectedVids);
    if (next.has(vid)) {
      next.delete(vid);
    } else {
      next.add(vid);
    }
    setSelectedVids(next);
  };

  // 全选
  const handleSelectAll = () => {
    if (!seriesData) return;
    setSelectedVids(new Set(seriesData.episodes.map((ep) => ep.vid)));
  };

  // 反选
  const handleInvertSelect = () => {
    if (!seriesData) return;
    const next = new Set();
    for (const ep of seriesData.episodes) {
      if (!selectedVids.has(ep.vid)) {
        next.add(ep.vid);
      }
    }
    setSelectedVids(next);
  };

  // 清空选择
  const handleDeselectAll = () => {
    setSelectedVids(new Set());
  };

  // 快捷集数选择
  const handleQuickSelect = (type) => {
    if (!seriesData || !seriesData.episodes) return;
    const eps = seriesData.episodes;
    const total = eps.length;
    let targetEps = [];
    if (type === 'first10') {
      targetEps = eps.slice(0, 10);
    } else if (type === 'first30') {
      targetEps = eps.slice(0, 30);
    } else if (type === 'last30') {
      targetEps = eps.slice(Math.max(0, total - 30));
    }
    setSelectedVids(new Set(targetEps.map((ep) => ep.vid)));
  };

  // 根据区间字符串应用筛选 (如 "1-30" 或 "1,5,10-20")
  const handleApplyRange = () => {
    if (!seriesData || !seriesData.episodes || !rangeInput.trim()) return;
    const total = seriesData.episodes.length;
    const nums = new Set();
    const parts = rangeInput.split(',');
    for (let part of parts) {
      part = part.trim();
      if (part.includes('-')) {
        const [a, b] = part.split('-').map((n) => parseInt(n.trim(), 10));
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (i >= 1 && i <= total) nums.add(i);
          }
        }
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n) && n >= 1 && n <= total) nums.add(n);
      }
    }
    const selectedEps = seriesData.episodes.filter((ep) => nums.has(ep.vid_index));
    setSelectedVids(new Set(selectedEps.map((ep) => ep.vid)));
  };

  // 提交批量下载
  const handleBatchDownload = async () => {
    if (!seriesData || selectedVids.size === 0) {
      setErrorMsg('请至少勾选一集欲下载的短剧');
      return;
    }
    setSubmitting(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const selectedEps = seriesData.episodes.filter((ep) => selectedVids.has(ep.vid));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: seriesData.series_id,
        seriesTitle: seriesData.series_title,
        episodes: selectedEps,
      });
      if (res.success) {
        setSuccessMsg(`已成功将 ${res.count} 集提交至下载队列！点击下方按钮跳转至“下载管理”查看实时进度。`);
      } else {
        setErrorMsg(res.error || '提交下载失败');
      }
    } catch (err) {
      setErrorMsg('提交下载异常: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 pb-10">
      <p className="text-sm text-muted-foreground">
        支持粘贴红果短剧 App 分享链接或剧集 ID，突破 AES-128 CENC 原生加密，无水印全集高清下载。
      </p>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="search">
            <Search />
            搜索剧集
          </TabsTrigger>
          <TabsTrigger value="input">
            <Sparkles />
            粘贴链接 / ID
          </TabsTrigger>
        </TabsList>

        <TabsContent value="search" className="mt-4">
          <SearchPanel
            onSelectSeries={handleSeriesFromSearch}
            onSwitchToInput={() => setTab('input')}
          />
        </TabsContent>

        <TabsContent value="input" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>输入短剧链接或 ID</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  placeholder="例如: https://novelquickapp.com/s/WGPClz6sw10/ 或 7664958856774044697"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleResolve()}
                />
                <Button onClick={handleResolve} disabled={loading} className="shrink-0">
                  {loading ? (
                    <>
                      <RefreshCw className="animate-spin" />
                      解析中...
                    </>
                  ) : (
                    <>
                      <Film />
                      解析剧集
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {errorMsg && (
        <Alert variant="destructive">
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}
      {successMsg && (
        <Alert>
          <AlertDescription>{successMsg}</AlertDescription>
        </Alert>
      )}

      {/* 剧集列表与选择控制 */}
      {seriesData && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex gap-4">
                {seriesData.cover ? (
                  <img
                    src={seriesData.cover}
                    alt={seriesData.series_title}
                    className="aspect-3/4 w-20 shrink-0 rounded-lg border object-cover"
                  />
                ) : (
                  <div className="grid aspect-3/4 w-20 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
                    <Film className="size-6" />
                  </div>
                )}
                <div className="grid content-start gap-2">
                  <CardTitle>《{seriesData.series_title}》</CardTitle>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge>总集数: {seriesData.total} 集</Badge>
                    <Badge variant="secondary" className="font-mono">
                      series_id: {seriesData.series_id}
                    </Badge>
                    <Badge variant="outline">AES-128 原生自动解密</Badge>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={handleBatchDownload}
                  disabled={submitting || selectedVids.size === 0}
                >
                  <Download />
                  下载选中集数 ({selectedVids.size}/{seriesData.total})
                </Button>
                {onNavigate && (
                  <Button variant="outline" onClick={() => onNavigate('manager')}>
                    <FolderOpen />
                    查看下载管理
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <Separator />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={handleSelectAll}>
                  全选
                </Button>
                <Button size="sm" variant="secondary" onClick={handleInvertSelect}>
                  反选
                </Button>
                <Button size="sm" variant="secondary" onClick={handleDeselectAll}>
                  取消全选
                </Button>
                <Separator orientation="vertical" className="h-5" />
                {QUICK_SELECTS.map((q) => (
                  <Button key={q.type} size="sm" variant="secondary" onClick={() => handleQuickSelect(q.type)}>
                    {q.label}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Label htmlFor="range-filter" className="text-xs text-muted-foreground">
                  范围筛选
                </Label>
                <Input
                  id="range-filter"
                  className="w-44"
                  placeholder="如 1-30 或 1,5,10"
                  value={rangeInput}
                  onChange={(e) => setRangeInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleApplyRange()}
                />
                <Button size="sm" onClick={handleApplyRange}>
                  应用
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {seriesData.episodes.map((ep) => (
                <label
                  key={ep.vid}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 transition-colors hover:bg-accent"
                >
                  <Checkbox
                    checked={selectedVids.has(ep.vid)}
                    onCheckedChange={() => toggleVid(ep.vid)}
                  />
                  <span className="grid min-w-0">
                    <span className="text-sm font-medium">
                      第 {String(ep.vid_index).padStart(2, '0')} 集
                    </span>
                    {ep.title && (
                      <span className="truncate text-xs text-muted-foreground">{ep.title}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default HongguoDownload;
