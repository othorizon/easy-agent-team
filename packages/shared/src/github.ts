import { z } from 'zod';

export const githubRoleSchema = z.enum(['read', 'triage', 'write', 'maintain', 'admin']);
export type GithubRole = z.infer<typeof githubRoleSchema>;
export const githubSettingsSchema = z.object({
  enabled: z.boolean(), organization: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
  appId: z.string().regex(/^\d+$/), clientId: z.string().trim().min(1).max(200),
  installationId: z.string().regex(/^\d+$/),
  clientSecret: z.string().max(2000).optional(), privateKey: z.string().max(20000).optional(),
});
export type UpdateGithubSettings = z.infer<typeof githubSettingsSchema>;
export const githubSetupSchema = z.object({
  organization: githubSettingsSchema.shape.organization,
  name: z.string().trim().min(1).max(100),
  replaceExisting: z.boolean().default(false),
});
export type GithubSetupRequest = z.infer<typeof githubSetupSchema>;
export type GithubConnectionState = 'unconfigured' | 'app_ready' | 'connected' | 'uninstalled' | 'app_unavailable' | 'error';
export interface GithubSetupStart {
  url: string;
  manifest: Record<string, unknown>;
}
export interface GithubSettingsInfo {
  enabled: boolean; organization: string; appId: string; clientId: string; installationId: string;
  hasClientSecret: boolean; hasPrivateKey: boolean; callbackUrl: string;
  setupCallbackUrl: string; manifestCallbackUrl: string; appSlug: string | null;
  connectionState: GithubConnectionState; connectionError: string; checkedAt: string | null;
}
export type GithubOrgState = 'unknown' | 'absent' | 'pending' | 'processing' | 'active';
export interface GithubAccountInfo {
  enabled: boolean; organization: string; linked: boolean; login: string | null;
  needsAuthorization: boolean; orgState: GithubOrgState; orgRole: string | null;
  checkedAt: string | null; error: string; task: GithubTaskInfo | null;
}
export interface GithubTaskInfo {
  state: string; error: string; attempts: number; notification: string;
}
export interface GithubMemberInfo {
  userId: string; name: string; login: string | null; orgState: GithubOrgState;
  role: GithubRole | 'none' | 'unknown'; state: string; error: string;
  notification: string; canGrant: boolean; canChangeRole: boolean;
  isOwner?: boolean; needsAuthorization?: boolean;
  roleError?: string; roleCheckedAt?: string | null;
  operation?: 'grant' | 'role';
  /** Cached identity generation; never used as an authorization credential. */
  bindingVersion?: string;
}
export interface GithubAppInfo {
  enabled: boolean; organization: string; repository: string | null; repositoryId: string | null;
  scope: 'organization' | 'outside' | 'unknown'; checkedAt: string | null; error: string;
  ownerLogin: string | null; ownerRole: GithubRole | 'none' | 'unknown'; ownerIsOrgOwner: boolean;
  members: GithubMemberInfo[];
}

export interface GithubCollaborator {
  githubId: string; login: string; role: GithubRole | 'unknown'; roleError: string; direct: boolean;
  userId: string | null; name: string | null; relation: 'owner' | 'member' | 'eat' | 'external';
}
export interface GithubCollaboratorsInfo {
  repository: string; repositoryId: string; repoVersion: number; checkedAt: string;
  canManage: boolean; collaborators: GithubCollaborator[];
}
export const githubCollaboratorChangeSchema = z.object({
  repositoryId: z.string().regex(/^\d+$/), repoVersion: z.number().int().positive(),
  expectedRole: githubRoleSchema,
  // null explicitly removes direct access; it is never treated as an invitation or an EAT member removal.
  role: githubRoleSchema.nullable(),
});
export type GithubCollaboratorChange = z.infer<typeof githubCollaboratorChangeSchema>;
