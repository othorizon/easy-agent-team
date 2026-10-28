import { z } from 'zod';

export const REPLY_MESSAGE_PLACEHOLDER = '{message}';
export const REPLY_REDIRECT_PATH = '/redirect';
export const REPLY_REDIRECT_MAX_LENGTH = 65536;
const placeholder = /\{message\}|%7Bmessage%7D/gi;
const blockedSchemes = new Set([
  'javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'filesystem:',
  'chrome:', 'chrome-extension:', 'edge:', 'resource:', 'view-source:',
]);

/** 只作浏览器导航，绝不在服务端请求该地址。允许 HTTPS/HTTP 和应用的 scheme:// 深链接。 */
export function isReplyRedirectUrl(value: string): boolean {
  if (!value || value.length > REPLY_REDIRECT_MAX_LENGTH || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password && !blockedSchemes.has(url.protocol);
  } catch {
    return false;
  }
}

export const replyCallbackUrlSchema = z.string().max(4096).refine((value) => {
  const matches = [...value.matchAll(placeholder)];
  if (!matches.length) return false;
  // 占位符只允许在路径、查询参数或片段中，不能改变协议或目标主机。
  const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)?.[0];
  return !!authority && matches.every((match) => match.index! >= authority.length)
    && isReplyRedirectUrl(value.replace(placeholder, 'message'));
}, '回复回调 URL 必须是有效的网页或应用深链接，并在路径、查询参数或片段中包含 {message} 占位符');

export function resolveReplyCallbackUrl(template: string, message: string): string {
  replyCallbackUrlSchema.parse(template);
  const target = template.replace(placeholder, () => encodeURIComponent(message));
  if (!isReplyRedirectUrl(target)) throw new Error('回复回调 URL 展开后无效或过长，请减少消息占位符或缩短链接');
  return target;
}

/** 用片段包裹完整目标，避免目标 URL 和消息被发送到中转页的 HTTP 日志。 */
export function buildReplyRedirectUrl(baseUrl: string, template: string, message: string): string {
  const target = resolveReplyCallbackUrl(template, message);
  const url = new URL(baseUrl.replace(/\/$/, '') + REPLY_REDIRECT_PATH);
  url.hash = new URLSearchParams({ url: target }).toString();
  return url.toString();
}

export function readReplyRedirectUrl(hash: string): string | null {
  const target = new URLSearchParams(hash.replace(/^#/, '')).get('url');
  return target && isReplyRedirectUrl(target) ? target : null;
}
