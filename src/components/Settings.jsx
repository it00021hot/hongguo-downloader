import React, { useState, useEffect } from 'react';
import { Check, FolderOpen, Globe, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
  { label: '仅剧名', value: '剧名' },
];

const PROXY_MODES = [
  { value: 'system', label: '跟随系统', desc: '使用系统 / 环境变量里已有的代理设置' },
  { value: 'custom', label: '手动指定', desc: '自己填写代理地址与端口（支持 HTTP/HTTPS 代理）' },
  { value: 'direct', label: '强制直连', desc: '忽略一切代理，直接连接' },
];

// 常见代理软件默认端口，方便一键填入
const PORT_PRESETS = [
  { label: 'Clash / Mihomo', port: 7890 },
  { label: 'V2rayN', port: 10809 },
  { label: 'Shadowsocks', port: 1080 },
  { label: 'Burp / 抓包', port: 8080 },
];

const CONCURRENT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** 已保存设置 -> 当前生效的代理描述 */
function describeProxy(settings) {
  if (!settings || settings.proxy_enabled !== true) {
    return { on: false, text: '未启用（所有请求直连）' };
  }
  const mode = settings.proxy_mode || 'system';
  if (mode === 'direct') {
    return { on: false, text: '已开启但模式为「强制直连」' };
  }
  if (mode === 'custom') {
    const host = (settings.proxy_host || '').trim();
    const port = (settings.proxy_port || '').toString().trim();
    if (!host) return { on: false, text: '已开启，但未填写代理地址' };
    return { on: true, text: `${host}${port ? ':' + port : ''}` };
  }
  return { on: true, text: '跟随系统 / 环境变量代理' };
}

function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    window.electronAPI.getSettings().then(setSettings);
  }, []);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const selectFolder = async () => {
    const dir = await window.electronAPI.selectFolder();
    if (dir) update('root', dir);
  };

  const save = async () => {
    const res = await window.electronAPI.saveSettings(settings);
    if (res && res.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  // ===== 代理弹窗 =====
  const openProxyModal = () => {
    setProxyDraft({
      proxy_enabled: settings.proxy_enabled === true,
      proxy_mode: settings.proxy_mode || 'system',
      proxy_host: settings.proxy_host || '127.0.0.1',
      proxy_port: settings.proxy_port || 7890,
      proxy_username: settings.proxy_username || '',
      proxy_password: settings.proxy_password || '',
    });
    setTestResult(null);
    setProxyOpen(true);
  };

  const patchDraft = (key, value) => {
    setProxyDraft((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.electronAPI.testProxy(proxyDraft);
      setTestResult(res);
    } catch (e) {
      setTestResult({ success: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const applyProxy = async () => {
    const next = { ...settings, ...proxyDraft };
    const res = await window.electronAPI.saveSettings(next);
    if (res && res.success) {
      setSettings(next);
      setProxyOpen(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (!settings) {
    return <p className="text-sm text-muted-foreground">加载中...</p>;
  }

  const proxyInfo = describeProxy(settings);
  const draftMode = proxyDraft ? proxyDraft.proxy_mode : 'system';
  const draftModeDesc = PROXY_MODES.find((m) => m.value === draftMode)?.desc;
  const draftEnabled = proxyDraft ? proxyDraft.proxy_enabled : false;
  const disableDraftField = !draftEnabled;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-10">
      <Card>
        <CardHeader>
          <CardTitle>下载目录</CardTitle>
          <CardDescription>
            文件将保存到 <code className="font-mono">下载目录/红果短剧/剧名/</code> 下
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input
            value={settings.root || ''}
            onChange={(e) => update('root', e.target.value)}
            placeholder="选择下载保存目录"
          />
          <Button variant="outline" onClick={selectFolder} className="shrink-0">
            <FolderOpen />
            选择文件夹
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>文件命名规则</CardTitle>
          <CardDescription>
            可用变量：<code className="font-mono">剧名</code>（series_title）·
            <code className="font-mono">集数</code>（vid_index，如 001）·
            <code className="font-mono">标题</code>（ep_title）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {FORMAT_PRESETS.map((p) => (
              <Button
                key={p.value}
                size="sm"
                variant={settings.name_format === p.value ? 'default' : 'outline'}
                onClick={() => update('name_format', p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Input
            value={settings.name_format || ''}
            onChange={(e) => update('name_format', e.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>最大并发下载数</CardTitle>
          <CardDescription>
            同时下载 <b>{settings.max_concurrent || 3}</b> 集（保存后立即生效）。并发越高越快，
            但可能触发接口限流，建议 3~5。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={String(settings.max_concurrent || 3)}
            onValueChange={(v) => update('max_concurrent', parseInt(v, 10))}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONCURRENT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 个同时下载
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>网络代理</CardTitle>
          <CardDescription>
            本机有代理（Clash / V2rayN 等）时在这里填上，解析剧集与下载视频都会走该代理。保存后立即生效，
            无需重启。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant={proxyInfo.on ? 'default' : 'secondary'}>
            {proxyInfo.on ? '已启用' : '未启用'}
          </Badge>
          <span className="text-sm text-muted-foreground">{proxyInfo.text}</span>
          <Button variant="outline" size="sm" onClick={openProxyModal} className="ml-auto">
            <Globe />
            配置代理
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save}>
          {saved ? (
            <>
              <Check />
              已保存
            </>
          ) : (
            '保存设置'
          )}
        </Button>
      </div>

      <Dialog open={proxyOpen} onOpenChange={setProxyOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>网络代理设置</DialogTitle>
            <DialogDescription>
              关闭「启用代理」时所有请求直连，代理配置不会生效。
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="proxy-enabled" className="grid gap-0.5">
              启用代理
              <span className="text-xs font-normal text-muted-foreground">
                关闭时代理不生效，所有请求直连
              </span>
            </Label>
            <Switch
              id="proxy-enabled"
              checked={draftEnabled}
              onCheckedChange={(v) => patchDraft('proxy_enabled', v)}
            />
          </div>

          <div className="grid gap-5">
            <div className="grid gap-2">
              <Label>代理模式</Label>
              <Select
                value={draftMode}
                onValueChange={(v) => patchDraft('proxy_mode', v)}
                disabled={disableDraftField}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROXY_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{draftModeDesc}</p>
            </div>

            {draftMode === 'custom' && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="proxy-host">代理地址</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="proxy-host"
                      placeholder="127.0.0.1"
                      value={proxyDraft.proxy_host}
                      disabled={disableDraftField}
                      onChange={(e) => patchDraft('proxy_host', e.target.value)}
                    />
                    <span className="text-muted-foreground">:</span>
                    <Input
                      className="w-28"
                      placeholder="7890"
                      type="number"
                      min="1"
                      max="65535"
                      value={proxyDraft.proxy_port}
                      disabled={disableDraftField}
                      onChange={(e) => patchDraft('proxy_port', e.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {PORT_PRESETS.map((p) => (
                      <Button
                        key={p.port}
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={disableDraftField}
                        onClick={() => patchDraft('proxy_port', p.port)}
                      >
                        {p.label} {p.port}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="proxy-user">代理认证（可选）</Label>
                  <div className="flex gap-2">
                    <Input
                      id="proxy-user"
                      placeholder="用户名"
                      autoComplete="off"
                      value={proxyDraft.proxy_username}
                      disabled={disableDraftField}
                      onChange={(e) => patchDraft('proxy_username', e.target.value)}
                    />
                    <Input
                      type="password"
                      placeholder="密码"
                      autoComplete="new-password"
                      value={proxyDraft.proxy_password}
                      disabled={disableDraftField}
                      onChange={(e) => patchDraft('proxy_password', e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">代理无需认证时留空即可</p>
                </div>
              </>
            )}

            {testResult && (
              <Alert variant={testResult.success ? 'default' : 'destructive'}>
                {testResult.success ? (
                  <Check className="size-4" />
                ) : (
                  <TriangleAlert className="size-4" />
                )}
                <AlertTitle>{testResult.success ? '连接成功' : '连接失败'}</AlertTitle>
                <AlertDescription>
                  {testResult.success ? testResult.message : testResult.error}
                  {testResult.success && testResult.via ? ` · 经由 ${testResult.via}` : ''}
                </AlertDescription>
              </Alert>
            )}
          </div>

          <Separator />

          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={runTest} disabled={testing}>
              <RefreshCw className={testing ? 'animate-spin' : undefined} />
              {testing ? '测试中...' : '测试连接'}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setProxyOpen(false)}>
                取消
              </Button>
              <Button onClick={applyProxy}>
                <Check />
                保存并生效
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default SettingsPage;
