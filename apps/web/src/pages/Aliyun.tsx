import type {
  AliyunAvailability,
  AliyunConnectionInfo,
  AliyunPermissionInfo,
} from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, getStoredUser } from '../api';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui/tabs';
import { Tip } from '../components/ui/tooltip';

export function AliyunPage() {
  const admin = getStoredUser()?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tab = admin && params.get('tab') === 'manage' ? 'manage' : 'catalog';
  const available = useQuery({
    queryKey: ['aliyun', 'status'],
    queryFn: () => api<AliyunAvailability>('GET', '/api/aliyun/status'),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="阿里云权限"
        description="按云账号管理 RAM 自定义策略对应的权限点。"
        actions={
          admin && (
            <Button asChild variant="outline">
              <Link to="/settings?section=aliyun">管理接入</Link>
            </Button>
          )
        }
      />
      {available.isError ? (
        <p role="alert">
          加载失败：{available.error.message}
          <Button variant="ghost" onClick={() => void available.refetch()}>
            重试
          </Button>
        </p>
      ) : !available.data ? (
        <p className="text-muted-foreground">正在加载…</p>
      ) : !available.data.available ? (
        <p className="py-8 text-muted-foreground">
          尚未接入云账号，请联系管理员。
        </p>
      ) : (
        <Tabs value={tab} onValueChange={(value) => setParams({ tab: value })}>
          <TabsList>
            <TabsTrigger value="catalog">目录</TabsTrigger>
            {admin && <TabsTrigger value="manage">管理</TabsTrigger>}
          </TabsList>
          <TabsContent value="catalog" className="pt-5">
            <p className="py-8 text-sm text-muted-foreground">
              暂无开放申请的权限点。
            </p>
          </TabsContent>
          <TabsContent value="manage" className="pt-5">
            {admin && tab === 'manage' && <AliyunDirectoryManagement />}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function AliyunDirectoryManagement() {
  const client = useQueryClient();
  const started = useRef(false);
  const connections = useQuery({
    queryKey: ['aliyun', 'connections'],
    queryFn: () =>
      api<AliyunConnectionInfo[]>('GET', '/api/aliyun/connections'),
  });
  const permissions = useQuery({
    queryKey: ['aliyun', 'permissions', 'manage'],
    queryFn: () =>
      api<AliyunPermissionInfo[]>('GET', '/api/aliyun/permissions/manage'),
  });
  const refresh = useMutation({
    mutationFn: async (rows: AliyunConnectionInfo[]) => {
      const results = await Promise.allSettled(
        rows.map((c) => api('POST', `/api/aliyun/connections/${c.id}/refresh`)),
      );
      const failed = results.flatMap((r, i) =>
        r.status === 'rejected'
          ? [
              `${rows[i].name}：${r.reason instanceof Error ? r.reason.message : '刷新失败'}`,
            ]
          : [],
      );
      if (failed.length) throw new Error(failed.join('；'));
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: ['aliyun', 'permissions'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  useEffect(() => {
    if (connections.data && !started.current) {
      started.current = true;
      refresh.mutate(connections.data);
    }
  }, [connections.data, refresh.mutate]);
  const columns: DataTableColumn<AliyunPermissionInfo>[] = [
    {
      header: '策略名称',
      cell: ({ row }) => (
        <Tip content={row.original.policyName}>
          <span className="block max-w-64 truncate font-mono text-xs">
            {row.original.policyName}
          </span>
        </Tip>
      ),
    },
    {
      header: 'RAM 说明',
      cell: ({ row }) => (
        <p className="max-w-md break-words text-sm">
          {row.original.description || '—'}
        </p>
      ),
    },
    {
      header: '云端状态',
      cell: ({ row }) => (
        <Badge variant="secondary">
          {row.original.cloudExists ? '存在' : '云端已删除'}
        </Badge>
      ),
    },
  ];
  if (connections.isError || permissions.isError)
    return (
      <p role="alert">
        目录加载失败：{connections.error?.message ?? permissions.error?.message}
        <Button
          variant="ghost"
          onClick={() => {
            void connections.refetch();
            void permissions.refetch();
          }}
        >
          重试
        </Button>
      </p>
    );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          打开管理时自动刷新一次；可随时手动同步策略与说明。
        </p>
        <Button
          variant="outline"
          loading={refresh.isPending}
          disabled={!connections.data}
          onClick={() => refresh.mutate(connections.data ?? [])}
        >
          刷新目录
        </Button>
      </div>
      {refresh.error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {refresh.error.message}
        </p>
      )}
      {!connections.data ? (
        <p className="text-muted-foreground">正在加载…</p>
      ) : (
        connections.data.map((c) => (
          <section
            key={c.id}
            className="space-y-3 rounded-xl border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium break-all">{c.name}</h2>
              <Badge variant="secondary">
                {c.status === 'paused' ? '已暂停' : '已启用'}
              </Badge>
              <span className="text-xs text-muted-foreground break-all">
                云账号 ID：{c.accountId}
              </span>
            </div>
            <DataTable
              columns={columns}
              data={permissions.data?.filter((p) => p.connectionId === c.id)}
              loading={permissions.isPending}
              getRowId={(p) => p.id}
              empty={
                <p className="py-5 text-sm text-muted-foreground">
                  未发现 eat-perm- 自定义策略。
                </p>
              }
            />
          </section>
        ))
      )}
    </div>
  );
}
