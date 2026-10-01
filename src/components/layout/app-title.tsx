import { Film } from 'lucide-react'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

/** 侧边栏顶部品牌区：应用名 + 版本号由主进程注入 */
export function AppTitle({ brand, version }: { brand: string; version: string }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          className="gap-3 py-0 hover:bg-transparent active:bg-transparent"
        >
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Film className="size-5" />
          </div>
          <div className="grid flex-1 text-start text-sm leading-tight">
            <span className="truncate font-bold">{brand}</span>
            <span className="truncate text-xs text-muted-foreground">v{version}</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
