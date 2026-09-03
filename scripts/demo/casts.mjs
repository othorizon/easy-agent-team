/**
 * CLI 录屏脚本（cast 定义）：每条 step 都是一条**真实执行**的命令，输出不做任何加工。
 * 录制用 scripts/demo/record-cli.mjs，渲染成 GIF 用 scripts/demo/render-cast.mjs。
 *
 * 约定：
 *   - home / cwd 用真实存在的路径（/home/<用户>/...），命令输出里的路径就是它本来的样子；
 *   - `during` 是命令执行**过程中**别人做的事（比如另一个人在浏览器里点了同意）；
 *   - `after` 是命令结束后、下一条命令之前别人做的事（比如 Owner 批了申请、被求助者回了消息）；
 *   - `rows` 是窗口高度上限（行），渲染时按最高的一帧收窄，所以给宽松些没坏处。
 *
 * 有先后依赖：onboard 会登录（后面的 cast 都用它留下的凭证），deploy-fail 要求仓库
 * HEAD 停在那个跑不起来的提交上，deploy-ok 里的 `git revert` 才有东西可 revert。
 */

const PLATFORM = process.env.EAT_DEMO_PLATFORM ?? 'http://eat.internal.example.com';

export const CASTS = {
  /** 新同事从零开始：登录 → 把团队的 Skill 与 MCP 配置同步到本地 AI */
  onboard: {
    title: '吴敏 — 新同事的第一天',
    home: '/home/wumin',
    cwd: '/home/wumin',
    rows: 32,
    resetCredentials: true,
    steps: [
      {
        cmd: `eat login --server ${PLATFORM}`,
        during: { at: 2500, action: 'approveDevice', as: 'wumin' },
      },
      { cmd: 'eat sync' },
      { cmd: 'ls ~/.claude/skills' },
    ],
  },

  /** 缺权限：清单看得见、值看不见 → 自己发起申请 → 批了之后再拉 */
  permissions: {
    title: '吴敏 — 缺一组上传凭证',
    home: '/home/wumin',
    cwd: '/home/wumin/work/campaign-page',
    rows: 34,
    steps: [
      { cmd: 'eat env list oss-storage' },
      { cmd: 'eat env pull oss-storage' },
      {
        cmd: 'eat env request oss-storage OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET --reason "活动页要把 30 张素材传到 team-assets-prod，只写 /campaign/1111/ 前缀"',
        after: { action: 'approveAccessRequest', as: 'liwei', environment: 'oss-storage' },
      },
      { cmd: 'eat env pull oss-storage' },
      { cmd: 'cat .env' },
    ],
  },

  /** 缺信息：AI 直接找 Skill 的作者问，答复回来了继续干活 */
  ask: {
    title: '吴敏 — 让 AI 自己去问人',
    home: '/home/wumin',
    cwd: '/home/wumin/work/campaign-page',
    rows: 34,
    steps: [
      { cmd: 'eat ask targets' },
      {
        cmd: 'eat ask create --skill crm-data-query --title "活动页的报名转化率怎么算才和运营后台一致？" --description "按有效订单口径算出来的转化率比运营后台低 0.8 个点，不确定分母该用 PV 还是 UV。" --tried "读过 crm-data-query 里的有效订单定义；分母分别用 PV / UV 算过，两个都对不上。"',
        after: {
          action: 'replyHelp',
          as: 'zhengnan',
          message:
            '分母用 UV，而且是活动落地页的 UV、不是全站 UV。运营后台那个数还去掉了内部 IP（我们自己人反复刷的量），去掉之后就对上了。去重口径我补进 crm-data-query。',
        },
      },
      { cmd: 'eat ask list' },
    ],
  },

  /** 部署门禁：本地扫描认出与平台密钥指纹匹配的字符串，直接不让部署 */
  'deploy-gate': {
    title: '孙浩 — 差点把密钥推上去',
    home: '/home/sunhao',
    cwd: '/home/sunhao/work/crm-dashboard',
    rows: 32,
    setup: { loginAs: 'sunhao', run: ['eat sync', 'git reset -q', 'git checkout -- .', 'git clean -qfd'] },
    steps: [
      { cmd: 'eat env pull internal-api --keys INTERNAL_API_TOKEN' },
      { cmd: 'git add -A && git status --short' },
      { cmd: 'eat deploy crm-dashboard' },
      { cmd: 'git rm -q --cached .env && echo .env >> .gitignore && rm .env' },
      { cmd: 'eat scan' },
    ],
  },

  /** 部署失败：平台里直接看到构建的真实报错，不用登部署后台翻日志 */
  'deploy-fail': {
    title: '孙浩 — 构建挂了',
    home: '/home/sunhao',
    cwd: '/home/sunhao/work/crm-dashboard',
    rows: 44,
    // 上一条 cast 在工作区里留了 .gitignore 与暂存区改动，先复位
    setup: { run: ['git reset -q', 'git checkout -- .', 'git clean -qfd'] },
    steps: [
      { cmd: 'eat deploy crm-dashboard' },
      { cmd: 'eat app build-logs crm-dashboard --tail 10' },
    ],
  },

  /** 修好再上：一条命令部署，成功后看状态与容器运行日志 */
  'deploy-ok': {
    title: '孙浩 — 修好，上线',
    home: '/home/sunhao',
    cwd: '/home/sunhao/work/crm-dashboard',
    rows: 32,
    steps: [
      { cmd: 'git revert --no-edit HEAD && git push -q origin main' },
      { cmd: 'eat deploy crm-dashboard' },
      { cmd: 'eat app status crm-dashboard' },
      { cmd: 'eat app run-logs crm-dashboard --tail 3' },
    ],
  },
};
