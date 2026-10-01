import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { AppTitle } from './app-title'
import { NAV_LIST, type PageId } from './sidebar-nav'

type AppSidebarProps = {
  activePage: PageId
  brand: string
  onNavigate: (page: PageId) => void
  version: string
}

export function AppSidebar({
  activePage,
  brand,
  onNavigate,
  version,
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <AppTitle brand={brand} version={version} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>功能</SidebarGroupLabel>
          <SidebarMenu>
            {NAV_LIST.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  tooltip={item.title}
                  isActive={activePage === item.id}
                  onClick={() => onNavigate(item.id)}
                >
                  <item.icon />
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <p className="truncate text-xs text-muted-foreground">
          AES-128 CENC 原生解密 · 无水印
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
