import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, AtSign } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';

export type MentionUser = { id: string; name: string; email: string };

export function FolioComposer({
  users,
  submit,
  label,
  onCancel,
  autoFocus = false,
  toolbar,
}: {
  users: MentionUser[];
  submit: (content: string, mentions: string[]) => Promise<void>;
  label: string;
  onCancel?: () => void;
  autoFocus?: boolean;
  toolbar?: ReactNode;
}) {
  const [content, setContent] = useState('');
  const [mentions, setMentions] = useState<MentionUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = '0px';
    input.current.style.height = Math.min(160, Math.max(64, input.current.scrollHeight)) + 'px';
  }, [content]);
  const query = /(?:^|\s)@([^\s@]*)$/.exec(content)?.[1];
  const matches =
    query === undefined
      ? []
      : users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  return (
    <form
      className="folio-editor"
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
          ref={input}
          aria-label={onCancel ? '回复内容' : '评论内容'}
          autoFocus={autoFocus}
          required
          maxLength={10000}
          disabled={busy}
          className="folio-editor-input"
          value={content}
          placeholder={onCancel ? '回复，或 @ 提及同事…' : '写下你的想法，@ 提及同事…'}
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
          <div className="folio-mention-menu" aria-label="提及同事">
            {matches.length ? (
              matches.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="folio-mention-option"
                  onClick={() => {
                    setContent(content.replace(/@[^\s@]*$/, '@' + u.name + ' '));
                    setMentions([...mentions.filter((m) => m.id !== u.id), u]);
                    input.current?.focus();
                  }}
                >
                  <span className="folio-avatar" aria-hidden="true">
                    {u.name.slice(0, 1)}
                  </span>
                  <span>
                    {u.name} <small>{u.email}</small>
                  </span>
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
      <div className="folio-editor-footer">
        <div className="folio-editor-tools">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="提及同事"
            title="提及同事"
            disabled={busy}
            onClick={() => {
              setContent((value) => value + (value && !/\s$/.test(value) ? ' ' : '') + '@');
              input.current?.focus();
            }}
          >
            <AtSign />
          </Button>
          {toolbar}
        </div>
        <div className="folio-editor-send">
          {onCancel && (
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              取消
            </Button>
          )}
          <kbd title="Ctrl / ⌘ + Enter 发送">⌘ ↵</kbd>
          <Button type="submit" loading={busy} disabled={!content.trim()} aria-label={label} title={label}>
            {!busy && <ArrowUp />}
            <span className="sr-only">{label}</span>
          </Button>
        </div>
      </div>
    </form>
  );
}
