import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  llmAdjustQuotaSchema,
  llmOperationSchema,
  llmSettingsSchema,
  llmStatusRequestSchema,
  llmUserPolicySchema,
  type LlmAdjustQuotaRequest,
  type LlmSettingsRequest,
  type LlmUserPolicyRequest,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { LlmGatewayService } from './llm-gateway.service';
import { LlmSettingsService } from './llm-settings.service';

const usageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyId: z.uuid().optional(),
});

@Controller('api/llm-gateway')
export class LlmGatewayController {
  constructor(private readonly gateway: LlmGatewayService) {}
  @Get() @Header('Cache-Control', 'no-store') info(@CurrentUser() u: AuthUser) {
    return this.gateway.info(u.id);
  }
  @Get('models') models(@CurrentUser() u: AuthUser) {
    return this.gateway.models(u.id);
  }
  @Get('keys/history') @Header('Cache-Control', 'no-store') history(@CurrentUser() u: AuthUser) {
    return this.gateway.history(u.id);
  }
  @Post('retry') @HttpCode(200) retry(@CurrentUser() u: AuthUser) {
    return this.gateway.retry(u.id);
  }
  @Get('usage') @Header('Cache-Control', 'no-store') usage(
    @CurrentUser() u: AuthUser,
    @Query(new ZodValidationPipe(usageQuery)) q: z.infer<typeof usageQuery>,
  ) {
    return this.gateway.usage(u.id, q.page, q.pageSize, q.keyId);
  }
  @Post('key')
  @HttpCode(200)
  create(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(llmOperationSchema)) b: { requestId: string }) {
    return this.gateway.operate(u.id, u.id, 'create', b.requestId);
  }
  @Put('key/status')
  status(
    @CurrentUser() u: AuthUser,
    @Body(new ZodValidationPipe(llmStatusRequestSchema)) b: { requestId: string; enabled: boolean },
  ) {
    return this.gateway.operate(u.id, u.id, 'status', b.requestId, { enabled: b.enabled });
  }
  @Delete('key')
  @HttpCode(200)
  remove(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(llmOperationSchema)) b: { requestId: string }) {
    return this.gateway.operate(u.id, u.id, 'delete', b.requestId);
  }
  @Post('key/reveal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  reveal(@CurrentUser() u: AuthUser) {
    return this.gateway.reveal(u.id, u.id);
  }
}

@Controller('api/admin/llm-gateway-settings')
@Roles('admin')
export class LlmGatewaySettingsController {
  constructor(private readonly settings: LlmSettingsService) {}
  @Get() @Header('Cache-Control', 'no-store') info() {
    return this.settings.info();
  }
  @Get('account') @Header('Cache-Control', 'no-store') account() {
    return this.settings.account();
  }
  @Put() save(@Body(new ZodValidationPipe(llmSettingsSchema)) b: LlmSettingsRequest, @CurrentUser() u: AuthUser) {
    return this.settings.save(b, u.id);
  }
  @Post('test')
  @HttpCode(200)
  test(@Body(new ZodValidationPipe(llmSettingsSchema)) b: LlmSettingsRequest) {
    return this.settings.test(b);
  }
}

@Controller('api/admin/llm-gateway')
@Roles('admin')
export class LlmGatewayAdminController {
  constructor(private readonly gateway: LlmGatewayService) {}
  @Get('users') @Header('Cache-Control', 'no-store') users() {
    return this.gateway.list();
  }
  @Post('users/:id/retry')
  @HttpCode(200)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.gateway.retry(id);
  }
  @Put('users/:id/policy')
  policy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() u: AuthUser,
    @Body(new ZodValidationPipe(llmUserPolicySchema)) b: LlmUserPolicyRequest,
  ) {
    const { requestId, ...payload } = b;
    return this.gateway.operate(id, u.id, 'policy', requestId, payload);
  }
  @Post('users/:id/quota')
  @HttpCode(200)
  quota(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() u: AuthUser,
    @Body(new ZodValidationPipe(llmAdjustQuotaSchema)) b: LlmAdjustQuotaRequest,
  ) {
    const { requestId, ...payload } = b;
    return this.gateway.operate(id, u.id, 'quota', requestId, payload);
  }
}
