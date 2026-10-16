import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { unzipSync } from 'fflate';
import {
  SITE_MAX_BYTES,
  SITE_MAX_FILES,
  siteFileSchema,
  type SiteFile,
  type SiteCapabilityInfo,
  type SiteInfo,
  type SiteVersion,
} from '@eat/shared';
import { toast } from 'sonner';
import { api } from '../api';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Input, Textarea } from '../components/ui/input';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { SiteDiscussion } from './SiteComments';

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm';
const modes: Record<string, string> = { authenticated: '仅登录用户', public: '公开访问', password: '密码访问' };

export function SitesPage() {
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
  return (
    <div className="space-y-5">
      <PageHeader
        title="静态网站"
        description="推送静态文件即可发布，自动分配域名，保留历史版本。"
        actions={
          <Button disabled={!capability.data?.enabled} onClick={() => setCreating(!creating)}>
            创建网站
          </Button>
        }
      />
      {capability.data && !capability.data.enabled && (
        <Card>
          <CardContent className="space-y-2 pt-5">
            <p>静态网站尚未启用，或正在检查配置。</p>
            <p className="text-sm text-muted-foreground">
              请管理员在系统设置中配置 OSS、域名和 HTTPS，并完成启用检查。已有文件、历史版本与评论会保留。
            </p>
          </CardContent>
        </Card>
      )}
      {capability.error && (
        <p role="alert" className="text-destructive">
          {capability.error.message}
        </p>
      )}
      {creating && capability.data?.enabled && (
        <Card>
          <CardContent className="pt-5">
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={async (e) => {
                e.preventDefault();
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
                  toast.success('网站已创建，可以上传首个版本');
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="space-y-1 text-sm">
                网站标识
                <Input name="slug" required maxLength={40} pattern="[a-z0-9][a-z0-9-]*" placeholder="my-site" />
              </label>
              <label className="space-y-1 text-sm">
                名称
                <Input name="name" required maxLength={100} placeholder="网站名称" />
              </label>
              <label className="space-y-1 text-sm sm:col-span-2">
                说明
                <Textarea name="description" maxLength={2000} />
              </label>
              <label className="space-y-1 text-sm">
                访问方式
                <select
                  className={selectClass + ' block w-full'}
                  value={access}
                  onChange={(e) => setAccess(e.target.value)}
                >
                  {Object.entries(modes).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {access === 'password' && (
                <label className="space-y-1 text-sm">
                  访问密码
                  <Input type="password" name="password" required minLength={4} maxLength={128} />
                </label>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="spa" />
                单页应用路由回退
              </label>
              <div className="sm:col-span-2">
                <Button loading={busy}>创建</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {list.isLoading && <p className="text-muted-foreground">正在读取网站…</p>}
      {list.error && (
        <p role="alert" className="text-destructive">
          {list.error.message}
        </p>
      )}
      {capability.data?.enabled && !list.isLoading && !list.error && !list.data?.length && (
        <p className="py-12 text-center text-muted-foreground">创建网站后，即可上传目录或 ZIP 发布。</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {capability.data?.enabled &&
          list.data?.map((s) => (
            <Card key={s.id}>
              <CardContent className="space-y-3 pt-5">
                <div className="flex items-center justify-between gap-2">
                  <Link to={'/sites/' + s.slug} className="font-semibold hover:text-primary">
                    {s.name}
                  </Link>
                  <Badge variant="secondary">{modes[s.access]}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{s.description || s.slug}</p>
                <a
                  className="break-all text-sm text-primary hover:underline"
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {s.url}
                </a>
                <div className="text-xs text-muted-foreground">
                  {s.currentVersionId ? '已发布' : '尚未发布'} · {s.canManage ? '你可以管理' : '可查看与评论'}
                </div>
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  );
}

function base64(content: Uint8Array) {
  let out = '';
  for (let i = 0; i < content.length; i += 8192) out += String.fromCharCode(...content.subarray(i, i + 8192));
  return btoa(out);
}
async function uploadFiles(selection: FileList): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  let total = 0;
  const add = (path: string, bytes: Uint8Array) => {
    total += bytes.length;
    if (total > SITE_MAX_BYTES || files.length >= SITE_MAX_FILES) throw new Error('每次发布最多 2000 个文件、50 MiB');
    files.push(siteFileSchema.parse({ path, content: base64(bytes), encoding: 'base64' }));
  };
  if (selection.length === 1 && selection[0].name.toLowerCase().endsWith('.zip')) {
    if (selection[0].size > SITE_MAX_BYTES) throw new Error('ZIP 文件最多 50 MiB');
    let declared = 0,
      count = 0;
    const entries = unzipSync(new Uint8Array(await selection[0].arrayBuffer()), {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        declared += f.originalSize;
        count++;
        if (declared > SITE_MAX_BYTES || count > SITE_MAX_FILES) throw new Error('ZIP 解压内容超过发布限制');
        siteFileSchema.shape.path.parse(f.name);
        return true;
      },
    });
    for (const [path, bytes] of Object.entries(entries)) add(path, bytes);
  } else {
    for (const f of Array.from(selection)) {
      const path = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
      if (
        path
          .split('/')
          .some((s) => s === '.git' || s === 'node_modules' || /^\.env(?:\.|$)/.test(s) || s === '.DS_Store')
      )
        continue;
      if (total + f.size > SITE_MAX_BYTES) throw new Error('每次发布最多 50 MiB');
      add(path, new Uint8Array(await f.arrayBuffer()));
    }
  }
  if (!files.some((f) => f.path === 'index.html')) throw new Error('目录或 ZIP 根目录必须包含 index.html');
  return files;
}

export function SiteDetailPage() {
  const { slug = '' } = useParams();
  const cache = useQueryClient();
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const detail = useQuery({ queryKey: ['site', slug], queryFn: () => api<SiteInfo>('GET', '/api/sites/' + slug) });
  const headers: Record<string, string> = proof ? { 'x-eat-site-access': proof } : {};
  const versions = useQuery({
    queryKey: ['site-versions', slug, proof],
    queryFn: () => api<SiteVersion[]>('GET', '/api/sites/' + slug + '/versions', undefined, headers),
    retry: false,
  });
  const s = detail.data;
  const versionId = selected || s?.currentVersionId || '';
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['site', slug] });
    void cache.invalidateQueries({ queryKey: ['site-versions', slug] });
    void cache.invalidateQueries({ queryKey: ['sites'] });
  };
  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    setBusy(true);
    try {
      const payload = await uploadFiles(files);
      const v = await api<SiteVersion>('POST', '/api/sites/' + slug + '/releases', { files: payload, message: '' });
      setSelected(v.id);
      refresh();
      toast.success('已发布 v' + v.number);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }
  if (!s) return <p role="status">{detail.error?.message || '正在读取网站…'}</p>;
  return (
    <div className="space-y-5">
      <Link to="/sites" className="text-sm text-muted-foreground hover:underline">
        ← 静态网站
      </Link>
      <PageHeader
        title={s.name}
        description={s.description || s.slug}
        actions={
          <Button asChild variant="outline">
            <a href={s.url} target="_blank" rel="noreferrer">
              打开网站
            </a>
          </Button>
        }
      />
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{modes[s.access]}</Badge>
        <span className="break-all text-sm text-muted-foreground">{s.url}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard
              .writeText(s.url)
              .then(() => toast.success('已复制链接'))
              .catch(() => toast.error('复制失败'))
          }
        >
          复制链接
        </Button>
        {s.canManage && s.access === 'password' && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                const r = await api<{ url: string }>('POST', '/api/sites/' + slug + '/share', {});
                await navigator.clipboard.writeText(r.url);
                toast.success('已复制免输密码链接，有效期 90 天');
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            复制免输密码链接
          </Button>
        )}
      </div>
      {s.canManage && (
        <Card>
          <CardContent className="space-y-4 pt-5">
            <h2 className="font-semibold">发布新版本</h2>
            <p className="text-sm text-muted-foreground">
              上传构建产物，根目录包含 index.html。最多 2000 个文件、50 MiB；历史发布文件完整保留。
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                上传 ZIP
                <input
                  className="block max-w-full text-sm"
                  type="file"
                  accept=".zip"
                  disabled={busy}
                  onChange={upload}
                />
              </label>
              <label className="text-sm">
                上传目录
                <input
                  className="block max-w-full text-sm"
                  type="file"
                  multiple
                  {...({ webkitdirectory: '' } as object)}
                  disabled={busy}
                  onChange={upload}
                />
              </label>
              {busy && (
                <span role="status" className="text-sm">
                  正在上传并发布…
                </span>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-medium">网站设置</summary>
              <form
                key={s.updatedAt}
                className="mt-3 grid gap-3 sm:grid-cols-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  try {
                    await api('PATCH', '/api/sites/' + slug, {
                      name: d.get('name'),
                      description: d.get('description'),
                      access: d.get('access'),
                      password: d.get('password') || undefined,
                      spa: d.get('spa') === 'on',
                    });
                    refresh();
                    toast.success('设置已更新');
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}
              >
                <Input aria-label="网站名称" name="name" required defaultValue={s.name} />
                <select aria-label="访问方式" className={selectClass} name="access" defaultValue={s.access}>
                  {Object.entries(modes).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <Input
                  name="password"
                  type="password"
                  aria-label="新访问密码"
                  minLength={4}
                  maxLength={128}
                  placeholder="新访问密码，留空保持原密码"
                />
                <Textarea aria-label="说明" name="description" defaultValue={s.description} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="spa" defaultChecked={s.spa} />
                  单页应用路由回退
                </label>
                <Button type="submit" size="sm">
                  保存设置
                </Button>
              </form>
            </details>
          </CardContent>
        </Card>
      )}
      {versions.error && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            try {
              const result = await api<{ accessToken: string }>('POST', '/api/sites/' + slug + '/access', {
                password: d.get('password'),
              });
              setProof(result.accessToken);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
        >
          <p className="text-sm">{versions.error.message}</p>
          <Input
            className="w-44"
            aria-label="网站访问密码"
            name="password"
            type="password"
            required
            placeholder="网站访问密码"
          />
          <Button size="sm">验证密码</Button>
        </form>
      )}
      <section className="space-y-3">
        <h2 className="font-semibold">历史版本</h2>
        <div className="overflow-auto rounded-lg border">
          <table className="min-w-[600px] w-full text-left text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-3">版本</th>
                <th className="p-3">内容</th>
                <th className="p-3">发布时间</th>
                <th className="p-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {versions.data?.map((v) => (
                <tr key={v.id} className="border-t">
                  <td className="p-3">
                    v{v.number}
                    {s.currentVersionId === v.id && (
                      <Badge className="ml-2" variant="secondary">
                        当前
                      </Badge>
                    )}
                  </td>
                  <td className="p-3">
                    {v.fileCount} 个文件 · {(v.totalBytes / 1024).toFixed(1)} KiB{v.message && <p>{v.message}</p>}
                  </td>
                  <td className="whitespace-nowrap p-3">{new Date(v.createdAt).toLocaleString()}</td>
                  <td className="p-3">
                    <div className="flex gap-2">
                      <a className="text-primary" href={v.url} target="_blank" rel="noreferrer">
                        打开
                      </a>
                      <button className="text-primary" onClick={() => setSelected(v.id)}>
                        查看评论
                      </button>
                      {s.canManage && s.currentVersionId !== v.id && (
                        <button
                          className="text-primary"
                          onClick={async () => {
                            try {
                              await api('POST', '/api/sites/' + slug + '/activate', { versionId: v.id });
                              refresh();
                              toast.success('已切换到 v' + v.number);
                            } catch (e) {
                              toast.error((e as Error).message);
                            }
                          }}
                        >
                          设为当前
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!versions.data?.length && !versions.error && <p className="text-sm text-muted-foreground">尚未发布版本。</p>}
      </section>
      {versionId && (
        <Card>
          <CardContent className="pt-5">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">浏览上下文</span>
              <select
                className={selectClass}
                aria-label="评论浏览版本"
                value={versionId}
                onChange={(e) => setSelected(e.target.value)}
              >
                {versions.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.number}
                  </option>
                ))}
              </select>
            </div>
            <SiteDiscussion key={slug} slug={slug} versionId={versionId} initialProof={proof} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function SiteAuthorizePage() {
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  const started = useRef(false);
  // 防止 StrictMode / 重渲染重复创建授权票据；只接受服务端校验后返回的站点地址。
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const slug = params.get('site'),
      returnUrl = params.get('returnUrl');
    if (!slug || !returnUrl) setError('网站登录地址不完整');
    else
      void api<{ url: string }>('POST', '/api/sites/' + encodeURIComponent(slug) + '/authorize', { returnUrl })
        .then((r) => location.replace(r.url))
        .catch((e) => setError(e.message));
  }, []);
  return <p role="status">{error || '正在验证网站访问身份…'}</p>;
}
