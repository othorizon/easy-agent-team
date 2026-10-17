import type { ReactNode } from 'react';
import type { SiteComment, SiteThread } from '@eat/shared';
import { Check, CheckCircle2, ChevronDown, ExternalLink, MapPin, MessageSquare, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';

export function FolioThread({
  thread: t,
  canReply,
  embedded,
  siteUrl,
  targeted,
  replying,
  updating,
  deleting,
  onReply,
  onResolve,
  onLocate,
  onDelete,
  children,
}: {
  thread: SiteThread;
  canReply: boolean;
  embedded: boolean;
  siteUrl?: string;
  targeted: boolean;
  replying: boolean;
  updating: boolean;
  deleting: boolean;
  onReply: () => void;
  onResolve: () => void;
  onLocate: () => void;
  onDelete: (comment: SiteComment) => void;
  children?: ReactNode;
}) {
  const currentUrl = siteUrl ? new URL(t.page, siteUrl) : null;
  currentUrl?.searchParams.set('eat_thread', t.id);
  return (
    <article
      id={'thread-' + t.id}
      className="folio-thread"
      data-targeted={targeted}
      data-resolved={t.status === 'resolved'}
    >
      {t.comments.map((c, index) => (
        <div key={c.id} id={'comment-' + c.id} className="folio-comment" data-reply={index > 0}>
          <span className="folio-avatar" aria-hidden="true">
            {c.authorName.slice(0, 1)}
          </span>
          <div className="folio-comment-body">
            <header className="folio-comment-meta">
              <span className="folio-author">{c.authorName}</span>
              <time dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>
                {new Date(c.createdAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              {index === 0 && t.status === 'resolved' && (
                <span className="folio-resolved">
                  <CheckCircle2 />
                  已解决
                </span>
              )}
              {canReply && c.canDelete && !c.deletedAt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="folio-comment-delete"
                  aria-label="删除评论"
                  title="删除评论"
                  disabled={deleting}
                  onClick={() => onDelete(c)}
                >
                  <Trash2 />
                </Button>
              )}
            </header>
            {index === 0 && t.anchor.text && (
              <blockquote className="folio-anchor-quote">
                <MapPin aria-hidden="true" />
                <span>{t.anchor.text}</span>
              </blockquote>
            )}
            {c.deletedAt ? (
              <p className="folio-comment-deleted">评论已删除</p>
            ) : (
              <p className="folio-comment-text">{c.content}</p>
            )}
          </div>
        </div>
      ))}
      <div className="folio-thread-footer">
        <div className="folio-thread-origin">
          {!embedded && <span className="folio-thread-path">{t.page}</span>}
          <span>
            {t.anchor.type === 'page' ? '页面反馈' : t.anchor.type === 'region' ? '区域标注' : '元素标注'}
          </span>
        </div>
        <div className="folio-thread-actions">
          {canReply && (
            <Button type="button" variant="ghost" size="sm" aria-pressed={replying} onClick={onReply}>
              <MessageSquare />
              回复
            </Button>
          )}
          {embedded && t.anchor.type !== 'page' && (
            <Button type="button" variant="ghost" size="sm" onClick={onLocate}>
              <MapPin />
              定位标注
            </Button>
          )}
          {!embedded && currentUrl && (
            <Button asChild variant="ghost" size="sm">
              <a href={currentUrl.href} target="_blank" rel="noreferrer">
                <ExternalLink />
                查看页面
              </a>
            </Button>
          )}
          {canReply && t.canResolve && (
            <Button type="button" variant="ghost" size="sm" loading={updating} onClick={onResolve}>
              <Check />
              {t.status === 'open' ? '标记解决' : '重新打开'}
            </Button>
          )}
        </div>
        <details className="folio-thread-context">
          <summary>
            评论上下文
            <ChevronDown aria-hidden="true" />
          </summary>
          <div>
            <p>
              页面：{t.page} · 发起于 v{t.versionNumber}
            </p>
            <a href={t.url} target="_blank" rel="noreferrer">
              查看评论时的页面
              <ExternalLink />
            </a>
            <ul>
              {t.comments.map((c) => (
                <li key={c.id}>
                  {c.authorName} · v{c.versionNumber} · {new Date(c.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        </details>
        {children}
      </div>
    </article>
  );
}
