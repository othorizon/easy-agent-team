import { Body, Controller, ForbiddenException, Headers, Inject, NotFoundException, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/auth.decorators';
import { AuthService } from '../auth/auth.service';
import { DB, type Db } from '../db/db.module';
import { users } from '../db/schema';
import { demoConfig } from './demo.config';

const DEMO_TOKEN_TTL_MS = 12 * 3600 * 1000;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

@Controller('api/demo')
export class DemoController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  /**
   * 演示门户的「一键以某身份进入」：凭共享密钥给指定成员签一个 Web 会话。
   *
   * 不走口令登录，是因为演示账号的口令是公开的，访客改不改得了它都不该影响入口；
   * 密钥只在门户后端手里，浏览器拿到的是签出来的会话令牌。
   * 端点只在演示模式且配置了密钥时存在，否则一律按不存在处理。
   */
  @Public()
  @Post('login')
  async login(@Headers('x-demo-secret') secret: string | undefined, @Body() body: { email?: string }) {
    const cfg = demoConfig();
    if (!cfg.enabled || !cfg.loginSecret) throw new NotFoundException();
    if (!secret || !sameSecret(secret, cfg.loginSecret)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '演示登录密钥不正确' });
    }
    const email = String(body?.email ?? '').trim();
    const user = (await this.db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (!user || user.status !== 'active' || user.email === cfg.bootstrapAdminEmail) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: '没有这个演示身份' });
    }
    const { token } = await this.auth.issueToken(
      user.id,
      '演示入口',
      'web',
      new Date(Date.now() + DEMO_TOKEN_TTL_MS),
    );
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }
}
