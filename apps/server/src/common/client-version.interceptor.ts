import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mergeMap, Observable } from 'rxjs';
import { CLI_VERSION, CLI_VERSION_HEADER, CLIENT_HEADER, SKILL_VERSION_HEADER } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { SkillsService } from '../skills/skills.service';

/** 指纹的 per-user 内存缓存窗口：连续命令不必每次打库，一分钟的滞后对更新提示无影响 */
const CACHE_TTL_MS = 60_000;
/** 缓存条目上限，超出后整体清空（团队规模的用户数远小于此，纯属防御） */
const CACHE_MAX = 500;

/**
 * CLI 更新检测的服务端一半（决策 26）：给自报身份的 CLI 请求附带
 * x-eat-cli-version（平台当前分发的 CLI 版本）与 x-eat-skill-version（该用户的 Skill 集合指纹）。
 *
 * 搭响应头的车而不是让 CLI 定时轮询版本接口：联网命令本就要请求平台，零额外往返；
 * 且 Skill 是否有更新本来就是 per-user 的，全局版本号表达不了。
 *
 * 只对带 x-eat-client 的请求生效——控制台不需要这两个头，不必为它多查一次库。
 * 任何一步失败都静默跳过：更新提示绝不能影响业务请求本身。
 */
@Injectable()
export class ClientVersionInterceptor implements NestInterceptor {
  private readonly cache = new Map<string, { value: string; at: number }>();

  constructor(private readonly skills: SkillsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest & { authUser?: AuthUser }>();
    if (!request.headers?.[CLIENT_HEADER]) return next.handle();

    const reply = http.getResponse<FastifyReply>();
    // 先落 CLI 版本头：异常路径由过滤器复用同一个 reply，这个头依然会带上
    reply.header(CLI_VERSION_HEADER, CLI_VERSION);

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        const user = request.authUser;
        if (user) {
          const version = await this.bundleVersion(user);
          if (version) reply.header(SKILL_VERSION_HEADER, version);
        }
        return body;
      }),
    );
  }

  private async bundleVersion(user: AuthUser): Promise<string | null> {
    const now = Date.now();
    const hit = this.cache.get(user.id);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
    try {
      const value = await this.skills.bundleVersion(user);
      if (this.cache.size >= CACHE_MAX) this.cache.clear();
      this.cache.set(user.id, { value, at: now });
      return value;
    } catch {
      return null;
    }
  }
}
