import type { ConnectionTestResult } from '@eat/shared';
import { Check, CheckCircle2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

export function SettingsSection({
  title,
  description,
  status,
  children,
}: {
  title: string;
  description: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" aria-label={title}>
      <header className="settings-section-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {status && <div className="shrink-0">{status}</div>}
      </header>
      {children}
    </section>
  );
}

export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-label={title}>
      <div className="settings-group-heading">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-fields">{children}</div>
    </section>
  );
}

export function SettingsActions({
  pending,
  dirty,
  saved,
  error,
  disabled,
  children,
  label = '保存更改',
}: {
  pending: boolean;
  dirty: boolean;
  saved?: boolean;
  error?: string;
  disabled?: boolean;
  children?: ReactNode;
  label?: string;
}) {
  return (
    <div className="settings-actions">
      <div className="settings-action-buttons">
        <Button type="submit" loading={pending} disabled={disabled || !dirty}>
          {pending ? '保存中…' : label}
        </Button>
        {children}
      </div>
      <div aria-live="polite" className="settings-save-state">
        {error ? (
          <p role="alert" className="text-destructive">
            保存失败：{error}
          </p>
        ) : pending ? (
          <p>正在保存更改…</p>
        ) : dirty ? (
          <p>有未保存的更改</p>
        ) : saved ? (
          <p className="flex items-center gap-1.5 text-success">
            <Check className="size-4" />
            更改已保存
          </p>
        ) : (
          <p>修改后保存生效</p>
        )}
      </div>
    </div>
  );
}

export function SettingsTestResult({ result }: { result: ConnectionTestResult | null }) {
  if (!result) return null;
  return (
    <div
      role={result.ok ? 'status' : 'alert'}
      className={cn('settings-notice', result.ok ? 'text-success' : 'text-destructive')}
    >
      {result.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
      <p>
        {result.message}
        {result.ok && `（${result.latencyMs}ms）`}
      </p>
    </div>
  );
}

export function SettingsLoading() {
  return (
    <div className="space-y-5 py-8" role="status" aria-label="正在读取设置">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-10 max-w-xl" />
        </div>
      ))}
      <span className="sr-only">正在读取设置…</span>
    </div>
  );
}

export function SettingsLoadError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="settings-load-error">
      <p className="font-medium">未能读取设置</p>
      <p className="mt-1 break-words text-sm text-muted-foreground">{error.message}</p>
      <Button type="button" variant="outline" onClick={retry} className="mt-3">
        重新读取
      </Button>
    </div>
  );
}
