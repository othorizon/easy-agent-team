import * as React from 'react';
import { cn } from '../lib/utils';
import { Label } from './ui/label';
import type { FieldErrors } from 'react-hook-form';

/**
 * 表单字段容器：label + 控件 + 提示/错误。
 * 配合 react-hook-form 使用：error 传 formState.errors.xxx?.message。
 * 校验规则不写在 register 上，统一用 zodResolver 挂 `@eat/shared` 里的契约（中文报错兜底见 lib/zod.ts）。
 */
export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  className,
  children,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const descriptionId = htmlFor && (error || hint !== undefined) ? `${htmlFor}-description` : undefined;
  const controls = React.Children.map(children, (child) => {
    if (
      !React.isValidElement<{
        id?: string;
        'aria-describedby'?: string;
        'aria-invalid'?: boolean;
      }>(child) ||
      child.props.id !== htmlFor ||
      !htmlFor
    )
      return child;
    return React.cloneElement(child, {
      'aria-describedby':
        [child.props['aria-describedby'], descriptionId].filter(Boolean).join(' ') || undefined,
      'aria-invalid': error ? true : child.props['aria-invalid'],
    });
  });
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label !== undefined && (
        <Label htmlFor={htmlFor} className="text-foreground/90">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
      )}
      {controls}
      {error ? (
        <p id={descriptionId} role="alert" className="text-xs leading-snug text-destructive">
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/**
 * 表单里第一条报错（按字段声明顺序深度优先）。字段多、不是每个都挂了报错位置的表单，
 * 提交失败时把它放到表单底部做汇总，免得「点了保存没反应」。
 */
export function firstErrorMessage(errors: FieldErrors): string | undefined {
  for (const [key, value] of Object.entries(errors)) {
    // ref 是 DOM 节点，往里递归会顺着 React 内部字段绕圈
    if (key === 'ref' || !value || typeof value !== 'object') continue;
    if (typeof value.message === 'string' && value.message) return value.message;
    const nested = firstErrorMessage(value as FieldErrors);
    if (nested) return nested;
  }
  return undefined;
}
