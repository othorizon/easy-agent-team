import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('user', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['admin', 'member'] })
    .notNull()
    .default('member'),
  passwordHash: text('password_hash').notNull(),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiTokens = pgTable(
  'api_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: ['web', 'cli'] }).notNull().default('cli'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_token_hash_idx').on(t.tokenHash)],
);

/** 设备码授权流的中间状态，短生命周期 */
export const deviceAuths = pgTable(
  'device_auth',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceCodeHash: text('device_code_hash').notNull(),
    userCode: text('user_code').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'delivered', 'expired'] })
      .notNull()
      .default('pending'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** 授权后暂存的 Token（KEK 加密），CLI 轮询取走后即清空 */
    issuedTokenEncrypted: text('issued_token_encrypted'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('device_auth_code_idx').on(t.deviceCodeHash),
    uniqueIndex('device_auth_user_code_idx').on(t.userCode),
  ],
);

export const environments = pgTable('environment', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  source: text('source', { enum: ['manual', 'db_assignment'] })
    .notNull()
    .default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const envVariables = pgTable(
  'env_variable',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** 敏感变量的加密值；非敏感变量此列为空 */
    valueEncrypted: text('value_encrypted'),
    /** 非敏感变量的明文值（secret=false 时使用，平台上可直接查看） */
    valuePlain: text('value_plain'),
    /** 是否敏感：敏感值加密存储、读取需授权并审计；非敏感值明文存储、全员可读 */
    secret: boolean('secret').notNull().default(true),
    description: text('description').notNull().default(''),
    /** 无权限时是否在清单中可见（默认可见：AI 能看懂用途，取值另需权限） */
    visibleWithoutPermission: boolean('visible_without_permission').notNull().default(true),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('env_variable_env_key_idx').on(t.environmentId, t.key)],
);

/** 读值授权：variableId / environmentId 二选一（环境级 = 该环境全部变量） */
export const variableGrants = pgTable(
  'variable_grant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    variableId: uuid('variable_id').references(() => envVariables.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'cascade',
    }),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('variable_grant_user_idx').on(t.userId)],
);

export const accessRequests = pgTable(
  'access_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    keys: jsonb('keys').$type<string[]>().notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('access_request_status_idx').on(t.status)],
);

export const skills = pgTable('skill', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  visibility: text('visibility', { enum: ['team', 'granted', 'private'] })
    .notNull()
    .default('team'),
  /** 是否允许对此 skill 发起求助（P1 求助系统入口） */
  allowHelp: boolean('allow_help').notNull().default(false),
  source: text('source', { enum: ['manual', 'experience'] })
    .notNull()
    .default('manual'),
  currentVersion: integer('current_version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface SkillFileRow {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  executable: boolean;
}

export const skillVersions = pgTable(
  'skill_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** SKILL.md 正文 */
    content: text('content').notNull(),
    files: jsonb('files').$type<SkillFileRow[]>().notNull().default([]),
    changelog: text('changelog').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skill_version_idx').on(t.skillId, t.version)],
);

export const skillSubscriptions = pgTable(
  'skill_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['manual', 'template', 'experience'] })
      .notNull()
      .default('manual'),
    /** 对模板派生的 skill 的"排除"标记：用户主动退掉模板里的某一项 */
    excluded: boolean('excluded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skill_subscription_user_skill_idx').on(t.userId, t.skillId)],
);

/** 角色模板：管理员预定义的能力套餐 */
export const roleTemplates = pgTable('role_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const templateItems = pgTable(
  'template_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => roleTemplates.id, { onDelete: 'cascade' }),
    itemType: text('item_type', { enum: ['skill', 'mcp_config', 'environment'] }).notNull(),
    itemId: uuid('item_id').notNull(),
  },
  (t) => [uniqueIndex('template_item_idx').on(t.templateId, t.itemType, t.itemId)],
);

/** 成员选用的模板（一人一个，可换可清） */
export const userTemplateSelections = pgTable('user_template_selection', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  templateId: uuid('template_id')
    .notNull()
    .references(() => roleTemplates.id, { onDelete: 'cascade' }),
  selectedAt: timestamp('selected_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 分发的 MCP Server 配置；env/headers 的值可写 ${env:slug/KEY} 引用 */
export const mcpConfigs = pgTable('mcp_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  command: text('command'),
  args: jsonb('args').$type<string[]>().notNull().default([]),
  url: text('url'),
  headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
  env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
  visibility: text('visibility', { enum: ['team', 'private'] })
    .notNull()
    .default('team'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mcpSubscriptions = pgTable(
  'mcp_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    configId: uuid('config_id')
      .notNull()
      .references(() => mcpConfigs.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['manual', 'template'] }).notNull().default('manual'),
    excluded: boolean('excluded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mcp_subscription_user_config_idx').on(t.userId, t.configId)],
);

/** 团队共享数据库实例（管理凭证加密存储） */
export const dbInstances = pgTable('db_instance', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  engine: text('engine', { enum: ['postgres', 'mysql'] }).notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  adminUser: text('admin_user').notNull(),
  adminPasswordEncrypted: text('admin_password_encrypted').notNull(),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 库 + 专属账号的分配记录；active 后关联生成的环境 */
export const dbAssignments = pgTable(
  'db_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => dbInstances.id, { onDelete: 'cascade' }),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dbName: text('db_name').notNull(),
    dbUser: text('db_user').notNull(),
    purpose: text('purpose').notNull(),
    status: text('status', { enum: ['pending', 'active', 'failed', 'rejected', 'disabled', 'deleted'] })
      .notNull()
      .default('pending'),
    environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'set null' }),
    error: text('error'),
    decidedBy: uuid('decided_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('db_assignment_requester_idx').on(t.requesterId),
    uniqueIndex('db_assignment_instance_dbname_idx').on(t.instanceId, t.dbName),
  ],
);

/** 可求助者登记：description 会被 AI 读取用于选择求助对象 */
export const helperProfiles = pgTable('helper_profile', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  webhookUrl: text('webhook_url'),
  webhookSecretEncrypted: text('webhook_secret_encrypted'),
  /** webhook 开关：接收找我的新求助 / 接收我参与求助的新回复 */
  notifyHelp: boolean('notify_help').notNull().default(true),
  notifyReply: boolean('notify_reply').notNull().default(true),
  available: boolean('available').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const helpRequests = pgTable(
  'help_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    helperId: uuid('helper_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    tried: text('tried').notNull().default(''),
    status: text('status', { enum: ['open', 'answered', 'resolved', 'closed'] })
      .notNull()
      .default('open'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('help_request_helper_idx').on(t.helperId), index('help_request_requester_idx').on(t.requesterId)],
);

export const helpMessages = pgTable(
  'help_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => helpRequests.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('help_message_request_idx').on(t.requestId)],
);

/** 经验沉淀：求助 ↔ 沉淀出的 skill 的关联与配置 */
export const experiences = pgTable('experience', {
  id: uuid('id').primaryKey().defaultRandom(),
  helpRequestId: uuid('help_request_id')
    .notNull()
    .unique()
    .references(() => helpRequests.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id')
    .notNull()
    .references(() => skills.id, { onDelete: 'cascade' }),
  public: boolean('public').notNull(),
  grantedToRequester: boolean('granted_to_requester').notNull().default(true),
  grantedToHelper: boolean('granted_to_helper').notNull().default(true),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  'webhook_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    targetUrl: text('target_url').notNull(),
    /** 摘要信息（不含敏感正文） */
    summary: text('summary').notNull().default(''),
    status: text('status', { enum: ['pending', 'success', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_delivery_status_idx').on(t.status)],
);

/** 平台 AI 接入配置（单行；OpenAI 接口范式） */
/** 开放注册设置（单行）：管理员开启后，登录页提供自助注册 */
export const registrationSettings = pgTable('registration_setting', {
  id: uuid('id').primaryKey().defaultRandom(),
  enabled: boolean('enabled').notNull().default(false),
  /** 允许的邮箱后缀（小写、含 @ 前缀）；空数组 = 任意邮箱 */
  allowedEmailSuffixes: jsonb('allowed_email_suffixes').$type<string[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiSettings = pgTable('ai_setting', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiBaseUrl: text('api_base_url').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  model: text('model').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiCallLogs = pgTable(
  'ai_call_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    status: text('status', { enum: ['success', 'failed'] }).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_call_log_purpose_idx').on(t.purpose)],
);

/** Dokploy 接入配置（单行）。项目 / 环境 / SSH key 三项是自助建应用的落点（决策 31） */
export const dokploySettings = pgTable('dokploy_setting', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiUrl: text('api_url').notNull(),
  apiTokenEncrypted: text('api_token_encrypted').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** 自助创建的应用建在 Dokploy 的哪个项目 / 环境下；空串 = 未配置 */
  projectId: text('project_id').notNull().default(''),
  environmentId: text('environment_id').notNull().default(''),
  /** 自助创建的应用绑哪把 SSH key 拉仓库；空串 = 不绑（只能拉公开仓库） */
  sshKeyId: text('ssh_key_id').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 应用（决策 31）：与 Dokploy 的 application 一一对应。
 * managed=true 的是平台在 Dokploy 上自动建出来的（Git 源 / SSH key / 构建方式都由平台写入、删除时连带删除）；
 * managed=false 的是管理员挂载的既有 application，构建配置归 Dokploy 侧维护、平台不替它记。
 */
export const apps = pgTable('app', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  repoUrl: text('repo_url').notNull().default(''),
  branch: text('branch').notNull().default('main'),
  /** 构建方式；挂载的应用为 null */
  buildType: text('build_type', { enum: ['static', 'dockerfile'] }),
  dockerfile: text('dockerfile').notNull().default('Dockerfile'),
  dockerContextPath: text('docker_context_path').notNull().default(''),
  publishDirectory: text('publish_directory').notNull().default('.'),
  staticSpa: boolean('static_spa').notNull().default(false),
  dokployApplicationId: text('dokploy_application_id').notNull(),
  description: text('description').notNull().default(''),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  managed: boolean('managed').notNull().default(true),
  /**
   * 部署授权（决策 31）：用户自建的应用首次部署要管理员放行一次，放行后不再拦。
   * 管理员自己建的 / 挂载的应用创建即视为已授权。
   */
  deployApproved: boolean('deploy_approved').notNull().default(false),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /** 最近一次因未授权被拒的部署尝试：控制台据此把应用标成「待授权」 */
  approvalRequestedAt: timestamp('approval_requested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appMembers = pgTable(
  'app_member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('app_member_idx').on(t.appId, t.userId)],
);

/**
 * 部署元数据（决策 30）。部署记录本身与其状态**一律以 Dokploy 的构建记录为准**，这张表只存
 * Dokploy 那边没有的业务信息：谁触发的、从哪触发的、带了什么 CLI 前置检查报告（决策 #8）。
 * 刻意不存 status / error——那些实时读 Dokploy，在库里存一份必然过期（旧实现就卡在这上面）。
 *
 * 行只增不删：Dokploy 每个应用只保留最近 10 条构建记录（removeLastTenDeployments，硬编码不可配），
 * 超出的连构建日志一起删掉；而「谁在什么时候带着什么扫描报告部署了生产」是平台的合规记录，
 * 不能跟着一起消失，所以元数据留着，列表里显示为 archived。
 */
export const deployments = pgTable(
  'deployment',
  {
    /** 触发时由服务端显式生成，并以 `eat:<id>` 写进 Dokploy 构建记录的 description 供精确认领 */
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    triggeredBy: uuid('triggered_by')
      .notNull()
      .references(() => users.id),
    /** cli = eat deploy / MCP（带扫描报告）；console = 控制台按钮（没做扫描，决策 31） */
    source: text('source', { enum: ['cli', 'console'] })
      .notNull()
      .default('cli'),
    /**
     * 认领到的 Dokploy 构建记录 id。触发时 Dokploy 还没建出记录（部署是排队执行的），
     * 首次读到就回写；唯一索引保证一条构建记录不会被两行元数据同时认领。
     */
    dokployDeploymentId: text('dokploy_deployment_id'),
    /**
     * 当初是怎么认领上的：tagged = description 里的标记精确匹配；inferred = 按时间推断。
     * 必须记下来——Dokploy v0.30.5 起构建结束后会把 title/description 覆盖成提交信息，标记随之消失，
     * 之后再读只能靠回写的 id 认，没有这一列就分不清「当初精确认过」和「一直是猜的」。
     */
    claim: text('claim', { enum: ['tagged', 'inferred'] }),
    report: jsonb('report').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deployment_app_idx').on(t.appId),
    uniqueIndex('deployment_dokploy_idx').on(t.dokployDeploymentId),
  ],
);

export const auditLogs = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id'),
    actorTokenId: uuid('actor_token_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_action_idx').on(t.action), index('audit_log_created_idx').on(t.createdAt)],
);
