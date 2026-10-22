import type { CreateDbInstanceRequest, DbAssignmentInfo, DbInstanceInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createDbAssignmentSchema, createDbInstanceSchema } from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { PAGE_SIZE_OPTIONS, Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tip } from '../components/ui/tooltip';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useQueryParams } from '../lib/use-query-params';
import { z } from '../lib/zod';
import { AssignmentActions, DB_STATUS_BADGE, useAssignmentAction } from './db-shared';

export function DbsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const [addingInstance, setAddingInstance] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [params, setParams] = useQueryParams({ tab: 'mine', q: '', page: '1', pageSize: '20' });
  const tab = params.tab === 'instances' ? 'instances' : isAdmin && params.tab === 'all' ? 'all' : 'mine';
  const requestedPage = Number(params.page);
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize)) ? Number(params.pageSize) : 20;

  const instances = useQuery({ queryKey: ['db-instances'], queryFn: () => api<DbInstanceInfo[]>('GET', '/api/db/instances') });
  const mine = useQuery({ queryKey: ['db-mine'], queryFn: () => api<DbAssignmentInfo[]>('GET', '/api/db/assignments/mine') });
  const all = useQuery({
    queryKey: ['db-all'],
    queryFn: () => api<DbAssignmentInfo[]>('GET', '/api/db/assignments'),
    enabled: isAdmin,
  });

  // 管理员 tab 角标：待批准的申请数
  const pendingCount = (all.data ?? []).filter((r) => r.status === 'pending').length;

  const keyword = params.q.trim().toLowerCase();
  const assignments = ((tab === 'all' ? all.data : mine.data) ?? []).filter(
    (r) => r.dbName.toLowerCase().includes(keyword) || r.instanceName.toLowerCase().includes(keyword),
  );
  const filteredInstances = (instances.data ?? []).filter((r) => r.name.toLowerCase().includes(keyword));
  const activeQuery = tab === 'instances' ? instances : tab === 'all' ? all : mine;
  const total = tab === 'instances' ? filteredInstances.length : assignments.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const offset = (page - 1) * pageSize;
  const assignmentRows = assignments.slice(offset, offset + pageSize);
  const instanceRows = filteredInstances.slice(offset, offset + pageSize);

  // 删除或刷新后回到有效页码；等待当前页签的数据加载完成再同步 URL。
  useEffect(() => {
    if (activeQuery.data && !activeQuery.isFetching && params.page !== String(page)) {
      setParams({ page: String(page) });
    }
  }, [activeQuery.data, activeQuery.isFetching, params.page, page, setParams]);

  const clearSearch = keyword ? <Button variant="outline" onClick={() => setParams({ q: '', page: '1' })}>清除搜索</Button> : undefined;
  const loadError = (
    <Empty text="列表加载失败" action={<Button variant="outline" onClick={() => void activeQuery.refetch()}>重试</Button>} />
  );
  const pagination = !activeQuery.isLoading && !activeQuery.isError ? (
    <Pagination
      total={total}
      page={page}
      pageSize={pageSize}
      onPageChange={(value) => setParams({ page: String(value) })}
      onPageSizeChange={(value) => setParams({ pageSize: String(value), page: '1' })}
    />
  ) : null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['db-instances'] });
    void queryClient.invalidateQueries({ queryKey: ['db-mine'] });
    void queryClient.invalidateQueries({ queryKey: ['db-all'] });
  };

  const addInstance = useMutation({
    mutationFn: (v: CreateDbInstanceRequest) => api('POST', '/api/db/instances', v),
    onSuccess: () => {
      toast.success('实例已登记');
      setAddingInstance(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '登记失败'),
  });

  const request = useMutation({
    mutationFn: (v: { instanceId: string; dbName: string; purpose: string }) => api('POST', '/api/db/assignments', v),
    onSuccess: () => {
      toast.success('申请已提交，等待管理员批准');
      setRequesting(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '申请失败'),
  });

  const act = useAssignmentAction();

  const removeInstance = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/db/instances/${id}`),
    onSuccess: () => {
      toast.success('实例已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const assignmentColumns = (admin: boolean): DataTableColumn<DbAssignmentInfo>[] => [
    {
      id: 'dbName',
      header: '库',
      // 库名即详情入口（决策 39）；操作列里再给一个显式的「详情」，不靠猜
      cell: ({ row: { original: r } }) => (
        <Link to={`/db/${r.id}`}>
          <InlineCode className="text-primary hover:underline">{r.dbName}</InlineCode>
        </Link>
      ),
    },
    {
      accessorKey: 'instanceName',
      header: '实例',
      meta: { className: 'w-32', cellClassName: 'text-muted-foreground whitespace-nowrap' },
    },
    ...(admin
      ? [
          {
            accessorKey: 'requesterName',
            header: '申请人',
            meta: { className: 'w-24', cellClassName: 'text-muted-foreground whitespace-nowrap' },
          } satisfies DataTableColumn<DbAssignmentInfo>,
        ]
      : []),
    {
      id: 'purpose',
      header: '用途',
      meta: { cellClassName: 'text-muted-foreground' },
      cell: ({ row: { original: r } }) => (
        <Tip content={r.purpose}>
          <span className="block max-w-48 truncate">{r.purpose}</span>
        </Tip>
      ),
    },
    {
      id: 'status',
      header: '状态',
      meta: { className: 'w-22' },
      cell: ({ row: { original: r } }) => DB_STATUS_BADGE[r.status],
    },
    {
      id: 'credential',
      header: '凭证',
      meta: { className: 'w-40' },
      cell: ({ row: { original: r } }) =>
        r.environmentSlug ? (
          <Link to={`/envs/${r.environmentSlug}`}>
            <InlineCode className="text-primary hover:underline">{r.environmentSlug}</InlineCode>
          </Link>
        ) : r.error ? (
          <Tip content={r.error}>
            <span className="block max-w-40 truncate text-destructive">{r.error}</span>
          </Tip>
        ) : (
          '—'
        ),
    },
    {
      id: 'actions',
      header: '操作',
      meta: { className: admin ? 'w-64' : 'w-20' },
      cell: ({ row: { original: r } }) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
            <Link to={`/db/${r.id}`}>
              详情
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
          {admin && (
            <AssignmentActions
              row={r}
              pending={act.isPending && act.variables?.id === r.id}
              onAct={(action) => act.mutate({ id: r.id, action })}
            />
          )}
        </div>
      ),
    },
  ];

  const assignmentTable = (rows: DbAssignmentInfo[], admin: boolean, loading: boolean, emptyText: React.ReactNode) => (
    <DataTable
      columns={assignmentColumns(admin)}
      data={rows}
      loading={loading}
      skeletonRows={2}
      getRowId={(r) => r.id}
      className={admin ? 'min-w-[760px]' : 'min-w-[600px]'}
      empty={<Empty text={keyword ? '没有符合条件的数据库' : emptyText} action={clearSearch} className="py-6" />}
    />
  );

  const instanceColumns: DataTableColumn<DbInstanceInfo>[] = [
    {
      accessorKey: 'name',
      header: '名称',
      meta: { cellClassName: 'font-medium whitespace-nowrap' },
      cell: ({ row: { original: r } }) => (
        <>
          {r.name}
          <div className="mt-0.5 text-xs text-muted-foreground md:hidden">
            {r.host}:{r.port}
          </div>
        </>
      ),
    },
    {
      id: 'engine',
      header: '类型',
      meta: { className: 'w-24' },
      cell: ({ row: { original: r } }) => <Badge variant="secondary">{r.engine}</Badge>,
    },
    {
      id: 'address',
      header: '地址',
      meta: { hideBelow: 'md' },
      cell: ({ row: { original: r } }) => (
        <InlineCode>
          {r.host}:{r.port}
        </InlineCode>
      ),
    },
    {
      accessorKey: 'assignmentCount',
      header: '已分配',
      meta: { className: 'w-18 text-right', cellClassName: 'tabular-nums' },
    },
    {
      accessorKey: 'note',
      header: '备注',
      meta: { hideBelow: 'lg', cellClassName: 'max-w-xs truncate text-muted-foreground' },
    },
    ...(isAdmin
      ? [
          {
            id: 'actions',
            header: '操作',
            meta: { className: 'w-20' },
            cell: ({ row: { original: r } }) => (
              <Confirm
                title="删除实例登记？"
                description="不影响实例本身，仅移除平台上的登记。"
                confirmText="删除"
                onConfirm={() => removeInstance.mutate(r.id)}
              >
                <Button size="sm" variant="outline-destructive">
                  删除
                </Button>
              </Confirm>
            ),
          } satisfies DataTableColumn<DbInstanceInfo>,
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="数据库"
        description="团队共享的数据库实例（面向日常项目，非生产核心）。成员申请后由管理员批准，平台自动建库建号，凭证以环境变量形式下发。"
        actions={
          <>
            {isAdmin && (
              <Button variant="outline" onClick={() => setAddingInstance(true)}>
                <Plus />
                登记实例
              </Button>
            )}
            <Button onClick={() => setRequesting(true)}>
              <Plus />
              申请数据库
            </Button>
          </>
        }
      />

      <div className="relative sm:w-[300px]">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          className="pl-9"
          placeholder={tab === 'instances' ? '搜索实例名称' : '搜索库名 / 实例名称'}
          aria-label={tab === 'instances' ? '搜索实例名称' : '搜索库名或实例名称'}
          value={params.q}
          onChange={(e) => setParams({ q: e.target.value, page: '1' })}
        />
      </div>

      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value, page: '1' })}>
        <TabsList>
          <TabsTrigger value="mine">我的数据库</TabsTrigger>
          <TabsTrigger value="instances">数据库实例</TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="all">
              全部分配
              {pendingCount > 0 && <Badge className="px-1.5">{pendingCount}</Badge>}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="mine" className="mt-4">
          <Card>
            <CardContent className="space-y-4">
              {mine.isError
                ? loadError
                : assignmentTable(
                    assignmentRows,
                    false,
                    mine.isLoading,
                    '暂无。点击「申请数据库」，批准后凭证会出现在你的环境列表里。',
                  )}
              {pagination}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="instances" className="mt-4">
          <Card>
            <CardContent className="space-y-4">
              {instances.isError ? (
                loadError
              ) : (
                <DataTable
                  columns={instanceColumns}
                  data={instanceRows}
                  loading={instances.isLoading}
                  skeletonRows={2}
                  getRowId={(r) => r.id}
                  empty={<Empty text={keyword ? '没有符合条件的实例' : '暂无实例（由管理员登记）'} action={clearSearch} className="py-6" />}
                />
              )}
              {pagination}
            </CardContent>
          </Card>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="all" className="mt-4">
            <Card>
              <CardContent className="space-y-4">
                {all.isError ? loadError : assignmentTable(assignmentRows, true, all.isLoading, '暂无分配')}
                {pagination}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {addingInstance && (
        <AddInstanceDialog
          pending={addInstance.isPending}
          onClose={() => setAddingInstance(false)}
          onSubmit={(v) => addInstance.mutate(v)}
        />
      )}
      {requesting && (
        <RequestDbDialog
          instances={instances.data ?? []}
          pending={request.isPending}
          onClose={() => setRequesting(false)}
          onSubmit={(v) => request.mutate(v)}
        />
      )}
    </div>
  );
}

function AddInstanceDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: CreateDbInstanceRequest) => void;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm({
    resolver: zodResolver(createDbInstanceSchema),
    defaultValues: { name: '', engine: 'postgres', host: '', port: 5432, adminUser: '', adminPassword: '', note: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>登记数据库实例</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit(onSubmit)}
        >
          <Field label="名称" htmlFor="ins-name" required error={errors.name?.message}>
            <Input id="ins-name" placeholder="团队测试 PG" aria-invalid={!!errors.name} {...register('name')} />
          </Field>
          <Field label="类型">
            <Controller
              control={control}
              name="engine"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: 'PostgreSQL', value: 'postgres' },
                    { label: 'MySQL（暂不支持自动建库）', value: 'mysql' },
                  ]}
                />
              )}
            />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="主机" htmlFor="ins-host" required error={errors.host?.message} className="col-span-2">
              <Input id="ins-host" placeholder="db.internal.example.com" aria-invalid={!!errors.host} {...register('host')} />
            </Field>
            <Field label="端口" htmlFor="ins-port" required error={errors.port?.message}>
              <Input
                id="ins-port"
                type="number"
                min={1}
                max={65535}
                aria-invalid={!!errors.port}
                {...register('port', { valueAsNumber: true })}
              />
            </Field>
          </div>
          <Field label="管理账号" htmlFor="ins-user" required error={errors.adminUser?.message}>
            <Input id="ins-user" placeholder="postgres" aria-invalid={!!errors.adminUser} {...register('adminUser')} />
          </Field>
          <Field label="管理密码" htmlFor="ins-pass" hint="加密存储">
            <Input id="ins-pass" type="password" autoComplete="new-password" {...register('adminPassword')} />
          </Field>
          <Field label="备注" htmlFor="ins-note">
            <Input id="ins-note" placeholder="用途说明" {...register('note')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            登记
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 契约里 instanceId 只要求是字符串（服务端再查存在性），表单上空值要拦成「请选择实例」 */
const requestDbFormSchema = createDbAssignmentSchema.extend({ instanceId: z.string().min(1, '请选择实例') });

function RequestDbDialog({
  instances,
  pending,
  onClose,
  onSubmit,
}: {
  instances: DbInstanceInfo[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: { instanceId: string; dbName: string; purpose: string }) => void;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm({
    resolver: zodResolver(requestDbFormSchema),
    defaultValues: { instanceId: '', dbName: '', purpose: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>申请数据库</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="实例" required error={errors.instanceId?.message}>
            <Controller
              control={control}
              name="instanceId"
              render={({ field }) => (
                <Select value={field.value || undefined} onValueChange={field.onChange}>
                  <SelectTrigger aria-invalid={!!errors.instanceId}>
                    <SelectValue placeholder="选择实例…" />
                  </SelectTrigger>
                  <SelectContent>
                    {instances.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name}（{i.engine} {i.host}:{i.port}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field
            label="库名"
            htmlFor="req-dbname"
            required
            error={errors.dbName?.message}
            hint="也用于生成账号名与凭证环境名"
          >
            <Input
              id="req-dbname"
              placeholder="proj_crm"
              className="font-mono"
              aria-invalid={!!errors.dbName}
              {...register('dbName')}
            />
          </Field>
          <Field label="用途" htmlFor="req-purpose" required error={errors.purpose?.message} hint="给管理员看">
            <Textarea
              id="req-purpose"
              rows={2}
              placeholder="CRM 小工具的数据存储"
              aria-invalid={!!errors.purpose}
              {...register('purpose')}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            提交申请
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
