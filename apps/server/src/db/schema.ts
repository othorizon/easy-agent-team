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
    valueEncrypted: text('value_encrypted').notNull(),
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

/** Dokploy 接入配置（单行） */
export const dokploySettings = pgTable('dokploy_setting', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiUrl: text('api_url').notNull(),
  apiTokenEncrypted: text('api_token_encrypted').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('project', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  repoUrl: text('repo_url').notNull().default(''),
  dokployApplicationId: text('dokploy_application_id').notNull(),
  description: text('description').notNull().default(''),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectMembers = pgTable(
  'project_member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('project_member_idx').on(t.projectId, t.userId)],
);

/** 部署记录；CLI 端检查报告存 report（决策 #8：不建平台侧 runner） */
export const deployments = pgTable(
  'deployment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    triggeredBy: uuid('triggered_by')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: ['deploying', 'success', 'failed'] })
      .notNull()
      .default('deploying'),
    report: jsonb('report').$type<Record<string, unknown>>(),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('deployment_project_idx').on(t.projectId)],
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
