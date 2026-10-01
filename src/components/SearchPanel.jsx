import React, { useState } from 'react';
import { ExternalLink, Film, RefreshCw, Search } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * SearchPanel —— 通过内嵌浏览器嗅探 hongguoduanju.com 的搜索结果
 * 拿到 series_id 后交给父组件走既有的「拉全集 + 选集下载」流程。
 */
function SearchPanel({ onSelectSeries, onSwitchToInput }) {
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null); // null=未搜索, []=无结果
  const [error, setError] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pickingId, setPickingId] = useState('');

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw) {
      setError('请输入剧名关键词');
      return;
    }
    setLoading(true);
    setError('');
    setResults(null);
    setPageTitle('');
    try {
      const res = await window.electronAPI.searchSeries(kw);
      if (!res || !res.success) {
        setError((res && res.error) || '搜索失败，请重试');
        setResults([]);
      } else {
        setResults(res.results || []);
        if (!res.results || res.results.length === 0) setPageTitle(res.pageTitle || '');
      }
    } catch (e) {
      setError('搜索异常: ' + e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  // 选中某部剧 -> 拉取完整分集 -> 交给下载页
  const pick = async (item) => {
    setPickingId(item.series_id);
    setError('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (res && res.success && res.data) {
        onSelectSeries(res.data);
      } else {
        setError((res && res.error) || '拉取分集失败');
      }
    } catch (e) {
      setError('拉取分集异常: ' + e.message);
    } finally {
      setPickingId('');
    }
  };

  const showBrowser = async () => {
    await window.electronAPI.searchWindowShow(true);
    setError('已打开搜索窗口，可手动操作；关闭该窗口后回到本页继续。');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>搜索短剧</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input
            placeholder="输入剧名，例如：一村人养一个神"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          />
          <Button onClick={doSearch} disabled={loading} className="shrink-0">
            {loading ? (
              <>
                <RefreshCw className="animate-spin" />
                搜索中...
              </>
            ) : (
              <>
                <Search />
                搜索
              </>
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          搜索词会用内置浏览器打开 hongguoduanju.com 取回结果，选中后可一键拉取全集下载。
        </p>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" />
            正在嗅探搜索结果，首次可能需要几秒…
          </div>
        )}

        {results && results.length === 0 && !loading && (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6">
            <p className="text-sm text-muted-foreground">
              没有找到相关短剧{pageTitle ? `（页面标题：${pageTitle}）` : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={showBrowser}>
                <ExternalLink />
                显示浏览器窗口
              </Button>
              {onSwitchToInput && (
                <Button variant="outline" size="sm" onClick={onSwitchToInput}>
                  改用链接 / ID 下载
                </Button>
              )}
            </div>
          </div>
        )}

        {results && results.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">找到 {results.length} 部相关短剧</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {results.map((item) => (
                <button
                  key={item.series_id}
                  type="button"
                  disabled={pickingId !== ''}
                  onClick={() => pick(item)}
                  className="flex flex-col overflow-hidden rounded-lg border text-start transition-colors hover:bg-accent disabled:opacity-60"
                  title={`点击查看并下载：${item.series_title}`}
                >
                  <div className="aspect-3/4 w-full bg-muted">
                    {item.cover ? (
                      <img
                        src={item.cover}
                        alt={item.series_title}
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="grid size-full place-items-center text-muted-foreground">
                        <Film className="size-5" />
                      </div>
                    )}
                  </div>
                  <div className="grid gap-0.5 p-2.5">
                    <span className="line-clamp-2 text-sm font-medium">{item.series_title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {pickingId === item.series_id ? (
                        <span className="inline-flex items-center gap-1">
                          <RefreshCw className="size-3 animate-spin" />
                          正在拉取分集…
                        </span>
                      ) : (
                        `series_id ${item.series_id}`
                      )}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default SearchPanel;
