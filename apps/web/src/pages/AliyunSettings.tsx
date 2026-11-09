import {
  createAliyunConnectionSchema,
  updateAliyunConnectionSchema,
  type AliyunConnectionInfo,
} from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api';
import { Confirm } from '../components/confirm';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { Field } from '../components/form';
import {
  SettingsGroup,
  SettingsLoadError,
  SettingsLoading,
  SettingsSection,
} from '../components/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Tip } from '../components/ui/tooltip';

export function AliyunSettingsCard({ active }: { active: boolean }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<AliyunConnectionInfo | 'new' | null>(
    null,
  );
  const connections = useQuery({
    queryKey: ['aliyun', 'connections'],
    queryFn: () =>
      api<AliyunConnectionInfo[]>('GET', '/api/aliyun/connections'),
    enabled: active,
  });
  const action = useMutation({
    mutationFn: ({
      connection,
      action,
    }: {
      connection: AliyunConnectionInfo;
      action: 'validate' | 'status' | 'delete';
    }) =>
      api(
        action === 'delete' ? 'DELETE' : 'POST',
        `/api/aliyun/connections/${connection.id}${action === 'delete' ? '' : `/${action}`}`,
        action === 'status'
          ? { status: connection.status === 'enabled' ? 'paused' : 'enabled' }
          : undefined,
      ),
    onSuccess: async (_, { action }) => {
      await client.invalidateQueries({ queryKey: ['aliyun'] });
      toast.success(action === 'validate' ? '管理凭证校验通过' : '接入已更新');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: DataTableColumn<AliyunConnectionInfo>[] = [
    {
      header: '接入',
      cell: ({ row: { original: c } }) => (
        <div>
          <p className="font-medium break-all">{c.name}</p>
          <p className="text-xs text-muted-foreground break-all">
            云账号 ID：{c.accountId}
          </p>
        </div>
      ),
    },
    {
      header: '状态',
      cell: ({ row }) => (
        <Badge variant="secondary">
          {row.original.status === 'enabled' ? '已启用' : '已暂停'}
        </Badge>
      ),
    },
    {
      header: '管理凭证',
      meta: { hideBelow: 'lg' },
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.accessKeyIdMasked} /{' '}
          {row.original.accessKeySecretMasked}
        </span>
      ),
    },
    {
      header: '操作',
      cell: ({ row: { original: c } }) => (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => setEditing(c)}
          >
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => action.mutate({ connection: c, action: 'validate' })}
          >
            校验
          </Button>
          <Tip content="暂停后拒绝新的申请、授予和凭证领取；管理查询与目录刷新仍可使用。">
            <span tabIndex={action.isPending ? 0 : undefined}>
              <Button
                size="sm"
                variant="ghost"
                disabled={action.isPending}
                onClick={() =>
                  action.mutate({ connection: c, action: 'status' })
                }
              >
                {c.status === 'enabled' ? '暂停' : '恢复'}
              </Button>
            </span>
          </Tip>
          <Confirm
            title={`删除接入 ${c.name}？`}
            description="删除前须先撤销此接入的全部授权。"
            onConfirm={() => action.mutate({ connection: c, action: 'delete' })}
          >
            <Button size="sm" variant="ghost" disabled={action.isPending}>
              删除
            </Button>
          </Confirm>
        </div>
      ),
    },
  ];
  return (
    <SettingsSection
      title="阿里云接入"
      description="登记云账号，校验管理凭证并发现 eat-perm- 自定义策略。管理凭证加密保存，仅显示掩码。"
    >
      {connections.isError ? (
        <SettingsLoadError
          error={connections.error}
          retry={() => void connections.refetch()}
        />
      ) : !connections.data ? (
        <SettingsLoading />
      ) : (
        <SettingsGroup
          title="云账号"
          description="OSS 所在的云账号需先在 OSS 设置完成身份迁移。"
        >
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setEditing('new')}>新建接入</Button>
            <Button asChild variant="outline">
              <Link to="/aliyun?tab=manage">目录管理</Link>
            </Button>
          </div>
          <DataTable
            columns={columns}
            data={connections.data}
            getRowId={(c) => c.id}
            empty={
              <p className="py-8 text-sm text-muted-foreground">
                暂无接入，添加云账号后即可发现权限点。
              </p>
            }
          />
          {action.error && (
            <p role="alert" className="text-sm text-destructive">
              {action.error.message}
            </p>
          )}
        </SettingsGroup>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing && (
          <ConnectionEditor
            key={editing === 'new' ? 'new' : editing.id}
            existing={editing === 'new' ? undefined : editing}
            close={() => setEditing(null)}
          />
        )}
      </Dialog>
    </SettingsSection>
  );
}

function ConnectionEditor({
  existing,
  close,
}: {
  existing?: AliyunConnectionInfo;
  close: () => void;
}) {
  const client = useQueryClient();
  const schema = existing
    ? updateAliyunConnectionSchema
    : createAliyunConnectionSchema;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: existing?.name ?? '',
      defaultRegion: existing?.defaultRegion ?? '',
      accessKeyId: '',
      accessKeySecret: '',
    },
  });
  const save = useMutation({
    mutationFn: (body: {
      name: string;
      defaultRegion: string;
      accessKeyId: string;
      accessKeySecret: string;
    }) =>
      api(
        existing ? 'PATCH' : 'POST',
        `/api/aliyun/connections${existing ? `/${existing.id}` : ''}`,
        body,
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['aliyun'] });
      toast.success('接入已保存');
      close();
    },
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{existing ? '编辑接入' : '新建接入'}</DialogTitle>
        <DialogDescription>
          {existing
            ? `云账号 ID：${existing.accountId}。管理凭证留空保留原值，更换时需同时填写两项。`
            : '保存时校验管理凭证并读取云账号 ID，同一个云账号只能接入一次。'}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={handleSubmit((body) => save.mutate(body))}
      >
        <Field
          label="接入名称"
          htmlFor="aliyun-name"
          error={errors.name?.message}
          hint="只允许小写字母、数字和连字符，CLI 使用此名称引用接入。"
        >
          <Input id="aliyun-name" {...register('name')} />
        </Field>
        <Field
          label="管理 AccessKey ID"
          htmlFor="aliyun-ak"
          error={errors.accessKeyId?.message}
        >
          <Input
            id="aliyun-ak"
            autoComplete="off"
            {...register('accessKeyId')}
          />
        </Field>
        <Field
          label="管理 AccessKey Secret"
          htmlFor="aliyun-sk"
          error={errors.accessKeySecret?.message}
        >
          <Input
            id="aliyun-sk"
            type="password"
            autoComplete="new-password"
            {...register('accessKeySecret')}
          />
        </Field>
        <Field
          label="默认地域（可选）"
          htmlFor="aliyun-region"
          error={errors.defaultRegion?.message}
        >
          <Input
            id="aliyun-region"
            placeholder="如 cn-beijing"
            {...register('defaultRegion')}
          />
        </Field>
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={close}>
            取消
          </Button>
          <Button type="submit" loading={save.isPending}>
            校验并保存
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
