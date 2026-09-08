import { useSearchParams } from 'react-router-dom';

/**
 * 一组同步到 URL 查询串的列表参数（筛选 + 分页）：值等于默认值时不写进 URL，
 * 于是刷新、前进后退与分享链接都能还原当前视图，而干净的默认视图不带一串问号参数。
 */
export function useQueryParams<T extends Record<string, string>>(
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const [params, setParams] = useSearchParams();
  const values = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback]),
  ) as T;

  const patch = (next: Partial<T>) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(next)) {
          if (value === undefined) continue;
          if (value === defaults[key]) p.delete(key);
          else p.set(key, String(value));
        }
        return p;
      },
      { replace: true },
    );
  };
  return [values, patch];
}
