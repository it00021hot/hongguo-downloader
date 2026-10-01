import React, { useEffect, useState } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { Header } from '@/components/layout/header';
import { Main } from '@/components/layout/main';
import { SkipToMain } from '@/components/skip-to-main';
import { ThemeSwitch } from '@/components/theme-switch';
import { NAV_ITEMS } from '@/components/layout/sidebar-nav';
import HongguoDownload from '@/components/HongguoDownload';
import DownloadManager from '@/components/DownloadManager';
import SettingsPage from '@/components/Settings';
import Player from '@/components/Player';
import Browse from '@/components/Browse';

export default function App() {
  const [page, setPage] = useState('browse');
  const [appInfo, setAppInfo] = useState(null); // { version, brand, appName }
  const [playerTarget, setPlayerTarget] = useState(null); // 浏览页点播 -> 播放页选中

  useEffect(() => {
    window.electronAPI.getAppInfo().then((info) => {
      setAppInfo(info);
    });
  }, []);

  // 主进程发来的导航指令（例如浏览页点「立即播放」）
  useEffect(() => {
    if (!window.electronAPI.onNavigate) return undefined;
    return window.electronAPI.onNavigate((data) => {
      if (!data || !data.page) return;
      if (data.payload) setPlayerTarget({ ...data.payload, ts: Date.now() });
      setPage(data.page);
    });
  }, []);

  const renderPage = () => {
    switch (page) {
      case 'browse':
        return <Browse onNavigate={setPage} />;
      case 'player':
        return <Player target={playerTarget} onNavigate={setPage} />;
      case 'manager':
        return <DownloadManager onNavigate={setPage} />;
      case 'settings':
        return <SettingsPage />;
      case 'download':
        return <HongguoDownload onNavigate={setPage} />;
    }
  };

  const current = NAV_ITEMS[page];

  return (
    <SidebarProvider>
      <SkipToMain />
      <AppSidebar
        activePage={page}
        brand={appInfo ? appInfo.brand : '红果短剧下载器'}
        version={appInfo ? appInfo.version : ''}
        onNavigate={setPage}
      />
      <SidebarInset>
        <Header>
          <div className="flex flex-1 items-center justify-between gap-4">
            <div className="grid gap-0.5">
              <h1 className="truncate text-base font-semibold">{current.title}</h1>
              <p className="hidden truncate text-xs text-muted-foreground md:block">
                {current.description}
              </p>
            </div>
            <ThemeSwitch />
          </div>
        </Header>
        <Main id="content" className="flex-1 overflow-y-auto">
          {renderPage()}
        </Main>
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  );
}
