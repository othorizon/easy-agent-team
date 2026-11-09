import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ossMigrationPreviewSchema, type OssMigrationIdentityPreview } from '@eat/shared';
import { api } from '../api';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { SettingsGroup } from '../components/settings';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Tip } from '../components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';

const columns: DataTableColumn<OssMigrationIdentityPreview>[] = [
  {
    id: 'user', header: 'EAT 用户', meta: { className: 'w-44 align-top' },
    cell: ({ row: { original: user } }) => (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{user.name}</span>
          {user.userStatus === 'disabled' && <Badge variant="secondary">已停用</Badge>}
        </div>
        <p className="break-all text-xs text-muted-foreground">{user.email}</p>
        <Tip content={user.userId}><span tabIndex={0} className="text-xs text-muted-foreground">用户 ID</span></Tip>
      </div>
    ),
  },
  {
    id: 'names', header: 'RAM 个人身份', meta: { className: 'w-64 align-top' },
    cell: ({ row: { original: user } }) => (
      <div className="space-y-2 text-xs">
        <p className="text-muted-foreground">旧用户名</p>
        <code className="block break-all">{user.oldRamName}</code>
        <p className="text-muted-foreground">目标用户名</p>
        <code className="block break-all">{user.targetRamName}</code>
        <p className="break-all text-muted-foreground">云端 UserId：{user.cloudUserId ?? '未确认'}</p>
        {!user.renameRequired && user.cloudUserId && <Badge variant="secondary">已是目标用户名</Badge>}
      </div>
    ),
  },
  {
    id: 'spaces', header: '有效空间与拟迁移授权', meta: { className: 'min-w-72 align-top' },
    cell: ({ row: { original: user } }) => (
      <div className="space-y-3 text-xs">
        {user.activeSpaces.map(space => (
          <div key={space.id} className="space-y-1">
            <p className="font-medium">{space.name}</p>
            <code className="block break-all text-muted-foreground">{space.prefix}</code>
            <details>
              <summary className="cursor-pointer text-muted-foreground">可用操作（{space.actions.length}）</summary>
              <p className="mt-1 break-words leading-relaxed">{space.actions.join('、')}</p>
            </details>
          </div>
        ))}
        <p className="font-medium">
          {user.aggregation.action === 'detach'
            ? '无有效空间：解绑聚合策略（含旧 Deny），保留策略本身'
            : '按有效空间重新应用 Allow 聚合策略'}
        </p>
        <p className="break-all text-muted-foreground">策略：{user.aggregation.policyName}（当前{user.aggregation.currentAttached ? '已绑定' : '未绑定'}）</p>
        {[
          ['当前策略原文', user.aggregation.currentPolicyDocument],
          ['拟迁移策略原文', user.aggregation.proposedPolicyDocument],
        ].map(([label, document]) => document && (
          <details key={label}>
            <summary className="cursor-pointer text-muted-foreground">{label}</summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3">{document}</pre>
          </details>
        ))}
      </div>
    ),
  },
  {
    id: 'checks', header: 'Key 状态与冲突', meta: { className: 'min-w-60 align-top' },
    cell: ({ row: { original: user } }) => (
      <div className="space-y-3 text-xs">
        <div className="space-y-2">
          {user.keys.length ? user.keys.map(key => (
            <div key={key.id} className="space-y-1">
              <code className="block break-all">{key.id}</code>
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary">{key.status}</Badge>
                <Badge variant="outline">{key.managed ? 'EAT 管理' : '非 EAT 当前管理'}</Badge>
              </div>
            </div>
          )) : <p className="text-muted-foreground">未读取到 Key</p>}
        </div>
        {!!user.securityActions.length && <p>执行时先停用全部 Key 并删除控制台登录配置，再调整聚合策略。</p>}
        {user.warnings.map(warning => <p key={warning} className="break-words text-muted-foreground">{warning}</p>)}
        {user.conflicts.length ? (
          <ul className="space-y-2 text-destructive">
            {user.conflicts.map((conflict, index) => <li key={`${conflict.code}-${index}`} className="break-words">{conflict.message}</li>)}
          </ul>
        ) : <p className="text-muted-foreground">未发现冲突</p>}
      </div>
    ),
  },
];

export function OssMigrationPreview({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = useMutation({
    mutationFn: async () => ossMigrationPreviewSchema.parse(await api('GET', '/api/admin/oss-settings/migration-preview')),
  });
  const report = preview.data;
  return (
    <SettingsGroup title="个人身份迁移" description="预演会逐人核对旧 RAM 身份、有效空间、拟迁移授权与真实 Key 状态。预演结果仅保存在当前窗口。">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">只读预演</Badge>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => { preview.reset(); setOpen(true); preview.mutate(); }}>
          迁移预演
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>OSS 身份迁移预演</DialogTitle>
            <DialogDescription>读取当前云端状态；不会改名、创建个人身份、修改 Key 或写入迁移结果。执行前需要重新核对。</DialogDescription>
          </DialogHeader>
          {preview.isPending && <p role="status" className="text-sm text-muted-foreground">正在读取 RAM 个人身份、Key 和策略…</p>}
          {preview.error && <p role="alert" className="break-words text-sm text-destructive">{preview.error.message}</p>}
          {report && (
            <>
              <div className="space-y-1 text-sm">
                <p className="break-all">云账号：{report.accountId ?? '尚未验证'} · Bucket：{report.bucket}</p>
                <p className="break-all text-xs text-muted-foreground">OSS 实例：{report.instanceId} · 预演时间：{new Date(report.generatedAt).toLocaleString()}</p>
                <p>{report.identities.length} 个个人身份 · {report.canMigrate ? '未发现冲突' : '存在冲突，需管理员处理后重新预演'}</p>
              </div>
              {!!report.conflicts.length && <ul role="alert" className="space-y-2 text-sm text-destructive">{report.conflicts.map((conflict, index) => <li key={`${conflict.code}-${index}`}>{conflict.message}</li>)}</ul>}
              <p className="text-xs text-muted-foreground sm:hidden">左右滑动表格查看完整报告。</p>
              <DataTable columns={columns} data={report.identities} getRowId={row => row.userId} className="min-w-[1000px]" empty={<p className="py-6 text-sm text-muted-foreground">尚无 OSS 个人身份。</p>} />
            </>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" loading={preview.isPending} onClick={() => preview.mutate()}>重新预演</Button>
            <Tip content="执行迁移功能尚未启用；当前仅提供只读预演。">
              <span tabIndex={0}><Button type="button" disabled>执行迁移</Button></span>
            </Tip>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
