import { ChevronsUpDown } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ComboboxGroup {
  label?: string;
  options: ComboboxOption[];
}

/** 可搜索的下拉单选（Popover + cmdk），选项多或需要检索时用它替代 Select */
export function Combobox({
  groups,
  value,
  onChange,
  placeholder = '请选择…',
  searchPlaceholder = '搜索…',
  emptyText = '没有匹配项',
  className,
}: {
  groups: ComboboxGroup[];
  value: string | null;
  onChange: (v: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const all = groups.flatMap((g) => g.options);
  const selected = all.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs outline-none transition-colors cursor-pointer',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
            !selected && 'text-muted-foreground/70',
            className,
          )}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {groups.map((g, gi) => (
              <CommandGroup key={gi} heading={g.label}>
                {g.options.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={`${opt.label} ${opt.hint ?? ''}`}
                    onSelect={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    data-checked={opt.value === value}
                    className="data-[checked=true]:bg-accent/70"
                  >
                    <span className="truncate">{opt.label}</span>
                    {opt.hint && <span className="ml-auto truncate text-xs text-muted-foreground">{opt.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
