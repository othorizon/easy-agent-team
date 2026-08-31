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

/**
 * 借助临时 textarea + execCommand 复制。
 * 平台常以 http://内网IP 访问，这类非安全上下文里 navigator.clipboard 不存在，只能走这条老路。
 * 必须在用户手势的同一个同步调用栈里执行，否则浏览器会拒绝。
 */
function copyByExecCommand(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // 放在视口内但不可见，避免 iOS 上因元素不可见而选不中、以及页面滚动跳动
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;';
  document.body.appendChild(ta);

  const selection = document.getSelection();
  const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari 上 select() 不够
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    if (selection && prevRange) {
      selection.removeAllRanges();
      selection.addRange(prevRange);
    }
  }
}

/** 复制文本，返回是否成功；不弹提示，调用方自行反馈 */
export async function writeClipboard(text: string): Promise<boolean> {
  // clipboard API 缺失时直接同步兜底，保住用户手势
  if (!navigator.clipboard?.writeText) return copyByExecCommand(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 权限被拒 / 文档未聚焦等，再试一次老办法
    return copyByExecCommand(text);
  }
}

/** 复制文本并弹出结果提示 */
export async function copyText(text: string): Promise<boolean> {
  const ok = await writeClipboard(text);
  if (ok) toast.success('已复制');
  else toast.error('复制失败，请手动选中复制');
  return ok;
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
        void writeClipboard(text).then((ok) => {
          if (!ok) {
            toast.error('复制失败，请手动选中复制');
            return;
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
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
