import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowUpRight, Copy, Files, LayoutGrid, List, MessageSquare,
  MoreHorizontal, Plus, Search, Settings, Upload, X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { SiteCapabilityInfo, SiteInfo } from '@eat/shared';
import { api } from '../../api';
import { PAGE_SIZE_OPTIONS, Pagination } from '../../components/pagination';
import { useQueryParams } from '../../lib/use-query-params';
import { Button } from '../../components/ui/button';
import { Input, Textarea } from '../../components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { FolioAccess, folioAccessModes } from './folio-ui';
import './folio.css';

type LibraryView = 'grid' | 'list';
type LibrarySort = 'updated' | 'created' | 'name';
const viewPreference = 'eat.folio-library-view';

function FolioProject({ site }: { site: SiteInfo }) {
  const detailUrl = '/folios/' + site.slug;
  const published = !!site.currentVersionId;
  return (
    <article className="folio-project">
      <div className="folio-project-header">
        <div className="folio-project-identity">
          <h2><Link className="folio-project-link" to={detailUrl} title={site.name}>{site.name}</Link></h2>
          <span className="folio-project-slug" title={site.slug}>{site.slug}</span>
        </div>
        <span className={published ? 'folio-status' : 'folio-status folio-status-draft'}>
          <i />{published ? '已发布' : '待发布'}
        </span>
      </div>
      {site.description && <p className="folio-project-description">{site.description}</p>}
      <div className="folio-project-footer">
        <div className="folio-project-meta">
          <FolioAccess access={site.access} />
          <time className="folio-project-date" dateTime={site.updatedAt} title={new Date(site.updatedAt).toLocaleString('zh-CN')}>
            {new Date(site.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 更新
          </time>
        </div>
        <div className="folio-project-actions">
          {published ? (
            <>
              <Button
                variant="ghost" size="icon-sm" aria-label={'复制链接：' + site.name} title="复制链接"
                onClick={() => void navigator.clipboard.writeText(site.url)
                  .then(() => toast.success('已复制 Folio 链接'))
                  .catch(() => toast.error('复制失败，请重试'))}
              ><Copy /></Button>
              <Button asChild variant="outline" size="sm">
                <a href={site.url} target="_blank" rel="noreferrer" aria-label={'打开 ' + site.name}>
                  打开<ArrowUpRight />
                </a>
              </Button>
            </>
          ) : (
            <Button asChild variant="outline" size="sm">
              <Link to={detailUrl + (site.canManage ? '?tab=releases' : '')}>
                {site.canManage ? '去发布' : '查看详情'}
              </Link>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={'更多操作：' + site.name} title="更多操作">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to={detailUrl}><MessageSquare />{published ? '查看评论' : '查看详情'}</Link>
              </DropdownMenuItem>
              {(published || site.canManage) && (
                <DropdownMenuItem asChild>
                  <Link to={detailUrl + '?tab=releases'}><Upload />{published ? '发布记录' : '发布 Folio'}</Link>
                </DropdownMenuItem>
              )}
              {site.canManage && (
                <DropdownMenuItem asChild>
                  <Link to={detailUrl + '?tab=settings'}><Settings />作品设置</Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  );
}

export function FoliosPage() {
  const cache = useQueryClient();
  const capability = useQuery({
    queryKey: ['sites-capability'],
    queryFn: () => api<SiteCapabilityInfo>('GET', '/api/sites/capability'),
    refetchInterval: 15000,
  });
  const list = useQuery({
    queryKey: ['sites'],
    queryFn: () => api<SiteInfo[]>('GET', '/api/sites'),
    enabled: capability.data?.enabled === true,
  });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState('authenticated');
  const [params, setParams] = useQueryParams({ q: '', scope: 'all', sort: 'updated', page: '1', pageSize: '20' });
  const query = params.q;
  const scope = params.scope === 'managed' ? 'managed' : 'all';
  const sort: LibrarySort = params.sort === 'created' || params.sort === 'name' ? params.sort : 'updated';
  const requestedPage = Number(params.page);
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize)) ? Number(params.pageSize) : 20;
  const searchInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<LibraryView>(() => {
    try { return localStorage.getItem(viewPreference) === 'list' ? 'list' : 'grid'; }
    catch { return 'grid'; }
  });
  function changeView(next: LibraryView) {
    setView(next);
    try { localStorage.setItem(viewPreference, next); }
    catch { /* Keep the view usable when browser storage is unavailable. */ }
  }
  const items = list.data ?? [];
  const visible = items.filter(
    (site) =>
      (scope !== 'managed' || site.canManage) &&
      `${site.name} ${site.description} ${site.slug}`.toLowerCase().includes(query.trim().toLowerCase()),
  ).sort((a, b) => (sort === 'name'
    ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    : Date.parse(sort === 'created' ? b.createdAt : b.updatedAt) - Date.parse(sort === 'created' ? a.createdAt : a.updatedAt))
    || a.slug.localeCompare(b.slug));
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const page = Math.min(pageCount, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const pageItems = visible.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => {
    if (capability.data?.enabled && list.data && !list.isFetching && params.page !== String(page)) {
      setParams({ page: String(page) });
    }
  }, [capability.data?.enabled, list.data, list.isFetching, params.page, page, setParams]);
  return (
    <Dialog
      open={creating}
      onOpenChange={(open) => {
        if (busy) return;
        if (open) setAccess('authenticated');
        setCreating(open);
      }}
    >
      <div className="folio-surface folio-library">
        <div className="folio-library-heading">
          <h1>Folio</h1>
          <DialogTrigger asChild>
            <Button disabled={!capability.data?.enabled}><Plus />创建 Folio</Button>
          </DialogTrigger>
        </div>
        {capability.isLoading && <p role="status" className="text-sm text-muted-foreground">正在检查发布配置…</p>}
        {capability.data && !capability.data.enabled && (
          <div className="folio-empty">
            <ArrowDownToLine />
            <h2>Folio 发布尚未启用</h2>
            <p>
              请管理员在系统设置中配置 OSS、域名和 HTTPS，并完成启用检查。已有文件、历史版本与评论会保留。
            </p>
          </div>
        )}
        {capability.error && (
          <p role="alert" className="text-destructive">
            {capability.error.message}
          </p>
        )}
        {capability.data?.enabled && (
          <>
            <div className="folio-library-toolbar">
              <div className="folio-filter" role="group" aria-label="Folio 范围">
                <button type="button" aria-pressed={scope === 'all'} onClick={() => setParams({ scope: 'all', page: '1' })}>
                  全部 Folio <span>{items.length}</span>
                </button>
                <button type="button" aria-pressed={scope === 'managed'} onClick={() => setParams({ scope: 'managed', page: '1' })}>
                  我管理的 <span>{items.filter((site) => site.canManage).length}</span>
                </button>
              </div>
              <div className="folio-library-controls">
                <div className="folio-search">
                  <Search aria-hidden="true" />
                  <Input
                    ref={searchInput}
                    aria-label="搜索 Folio" value={query}
                    onChange={(e) => setParams({ q: e.target.value, page: '1' })} placeholder="搜索 Folio…"
                  />
                  {query && (
                    <button type="button" aria-label="清空搜索" title="清空搜索" onClick={() => {
                      setParams({ q: '', page: '1' });
                      searchInput.current?.focus();
                    }}><X /></button>
                  )}
                </div>
                <select className="folio-library-sort" aria-label="Folio 排序" value={sort} onChange={(e) => setParams({ sort: e.target.value, page: '1' })}>
                  <option value="updated">最近更新</option>
                  <option value="created">最近创建</option>
                  <option value="name">名称排序</option>
                </select>
                <div className="folio-view-switch" role="group" aria-label="Folio 视图">
                  <button type="button" aria-label="卡片视图" title="卡片视图" aria-pressed={view === 'grid'} onClick={() => changeView('grid')}><LayoutGrid /></button>
                  <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={view === 'list'} onClick={() => changeView('list')}><List /></button>
                </div>
              </div>
            </div>
            {list.isLoading && (
              <p role="status" className="folio-empty">
                正在读取 Folio…
              </p>
            )}
            {list.error && (
              <div className="folio-empty">
                <p role="alert">{list.error.message}</p>
                <Button variant="outline" onClick={() => void list.refetch()}>
                  重试
                </Button>
              </div>
            )}
            {!list.isLoading && !list.error && !visible.length && (
              <div className="folio-empty">
                <Files />
                <h2>{query || scope !== 'all' ? '没有匹配的 Folio' : '你的下一份作品，从这里开始'}</h2>
                <p>
                  {query || scope !== 'all'
                    ? '试试其他关键词，或查看全部 Folio。'
                    : '创建 Folio 后，上传静态网站目录或 ZIP，即可分享和收集反馈。'}
                </p>
                {query || scope !== 'all' ? (
                  <Button variant="outline" onClick={() => {
                    setParams({ q: '', scope: 'all', page: '1' });
                    searchInput.current?.focus();
                  }}>重置筛选</Button>
                ) : (
                  <DialogTrigger asChild>
                    <Button>
                      <Plus />
                      创建第一个 Folio
                    </Button>
                  </DialogTrigger>
                )}
              </div>
            )}
            {!list.isLoading && !list.error && !!pageItems.length && <div className="folio-library-grid" data-view={view}>
              {pageItems.map((site) => <FolioProject key={site.id} site={site} />)}
            </div>}
            {!list.isLoading && !list.error && (
              <Pagination
                total={visible.length}
                page={page}
                pageSize={pageSize}
                onPageChange={(value) => setParams({ page: String(value) })}
                onPageSizeChange={(value) => setParams({ pageSize: String(value), page: '1' })}
              />
            )}
          </>
        )}
        <DialogContent className="folio-dialog sm:max-w-xl">
          <DialogHeader>
            <div className="folio-dialog-icon">
              <Plus />
            </div>
            <DialogTitle>创建 Folio</DialogTitle>
            <DialogDescription>给作品一个固定地址，之后的每次更新都在这里。</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !capability.data?.enabled) return;
              const data = new FormData(e.currentTarget);
              setBusy(true);
              try {
                await api('POST', '/api/sites', {
                  slug: data.get('slug'),
                  name: data.get('name'),
                  description: data.get('description'),
                  access,
                  password: data.get('password') || undefined,
                  spa: data.get('spa') === 'on',
                });
                setCreating(false);
                void cache.invalidateQueries({ queryKey: ['sites'] });
                toast.success('Folio 已创建，可以上传文件发布');
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy} className="folio-create-fields">
              <label>
                Folio 标识
                <Input
                  name="slug"
                  required
                  maxLength={40}
                  pattern="[a-z0-9][a-z0-9-]*"
                  placeholder="my-folio"
                />
                <small>用于固定访问地址，创建后不可修改。</small>
              </label>
              <label>
                名称
                <Input name="name" required maxLength={100} placeholder="为作品起个名字" />
              </label>
              <label className="folio-field-wide">
                说明
                <Textarea name="description" maxLength={2000} placeholder="简单介绍这份作品…" />
              </label>
              <label className="folio-field-wide">
                访问方式
                <select className="folio-select" value={access} onChange={(e) => setAccess(e.target.value)}>
                  {Object.entries(folioAccessModes).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <small>
                  {access === 'public'
                    ? '任何人都可以浏览，发表评论仍需登录。'
                    : access === 'password'
                      ? '通过密码或免输密码链接访问。'
                      : '只有登录 EAT 的用户可以浏览。'}
                </small>
              </label>
              {access === 'password' && (
                <label className="folio-field-wide">
                  访问密码
                  <Input
                    type="password"
                    name="password"
                    required
                    minLength={4}
                    maxLength={128}
                    autoComplete="new-password"
                    placeholder="至少 4 个字符"
                  />
                </label>
              )}
              <label className="folio-checkbox folio-field-wide">
                <input type="checkbox" name="spa" />
                <span>
                  单页应用路由回退<small>React、Vue 等 SPA 找不到路径时返回首页。</small>
                </span>
              </label>
              <div className="folio-static-note folio-field-wide">
                <Upload />
                <span>仅托管已构建的静态网站，不运行后端或构建命令。</span>
              </div>
              <div className="folio-form-footer folio-field-wide">
                <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                  取消
                </Button>
                <Button type="submit" loading={busy}>
                  {busy ? '正在创建…' : '创建 Folio'}
                </Button>
              </div>
            </fieldset>
          </form>
        </DialogContent>
      </div>
    </Dialog>
  );
}
