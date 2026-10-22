import type { SiteAnchor, SiteComment, SiteThread, UserPublic } from '@eat/shared';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { MapPin, MessageSquare, MousePointer2, ScanLine, Search, Trash2, RefreshCw, X } from 'lucide-react';
import { api, ApiError, getStoredUser, getToken } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import { FolioConnectionState } from './folios/folio-ui';
import { FolioComposer as Composer, type MentionUser } from './folios/FolioComposer';
import { FolioThread } from './folios/FolioThread';
import { FolioWebsitePanel } from './folios/FolioWebsitePanel';
import './folios/folio.css';
import './folios/folio-discussion.css';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';

export function FolioDiscussion({
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
  const embedOrigin = params.get('origin');
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
    if (targetThread && !loading && threads.some((t) => t.id === targetThread)) {
      const target = document.getElementById('thread-' + targetThread);
      const list = target?.parentElement;
      if (target && list && embedded)
        list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top;
      else if (target && !embedded)
        window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - 24 });
    }
  }, [targetThread, threads, loading, embedded]);
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    // 由服务器验证父源为本站固定域名或此版本域名，不信任 URL 参数本身。
    let canceled = false;
    parentOrigin.current = null;
    const query = new URLSearchParams({ versionId });
    if (embedOrigin) query.set('origin', embedOrigin);
    fetch(base + '/embed-origin?' + query)
      .then((r) => {
        if (!r.ok) throw new Error('页面来源验证失败');
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
  }, [embedded, slug, versionId, embedOrigin]);
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
        '/folio-comment-login?folio=' + encodeURIComponent(slug),
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
  const accessPrompt = error && (
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
            aria-label="Folio 访问密码"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入 Folio 访问密码"
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
  );
  const composer = versionId && !needsAccess && (
    <div className="folio-composer">
      {user ? (
        <>
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
          <Composer
            key={versionId + (embedded ? page : '')}
            users={users}
            label="发送评论"
            toolbar={
              embedded ? (
                anchor.type === 'page' && (
                  <div className="folio-annotation-tools">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => send('eat:select', { mode: 'element' })}
                    >
                      <MousePointer2 />
                      <span>标注元素</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => send('eat:select', { mode: 'region' })}
                    >
                      <ScanLine />
                      <span>框选区域</span>
                    </Button>
                  </div>
                )
              ) : (
                <details className="folio-compose-path">
                  <summary>评论页面：{composePage || '/'}</summary>
                  <label>
                    页面路径
                    <Input
                      aria-label="新评论的页面路径"
                      value={composePage}
                      onChange={(e) => setComposePage(e.target.value)}
                      placeholder="/ 或 /about"
                    />
                  </label>
                </details>
              )
            }
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
    <section
      className={cn(
        'folio-discussion',
        embedded ? 'folio-discussion-embedded flex h-full min-h-0 flex-col' : 'folio-discussion-workspace',
      )}
      aria-label="Folio 评论"
    >
      {embedded ? (
        <FolioWebsitePanel
          key={JSON.stringify([slug, versionId, page, user?.id])}
          threads={threads}
          loading={loading}
          page={page || '/'}
          users={users}
          signedIn={!!user}
          anchor={anchor}
          targetThread={targetThread}
          missingThreadId={missingLocation?.id}
          errorContent={accessPrompt}
          needsAccess={needsAccess}
          canCompose={!!versionId}
          disabled={deleting || !!updating}
          onSelect={(thread) => {
            setLocateMessage('');
            setMissingLocation(null);
            if (thread.anchor.type === 'page') send('eat:clear-anchor');
            else send('eat:locate', { anchor: thread.anchor, threadId: thread.id });
          }}
          onClearLocation={() => {
            send('eat:clear-anchor');
            setLocateMessage('');
            setMissingLocation(null);
          }}
          onSelectAnchor={(mode) => send('eat:select', { mode })}
          onClearAnchor={clearAnchor}
          onCreate={async (content, mentions) => {
            await request('POST', '/threads', { content, mentions, versionId, page: page || '/', anchor });
            if (contextKey === contextRef.current) {
              clearAnchor();
              await reload();
            }
          }}
          onReply={async (thread, content, mentions) => {
            await request('POST', '/threads/' + thread.id + '/replies', { content, mentions, versionId });
            if (contextKey === contextRef.current) await reload();
          }}
          onStatus={async (thread, status) => {
            setUpdating(thread.id);
            try {
              await request('PATCH', '/threads/' + thread.id, { status });
              if (contextKey === contextRef.current) await reload();
            } finally {
              setUpdating('');
            }
          }}
          onDelete={(comment) => {
            setDeleteTarget(comment);
            setDeleteError('');
          }}
          onRefresh={() => void reload()}
          onClose={() => {
            send('eat:clear-anchor');
            setMissingLocation(null);
            send('eat:close');
          }}
          onLogin={login}
        />
      ) : (
        <>
          <div
            className={cn(
              'folio-discussion-heading space-y-4',
              embedded && 'shrink-0 border-b px-4 pb-3 pt-4',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="folio-discussion-title">
                  {embedded ? '评论' : '讨论'}
                  <span>{threads.length}</span>
                </h2>
                {embedded && <p className="folio-discussion-page">{page || '/'}</p>}
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
              <div className="folio-comment-filters" role="group" aria-label="评论状态">
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
                <label className="folio-comment-search">
                  <Search aria-hidden="true" />
                  <Input
                    aria-label="按页面筛选评论"
                    placeholder="筛选页面，如 /about"
                    value={page}
                    onChange={(e) => setPage(e.target.value)}
                  />
                </label>
              )}
            </div>
          </div>
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
            className={cn(
              'folio-thread-list space-y-3',
              embedded && 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3',
            )}
            aria-busy={loading}
          >
            {accessPrompt}
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
                  <FolioThread
                    key={t.id}
                    thread={t}
                    canReply={!!user}
                    embedded={embedded}
                    siteUrl={siteUrl}
                    targeted={t.id === targetThread}
                    replying={replyTo === t.id}
                    updating={updating === t.id}
                    deleting={deleting}
                    onReply={() => setReplyTo(replyTo === t.id ? '' : t.id)}
                    onLocate={() => send('eat:locate', { anchor: t.anchor, threadId: t.id })}
                    onDelete={(comment) => {
                      setDeleteTarget(comment);
                      setDeleteError('');
                    }}
                    onResolve={async () => {
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
                  </FolioThread>
                ))}
              </>
            )}
          </div>
          {(!embedded || !replyTo) && composer}
        </>
      )}
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

export function FolioCommentPanelPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  return (
    <main className="folio-embed-page h-dvh overflow-hidden bg-background">
      <FolioDiscussion
        key={slug}
        slug={slug}
        versionId={params.get('versionId') ?? ''}
        initialPage={params.get('page') ?? '/'}
        embedded
      />
    </main>
  );
}

export function FolioCommentLoginPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  useEffect(() => {
    const slug = params.get('folio');
    if (!slug || !window.opener) {
      setError('请从 Folio 评论面板发起登录');
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
  return <FolioConnectionState error={error} message="正在连接评论面板…" />;
}
