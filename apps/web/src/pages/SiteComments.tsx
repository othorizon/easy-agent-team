import type { SiteAnchor, SiteThread, UserPublic } from '@eat/shared';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, getStoredUser, getToken } from '../api';
import { Button } from '../components/ui/button';
import { Input, Textarea } from '../components/ui/input';
import { Badge } from '../components/ui/badge';

type MentionUser = { id: string; name: string; email: string };
const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm';

function Composer({
  users,
  submit,
  label,
}: {
  users: MentionUser[];
  submit: (content: string, mentions: string[]) => Promise<void>;
  label: string;
}) {
  const [content, setContent] = useState('');
  const [mentions, setMentions] = useState<MentionUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = /(?:^|\s)@([^\s@]*)$/.exec(content)?.[1];
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
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
      <Textarea
        aria-label="评论内容"
        required
        maxLength={10000}
        value={content}
        placeholder="写下评论，输入 @ 搜索同事"
        onChange={(e) => {
          setContent(e.target.value);
          setMentions(mentions.filter((u) => e.target.value.includes('@' + u.name)));
        }}
      />
      {query !== undefined && (
        <div className="max-h-40 overflow-auto rounded-md border bg-background">
          {users
            .filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 12)
            .map((u) => (
              <button
                key={u.id}
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setContent(content.replace(/@[^\s@]*$/, '@' + u.name + ' '));
                  setMentions([...mentions.filter((m) => m.id !== u.id), u]);
                }}
              >
                {u.name} <span className="text-muted-foreground">{u.email}</span>
              </button>
            ))}
        </div>
      )}
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
      <Button type="submit" size="sm" loading={busy} disabled={!content.trim()}>
        {label}
      </Button>
    </form>
  );
}

export function SiteDiscussion({
  slug,
  versionId,
  initialPage = '',
  initialProof = '',
  embedded = false,
}: {
  slug: string;
  versionId: string;
  initialPage?: string;
  initialProof?: string;
  embedded?: boolean;
}) {
  const [page, setPage] = useState(initialPage);
  const [proof, setProof] = useState(initialProof);
  const [scope, setScope] = useState('all');
  const [status, setStatus] = useState('');
  const [threads, setThreads] = useState<SiteThread[]>([]);
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [user, setUser] = useState<UserPublic | null>(() => {
    try {
      return getStoredUser();
    } catch {
      return null;
    }
  });
  const [session, setSession] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [anchor, setAnchor] = useState<SiteAnchor>({ type: 'page' });
  const [replyTo, setReplyTo] = useState('');
  const [password, setPassword] = useState('');
  const [locateMessage, setLocateMessage] = useState('');
  const popup = useRef<Window | null>(null);
  const proofRef = useRef(proof);
  proofRef.current = proof;
  const [params] = useSearchParams();
  const targetThread = params.get('thread');
  const embedOrigin = params.get('origin');
  const base = `/api/sites/${encodeURIComponent(slug)}`;
  const parentOrigin = useRef<string | null>(null);

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
      throw new Error(data.message ?? '请求失败');
    }
    return data;
  }
  async function reload() {
    if (!versionId) {
      setLoading(false);
      return;
    }
    const q = new URLSearchParams();
    if (page) q.set('page', page);
    if (scope === 'current') q.set('versionId', versionId);
    if (status) q.set('status', status);
    setError('');
    setLoading(true);
    try {
      setThreads(await request<SiteThread[]>('GET', '/threads?' + q));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setProof(initialProof);
  }, [initialProof]);
  useEffect(() => {
    void reload();
  }, [slug, versionId, page, proof, session, scope, status]);
  useEffect(() => {
    if (user)
      void request<MentionUser[]>('GET', '/mention-users')
        .then(setUsers)
        .catch(() => setUsers([]));
  }, [slug, user?.id, session, proof]);
  useEffect(() => {
    if (targetThread && threads.some((t) => t.id === targetThread))
      document.getElementById('thread-' + targetThread)?.scrollIntoView({ block: 'center' });
  }, [targetThread, threads]);
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    // 由服务器验证父源为本站固定域名或此版本域名，不信任 URL 参数本身。
    let canceled = false;
    parentOrigin.current = null;
    const query = new URLSearchParams({ versionId });
    if (embedOrigin) query.set('origin', embedOrigin);
    fetch(base + '/embed-origin?' + query)
      .then((r) => {
        if (!r.ok) throw new Error('网站来源验证失败');
        return r.json();
      })
      .then((data) => {
        if (canceled || typeof data.origin !== 'string') return;
        parentOrigin.current = data.origin;
        window.parent.postMessage({ type: 'eat:ready' }, data.origin);
      })
      .catch(() => setError('无法连接页面批注，请刷新页面'));
    const listener = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== parentOrigin.current || !e.data) return;
      if (e.data.type === 'eat:init' && e.data.versionId === versionId) {
        if (typeof e.data.proof === 'string') setProof(e.data.proof);
        if (typeof e.data.page === 'string') setPage(e.data.page);
      }
      if (e.data.type === 'eat:anchor') {
        setAnchor(e.data.anchor);
        setReplyTo('');
      }
      if (e.data.type === 'eat:located')
        setLocateMessage(e.data.found ? '已定位到页面位置' : '原位置已变化，请打开原版本查看。');
    };
    window.addEventListener('message', listener);
    return () => {
      canceled = true;
      window.removeEventListener('message', listener);
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
        } catch (e) {
          setError((e as Error).message);
        }
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [slug]);
  function select(mode: string) {
    if (parentOrigin.current) window.parent.postMessage({ type: 'eat:select', mode }, parentOrigin.current);
  }
  function login() {
    if (embedded && window.parent !== window)
      popup.current = window.open(
        '/site-comment-login?site=' + encodeURIComponent(slug),
        'eat-comment-login',
        'popup,width=520,height=680',
      );
    else location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">页面讨论</h2>
        <Button size="sm" variant="ghost" onClick={() => void reload()}>
          刷新
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {!embedded && (
          <Input
            className="w-44"
            aria-label="按页面筛选"
            placeholder="全部页面，或 /about"
            value={page}
            onChange={(e) => setPage(e.target.value)}
          />
        )}
        <select aria-label="版本范围" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">全部版本</option>
          <option value="current">当前浏览版本</option>
        </select>
        <select
          aria-label="讨论状态"
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="open">未解决</option>
          <option value="resolved">已解决</option>
        </select>
      </div>
      {error && (
        <div className="space-y-2 rounded-md border p-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const data = await request<{ accessToken: string }>('POST', '/access', { password });
                setProof(data.accessToken);
                setPassword('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Input
              type="password"
              aria-label="网站访问密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码网站可在此验证"
            />
            <Button size="sm" type="submit">
              验证
            </Button>
          </form>
          {!user && (
            <Button size="sm" onClick={login}>
              登录 EAT
            </Button>
          )}
        </div>
      )}
      {locateMessage && (
        <p role="status" className="text-sm text-muted-foreground">
          {locateMessage}
        </p>
      )}
      {loading && <p className="text-sm text-muted-foreground">正在读取讨论…</p>}
      {!loading && !error && !threads.length && <p className="text-sm text-muted-foreground">还没有讨论。</p>}
      {threads.map((t) => (
        <article id={'thread-' + t.id} key={t.id} className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">来自 v{t.versionNumber}</Badge>
            <span>{t.page}</span>
            <span>{t.anchor.type === 'page' ? '整页' : t.anchor.type === 'region' ? '区域' : '元素'}</span>
            {t.status === 'resolved' && <Badge variant="secondary">已解决</Badge>}
          </div>
          {t.anchor.text && (
            <blockquote className="line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground">
              {t.anchor.text}
            </blockquote>
          )}
          {t.comments.map((c) => (
            <div key={c.id} className="space-y-1">
              <div className="text-xs text-muted-foreground">
                {c.authorName} · v{c.versionNumber} · {new Date(c.createdAt).toLocaleString()}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">{c.content}</p>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 text-xs">
            <a className="text-primary hover:underline" href={t.url} target="_blank" rel="noreferrer">
              查看原版本
            </a>
            {embedded && t.anchor.type !== 'page' && (
              <button
                className="text-primary"
                onClick={() =>
                  parentOrigin.current &&
                  window.parent.postMessage(
                    { type: 'eat:locate', anchor: t.anchor, threadId: t.id },
                    parentOrigin.current,
                  )
                }
              >
                定位元素
              </button>
            )}
            {user && (
              <button className="text-primary" onClick={() => setReplyTo(replyTo === t.id ? '' : t.id)}>
                回复
              </button>
            )}
            {user && t.canResolve && (
              <button
                className="text-primary"
                onClick={async () => {
                  try {
                    await request('PATCH', '/threads/' + t.id, { status: t.status === 'open' ? 'resolved' : 'open' });
                    await reload();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {t.status === 'open' ? '标记解决' : '重新打开'}
              </button>
            )}
          </div>
          {replyTo === t.id && (
            <Composer
              users={users}
              label="发送回复"
              submit={async (content, mentions) => {
                await request('POST', '/threads/' + t.id + '/replies', { content, mentions, versionId });
                setReplyTo('');
                await reload();
              }}
            />
          )}
        </article>
      ))}
      {versionId && (
        <div className="space-y-3 border-t pt-4">
          {user ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={anchor.type === 'page' ? 'secondary' : 'outline'}
                  onClick={() => setAnchor({ type: 'page' })}
                >
                  整页评论
                </Button>
                {embedded && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => select('element')}>
                      选择元素
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => select('region')}>
                      选择区域
                    </Button>
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {anchor.type === 'page' ? '评论当前页面' : anchor.type === 'region' ? '已选择区域' : '已选择元素'}
                {anchor.text ? '：' + anchor.text.slice(0, 80) : ''}。评论关联 {page || '/'}，记录当前浏览版本。
              </p>
              <Composer
                key={versionId + page}
                users={users}
                label="发表评论"
                submit={async (content, mentions) => {
                  await request('POST', '/threads', { content, mentions, versionId, page: page || '/', anchor });
                  setAnchor({ type: 'page' });
                  await reload();
                }}
              />
            </>
          ) : (
            <Button onClick={login}>登录后发表评论</Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SiteCommentPanelPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  return (
    <main className="min-h-dvh bg-background p-4">
      <SiteDiscussion
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
      setError('请从网站评论面板发起登录');
      return;
    }
    const listener = async (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.opener || e.data?.type !== 'eat:login-context') return;
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
