import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  requestDecisionSchema,
  requestListSchema,
  requestResubmitSchema,
  type RequestDecision,
  type RequestListQuery,
} from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { RequestsService } from './requests.service';
import { z } from 'zod';
import { verifyRequestActionToken } from './request-action-link';

@Controller('api/requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}
  @Post(':id/notification-approve') approveFromNotification(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(z.object({ token: z.string().min(1).max(2048) }).strict()))
    dto: { token: string },
  ) {
    verifyRequestActionToken(dto.token, id, u.id);
    return this.requests.decide(u, id, { decision: 'approved' });
  }
  @Get() list(
    @CurrentUser() u: AuthUser,
    @Query(new ZodValidationPipe(requestListSchema)) q: RequestListQuery,
  ) {
    return this.requests.list(u, q);
  }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.get(u, id);
  }
  @Post(':id/decision') decide(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(requestDecisionSchema)) dto: RequestDecision,
  ) {
    return this.requests.decide(u, id, dto);
  }
  @Post(':id/withdraw') withdraw(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.withdraw(u, id);
  }
  @Post(':id/resubmit') resubmit(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(requestResubmitSchema)) dto: { reason: string },
  ) {
    return this.requests.resubmit(u, id, dto.reason);
  }
  @Post(':id/remind') remind(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.remind(u, id);
  }
}
