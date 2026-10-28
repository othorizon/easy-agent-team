import { BadRequestException, Body, Controller, ForbiddenException, Inject, Post } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { buildNotificationCard, sendNotificationSchema, type SendNotificationRequest, type SendNotificationResult } from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { users } from '../db/schema';
import { NotifierService } from './notifier.service';

@Controller('api/notifications')
export class MessagesController {
  constructor(@Inject(DB) private readonly db: Db, private readonly notifier: NotifierService,
    private readonly audit: AuditService) {}

  @Post('send')
  async send(@CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(sendNotificationSchema)) body: SendNotificationRequest): Promise<SendNotificationResult> {
    // 权限每次从数据库读取；管理员也必须显式启用全员通知权限。
    const [sender] = await this.db.select({ name: users.name, canNotifyAll: users.canNotifyAll })
      .from(users).where(eq(users.id, actor.id));
    if (body.all && !sender?.canNotifyAll) {
      throw new ForbiddenException({ error: 'NOTIFY_ALL_FORBIDDEN', message: '全员通知权限未开启，请联系管理员在用户管理中授权' });
    }
    const people = await this.db.select({ id: users.id, name: users.name, email: users.email, status: users.status })
      .from(users).orderBy(asc(users.createdAt));
    const selected = body.all ? people.filter(p => p.status === 'active') : [...new Set(body.to!.map(ref => {
      const found = people.filter(p => p.id === ref || p.email.toLowerCase() === ref.toLowerCase());
      if (found.length !== 1) throw new BadRequestException({ error: 'INVALID_RECIPIENT',
        message: `无法唯一识别接收人 ${ref}，请用 eat users 查询完整用户 ID 或邮箱` });
      return found[0];
    }))];
    const card = buildNotificationCard({ ...body, senderName: sender.name, sentAt: new Date() });
    // 给飞书 30 KB 消息体限制预留协议、签名和姓名空间；不截断 Markdown。
    if (Buffer.byteLength(JSON.stringify(card)) > 25000) {
      throw new BadRequestException({ error: 'MESSAGE_TOO_LARGE', message: '消息卡片过大，请缩短正文后重试' });
    }
    const targets = await Promise.all(selected.map(p => this.notifier.target(p.id)));
    const recipients: SendNotificationResult['recipients'] = selected.map((p, index) => ({
      id: p.id, name: p.name, email: p.email,
      status: !targets[index] ? 'unavailable' : 'ready',
      ...(p.status !== 'active' ? { reason: '账号已禁用' }
        : !targets[index] ? { reason: '当前飞书渠道尚未配置、验证或绑定' } : {}),
    }));
    if (body.dryRun) return { dryRun: true, title: body.title, recipients };
    await this.audit.record({ actorId: actor.id, action: 'notification.sent', targetType: 'notification',
      meta: { title: body.title, all: body.all, recipientIds: selected.map(p => p.id) } });
    // 每批最多 5 个请求；失败仅标记当前接收人，不中止或重发已成功的通知。
    for (let start = 0; start < selected.length; start += 5) {
      await Promise.all(selected.slice(start, start + 5).map(async (person, offset) => {
        const result = recipients[start + offset];
        if (result.status !== 'ready') return;
        try {
          const ok = await this.notifier.sendNotification(targets[start + offset]!, card, `${sender.name}: ${body.title}`);
          result.status = ok ? 'sent' : 'failed';
        } catch { result.status = 'failed'; }
        if (result.status === 'failed') result.reason = '飞书投递未确认成功，请检查通知配置；勿重复发送已成功的接收人';
      }));
    }
    return { dryRun: false, title: body.title, recipients };
  }
}
