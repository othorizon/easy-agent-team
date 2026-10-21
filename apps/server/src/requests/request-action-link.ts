import { createHmac, timingSafeEqual } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { loadConfig } from '../config';

// This is scoped consent from a notification, never an authentication token.
// The endpoint still requires login and rechecks the recipient's current permissions.
function signature(payload: string) {
  return createHmac('sha256', Buffer.from(loadConfig().kek, 'base64'))
    .update('eat:request-notification:approve:v1:' + payload)
    .digest();
}
export function createRequestActionToken(requestId: string, recipientId: string, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ requestId, recipientId, expiresAt: now + 7 * 86400_000 }),
  ).toString('base64url');
  return payload + '.' + signature(payload).toString('base64url');
}
export function verifyRequestActionToken(token: string, requestId: string, recipientId: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || token.length > 2048) throw new Error();
    const [payload, sig] = parts;
    const supplied = Buffer.from(sig, 'base64url'),
      expected = signature(payload);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      data.requestId !== requestId ||
      data.recipientId !== recipientId ||
      !Number.isFinite(data.expiresAt) ||
      data.expiresAt <= Date.now()
    )
      throw new Error();
  } catch {
    throw new ForbiddenException(
      '快捷审批链接已失效或不属于当前账户，请使用接收通知的账户登录，或前往申请详情审批',
    );
  }
}
