import { useSearchParams } from 'react-router-dom';

/** 页面级 tab 状态，同步到 URL 的 ?tab=，支持刷新保留与深链；默认 tab 不写入 URL */
export function useTabParam(defaultTab: string): [string, (tab: string) => void] {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? defaultTab;
  const setTab = (next: string) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === defaultTab) p.delete('tab');
        else p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  };
  return [tab, setTab];
}
