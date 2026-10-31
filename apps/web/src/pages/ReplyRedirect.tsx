import { readReplyRedirectUrl } from '@eat/shared';
import { ArrowUpRight, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { BrandLogo } from '../components/brand-logo';
import { Button } from '../components/ui/button';

/** 飞书到 Agent 的公共中转页：无需登录，不向服务端发送目标或消息。 */
export function ReplyRedirectPage() {
  const { hash } = useLocation();
  const target = readReplyRedirectUrl(hash);
  const attempted = useRef<string | null>(null);
  const linkField = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState('正在尝试打开任务…');

  useEffect(() => {
    if (!target || attempted.current === target) return;
    let appFrame: HTMLIFrameElement | undefined;
    // 短暂等待页面呈现；StrictMode 的第一次清理不会留下重复跳转。
    const timer = window.setTimeout(() => {
      if (attempted.current === target) return;
      attempted.current = target;
      setStatus('已尝试打开任务。如果没有跳转，请点击下方按钮。');
      try {
        if (/^https?:/i.test(target)) {
          window.location.assign(target);
        } else {
          // 外部协议没有处理程序或被客户端拦截时，不让错误页覆盖手动打开入口。
          appFrame = document.createElement('iframe');
          appFrame.hidden = true;
          appFrame.title = '打开任务应用';
          appFrame.src = target;
          document.body.appendChild(appFrame);
        }
      } catch {
        setStatus('未能自动打开任务，请点击下方按钮重试。');
      }
    }, 500);
    return () => {
      window.clearTimeout(timer);
      appFrame?.remove();
    };
  }, [target]);

  async function copyLink() {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target);
      setStatus('任务链接已复制。');
    } catch {
      const details = linkField.current?.closest('details');
      if (details) details.open = true;
      linkField.current?.focus();
      linkField.current?.select();
      setStatus('已选中任务链接，请手动复制。');
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 px-4 py-10">
      <section className="w-full max-w-lg space-y-5 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <BrandLogo className="h-9 w-auto" />
        <h1 className="text-xl font-semibold">回到任务处理回复</h1>
        {!target ? (
          <p role="alert" className="text-sm text-muted-foreground">任务链接缺失或无效。请重新打开求助回复通知中的按钮，或使用卡片里的“发送给 Agent”文本。</p>
        ) : (
          <>
            <p role="status" aria-live="polite" className="text-sm">{status}</p>
            <div className="flex flex-wrap gap-3">
              <Button asChild><a href={target} rel="noreferrer" onClick={() => {
                attempted.current = target;
                setStatus('请查看目标应用或浏览器的打开提示。');
              }}><ArrowUpRight />打开任务</a></Button>
              <Button variant="outline" onClick={() => void copyLink()}><Copy />复制任务链接</Button>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">如果飞书内未能打开，请通过右上角菜单在系统浏览器中打开此页面。请在安装了对应应用的电脑上操作，并允许浏览器打开应用。</p>
            <p className="text-sm text-muted-foreground">消息是否预填或发送，由目标应用决定。你也可以复制通知卡片里的“发送给 Agent”文本继续处理。</p>
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">查看任务链接</summary>
              <textarea ref={linkField} aria-label="任务链接" readOnly value={target} rows={4} className="mt-3 w-full rounded-md border bg-muted/40 p-3 text-xs break-all" />
            </details>
          </>
        )}
      </section>
    </main>
  );
}
