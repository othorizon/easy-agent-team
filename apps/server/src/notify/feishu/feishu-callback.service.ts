import { HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { lt, sql } from 'drizzle-orm';
import { extractFeishuBindCode } from '@eat/shared';
import { DB, type Db } from '../../db/db.module';
import { feishuEvents } from '../../db/schema';
import { FeishuAppService } from './feishu-app.service';
import { decryptFeishuPayload, feishuSignature, safeEqual } from './feishu-api';

export interface FeishuCardActionContext {
  appId: string;
  operatorOpenId: string;
  messageId: string;
  value: Record<string, unknown>;
  formValue: Record<string, unknown>;
}
export interface FeishuCardActionResult {
  toast?: { type: 'success' | 'error' | 'info' | 'warning'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}
export type FeishuCardActionHandler = (ctx: FeishuCardActionContext) => Promise<FeishuCardActionResult>;

interface FeishuEnvelope {
  type?: string;
  challenge?: string;
  token?: string;
  schema?: string;
  header?: { event_id?: string; event_type?: string; token?: string; app_id?: string };
  event?: Record<string, any>;
}

/** 同一个飞书账号 10 分钟内最多试错这么多次绑定码，挡住在私聊里穷举 */
const BIND_FAILURE_LIMIT = 10;
const BIND_FAILURE_WINDOW_MS = 10 * 60_000;

const HELP_TEXT =
  '你好，我是 EAT 平台的通知机器人。\n' +
  '绑定方法：在 EAT「个人中心 → 通知设置」里生成绑定码（形如 EAT-7KQ2MX），把它原样发给我即可。\n' +
  '绑定后，权限申请、审批结果、求助与回复、Folio 评论提及都会通过这里通知你，审批卡片可以直接点同意或驳回。';

export class FeishuCallbackError extends HttpException {}

/**
 * 飞书「事件与回调」的统一入口（决策 92）。
 * 强制要求 Encrypt Key：审批会通过卡片回调执行，必须能验签。
 * 校验顺序：解密 → 验签（地址验证除外，它只带 token）→ 核对 Verification Token 与 App ID → 按 event_id 去重。
 */
@Injectable()
export class FeishuCallbackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeishuCallbackService.name);
  private readonly cardHandlers = new Map<string, FeishuCardActionHandler>();
  private readonly bindFailures = new Map<string, number[]>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly feishu: FeishuAppService,
  ) {}

  onModuleInit() {
    // 事件去重记录只需要覆盖飞书的重推窗口（最长约 6 小时），留一周足够
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), 6 * 3600_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    await this.db.delete(feishuEvents).where(lt(feishuEvents.receivedAt, sql`now() - interval '7 days'`));
  }

  /** 卡片按钮的 value 里带 `eat: <kind>`，由对应业务模块注册处理 */
  registerCardAction(kind: string, handler: FeishuCardActionHandler) {
    this.cardHandlers.set(kind, handler);
  }

  async handle(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Record<string, unknown>> {
    const row = await this.feishu.row();
    const secrets = this.feishu.secrets(row);
    if (!secrets) throw new FeishuCallbackError({ msg: 'EAT 尚未配置飞书自建应用' }, 404);
    let outer: { encrypt?: unknown };
    try {
      outer = JSON.parse(rawBody);
    } catch {
      throw new FeishuCallbackError({ msg: 'invalid body' }, 400);
    }
    if (typeof outer?.encrypt !== 'string') {
      // 没加密说明开发者后台没配 Encrypt Key，审批回调无法验签，一律拒绝
      throw new FeishuCallbackError({ msg: '请在开发者后台「加密策略」配置 Encrypt Key，并与 EAT 保持一致' }, 400);
    }
    let payload: FeishuEnvelope;
    try {
      payload = JSON.parse(decryptFeishuPayload(secrets.encryptKey, outer.encrypt));
    } catch {
      throw new FeishuCallbackError({ msg: 'decrypt failed' }, 401);
    }

    if (payload.type === 'url_verification') {
      if (!safeEqual(payload.token, secrets.verificationToken)) throw new FeishuCallbackError({ msg: 'invalid token' }, 401);
      await this.feishu.touchCallback('verification');
      return { challenge: payload.challenge };
    }

    const header = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : (v ?? '');
    };
    const signature = header('x-lark-signature');
    const expected = feishuSignature(header('x-lark-request-timestamp'), header('x-lark-request-nonce'), secrets.encryptKey, rawBody);
    if (!safeEqual(signature, expected)) throw new FeishuCallbackError({ msg: 'invalid signature' }, 401);
    if (!safeEqual(payload.header?.token, secrets.verificationToken)) throw new FeishuCallbackError({ msg: 'invalid token' }, 401);
    if (payload.header?.app_id && payload.header.app_id !== secrets.appId) {
      throw new FeishuCallbackError({ msg: 'app mismatch' }, 401);
    }
    await this.feishu.touchCallback('event');

    const eventId = payload.header?.event_id;
    const type = payload.header?.event_type;
    if (eventId && type !== 'card.action.trigger') {
      const fresh = await this.db.insert(feishuEvents).values({ eventId }).onConflictDoNothing().returning();
      if (!fresh.length) return {};
    }
    const event = payload.event ?? {};
    if (type === 'im.message.receive_v1') {
      await this.onMessage(secrets.appId, event);
      return {};
    }
    if (type === 'card.action.trigger') return this.onCardAction(secrets.appId, event);
    return {};
  }

  private async onMessage(appId: string, event: Record<string, any>) {
    const message = event.message ?? {};
    const sender = event.sender ?? {};
    const openId: string | undefined = sender.sender_id?.open_id;
    if (message.chat_type !== 'p2p' || sender.sender_type !== 'user' || !openId || !message.message_id) return;
    let text = '';
    if (message.message_type === 'text') {
      try {
        text = String(JSON.parse(message.content ?? '{}').text ?? '');
      } catch {
        text = '';
      }
    }
    const code = extractFeishuBindCode(text);
    let reply = HELP_TEXT;
    if (code) {
      const now = Date.now();
      const failures = (this.bindFailures.get(openId) ?? []).filter((t) => now - t < BIND_FAILURE_WINDOW_MS);
      if (failures.length >= BIND_FAILURE_LIMIT) {
        reply = '绑定码错误次数过多，请 10 分钟后再试。';
      } else {
        const result = await this.feishu.bindByCode(code, appId, openId, sender.sender_id?.union_id ?? null);
        if (result.ok) {
          this.bindFailures.delete(openId);
          reply =
            `✅ 绑定成功：已关联 EAT 账号 ${result.name}（${result.email}）。\n` +
            '之后的通知会通过这里私聊发给你，审批卡片可以直接点同意或驳回。' +
            (result.replaced ? '\n这个飞书账号之前绑定的 EAT 账号已自动解绑。' : '');
        } else {
          this.bindFailures.set(openId, [...failures, now]);
          reply =
            result.reason === 'disabled'
              ? '该 EAT 账号已停用，无法绑定。'
              : '绑定码无效或已过期（有效期 10 分钟），请回到 EAT 页面重新生成后再发给我。';
        }
      }
    }
    // 回复走后台：事件要在 3 秒内应答，否则飞书会重推
    const api = this.feishu.client(await this.feishu.row());
    if (api) void api.replyText(message.message_id, reply).catch((e) => this.logger.warn(`飞书机器人回复失败：${(e as Error).message}`));
  }

  private async onCardAction(appId: string, event: Record<string, any>): Promise<Record<string, unknown>> {
    const value = (event.action?.value ?? {}) as Record<string, unknown>;
    const handler = typeof value.eat === 'string' ? this.cardHandlers.get(value.eat) : undefined;
    const operatorOpenId: string | undefined = event.operator?.open_id;
    const messageId: string | undefined = event.context?.open_message_id ?? event.open_message_id;
    if (!handler || !operatorOpenId || !messageId) {
      return { toast: { type: 'warning', content: '这张卡片已失效，请在 EAT 页面处理' } };
    }
    try {
      return { ...(await handler({ appId, operatorOpenId, messageId, value, formValue: event.action?.form_value ?? {} })) };
    } catch (e) {
      this.logger.warn(`飞书卡片回调处理失败：${(e as Error).message}`);
      return { toast: { type: 'error', content: '处理失败，请稍后重试或在 EAT 页面处理' } };
    }
  }
}
