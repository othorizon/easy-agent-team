import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDownToLine, ArrowUpRight, Files, Plus, Search, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { SiteCapabilityInfo, SiteInfo } from '@eat/shared';
import { api } from '../../api';
import { PageHeader } from '../../components/page-header';
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
import { FolioAccess, folioAccessModes, FolioMark } from './folio-ui';
import './folio.css';

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
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const items = list.data ?? [];
  const visible = items.filter(
    (site) =>
      (scope !== 'managed' || site.canManage) &&
      `${site.name} ${site.description} ${site.slug}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
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
        <div className="folio-heading">
          <FolioMark />
          <PageHeader
            title="Folio"
            description="发布作品，分享想法，让反馈发生。"
            actions={
              <DialogTrigger asChild>
                <Button disabled={!capability.data?.enabled}>
                  <Plus />
                  创建 Folio
                </Button>
              </DialogTrigger>
            }
          />
        </div>
        <div className="folio-library-intro">
          <span>
            <Files />
            网页、演示与报告的共享空间
          </span>
          <span>静态网站 · 版本记录 · 页面批注</span>
        </div>
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
                <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
                  全部 Folio <span>{items.length}</span>
                </button>
                <button type="button" aria-pressed={scope === 'managed'} onClick={() => setScope('managed')}>
                  我管理的 <span>{items.filter((site) => site.canManage).length}</span>
                </button>
              </div>
              <label className="folio-search">
                <Search aria-hidden="true" />
                <Input
                  aria-label="搜索 Folio"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索名称、标识或说明…"
                />
              </label>
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
                {!query && scope === 'all' && (
                  <DialogTrigger asChild>
                    <Button>
                      <Plus />
                      创建第一个 Folio
                    </Button>
                  </DialogTrigger>
                )}
              </div>
            )}
            <div className="folio-library-grid">
              {visible.map((site) => (
                <article className="folio-project" key={site.id}>
                  <div className="folio-project-top">
                    <FolioMark small />
                    <span
                      className={site.currentVersionId ? 'folio-status' : 'folio-status folio-status-draft'}
                    >
                      <i />
                      {site.currentVersionId ? '已发布' : '待发布'}
                    </span>
                  </div>
                  <h2>
                    <Link to={'/folios/' + site.slug}>{site.name}</Link>
                  </h2>
                  <p className="folio-project-description">{site.description || '还没有添加作品说明。'}</p>
                  <a className="folio-project-url" href={site.url} target="_blank" rel="noreferrer">
                    {site.slug}
                    <ArrowUpRight />
                  </a>
                  <div className="folio-project-footer">
                    <FolioAccess access={site.access} />
                    <Link
                      className="folio-project-action"
                      to={'/folios/' + site.slug}
                      aria-label={(site.canManage ? '管理 ' : '查看 ') + site.name}
                    >
                      {site.canManage ? '管理作品' : '查看评论'}
                      <ArrowUpRight />
                    </Link>
                  </div>
                  <div className="folio-project-date">
                    更新于{' '}
                    {new Date(site.updatedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
                  </div>
                </article>
              ))}
            </div>
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
