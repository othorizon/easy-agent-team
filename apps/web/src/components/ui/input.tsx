import * as React from 'react';
import { cn } from '../../lib/utils';

/* React 18 下 ref 必须走 forwardRef（react-hook-form 依赖 ref 读取输入值） */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          'flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs transition-colors outline-none',
          'placeholder:text-muted-foreground/70 selection:bg-primary/15',
          'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-muted',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        className={cn(
          'flex w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs transition-colors outline-none',
          'placeholder:text-muted-foreground/70',
          'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-muted',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Input, Textarea };
