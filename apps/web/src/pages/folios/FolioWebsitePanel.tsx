import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SiteAnchor, SiteComment, SiteThread } from '@eat/shared';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Info,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { FolioComposer, type FolioDraft, type MentionUser } from './FolioComposer';
import './folio-website.css';

const emptyDraft: FolioDraft = { content: '', mentions: [] };

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    return;
  } catch {
    // Cross-origin embeds may not have Clipboard API permission.
    const previous = document.activeElement as HTMLElement | null;
    const input = document.createElement('textarea');
    input.value = url;
    input.readOnly = true;
    input.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(input);
    input.select();
    try {
      if (!document.execCommand('copy')) throw new Error('复制失败，请重试');
    } finally {
      input.remove();
      previous?.focus({ preventScroll: true });
    }
  }
}

function CommentMenu({
  thread,
  comment,
  root,
  disabled,
  onStatus,
  onDelete,
  onDetails,
  onNotice,
}: {
  thread: SiteThread;
  comment: SiteComment;
  root: boolean;
  disabled: boolean;
  onStatus: () => void;
  onDelete: () => void;
  onDetails: () => void;
  onNotice: (message: string, error?: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="folio-website-more"
          aria-label={root ? '讨论操作' : '回复操作'}
          title={root ? '讨论操作' : '回复操作'}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="folio-website-menu"
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        {root && thread.canResolve && (
          <DropdownMenuItem disabled={disabled} onSelect={onStatus}>
            {thread.status === 'open' ? <CheckCircle2 /> : <RotateCcw />}
            {thread.status === 'open' ? '标记解决' : '重新打开'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() =>
            void copyLink(thread.url)
              .then(() => onNotice('讨论链接已复制'))
              .catch((e: Error) => onNotice(e.message, true))
          }
        >
          <Copy />
          复制讨论链接
        </DropdownMenuItem>
        {root && (
          <>
            <DropdownMenuItem asChild>
              <a href={thread.url} target="_blank" rel="noreferrer">
                <ExternalLink />
                查看评论时的页面
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDetails}>
              <Info />
              详细信息
            </DropdownMenuItem>
          </>
        )}
        {comment.canDelete && !comment.deletedAt && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive disabled={disabled} onSelect={onDelete}>
              <Trash2 />
              删除评论
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WebsiteThread({
  thread,
  active,
  signedIn,
  disabled,
  missingLocation,
  onSelect,
  onStatus,
  onDelete,
  onNotice,
  children,
}: {
  thread: SiteThread;
  active: boolean;
  signedIn: boolean;
  disabled: boolean;
  missingLocation: boolean;
  onSelect: () => void;
  onStatus: () => void;
  onDelete: (comment: SiteComment) => void;
  onNotice: (message: string, error?: boolean) => void;
  children: ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const replies = thread.comments.slice(1);
  const select = () => {
    if (!window.getSelection()?.isCollapsed) return;
    onSelect();
  };
  return (
    <article
      id={'thread-' + thread.id}
      className="folio-website-thread"
      data-active={active}
      data-resolved={thread.status === 'resolved'}
    >
      {thread.comments.slice(0, active ? undefined : 1).map((comment, index) => (
        <div
          id={'comment-' + comment.id}
          key={comment.id}
          className="folio-website-comment"
          data-reply={index > 0}
        >
          <button
            type="button"
            className="folio-website-select"
            onClick={select}
            aria-label={index === 0 ? '展开讨论并定位标注' : '定位这组讨论'}
            aria-expanded={index === 0 ? active : undefined}
            aria-controls={index === 0 ? 'discussion-' + thread.id : undefined}
            aria-describedby={'comment-content-' + comment.id}
          >
            <span className="folio-avatar" aria-hidden="true">
              {comment.authorName.slice(0, 1)}
            </span>
            <span className="folio-website-comment-content" id={'comment-content-' + comment.id}>
              <span className="folio-website-meta">
                <span className="folio-author">{comment.authorName}</span>
                <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
                  {new Date(comment.createdAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
                {index === 0 && thread.status === 'resolved' && (
                  <CheckCircle2 className="folio-website-resolved-icon" aria-label="已解决" />
                )}
              </span>
              {index === 0 && thread.anchor.type !== 'page' && (
                <span className="folio-website-quote">
                  <MapPin />
                  <span>
                    {thread.anchor.text || (thread.anchor.type === 'region' ? '页面区域' : '页面元素')}
                  </span>
                </span>
              )}
              <span className={comment.deletedAt ? 'folio-comment-deleted' : 'folio-comment-text'}>
                {comment.deletedAt ? '评论已删除' : comment.content}
              </span>
              {index === 0 && !active && !!replies.length && (
                <span className="folio-website-reply-count">
                  <MessageSquare />
                  {replies.length} 条回复
                </span>
              )}
            </span>
          </button>
          <CommentMenu
            thread={{ ...thread, canResolve: signedIn && thread.canResolve }}
            comment={{
              ...comment,
              canDelete: signedIn && comment.canDelete,
            }}
            root={index === 0}
            disabled={disabled}
            onStatus={onStatus}
            onDelete={() => onDelete(comment)}
            onDetails={() => setDetails(!details)}
            onNotice={onNotice}
          />
        </div>
      ))}
      {details && (
        <div className="folio-website-context">
          <p>
            页面：{thread.page} · 发起于 v{thread.versionNumber}
          </p>
          {thread.comments.map((comment) => (
            <p key={comment.id}>
              {comment.authorName} · v{comment.versionNumber} · {new Date(comment.createdAt).toLocaleString()}
            </p>
          ))}
        </div>
      )}
      {active && (
        <div id={'discussion-' + thread.id} className="folio-website-discussion">
          {missingLocation && (
            <p role="status" className="folio-website-location-error">
              页面内容已变化，可查看评论时的页面。{' '}
              <a href={thread.url} target="_blank" rel="noreferrer">
                查看评论时的页面
              </a>
            </p>
          )}
          {children}
        </div>
      )}
    </article>
  );
}

export function FolioWebsitePanel({
  threads,
  loading,
  page,
  users,
  signedIn,
  anchor,
  targetThread,
  missingThreadId,
  errorContent,
  needsAccess,
  canCompose,
  disabled,
  onSelect,
  onClearLocation,
  onSelectAnchor,
  onClearAnchor,
  onCreate,
  onReply,
  onStatus,
  onDelete,
  onRefresh,
  onClose,
  onLogin,
}: {
  threads: SiteThread[];
  loading: boolean;
  page: string;
  users: MentionUser[];
  signedIn: boolean;
  anchor: SiteAnchor;
  targetThread: string | null;
  missingThreadId?: string;
  errorContent: ReactNode;
  needsAccess: boolean;
  canCompose: boolean;
  disabled: boolean;
  onSelect: (thread: SiteThread) => void;
  onClearLocation: () => void;
  onSelectAnchor: (mode: 'element' | 'region') => void;
  onClearAnchor: () => void;
  onCreate: (content: string, mentions: string[]) => Promise<void>;
  onReply: (thread: SiteThread, content: string, mentions: string[]) => Promise<void>;
  onStatus: (thread: SiteThread, status: SiteThread['status']) => Promise<void>;
  onDelete: (comment: SiteComment) => void;
  onRefresh: () => void;
  onClose: () => void;
  onLogin: () => void;
}) {
  const [activeId, setActiveId] = useState('');
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, FolioDraft>>({});
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const pendingDrafts = useRef(new Set<string>());
  const [notice, setNotice] = useState<{ message: string; error?: boolean; undo?: SiteThread } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const handledTarget = useRef('');
  const pendingStatus = useRef(false);
  const open = threads.filter((thread) => thread.status === 'open');
  const resolved = threads.filter((thread) => thread.status === 'resolved');
  const setDraft = (key: string, value: FolioDraft) => setDrafts((current) => ({ ...current, [key]: value }));
  const showNotice = (message: string, error = false) => setNotice({ message, error });
  async function sendDraft(key: string, action: () => Promise<void>) {
    if (pendingDrafts.current.has(key)) throw new Error('正在发送，请稍候');
    pendingDrafts.current.add(key);
    setSending(new Set(pendingDrafts.current));
    setSendErrors((current) => ({ ...current, [key]: '' }));
    try {
      await action();
    } catch (error) {
      setSendErrors((current) => ({ ...current, [key]: (error as Error).message }));
      throw error;
    } finally {
      pendingDrafts.current.delete(key);
      setSending(new Set(pendingDrafts.current));
    }
  }
  const select = (thread: SiteThread) => {
    setComposing(false);
    setActiveId(thread.id);
    onSelect(thread);
  };
  const clearSelection = () => {
    setActiveId('');
    setComposing(false);
    onClearLocation();
  };
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 10000 : 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (anchor.type !== 'page') {
      setActiveId('');
      setComposing(true);
    }
  }, [anchor]);
  useEffect(() => {
    if (loading || !activeId || threads.some((thread) => thread.id === activeId)) return;
    setActiveId('');
    onClearLocation();
  }, [loading, threads, activeId]);
  useEffect(() => {
    if (!targetThread || loading || handledTarget.current === targetThread) return;
    const thread = threads.find((item) => item.id === targetThread);
    if (!thread) return;
    handledTarget.current = targetThread;
    if (thread.status === 'resolved') setResolvedOpen(true);
    select(thread);
  }, [targetThread, loading, threads]);
  useEffect(() => {
    if (!activeId) return;
    const frame = requestAnimationFrame(() => {
      const container = list.current;
      const target = document.getElementById('thread-' + activeId);
      if (!container || !target) return;
      const bounds = container.getBoundingClientRect();
      const selected = target.getBoundingClientRect();
      if (selected.height > bounds.height || selected.top < bounds.top)
        container.scrollTop += selected.top - bounds.top - 8;
      else if (selected.bottom > bounds.bottom) container.scrollTop += selected.bottom - bounds.bottom + 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId, resolvedOpen]);
  async function changeStatus(
    thread: SiteThread,
    status: SiteThread['status'] = thread.status === 'open' ? 'resolved' : 'open',
    undo = false,
  ) {
    if (pendingStatus.current || disabled) return;
    pendingStatus.current = true;
    try {
      await onStatus(thread, status);
      if (status === 'resolved') {
        if (activeId === thread.id) {
          setActiveId('');
          onClearLocation();
        }
        setNotice({ message: undo ? '已撤销重新打开' : '讨论已解决', undo: undo ? undefined : thread });
      } else {
        setActiveId(thread.id);
        onSelect(thread);
        setNotice({ message: undo ? '已撤销解决' : '讨论已重新打开' });
      }
    } catch (error) {
      showNotice((error as Error).message, true);
    } finally {
      pendingStatus.current = false;
    }
  }
  const renderThread = (thread: SiteThread) => (
    <WebsiteThread
      key={thread.id}
      thread={thread}
      active={activeId === thread.id}
      signedIn={signedIn}
      disabled={disabled || sending.size > 0}
      missingLocation={missingThreadId === thread.id}
      onSelect={() => select(thread)}
      onStatus={() => void changeStatus(thread)}
      onDelete={onDelete}
      onNotice={showNotice}
    >
      {signedIn ? (
        <FolioComposer
          key={thread.id}
          users={users}
          reply
          label="发送回复"
          autoFocus={window.matchMedia('(pointer: fine)').matches}
          draft={drafts['reply:' + thread.id] ?? emptyDraft}
          onDraftChange={(value) => setDraft('reply:' + thread.id, value)}
          submitting={sending.has('reply:' + thread.id)}
          submitError={sendErrors['reply:' + thread.id]}
          onEscape={clearSelection}
          submit={(content, mentions) =>
            sendDraft('reply:' + thread.id, () => onReply(thread, content, mentions))
          }
        />
      ) : (
        <button type="button" className="folio-website-signin" onClick={onLogin}>
          登录后回复
        </button>
      )}
    </WebsiteThread>
  );
  return (
    <div
      className="folio-website-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && (activeId || composing)) {
          event.preventDefault();
          clearSelection();
        }
      }}
    >
      <header className="folio-website-header">
        <div>
          <h2>
            评论 <span>{open.length}</span>
          </h2>
          <p title={page}>未解决 · {page || '/'}</p>
        </div>
        <div className="folio-website-header-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="评论面板操作">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="folio-website-menu"
              onEscapeKeyDown={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem disabled={loading} onSelect={onRefresh}>
                <RefreshCw />
                刷新评论
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭评论" onClick={onClose}>
            <X />
          </Button>
        </div>
      </header>
      <div className="folio-website-list" ref={list} aria-busy={loading}>
        {errorContent}
        {loading && !threads.length ? (
          <p role="status" className="folio-website-empty">
            正在读取评论…
          </p>
        ) : (
          <>
            {!errorContent && !open.length && (
              <div className="folio-website-empty">
                {resolved.length ? <CheckCircle2 /> : <MessageSquare />}
                <p>{resolved.length ? '所有讨论都已解决' : '还没有评论'}</p>
                <span>
                  {resolved.length
                    ? '已解决的讨论收在下方，随时可以查看。'
                    : '留下想法，或选择页面上的位置进行标注。'}
                </span>
              </div>
            )}
            {open.map(renderThread)}
            {!!resolved.length && (
              <section className="folio-website-resolved" aria-label="已解决的讨论">
                <button
                  type="button"
                  className="folio-website-resolved-toggle"
                  aria-expanded={resolvedOpen}
                  aria-controls="resolved-discussions"
                  onClick={() => {
                    setResolvedOpen(!resolvedOpen);
                    if (resolvedOpen && resolved.some((thread) => thread.id === activeId)) clearSelection();
                  }}
                >
                  <ChevronDown data-open={resolvedOpen} />
                  <span>已解决</span>
                  <span>{resolved.length}</span>
                </button>
                {resolvedOpen && <div id="resolved-discussions">{resolved.map(renderThread)}</div>}
              </section>
            )}
          </>
        )}
      </div>
      {notice && (
        <div className="folio-website-notice" role={notice.error ? 'alert' : 'status'}>
          <span>
            {!notice.error && <Check />}
            {notice.message}
          </span>
          {notice.undo && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void changeStatus(notice.undo!, notice.undo!.status, true)}
            >
              撤销
            </button>
          )}
        </div>
      )}
      {!needsAccess && canCompose && (
        <div className="folio-website-new">
          {!signedIn ? (
            <Button type="button" variant="outline" onClick={onLogin}>
              登录后评论
            </Button>
          ) : composing ? (
            <>
              {anchor.type !== 'page' && (
                <div className="folio-website-anchor">
                  <MapPin />
                  <span>{anchor.text || (anchor.type === 'region' ? '已选区域' : '已选元素')}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="取消标注"
                    onClick={onClearAnchor}
                  >
                    <X />
                  </Button>
                </div>
              )}
              <FolioComposer
                users={users}
                label="发送评论"
                autoFocus
                draft={drafts.new ?? emptyDraft}
                onDraftChange={(value) => setDraft('new', value)}
                submitting={sending.has('new')}
                submitError={sendErrors.new}
                onEscape={clearSelection}
                toolbar={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="选择标注位置"
                        title="选择标注位置"
                      >
                        <MapPin />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      side="top"
                      className="folio-website-menu"
                      onEscapeKeyDown={(e) => e.stopPropagation()}
                    >
                      <DropdownMenuItem onSelect={onClearAnchor}>
                        <MessageSquare />
                        整页评论
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onSelectAnchor('element')}>
                        <MousePointer2 />
                        标注元素
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onSelectAnchor('region')}>
                        <ScanLine />
                        框选区域
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
                submit={async (content, mentions) => {
                  await sendDraft('new', () => onCreate(content, mentions));
                  setComposing(false);
                }}
              />
            </>
          ) : (
            <button
              type="button"
              className="folio-website-new-trigger"
              onClick={() => {
                setActiveId('');
                setComposing(true);
                onClearLocation();
              }}
            >
              <Plus />
              <span>{drafts.new?.content ? '继续编辑新评论…' : '添加评论…'}</span>
              <MapPin />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
