import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';

/** 标签输入：回车 / 逗号 / 空格 添加，退格删除最后一个 */
export function TagsInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  function commit() {
    const t = draft.trim().replace(/,$/, '');
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  }

  return (
    <div
      className={cn(
        'flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5 text-sm shadow-xs transition-colors',
        'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25',
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1 font-normal">
          {tag}
          <button
            type="button"
            aria-label={`移除 ${tag}`}
            className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((t) => t !== tag));
            }}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        ref={inputRef}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}
