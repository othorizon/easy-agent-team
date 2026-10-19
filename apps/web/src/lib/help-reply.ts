import type { ReplyHelpRequest } from '@eat/shared';
import { api } from '../api';

export type HelpReplyInput = ReplyHelpRequest & { resolve?: boolean };

/** 回复失败直接抛错；回复已保存但标记失败单独返回，避免重试时重复发送。 */
export async function sendHelpReply(
  requestId: string,
  { content, reopen, resolve }: HelpReplyInput,
): Promise<{ resolveError: Error | null }> {
  await api('POST', `/api/help-requests/${requestId}/reply`, { content, reopen });
  if (resolve) {
    try {
      await api('POST', `/api/help-requests/${requestId}/resolve`, {});
    } catch (error) {
      return { resolveError: error instanceof Error ? error : new Error('标记已解决失败') };
    }
  }
  return { resolveError: null };
}
