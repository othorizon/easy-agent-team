import { Files, Globe2, LockKeyhole, Users, Loader2, ShieldAlert } from 'lucide-react';
import type { SiteInfo } from '@eat/shared';

export const folioAccessModes: Record<string, string> = {
  authenticated: '仅登录用户',
  public: '公开访问',
  password: '密码访问',
};

export function FolioAccess({ access }: { access: SiteInfo['access'] }) {
  const Icon = access === 'public' ? Globe2 : access === 'password' ? LockKeyhole : Users;
  return (
    <span className="folio-access">
      <Icon aria-hidden="true" />
      {folioAccessModes[access]}
    </span>
  );
}

export function FolioMark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? 'folio-mark folio-mark-small' : 'folio-mark'}>
      <Files aria-hidden="true" />
    </span>
  );
}

export function FolioConnectionState({ error, message }: { error: string; message: string }) {
  return (
    <div className="folio-connection">
      <div className="folio-connection-icon">
        {error ? <ShieldAlert /> : <Loader2 className="animate-spin" />}
      </div>
      <h1>{error ? '暂时无法连接' : '正在验证访问身份'}</h1>
      <p role={error ? 'alert' : 'status'}>{error || message}</p>
      {error && <a href="/folios">返回 Folio</a>}
    </div>
  );
}
