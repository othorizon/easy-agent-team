import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { unzipSync } from 'fflate';
import {
  SITE_MAX_BYTES,
  SITE_MAX_FILES,
  siteFileSchema,
  type SiteFile,
  type SiteInfo,
  type SiteVersion,
} from '@eat/shared';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FolderUp,
  History,
  MessageSquare,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../api';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Input, Textarea } from '../components/ui/input';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { FolioDiscussion } from './FolioComments';
import { FolioAccess, FolioConnectionState, FolioMark, folioAccessModes } from './folios/folio-ui';
import './folios/folio.css';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm';
const modes = folioAccessModes;

export { FoliosPage } from './folios/FolioLibrary';

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
    if (total > SITE_MAX_BYTES || files.length >= SITE_MAX_FILES)
      throw new Error('每次发布最多 2000 个文件、50 MiB');
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

export function FolioDetailPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const cache = useQueryClient();
  const [proof, setProof] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restore, setRestore] = useState<SiteVersion | null>(null);
  const [commentVersion, setCommentVersion] = useState<SiteVersion | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const detail = useQuery({
    queryKey: ['site', slug],
    queryFn: () => api<SiteInfo>('GET', '/api/sites/' + slug),
  });
  const headers: Record<string, string> = proof ? { 'x-eat-site-access': proof } : {};
  const versions = useQuery({
    queryKey: ['site-versions', slug, proof],
    queryFn: () => api<SiteVersion[]>('GET', '/api/sites/' + slug + '/versions', undefined, headers),
    enabled: !!detail.data,
    retry: false,
  });
  const s = detail.data;
  const tab =
    params.get('tab') === 'releases'
      ? 'releases'
      : params.get('tab') === 'settings' && s?.canManage
        ? 'settings'
        : 'comments';
  function changeTab(value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === 'comments') next.delete('tab');
      else {
        next.set('tab', value);
        next.delete('thread');
      }
      return next;
    });
  }
  useEffect(() => {
    setProof('');
    setCommentVersion(null);
  }, [slug]);
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['site', slug] });
    void cache.invalidateQueries({ queryKey: ['site-versions', slug] });
    void cache.invalidateQueries({ queryKey: ['sites'] });
  };
  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const files = input.files;
    if (!files?.length || busy) return;
    setBusy(true);
    try {
      const payload = await uploadFiles(files);
      await api<SiteVersion>('POST', '/api/sites/' + slug + '/releases', { files: payload, message: '' });
      refresh();
      setPublishing(false);
      toast.success('Folio 已发布，访问链接保持不变');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      input.value = '';
    }
  }
  if (!s) return <p role={detail.error ? 'alert' : 'status'}>{detail.error?.message || '正在读取 Folio…'}</p>;
  return (
    <div className="folio-surface folio-detail">
      <Link to="/folios" className="folio-back">
        <ArrowLeft className="size-4" /> Folio
      </Link>
      <div className="folio-heading">
        <FolioMark />
        <PageHeader
          title={s.name}
          description={s.description || s.slug}
          actions={
            <>
              {s.currentVersionId && (
                <Button asChild variant="outline">
                  <a href={s.url} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    打开 Folio
                  </a>
                </Button>
              )}
              {s.canManage && (
                <Button onClick={() => setPublishing(true)}>
                  <Upload />
                  {s.currentVersionId ? '发布新版' : '发布 Folio'}
                </Button>
              )}
            </>
          }
        />
      </div>
      <div className="folio-linkbar">
        <span className={s.currentVersionId ? 'folio-status' : 'folio-status folio-status-draft'}>
          <i />
          {s.currentVersionId ? '已发布' : '待发布'}
        </span>
        <FolioAccess access={s.access} />
        <a className="folio-link-url" href={s.url} target="_blank" rel="noreferrer">
          {s.url}
        </a>
        <Button
          variant="outline"
          disabled={!s.currentVersionId}
          onClick={() =>
            void navigator.clipboard
              .writeText(s.url)
              .then(() => toast.success('已复制 Folio 链接'))
              .catch(() => toast.error('复制失败'))
          }
        >
          <Copy />
          复制链接
        </Button>
        {s.canManage && s.access === 'password' && s.currentVersionId && (
          <Button
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
      <Tabs value={tab} onValueChange={changeTab} className="folio-detail-tabs">
        <TabsList aria-label="Folio 详情" className="folio-tabs">
          <TabsTrigger value="comments">
            <MessageSquare className="size-4" />
            评论
          </TabsTrigger>
          <TabsTrigger value="releases">
            <History className="size-4" />
            发布记录
          </TabsTrigger>
          {s.canManage && (
            <TabsTrigger value="settings">
              <Settings className="size-4" />
              设置
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="comments" forceMount hidden={tab !== 'comments'}>
          {s.currentVersionId ? (
            <Card className="folio-discussion-card">
              <CardContent className="folio-discussion-body">
                {commentVersion && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
                    <span>正在查看发布记录 v{commentVersion.number} 的评论</span>
                    <Button variant="outline" onClick={() => setCommentVersion(null)}>
                      返回全部评论
                    </Button>
                  </div>
                )}
                <FolioDiscussion
                  key={slug}
                  slug={slug}
                  versionId={s.currentVersionId}
                  initialProof={proof}
                  filterVersionId={commentVersion?.id}
                  siteUrl={s.url}
                  onAccessVerified={setProof}
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <MessageSquare className="size-8 text-muted-foreground" />
                <h2 className="font-medium">发布 Folio，开始收集反馈</h2>
                <p className="text-sm text-muted-foreground">发布后，访客可以直接评论或标注内容。</p>
                {s.canManage && (
                  <Button onClick={() => setPublishing(true)}>
                    <Upload />
                    发布 Folio
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="releases" className="folio-releases space-y-5">
          <PageHeader
            title="发布记录"
            description="每次发布后 Folio 链接保持不变。需要时可查看历史内容或恢复某次发布。"
          />
          {versions.isLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              正在读取发布记录…
            </p>
          )}
          {versions.error && (
            <div className="space-y-3 rounded-lg border p-4">
              <p role="alert" className="text-sm text-destructive">
                {versions.error.message}
              </p>
              {s.access === 'password' && !s.canManage ? (
                <SiteAccessForm slug={slug} onVerified={setProof} />
              ) : (
                <Button variant="outline" onClick={() => void versions.refetch()}>
                  重试
                </Button>
              )}
            </div>
          )}
          {!!versions.data?.length && (
            <div className="folio-release-table overflow-x-auto">
              <table className="w-full min-w-[600px] text-left text-sm">
                <caption className="sr-only">Folio 发布记录</caption>
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-4">发布版本</th>
                    <th className="p-4">内容</th>
                    <th className="p-4">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.data.map((v) => (
                    <tr key={v.id} className="border-t">
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-base font-medium">v{v.number}</span>
                          {s.currentVersionId === v.id && <Badge variant="secondary">当前在线</Badge>}
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {new Date(v.createdAt).toLocaleString()}
                        </p>
                      </td>
                      <td className="p-4">
                        <p className="max-w-sm break-words font-medium">{v.message || '发布 v' + v.number}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {v.fileCount} 个文件 · {(v.totalBytes / 1024).toFixed(1)} KiB
                        </p>
                      </td>
                      <td className="p-4">
                        <div className="flex flex-wrap gap-2">
                          <Button asChild variant="outline" size="sm">
                            <a href={v.url} target="_blank" rel="noreferrer">
                              预览 Folio
                              <ExternalLink />
                            </a>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setCommentVersion(v);
                              changeTab('comments');
                            }}
                          >
                            相关评论
                          </Button>
                          {s.canManage && s.currentVersionId !== v.id && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={restoring}
                              onClick={() => setRestore(v)}
                            >
                              恢复此发布
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!versions.isLoading && !versions.data?.length && !versions.error && (
            <p className="rounded-xl border py-12 text-center text-sm text-muted-foreground">
              尚无发布记录，上传 Folio 文件后会显示在这里。
            </p>
          )}
        </TabsContent>
        {s.canManage && (
          <TabsContent value="settings" className="folio-settings-layout">
            <FolioSettingsForm key={s.id + s.updatedAt} folio={s} onSaved={refresh} />
            <FolioDelete folio={s} disabled={busy || restoring} />
          </TabsContent>
        )}
      </Tabs>
      <Dialog
        open={publishing}
        onOpenChange={(open) => {
          if (!busy) setPublishing(open);
        }}
      >
        <DialogContent className="folio-dialog folio-publish-dialog">
          <DialogHeader>
            <div className="folio-dialog-icon">
              <Upload />
            </div>
            <DialogTitle>{s.currentVersionId ? '发布新版' : '发布 Folio'}</DialogTitle>
            <DialogDescription>上传构建好的静态网站，发布后固定链接自动展示新版。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="folio-upload-zone">
              <Upload className="mx-auto mb-3 size-7 text-muted-foreground" />
              <p className="mb-4 text-sm">把准备好的作品，发布给大家</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button disabled={busy} onClick={() => zipInput.current?.click()}>
                  <Upload />
                  选择 ZIP
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => directoryInput.current?.click()}>
                  <FolderUp />
                  选择文件夹
                </Button>
              </div>
              <input
                ref={zipInput}
                aria-label="上传 ZIP"
                className="hidden"
                type="file"
                accept=".zip"
                disabled={busy}
                onChange={upload}
              />
              <input
                ref={directoryInput}
                aria-label="上传目录"
                className="hidden"
                type="file"
                multiple
                {...({ webkitdirectory: '' } as object)}
                disabled={busy}
                onChange={upload}
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              根目录需包含 index.html，最多 2000 个文件、50
              MiB。仅托管静态网站，不执行构建或服务端代码。发布成功后历史内容和评论会保留。
            </p>
            {busy && (
              <p role="status" className="text-sm">
                正在上传并发布，请稍候…
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!restore}
        onOpenChange={(open) => {
          if (!open) setRestore(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>恢复这次发布？</AlertDialogTitle>
            <AlertDialogDescription>
              Folio 链接将展示 {restore && new Date(restore.createdAt).toLocaleString()}{' '}
              发布的内容。所有发布记录和评论都会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!restore) return;
                setRestoring(true);
                try {
                  await api('POST', '/api/sites/' + slug + '/activate', { versionId: restore.id });
                  refresh();
                  toast.success('已恢复，Folio 链接现在展示所选内容');
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setRestoring(false);
                }
              }}
            >
              恢复发布
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SiteAccessForm({ slug, onVerified }: { slug: string; onVerified: (proof: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setBusy(true);
        try {
          const result = await api<{ accessToken: string }>('POST', '/api/sites/' + slug + '/access', {
            password: data.get('password'),
          });
          onVerified(result.accessToken);
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input
        className="w-52"
        aria-label="Folio 访问密码"
        name="password"
        type="password"
        required
        placeholder="输入 Folio 访问密码"
      />
      <Button loading={busy}>验证密码</Button>
    </form>
  );
}

function FolioDelete({ folio: s, disabled }: { folio: SiteInfo; disabled: boolean }) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setError('');
    try {
      const result = await api<{ ok: boolean; cleanupFailed: boolean }>('DELETE', '/api/sites/' + s.slug);
      await cache.cancelQueries({ queryKey: ['sites'] });
      cache.setQueryData<SiteInfo[]>(['sites'], (previous) => previous?.filter((site) => site.id !== s.id));
      void cache.invalidateQueries({ queryKey: ['sites'] });
      setOpen(false);
      navigate('/folios', { replace: true });
      cache.removeQueries({ queryKey: ['site', s.slug] });
      cache.removeQueries({ queryKey: ['site-versions', s.slug] });
      if (result.cleanupFailed) toast.warning('Folio 已删除，但部分发布文件清理失败，请联系管理员处理');
      else toast.success('Folio 已删除');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }
  return (
    <>
      <Card className="folio-danger">
        <CardContent className="space-y-4 pt-5">
          <div>
            <h2 className="font-semibold">删除 Folio</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              永久删除此 Folio、全部发布记录、文件和评论。所有访问链接将失效，删除后无法恢复。
            </p>
          </div>
          <Button
            variant="outline-destructive"
            disabled={disabled || deleting}
            onClick={() => {
              setError('');
              setOpen(true);
            }}
          >
            <Trash2 />
            删除 Folio
          </Button>
        </CardContent>
      </Card>
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!deleting) setOpen(value);
        }}
      >
        <AlertDialogContent aria-busy={deleting}>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">永久删除「{s.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除此 Folio
              的全部发布记录、文件、评论和回复。固定链接、历史版本链接和分享链接都会失效，此操作无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              destructive
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              {deleting ? '正在删除…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function FolioSettingsForm({ folio: s, onSaved }: { folio: SiteInfo; onSaved: () => void }) {
  const [access, setAccess] = useState(s.access);
  const [saving, setSaving] = useState(false);
  return (
    <Card className="folio-settings-panel">
      <CardContent className="pt-5">
        <form
          className="folio-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            const d = new FormData(e.currentTarget);
            setSaving(true);
            try {
              await api('PATCH', '/api/sites/' + s.slug, {
                name: d.get('name'),
                description: d.get('description'),
                access,
                password: access === 'password' ? d.get('password') || undefined : undefined,
                spa: d.get('spa') === 'on',
              });
              onSaved();
              toast.success('设置已保存');
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="folio-settings-title">
            <h2 className="font-semibold">Folio 设置</h2>
            <p className="mt-1 text-sm text-muted-foreground">管理 Folio 信息和访问权限。</p>
          </div>
          <label className="block space-y-2 text-sm">
            <span>Folio 名称</span>
            <Input name="name" required maxLength={100} defaultValue={s.name} />
          </label>
          <label className="block space-y-2 text-sm">
            <span>Folio 说明</span>
            <Textarea name="description" maxLength={2000} defaultValue={s.description} />
          </label>
          <div className="folio-settings-section">
            <h3>访问权限</h3>
            <label className="block space-y-2 text-sm">
              <span>谁可以访问</span>
              <select
                className={selectClass + ' block w-full'}
                value={access}
                onChange={(e) => setAccess(e.target.value as SiteInfo['access'])}
              >
                {Object.entries(modes).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              {access === 'public'
                ? '任何人都可浏览，发表评论仍需登录 EAT。'
                : access === 'password'
                  ? '访客需要输入密码，或通过免输密码链接访问。'
                  : '仅已登录 EAT 的用户可以浏览和评论。'}
            </p>
            {access === 'password' && (
              <label className="block space-y-2 text-sm">
                <span>{s.access === 'password' ? '更换访问密码' : '访问密码'}</span>
                <Input
                  name="password"
                  type="password"
                  required={s.access !== 'password'}
                  minLength={4}
                  maxLength={128}
                  autoComplete="new-password"
                  placeholder={s.access === 'password' ? '留空保留原密码' : '至少 4 个字符'}
                />
              </label>
            )}
          </div>
          <label className="folio-checkbox folio-routing">
            <input className="mt-1" type="checkbox" name="spa" defaultChecked={s.spa} />
            <span>
              单页应用路由回退
              <span className="mt-1 block text-xs text-muted-foreground">
                适用于 React、Vue 等应用；找不到路径时返回首页。
              </span>
            </span>
          </label>
          <div className="folio-settings-save">
            <p>变更访问方式或密码后，旧的分享凭据将失效。</p>
            <Button loading={saving} type="submit">
              保存设置
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function FolioAuthorizePage() {
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  const started = useRef(false);
  // 防止 StrictMode / 重渲染重复创建授权票据；只接受服务端校验后返回的 Folio 地址。
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const slug = params.get('folio'),
      returnUrl = params.get('returnUrl');
    if (!slug || !returnUrl) setError('Folio 登录地址不完整');
    else
      void api<{ url: string }>('POST', '/api/sites/' + encodeURIComponent(slug) + '/authorize', {
        returnUrl,
      })
        .then((r) => location.replace(r.url))
        .catch((e) => setError(e.message));
  }, []);
  return <FolioConnectionState error={error} message="正在验证 Folio 访问身份…" />;
}
