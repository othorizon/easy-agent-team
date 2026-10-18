import * as React from 'react';
import { cn } from '../lib/utils';
import { Label } from './ui/label';

/**
 * 表单字段容器：label + 控件 + 提示/错误。
 * 配合 react-hook-form 使用：error 传 formState.errors.xxx?.message。
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

/** 常用校验规则 */
export const rules = {
  slug: { value: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母、数字、连字符' },
  envKey: { value: /^[A-Za-z_][A-Za-z0-9_]*$/, message: '字母、数字、下划线，不能以数字开头' },
  email: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: '请输入有效邮箱' },
  url: { value: /^https?:\/\/.+/, message: '请输入有效的 URL' },
  dbName: { value: /^[a-z][a-z0-9_]{2,30}$/, message: '小写字母开头，字母/数字/下划线，3-31 位' },
};
