import { Slot } from '@radix-ui/react-slot';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';
import { cn } from '../../lib/utils';

/** 全局放一个（main.tsx）：统一悬停延迟，并让相邻提示之间移动时免等待 */
function TooltipProvider({ delayDuration = 300, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-fit max-w-[min(20rem,calc(100vw-2rem))] rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-relaxed text-background break-words whitespace-pre-line',
          'origin-(--radix-tooltip-content-transform-origin) animate-in fade-in-0 zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** 轻触打开后，Radix 自己在 click 里发出的关闭请求要忽略掉（毫秒） */
const TOUCH_OPEN_GUARD_MS = 600;

type TipProps = Omit<React.HTMLAttributes<HTMLElement>, 'content'> & {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>['side'];
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>['align'];
  contentClassName?: string;
};

/**
 * 一行替换原生 `title=`：`<Tip content="…"><span>…</span></Tip>`。
 *
 * - content 为空时不出浮层、子元素照常渲染，调用方不用写条件分支；
 * - 子元素必须能接 ref（原生元素或 forwardRef 组件），这里走 asChild；
 * - 自身也转发 ref 与事件，可以再被 Confirm / DropdownMenuTrigger 这类 asChild 触发器包住；
 * - 禁用的按钮收不到指针事件，要在外面包一层 `<span tabIndex={0}>` 再交给 Tip；
 * - Radix 的 Tooltip 在触屏上不响应（只认悬停与聚焦），而这里的提示多是截断全文、禁用原因这类
 *   手机上同样要看的信息，所以补上「轻触切换」：点一下开、再点或点别处关。
 */
const Tip = React.forwardRef<HTMLElement, TipProps>(function Tip(
  { content, children, side, align, contentClassName, onPointerDown, onClick, ...props },
  ref,
) {
  const [open, setOpen] = React.useState(false);
  const pointerType = React.useRef('');
  const openAtPointerDown = React.useRef(false);
  const touchOpenedAt = React.useRef(0);
  if (content === null || content === undefined || content === false || content === '') {
    return (
      <Slot ref={ref} onPointerDown={onPointerDown} onClick={onClick} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        if (!next && Date.now() - touchOpenedAt.current < TOUCH_OPEN_GUARD_MS) return;
        setOpen(next);
      }}
    >
      <TooltipTrigger
        asChild
        ref={ref as React.Ref<HTMLButtonElement>}
        {...props}
        // 自己的处理先于 Radix 的执行：在 Radix 因 pointerdown 关掉之前记下当时开没开
        onPointerDown={(e) => {
          onPointerDown?.(e);
          pointerType.current = e.pointerType;
          openAtPointerDown.current = open;
        }}
        // 用 click 而不是 pointerdown 切换：在截断的单元格上开始滑动不会误开
        onClick={(e) => {
          onClick?.(e);
          if (pointerType.current !== 'touch') return;
          const next = !openAtPointerDown.current;
          if (next) touchOpenedAt.current = Date.now();
          setOpen(next);
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} align={align} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
});

export { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
