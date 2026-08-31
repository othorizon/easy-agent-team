import type { DokployApplication } from '@eat/shared';
import { useQuery } from '@tanstack/react-query';
import { Check, Search } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { Button } from './ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/**
 * 「从 Dokploy 选择」应用（决策 27）：application id 仍可手写，这里提供可搜索的快速填写。
 * 清单按 Dokploy 项目分组；搜索同时匹配应用名、容器名（appName）与 id——
 * 同名应用在不同项目下很常见，只按显示名搜会选错。
 *
 * 只在弹开时才请求 Dokploy（enabled: open），避免每次打开项目弹窗都打一次外部服务。
 */
export function DokployAppPicker({ value, onPick }: { value: string; onPick: (app: DokployApplication) => void }) {
  const [open, setOpen] = useState(false);
  const apps = useQuery({
    queryKey: ['dokploy-applications'],
    queryFn: () => api<DokployApplication[]>('GET', '/api/dokploy/applications'),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const groups = new Map<string, DokployApplication[]>();
  for (const app of apps.data ?? []) {
    const key = app.projectName || '未分组';
    groups.set(key, [...(groups.get(key) ?? []), app]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full shrink-0 gap-1.5 sm:w-auto">
          <Search className="size-4" />
          从 Dokploy 选择
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(28rem,calc(100vw-2rem))] p-0">
        <Command
          // 关掉 cmdk 的内置过滤，改用我们自己拼的检索串（见 CommandItem 的 value）
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0
          }
        >
          <CommandInput placeholder="搜索应用名 / 容器名 / ID…" />
          <CommandList>
            {apps.isLoading && <div className="px-3 py-6 text-center text-sm text-muted-foreground">正在读取 Dokploy…</div>}
            {apps.isError && (
              <div className="px-3 py-6 text-center text-sm text-destructive">
                {apps.error instanceof ApiError ? apps.error.message : '读取 Dokploy 应用清单失败'}
                <div className="mt-1 text-xs text-muted-foreground">仍可在上方手动填写 Application ID</div>
              </div>
            )}
            {apps.isSuccess && <CommandEmpty>没有匹配的应用</CommandEmpty>}
            {[...groups.entries()].map(([projectName, list]) => (
              <CommandGroup key={projectName} heading={projectName}>
                {list.map((app) => (
                  <CommandItem
                    key={app.applicationId}
                    value={`${app.name} ${app.appName} ${app.applicationId}`}
                    onSelect={() => {
                      onPick(app);
                      setOpen(false);
                    }}
                    className="flex-col items-start gap-0.5"
                  >
                    <div className="flex w-full items-center gap-2">
                      <span className="truncate font-medium">{app.name}</span>
                      {app.appName && (
                        <span className="truncate font-mono text-xs text-muted-foreground">{app.appName}</span>
                      )}
                      {app.applicationId === value && <Check className="ml-auto size-4 shrink-0 text-primary" />}
                    </div>
                    <span className="truncate font-mono text-xs text-muted-foreground/80">{app.applicationId}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
