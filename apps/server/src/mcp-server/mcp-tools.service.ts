import { RequestsService } from '../requests/requests.service';
import { requestListSchema } from '@eat/shared';
import { OssToolsService } from '../oss/oss-tools.service';
import { isOssTool } from '@eat/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  buildEatTools,
  createAccessRequestSchema,
  createAppSchema,
  createDbAssignmentSchema,
  createHelpRequestSchema,
  logsQuerySchema,
  matchDbAssignments,
  resolveDbInstance,
  platformGuideSyncSkill,
  updateAppEnvSchema,
  updateAppSchema,
  variableKeySchema,
  type AppInfo,
  type EatToolDef,
} from '@eat/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.decorators';
import { DbsService } from '../dbs/dbs.service';
import { AppsService } from '../deploy/apps.service';
import { DeployService } from '../deploy/deploy.service';
import { AccessRequestsService } from '../envs/access-requests.service';
import { EnvsService } from '../envs/envs.service';
import { ExperiencesService } from '../help/experiences.service';
import { HelpService } from '../help/help.service';
import { HelpersService } from '../help/helpers.service';
import { FolioToolsService } from '../sites/folio-tools.service';
import { isFolioTool } from '@eat/shared';

/** 工具入参先过一遍 zod：模型给的参数什么形状都可能，错就回结构化的 VALIDATION_FAILED，别让它撞进服务层 */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new BadRequestException({
      error: 'VALIDATION_FAILED',
      message: '工具参数不合法',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }
  return result.data;
}

const slugArg = z.string().min(1).max(200);
const appArg = z.object({ app: slugArg });

/** 取出路径参数 app，剩下的原样交给对应的请求体契约（别把 app 也塞进请求体） */
function takeApp(args: Record<string, unknown>): { slug: string; rest: Record<string, unknown> } {
  const { app, ...rest } = args;
  return { slug: parse(slugArg, app), rest };
}
const envValuesArgs = z.object({ environment: slugArg, keys: z.array(variableKeySchema).optional() });
const requestIdArg = z.object({ requestId: z.string().min(1).max(100) });
const optionalRequestIdArg = z.object({ requestId: z.string().min(1).max(100).optional() });
const deployStatusArgs = z.object({
  app: slugArg,
  deploymentId: z.string().min(1).max(200).optional(),
  history: z.boolean().optional(),
  all: z.boolean().optional(),
});

/** 部署后台的内部 id 不给 AI（决策 33）：它既用不上也操作不了，露出来只会让它以为要去那边做什么 */
function forAgent(app: AppInfo): Omit<AppInfo, 'dokployApplicationId'> {
  const { dokployApplicationId: _internal, ...rest } = app;
  return rest;
}

/**
 * eat 自身能力的 MCP 工具实现（决策 55）。
 *
 * 直接调各个 Service，不绕回自己的 REST 接口——服务层本来就以 AuthUser 为第一入参，
 * 权限判定、审计落库全在里面，MCP 这层只做「参数校验 + 结果整形」。
 */
@Injectable()
export class McpToolsService {
  constructor(
    private readonly envs: EnvsService,
    private readonly accessRequests: AccessRequestsService,
    private readonly experiences: ExperiencesService,
    private readonly helpers: HelpersService,
    private readonly help: HelpService,
    private readonly apps: AppsService,
    private readonly deploy: DeployService,
    private readonly dbs: DbsService,
    private readonly folioTools: FolioToolsService,
    private readonly ossTools: OssToolsService,
    private readonly requests: RequestsService,
  ) {}

  listTools(): EatToolDef[] {
    return buildEatTools('remote');
  }

  /** 逐个工具分发。抛出的异常由调用方转成 MCP 的 isError 结果 */
  async call(user: AuthUser, name: string, rawArgs: unknown, ip?: string): Promise<unknown> {
    if (isOssTool(name)) return this.ossTools.call(user, name, rawArgs);
    if (isFolioTool(name)) return this.folioTools.call(user, name, rawArgs);
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'list_requests': return this.requests.list(user,parse(requestListSchema,{...args,scope:'mine'}));
      case 'get_request_status': return this.requests.get(user,parse(z.object({requestId:z.string().uuid()}),args).requestId);
      // ---------- 平台指南（只有远程接入有：云端客户端没有 eat sync 那条路） ----------
      case 'get_platform_guide': {
        const { path } = parse(z.object({ path: z.string().min(1).max(200).optional() }), args);
        const skill = platformGuideSyncSkill();
        if (!path || path === 'SKILL.md') {
          return {
            slug: skill.slug,
            version: skill.version,
            content: skill.content,
            files: skill.files.map(({ path }) => ({ path })),
          };
        }
        // Exact manifest lookup, never a filesystem read or an expansion of every reference.
        const file = skill.files.find((file) => file.path === path);
        if (!file) throw new BadRequestException({ error: 'GUIDE_FILE_NOT_FOUND', message: '指南文件不存在' });
        return { slug: skill.slug, version: skill.version, path: file.path, content: file.content };
      }

      // ---------- 环境变量 ----------
      case 'list_env_variables': {
        const { environment } = parse(z.object({ environment: slugArg.optional() }), args);
        const catalog = await this.envs.catalog(user);
        return environment ? catalog.filter((c) => c.environment.slug === environment) : catalog;
      }
      case 'get_env_values': {
        const { environment, keys } = parse(envValuesArgs, args);
        return this.envs.pullValues(user, environment, keys, ip);
      }
      case 'request_access': {
        const { environment, keys, reason } = parse(
          z.object({ environment: slugArg, keys: z.array(z.string()).min(1), reason: z.string().min(1) }),
          args,
        );
        return this.accessRequests.create(
          user,
          parse(createAccessRequestSchema, { environmentSlug: environment, keys, reason }),
        );
      }
      case 'get_access_request_status': {
        const { requestId } = parse(optionalRequestIdArg, args);
        return requestId ? this.accessRequests.get(user, requestId) : this.accessRequests.listMine(user);
      }

      // ---------- 经验与求助 ----------
      case 'search_experiences': {
        const { q } = parse(z.object({ q: z.string().min(1).max(200) }), args);
        return this.experiences.search(user, q);
      }
      case 'list_helpers':
        return this.helpers.targets();
      case 'create_help_request':
        return this.help.create(user, parse(createHelpRequestSchema, args));
      case 'get_help_request': {
        const { requestId } = parse(optionalRequestIdArg, args);
        return requestId ? this.help.detail(user, requestId) : this.help.listMine(user);
      }
      case 'reply_help_request': {
        const { requestId, content, reopen } = parse(
          requestIdArg.extend({ content: z.string().min(1).max(10000), reopen: z.boolean().default(true) }),
          args,
        );
        return this.help.reply(user, requestId, content, reopen);
      }
      case 'delete_help_request': {
        const { requestId } = parse(requestIdArg, args);
        return this.help.remove(user, requestId);
      }

      // ---------- 数据库账号 ----------
      case 'list_db_instances':
        return this.dbs.listInstances();
      case 'request_db': {
        const { instance, ...rest } = parse(
          z.object({ instance: z.string().min(1).max(200), dbName: z.string(), purpose: z.string() }),
          args,
        );
        const instances = await this.dbs.listInstances();
        const found = resolveDbInstance(instances, instance);
        // 名字打错是最常见的一种失败，直接把候选清单回给它，省一轮往返
        if (!found) {
          throw new BadRequestException({
            error: 'DB_INSTANCE_NOT_FOUND',
            message: `找不到实例 ${instance}，用 list_db_instances 查看可用实例`,
            instances: instances.map((i) => ({ id: i.id, name: i.name })),
          });
        }
        return this.dbs.createAssignment(user, parse(createDbAssignmentSchema, { ...rest, instanceId: found.id }));
      }
      case 'list_db_assignments':
        return this.dbs.listMine(user);
      case 'get_db_credentials': {
        const { assignment } = parse(z.object({ assignment: z.string().min(1).max(200) }), args);
        const mine = await this.dbs.listMine(user);
        const hits = matchDbAssignments(mine, assignment);
        // 和 request_db 找不到实例一样：把候选清单一起回过去，省一轮 list_db_assignments
        if (hits.length !== 1) {
          throw new BadRequestException({
            error: hits.length === 0 ? 'DB_ASSIGNMENT_NOT_FOUND' : 'DB_ASSIGNMENT_AMBIGUOUS',
            message:
              hits.length === 0
                ? `名下没有库 ${assignment}，用 list_db_assignments 查看`
                : `有 ${hits.length} 个同名库，改用「库名@实例名」或分配 id`,
            assignments: (hits.length === 0 ? mine : hits).map((a) => ({
              id: a.id,
              dbName: a.dbName,
              instanceName: a.instanceName,
              status: a.status,
            })),
          });
        }
        return this.dbs.credentials(user, hits[0].id, ip);
      }

      // ---------- 应用 ----------
      case 'list_apps':
        return (await this.apps.listApps(user)).map(forAgent);
      case 'create_app': {
        // 工具描述承诺 name 默认同 slug，服务端契约里 name 是必填，在这里补上
        const payload = { ...args, name: args.name ?? args.slug };
        return forAgent(await this.apps.createApp(user, parse(createAppSchema, payload)));
      }
      case 'update_app': {
        const { slug, rest } = takeApp(args);
        return forAgent(await this.apps.updateApp(user, slug, parse(updateAppSchema, rest)));
      }
      case 'get_app_env': {
        const { app } = parse(appArg, args);
        return this.apps.getEnv(user, app);
      }
      case 'set_app_env': {
        const { slug, rest } = takeApp(args);
        return this.apps.setEnv(user, slug, parse(updateAppEnvSchema, rest));
      }

      // ---------- 部署与日志 ----------
      case 'trigger_deploy': {
        const { app } = parse(appArg, args);
        // 来源记为 remote，便于在部署记录里区分从哪触发（决策 55）
        return this.deploy.deploy(user, app, { source: 'remote' });
      }
      case 'get_deploy_status': {
        const { app, deploymentId, history, all } = parse(deployStatusArgs, args);
        if (deploymentId) return this.deploy.getDeployment(user, app, deploymentId);
        if (history) return this.deploy.listDeployments(user, app, { all: all === true });
        return this.deploy.latestDeployment(user, app);
      }
      case 'get_build_logs': {
        const { slug, rest } = takeApp(args);
        return this.deploy.buildLogs(user, slug, parse(logsQuerySchema, rest));
      }
      case 'get_run_logs': {
        const { slug, rest } = takeApp(args);
        return this.deploy.runLogs(user, slug, parse(logsQuerySchema, rest));
      }

      default:
        throw new BadRequestException({ error: 'UNKNOWN_TOOL', message: `未知工具: ${name}` });
    }
  }
}
