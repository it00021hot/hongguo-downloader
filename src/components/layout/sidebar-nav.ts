import {
  Compass,
  Download,
  ListChecks,
  PlayCircle,
  Settings,
  type LucideIcon,
} from 'lucide-react'

export type PageId = 'browse' | 'download' | 'player' | 'manager' | 'settings'

export type NavItem = {
  id: PageId
  title: string
  description: string
  icon: LucideIcon
}

/** 侧边栏与页面标题共用的唯一导航表，避免两处各写一份 */
export const NAV_ITEMS: Record<PageId, NavItem> = {
  browse: {
    id: 'browse',
    title: '剧集浏览',
    description: '搜索红果短剧并查看分集信息',
    icon: Compass,
  },
  download: {
    id: 'download',
    title: '红果下载',
    description: '解析链接并批量下载整部短剧',
    icon: Download,
  },
  player: {
    id: 'player',
    title: '播放',
    description: '在线播放，边放边缓存',
    icon: PlayCircle,
  },
  manager: {
    id: 'manager',
    title: '下载管理',
    description: '查看进度、重试与合并导出',
    icon: ListChecks,
  },
  settings: {
    id: 'settings',
    title: '设置',
    description: '保存目录、命名规则与代理',
    icon: Settings,
  },
}

export const NAV_LIST: NavItem[] = Object.values(NAV_ITEMS)
