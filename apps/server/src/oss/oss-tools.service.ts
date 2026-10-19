import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ossToolRequest,
  type RequestOssSpace,
  type UpdateOssSpace,
} from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { OssService } from './oss.service';

@Injectable()
export class OssToolsService {
  constructor(private readonly oss: OssService) {}
  async call(user: AuthUser, name: string, input: unknown) {
    try {
      const request = ossToolRequest(name, input, randomUUID());
      const args = (input ?? {}) as Record<string, unknown>;
      switch (name) {
        case 'get_oss_status':
          return this.oss.capability();
        case 'request_oss_space':
          return this.oss.request(user, request.body as RequestOssSpace);
        case 'list_oss_spaces':
          return this.oss.list(user);
        case 'get_oss_space':
          return this.oss.get(user, args.space as string);
        case 'update_oss_space':
          return this.oss.update(
            user,
            args.space as string,
            request.body as UpdateOssSpace,
          );
        case 'set_oss_space_public_read':
          return this.oss.publicRead(
            user,
            args.space as string,
            (request.body as { enabled: boolean }).enabled,
          );
        case 'get_oss_credentials':
          return this.oss.credentials(user);
        case 'reset_oss_credentials':
          return this.oss.resetCredentials(user);
        case 'get_oss_operation':
          return this.oss.operation(user, args.operationId as string);
      }
    } catch (e) {
      if (e instanceof z.ZodError)
        throw new BadRequestException({
          error: 'VALIDATION_FAILED',
          message: 'OSS 工具参数不合法',
          details: e.issues,
        });
      throw e;
    }
  }
}
