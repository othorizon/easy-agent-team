import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, AtSign } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Tip } from '../../components/ui/tooltip';
import { Textarea } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import * as Popover from '@radix-ui/react-popover';

export type MentionUser = { id: string; name: string; email: string };
export type FolioDraft = { content: string; mentions: MentionUser[] };

export function FolioComposer({
  users,
  submit,
  label,
  onCancel,
  autoFocus = false,
  toolbar,
  reply = !!onCancel,
  draft,
  onDraftChange,
  onEscape,
  submitting = false,
  submitError,
}: {
  users: MentionUser[];
  submit: (content: string, mentions: string[]) => Promise<void>;
  label: string;
  onCancel?: () => void;
  autoFocus?: boolean;
  toolbar?: ReactNode;
  reply?: boolean;
  draft?: FolioDraft;
  onDraftChange?: (value: FolioDraft) => void;
  onEscape?: () => void;
  submitting?: boolean;
  submitError?: string;
}) {
  const [localDraft, setLocalDraft] = useState<FolioDraft>({ content: '', mentions: [] });
  const { content, mentions } = draft ?? localDraft;
  const updateDraft = onDraftChange ?? setLocalDraft;
  const [sending, setBusy] = useState(false);
  const busy = sending || submitting;
  const [error, setError] = useState('');
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);
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
          updateDraft({ content: '', mentions: [] });
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
          aria-label={reply ? '回复内容' : '评论内容'}
          required
          maxLength={10000}
          disabled={busy}
          className="folio-editor-input"
          value={content}
          placeholder={reply ? '回复，或 @ 提及同事…' : '写下你的想法，@ 提及同事…'}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query !== undefined && !mentionDismissed) {
              e.preventDefault();
              setMentionDismissed(true);
            } else if (e.key === 'Escape' && onEscape) {
              e.preventDefault();
              onEscape();
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          onChange={(e) => {
            setMentionDismissed(false);
            updateDraft({
              content: e.target.value,
              mentions: mentions.filter((u) => e.target.value.includes('@' + u.name)),
            });
          }}
        />
        <Popover.Root
          open={query !== undefined && !mentionDismissed}
          onOpenChange={(open) => {
            if (!open) setMentionDismissed(true);
          }}
        >
          <Popover.Anchor asChild>
            <span className="pointer-events-none absolute inset-0" aria-hidden="true" />
          </Popover.Anchor>
          <Popover.Portal>
            <Popover.Content
              className="folio-mention-popover"
              aria-label="提及同事"
              side="top"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onInteractOutside={(event) => {
                if (event.target === input.current) event.preventDefault();
              }}
              onEscapeKeyDown={(event) => event.stopPropagation()}
            >
              {matches.length ? (
                matches.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="folio-mention-option"
                    onClick={() => {
                      updateDraft({
                        content: content.replace(/@[^\s@]*$/, '@' + u.name + ' '),
                        mentions: [...mentions.filter((m) => m.id !== u.id), u],
                      });
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
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
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
      {(error || submitError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || submitError}
        </p>
      )}
      <div className="folio-editor-footer">
        <div className="folio-editor-tools">
          <Tip content="提及同事">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="提及同事"
              disabled={busy}
              onClick={() => {
                setMentionDismissed(false);
                updateDraft({
                  content: content + (content && !/\s$/.test(content) ? ' ' : '') + '@',
                  mentions,
                });
                input.current?.focus();
              }}
            >
              <AtSign />
            </Button>
          </Tip>
          {toolbar}
        </div>
        <div className="folio-editor-send">
          {onCancel && (
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              取消
            </Button>
          )}
          <Tip content="Ctrl / ⌘ + Enter 发送"><kbd>⌘ ↵</kbd></Tip>
          <Tip content={label}>
            <Button type="submit" loading={busy} disabled={!content.trim()} aria-label={label}>
              {!busy && <ArrowUp />}
              <span className="sr-only">{label}</span>
            </Button>
          </Tip>
        </div>
      </div>
    </form>
  );
}
