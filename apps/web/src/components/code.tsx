import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { cn } from '../lib/utils';

/** 行内代码 */
export function InlineCode({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={cn(
        'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground/90 break-all',
        className,
      )}
      {...props}
    />
  );
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制');
  } catch {
    toast.error('复制失败，请手动选中复制');
  }
}

/** 复制按钮（成功后短暂显示对勾） */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label="复制"
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer',
        className,
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error('复制失败，请手动选中复制'),
        );
      }}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** 带复制按钮的单行命令 */
export function Cmd({ text }: { text: string }) {
  return (
    <div className="flex w-fit max-w-full items-center gap-1 rounded-md border bg-muted/60 py-1 pr-1 pl-2.5">
      <code className="overflow-x-auto whitespace-nowrap font-mono text-[13px]">{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

/** 多行代码块 */
export function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/50 p-4 font-mono text-[13px] leading-relaxed',
        className,
      )}
    >
      {children}
    </pre>
  );
}
