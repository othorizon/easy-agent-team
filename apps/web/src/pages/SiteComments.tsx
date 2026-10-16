import type { SiteAnchor, SiteComment, SiteThread, UserPublic } from '@eat/shared';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Check,
  ExternalLink,
  MapPin,
  MessageSquare,
  MousePointer2,
  RefreshCw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { api, ApiError, getStoredUser, getToken } from '../api';
import { Button } from '../components/ui/button';
import { Input, Textarea } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';

type MentionUser = { id: string; name: string; email: string };

function Composer({
  users,
  submit,
  label,
  onCancel,
  autoFocus = false,
}: {
  users: MentionUser[];
  submit: (content: string, mentions: string[]) => Promise<void>;
  label: string;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [content, setContent] = useState('');
  const [mentions, setMentions] = useState<MentionUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = /(?:^|\s)@([^\s@]*)$/.exec(content)?.[1];
  const matches =
    query === undefined
      ? []
      : users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !content.trim()) return;
        setBusy(true);
        setError('');
        try {
          await submit(
            content,
            mentions.map((u) => u.id),
          );
          setContent('');
          setMentions([]);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="relative">
        <Textarea
          aria-label={onCancel ? '回复内容' : '评论内容'}
          autoFocus={autoFocus}
          required
          maxLength={10000}
          disabled={busy}
          className="min-h-24 max-h-40 resize-y rounded-xl bg-background"
          value={content}
          placeholder={onCancel ? '写下回复，输入 @ 提及同事…' : '分享想法或提出建议，输入 @ 提及同事…'}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          onChange={(e) => {
            setContent(e.target.value);
            setMentions(mentions.filter((u) => e.target.value.includes('@' + u.name)));
          }}
        />
        {query !== undefined && (
          <div
            className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-40 overflow-auto rounded-lg border bg-popover shadow-md"
            aria-label="提及同事"
          >
            {matches.length ? (
              matches.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    setContent(content.replace(/@[^\s@]*$/, '@' + u.name + ' '));
                    setMentions([...mentions.filter((m) => m.id !== u.id), u]);
                  }}
                >
                  {u.name} <span className="text-xs text-muted-foreground">{u.email}</span>
                </button>
              ))
            ) : (
              <p className="p-3 text-xs text-muted-foreground">没有匹配的同事</p>
            )}
          </div>
        )}
      </div>
      {!!mentions.length && (
        <div className="flex flex-wrap gap-1">
          {mentions.map((u) => (
            <Badge key={u.id} variant="secondary">
              @{u.name}
            </Badge>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Ctrl / ⌘ + Enter 发送</span>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              取消
            </Button>
          )}
          <Button type="submit" loading={busy} disabled={!content.trim()}>
            <Send />
            {label}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function SiteDiscussion({
  slug,
  versionId,
  initialPage = '',
  initialProof = '',
  embedded = false,
  filterVersionId,
  siteUrl,
  onAccessVerified,
}: {
  slug: string;
  versionId: string;
  initialPage?: string;
  initialProof?: string;
  embedded?: boolean;
  filterVersionId?: string;
  siteUrl?: string;
  onAccessVerified?: (proof: string) => void;
}) {
  const [page, setPage] = useState(initialPage);
  const [embedReady, setEmbedReady] = useState(!embedded || window.parent === window);
  const [proof, setProof] = useState(initialProof);
  const [composePage, setComposePage] = useState(initialPage || '/');
  const [status, setStatus] = useState('');
  const [threads, setThreads] = useState<SiteThread[]>([]);
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [user, setUser] = useState<UserPublic | null>(() => {
    try {
      return getToken() ? getStoredUser() : null;
    } catch {
      return null;
    }
  });
  const [session, setSession] = useState('');
  const [error, setError] = useState('');
  const [needsAccess, setNeedsAccess] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [anchor, setAnchor] = useState<SiteAnchor>({ type: 'page' });
  const [replyTo, setReplyTo] = useState('');
  const [updating, setUpdating] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SiteComment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [password, setPassword] = useState('');
  const [locateMessage, setLocateMessage] = useState('');
  const [missingLocation, setMissingLocation] = useState<SiteThread | null>(null);
  const popup = useRef<Window | null>(null);
  const proofRef = useRef(proof);
  proofRef.current = proof;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const contextKey = JSON.stringify([
    slug,
    versionId,
    page,
    proof,
    session,
    filterVersionId,
    user?.id,
    embedReady,
  ]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const requestSequence = useRef(0);
  const commentState = useRef<{
    context: string;
    payload: { page: string; versionId: string; hasComments: boolean };
  } | null>(null);
  const [params] = useSearchParams();
  const targetThread = params.get('thread');
  const base = `/api/sites/${encodeURIComponent(slug)}`;
  const parentOrigin = useRef<string | null>(null);
  const visibleThreads = threads.filter((t) => !status || t.status === status);

  function send(type: string, data: Record<string, unknown> = {}) {
    if (parentOrigin.current) window.parent.postMessage({ type, ...data }, parentOrigin.current);
  }
  function publishCommentState(hasComments: boolean) {
    if (!embedded) return;
    const payload = { page: page || '/', versionId, hasComments };
    commentState.current = { context: contextKey, payload };
    send('eat:comment-state', payload);
  }
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token: string | null = null;
    try {
      token = getToken();
    } catch {
      /* 分区存储不可用时通过弹窗取得受限会话 */
    }
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(proof ? { 'x-eat-site-access': proof } : {}),
        ...(session ? { 'x-eat-comment-session': session } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) {
        setUser(null);
        setSession('');
      }
      throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? '请求失败，请重试');
    }
    return data;
  }
  async function reload() {
    if (contextKey !== contextRef.current || !embedReady) return;
    const sequence = ++requestSequence.current;
    if (embedded && commentState.current?.context !== contextKey) publishCommentState(false);
    if (!versionId) {
      setThreads([]);
      setLoading(false);
      return;
    }
    const q = new URLSearchParams();
    if (page) q.set('page', page);
    if (filterVersionId) q.set('versionId', filterVersionId);
    setError('');
    setLoading(true);
    try {
      const result = await request<SiteThread[]>('GET', '/threads?' + q);
      if (sequence === requestSequence.current && contextKey === contextRef.current) {
        setThreads(result);
        setNeedsAccess(false);
        publishCommentState(result.some((t) => t.comments.some((c) => !c.deletedAt)));
      }
    } catch (e) {
      if (sequence === requestSequence.current && contextKey === contextRef.current) {
        setThreads([]);
        publishCommentState(false);
        setError((e as Error).message);
        setNeedsAccess(e instanceof ApiError && e.code === 'SITE_PASSWORD_REQUIRED');
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    setProof(initialProof);
  }, [initialProof]);
  useEffect(() => {
    void reload();
    return () => {
      requestSequence.current++;
    };
  }, [slug, versionId, page, proof, session, filterVersionId, user?.id, embedReady]);
  useEffect(() => {
    setAnchor({ type: 'page' });
    setReplyTo('');
    setLocateMessage('');
    setMissingLocation(null);
    setComposePage(page || '/');
  }, [page, versionId]);
  useEffect(() => {
    if (!loading && replyTo && !threads.some((t) => t.id === replyTo)) setReplyTo('');
  }, [threads, loading, replyTo]);
  useEffect(() => {
    let canceled = false;
    setUsers([]);
    if (user)
      void request<MentionUser[]>('GET', '/mention-users')
        .then((data) => {
          if (!canceled) setUsers(data);
        })
        .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [slug, user?.id, session, proof]);
  useEffect(() => {
    if (targetThread && !loading && threads.some((t) => t.id === targetThread))
      document.getElementById('thread-' + targetThread)?.scrollIntoView({ block: 'nearest' });
  }, [targetThread, threads, loading]);
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    // 网关使用 no-referrer，只信任服务端提供的实际浏览版本父源。
    let canceled = false;
    parentOrigin.current = null;
    fetch(base + '/embed-origin?versionId=' + encodeURIComponent(versionId))
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => {
        if (canceled || typeof data.origin !== 'string') return;
        parentOrigin.current = data.origin;
        send('eat:ready');
        const state = commentState.current;
        if (state?.context === contextRef.current) send('eat:comment-state', state.payload);
      })
      .catch(() => {
        if (!canceled) setError('无法连接页面批注，请刷新页面');
      });
    const listener = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== parentOrigin.current || !e.data) return;
      if (e.data.type === 'eat:init' && e.data.versionId === versionId) {
        setEmbedReady(true);
        if (typeof e.data.proof === 'string') setProof(e.data.proof);
        if (typeof e.data.page === 'string') setPage(e.data.page);
      }
      if (e.data.type === 'eat:anchor') {
        setAnchor(e.data.anchor);
        setReplyTo('');
      }
      if (e.data.type === 'eat:located') {
        setLocateMessage(e.data.found ? '已定位到页面位置' : '页面内容已变化，可查看评论时的页面。');
        setMissingLocation(
          e.data.found ? null : (threadsRef.current.find((t) => t.id === e.data.threadId) ?? null),
        );
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="alertdialog"]'))
        send('eat:close');
    };
    window.addEventListener('message', listener);
    window.addEventListener('keydown', escape);
    return () => {
      canceled = true;
      window.removeEventListener('message', listener);
      window.removeEventListener('keydown', escape);
    };
  }, [embedded, slug, versionId]);
  useEffect(() => {
    const listener = async (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== popup.current || !e.data) return;
      if (e.data.type === 'eat:login-ready')
        popup.current?.postMessage({ type: 'eat:login-context', proof: proofRef.current }, location.origin);
      if (e.data.type === 'eat:comment-code') {
        try {
          const res = await fetch(base + '/comment-session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: e.data.code }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message);
          setSession(data.token);
          setUser(data.user);
          setError('');
        } catch (e) {
          setError((e as Error).message);
        }
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [slug]);
  function login() {
    if (embedded && window.parent !== window) {
      popup.current = window.open(
        '/site-comment-login?site=' + encodeURIComponent(slug),
        'eat-comment-login',
        'popup,width=520,height=680',
      );
      if (!popup.current) setError('登录窗口未能打开，请允许弹出窗口后重试。');
    } else location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  }
  function clearAnchor() {
    setAnchor({ type: 'page' });
    send('eat:clear-anchor');
  }
  const composer = versionId && !needsAccess && (
    <div
      className={cn(
        'space-y-3',
        embedded ? 'shrink-0 border-t bg-background px-4 py-3' : 'rounded-xl border bg-muted/20 p-4',
      )}
    >
      {user ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">发表评论</span>
            {embedded && anchor.type === 'page' && (
              <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => send('eat:select', { mode: 'element' })}>
                  <MousePointer2 />
                  标注元素
                </Button>
                <Button variant="outline" size="sm" onClick={() => send('eat:select', { mode: 'region' })}>
                  框选区域
                </Button>
              </div>
            )}
          </div>
          {anchor.type !== 'page' && (
            <div className="flex items-start gap-2 rounded-lg border bg-background p-2 text-xs">
              <MapPin className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-words">
                {anchor.type === 'region' ? '已选区域' : '已选元素'}
                {anchor.text && '：' + anchor.text.slice(0, 100)}
              </span>
              <Button variant="ghost" size="icon-sm" aria-label="取消标注" onClick={clearAnchor}>
                <X />
              </Button>
            </div>
          )}
          {!embedded && (
            <details className="text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer rounded py-1 hover:text-foreground">
                评论页面：{composePage || '/'}
              </summary>
              <label className="mt-2 flex flex-wrap items-center gap-2">
                页面路径
                <Input
                  className="h-8 w-44"
                  aria-label="新评论的页面路径"
                  value={composePage}
                  onChange={(e) => setComposePage(e.target.value)}
                  placeholder="/ 或 /about"
                />
              </label>
            </details>
          )}
          <Composer
            key={versionId + (embedded ? page : '')}
            users={users}
            label="发送评论"
            submit={async (content, mentions) => {
              await request('POST', '/threads', {
                content,
                mentions,
                versionId,
                page: embedded ? page || '/' : composePage || '/',
                anchor,
              });
              if (contextKey === contextRef.current) {
                clearAnchor();
                setStatus('');
                await reload();
              }
            }}
          />
        </>
      ) : (
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">登录后即可参与讨论和标注页面</p>
          <Button className="w-full" onClick={login}>
            登录后评论
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <section className={cn(embedded ? 'flex h-full min-h-0 flex-col' : 'space-y-5')} aria-label="页面评论">
      <div className={cn('space-y-4', embedded && 'shrink-0 border-b px-4 pb-3 pt-4')}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              <MessageSquare className="size-4" />
              页面评论
            </h2>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              {embedded ? page || '/' : '集中查看反馈，页面更新后讨论会继续保留。'}
            </p>
          </div>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新评论"
              disabled={loading}
              onClick={() => void reload()}
            >
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
            {embedded && (
              <Button variant="ghost" size="icon" aria-label="关闭评论" onClick={() => send('eat:close')}>
                <X />
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg bg-muted p-1" role="group" aria-label="评论状态">
            {(
              [
                ['', '全部'],
                ['open', '待处理'],
                ['resolved', '已解决'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={status === value ? 'outline' : 'ghost'}
                size="sm"
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {label}
                <span className="ml-1 tabular-nums text-muted-foreground">
                  {threads.filter((t) => !value || t.status === value).length}
                </span>
              </Button>
            ))}
          </div>
          {!embedded && (
            <Input
              className="h-8 w-48"
              aria-label="按页面筛选评论"
              placeholder="筛选页面，如 /about"
              value={page}
              onChange={(e) => setPage(e.target.value)}
            />
          )}
        </div>
      </div>
      {!embedded && composer}
      {locateMessage && (
        <div
          className={cn(
            'flex shrink-0 items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground',
            embedded && 'mx-4 mt-3',
          )}
        >
          <div role="status" className="min-w-0 flex-1">
            {locateMessage}
            {missingLocation && (
              <a
                className="ml-1 text-primary underline"
                href={missingLocation.url}
                target="_blank"
                rel="noreferrer"
              >
                查看评论时的页面
              </a>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭定位提示"
            onClick={() => {
              setLocateMessage('');
              setMissingLocation(null);
            }}
          >
            <X />
          </Button>
        </div>
      )}
      <div
        className={cn('space-y-3', embedded && 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3')}
        aria-busy={loading}
      >
        {error && (
          <div className="space-y-3 rounded-xl border p-3">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            {needsAccess ? (
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setVerifying(true);
                  try {
                    const data = await request<{ accessToken: string }>('POST', '/access', { password });
                    setProof(data.accessToken);
                    onAccessVerified?.(data.accessToken);
                    setPassword('');
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setVerifying(false);
                  }
                }}
              >
                <Input
                  type="password"
                  aria-label="页面访问密码"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入页面访问密码"
                />
                <Button type="submit" loading={verifying}>
                  验证
                </Button>
              </form>
            ) : (
              <Button variant="outline" onClick={() => void reload()}>
                重试
              </Button>
            )}
            {!user && (
              <Button variant="outline" onClick={login}>
                登录 EAT
              </Button>
            )}
          </div>
        )}
        {loading ? (
          <p role="status" className="py-6 text-center text-sm text-muted-foreground">
            正在读取评论…
          </p>
        ) : (
          <>
            {!error && !visibleThreads.length && (
              <div className="space-y-2 py-8 text-center">
                <MessageSquare className="mx-auto size-7 text-muted-foreground/60" />
                <p className="text-sm font-medium">
                  {status ? '暂无' + (status === 'open' ? '待处理' : '已解决') + '的评论' : '还没有评论'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {status ? '切换到全部，查看其他讨论。' : '写下第一条反馈，让讨论从这里开始。'}
                </p>
              </div>
            )}
            {visibleThreads.map((t) => (
              <article
                id={'thread-' + t.id}
                key={t.id}
                className={cn(
                  'space-y-3 rounded-xl border bg-card p-4',
                  t.id === targetThread && 'ring-2 ring-ring/40',
                )}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {!embedded && <span className="break-all">{t.page}</span>}
                  <span>
                    {t.anchor.type === 'page'
                      ? '页面反馈'
                      : t.anchor.type === 'region'
                        ? '区域标注'
                        : '元素标注'}
                  </span>
                  {t.status === 'resolved' && (
                    <Badge variant="secondary">
                      <Check className="mr-1 size-3" />
                      已解决
                    </Badge>
                  )}
                </div>
                {t.anchor.text && (
                  <blockquote className="line-clamp-3 break-words rounded-r-md border-l-2 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {t.anchor.text}
                  </blockquote>
                )}
                {t.comments.map((c, index) => (
                  <div
                    key={c.id}
                    id={'comment-' + c.id}
                    className={cn('space-y-2', index > 0 && 'ml-2 border-l-2 pl-3')}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="font-medium">{c.authorName}</span>
                      <time
                        className="text-muted-foreground"
                        dateTime={c.createdAt}
                        title={new Date(c.createdAt).toLocaleString()}
                      >
                        {new Date(c.createdAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                      {user && c.canDelete && !c.deletedAt && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label="删除评论"
                          title="删除评论"
                          disabled={deleting}
                          onClick={() => {
                            setDeleteTarget(c);
                            setDeleteError('');
                          }}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                    {c.deletedAt ? (
                      <p className="text-sm italic text-muted-foreground">评论已删除</p>
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{c.content}</p>
                    )}
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  {user && (
                    <Button
                      variant={replyTo === t.id ? 'secondary' : 'outline'}
                      size="sm"
                      onClick={() => setReplyTo(replyTo === t.id ? '' : t.id)}
                    >
                      <MessageSquare />
                      回复
                    </Button>
                  )}
                  {embedded && t.anchor.type !== 'page' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => send('eat:locate', { anchor: t.anchor, threadId: t.id })}
                    >
                      <MapPin />
                      定位标注
                    </Button>
                  )}
                  {!embedded && siteUrl && (
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={(() => {
                          const url = new URL(t.page, siteUrl);
                          url.searchParams.set('eat_thread', t.id);
                          return url.href;
                        })()}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看页面
                        <ExternalLink />
                      </a>
                    </Button>
                  )}
                  {user && t.canResolve && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={updating === t.id}
                      onClick={async () => {
                        if (updating) return;
                        setUpdating(t.id);
                        try {
                          await request('PATCH', '/threads/' + t.id, {
                            status: t.status === 'open' ? 'resolved' : 'open',
                          });
                          await reload();
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setUpdating('');
                        }
                      }}
                    >
                      <Check />
                      {t.status === 'open' ? '标记解决' : '重新打开'}
                    </Button>
                  )}
                </div>
                <details className="text-xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer rounded py-1 hover:text-foreground">
                    评论上下文
                  </summary>
                  <div className="mt-2 space-y-2 rounded-lg bg-muted/40 p-3">
                    <p className="break-all">
                      页面：{t.page} · 发起于 v{t.versionNumber}
                    </p>
                    <a
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                      href={t.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看评论时的页面
                      <ExternalLink className="size-3" />
                    </a>
                    <ul className="space-y-1">
                      {t.comments.map((c) => (
                        <li key={c.id}>
                          {c.authorName} · v{c.versionNumber} · {new Date(c.createdAt).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
                {replyTo === t.id && user && (
                  <Composer
                    key={t.id + versionId}
                    users={users}
                    label="发送回复"
                    autoFocus
                    onCancel={() => setReplyTo('')}
                    submit={async (content, mentions) => {
                      await request('POST', '/threads/' + t.id + '/replies', {
                        content,
                        mentions,
                        versionId,
                      });
                      setReplyTo('');
                      await reload();
                    }}
                  />
                )}
              </article>
            ))}
          </>
        )}
      </div>
      {embedded && !replyTo && composer}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(null);
            setDeleteError('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条评论？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复。其他人的回复会保留；有后续回复时，此处会显示“评论已删除”。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <blockquote className="line-clamp-3 break-words rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
            {deleteTarget?.content}
          </blockquote>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={deleting}
              onClick={async () => {
                if (!deleteTarget || deleting) return;
                const commentId = deleteTarget.id;
                setDeleting(true);
                setDeleteError('');
                try {
                  await request('DELETE', '/comments/' + commentId);
                  if (contextKey === contextRef.current) {
                    setThreads((current) => {
                      const remaining = current
                        .map((t) => ({
                          ...t,
                          comments: t.comments.map((c) =>
                            c.id === commentId
                              ? {
                                  ...c,
                                  content: '',
                                  mentions: [],
                                  deletedAt: new Date().toISOString(),
                                  canDelete: false,
                                }
                              : c,
                          ),
                        }))
                        .filter((t) => t.comments.some((c) => !c.deletedAt));
                      return remaining;
                    });
                    setDeleteTarget(null);
                    await reload();
                  }
                } catch (e) {
                  setDeleteError((e as Error).message);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              <Trash2 />
              删除评论
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function SiteCommentPanelPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  return (
    <main className="h-dvh overflow-hidden bg-background">
      <SiteDiscussion
        key={slug}
        slug={slug}
        versionId={params.get('versionId') ?? ''}
        initialPage={params.get('page') ?? '/'}
        embedded
      />
    </main>
  );
}

export function SiteCommentLoginPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  useEffect(() => {
    const slug = params.get('site');
    if (!slug || !window.opener) {
      setError('请从页面评论面板发起登录');
      return;
    }
    const listener = async (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.opener || e.data?.type !== 'eat:login-context')
        return;
      window.removeEventListener('message', listener);
      try {
        const result = await api<{ code: string }>(
          'POST',
          '/api/sites/' + encodeURIComponent(slug) + '/comment-ticket',
          {},
          e.data.proof ? { 'x-eat-site-access': e.data.proof } : {},
        );
        window.opener.postMessage({ type: 'eat:comment-code', code: result.code }, location.origin);
        window.close();
      } catch (e) {
        setError((e as Error).message);
      }
    };
    window.addEventListener('message', listener);
    window.opener.postMessage({ type: 'eat:login-ready' }, location.origin);
    return () => window.removeEventListener('message', listener);
  }, []);
  return <p role="status">{error || '正在连接评论面板…'}</p>;
}
