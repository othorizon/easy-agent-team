import { githubRepoWebUrl } from '@eat/shared';
import { describe, expect, it } from 'vitest';

// githubRepoWebUrl 住在 packages/shared（控制台用它），shared 自己没有测试跑器，照 frontmatter.spec.ts 的先例放在这里。
describe('githubRepoWebUrl：GitHub 地址解析成仓库网页', () => {
  const web = 'https://github.com/acme/crm-dashboard';

  it.each([
    ['scp 式 SSH', 'git@github.com:acme/crm-dashboard.git'],
    ['scp 式 SSH 不带 .git', 'git@github.com:acme/crm-dashboard'],
    ['scp 式 SSH 冒号后多个斜杠', 'git@github.com:/acme/crm-dashboard.git'],
    ['ssh:// 形式', 'ssh://git@github.com/acme/crm-dashboard.git'],
    ['ssh:// 带端口', 'ssh://git@github.com:22/acme/crm-dashboard.git'],
    ['git+ssh://', 'git+ssh://git@github.com/acme/crm-dashboard.git'],
    ['https 带 .git', 'https://github.com/acme/crm-dashboard.git'],
    ['http', 'http://github.com/acme/crm-dashboard'],
    ['https 带 user:token@', 'https://oauth2:ghp_xxx@github.com/acme/crm-dashboard.git'],
    ['https 尾部斜杠', 'https://github.com/acme/crm-dashboard/'],
    ['直接贴的网页地址（子路径）', 'https://github.com/acme/crm-dashboard/tree/main/apps'],
    ['带 query / fragment', 'https://github.com/acme/crm-dashboard.git?ref=main#readme'],
    ['git:// 协议', 'git://github.com/acme/crm-dashboard.git'],
    ['www. 前缀 + 大写主机', 'https://WWW.GitHub.com/acme/crm-dashboard.git'],
    ['不带协议', 'github.com/acme/crm-dashboard'],
    ['前后空白', '  git@github.com:acme/crm-dashboard.git\n'],
  ])('%s', (_label, input) => {
    expect(githubRepoWebUrl(input)).toBe(web);
  });

  it('owner / 仓库名原样保留大小写与合法字符（GitHub 自己不区分大小写、会重定向）', () => {
    expect(githubRepoWebUrl('git@github.com:Acme-Inc/My.Repo_v2.git')).toBe('https://github.com/Acme-Inc/My.Repo_v2');
  });

  it.each([
    ['空串', ''],
    ['纯空白', '   '],
    ['自建 Git 服务 SSH', 'git@git.example.com:team/crm.git'],
    ['自建 Git 服务 https', 'https://git.example.com/team/crm.git'],
    ['GitLab', 'https://gitlab.com/acme/crm-dashboard.git'],
    ['gist 不是仓库', 'https://gist.github.com/acme/abc123'],
    ['形似的其他主机', 'https://github.com.evil.example/acme/crm-dashboard'],
    ['只有主机', 'https://github.com'],
    ['只有 owner', 'https://github.com/acme'],
    ['只有 owner 带尾斜杠', 'git@github.com:acme/'],
    ['owner 含非法字符', 'https://github.com/ac me/crm'],
    ['仓库名是 ..', 'https://github.com/acme/..'],
    ['本地路径', '/srv/git/crm.git'],
    ['Windows 路径', 'C:\\repos\\crm'],
  ])('非 GitHub 或解析不出仓库 → null：%s', (_label, input) => {
    expect(githubRepoWebUrl(input)).toBeNull();
  });
});
