import { useState } from 'react';
import { Send } from 'lucide-react';
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
