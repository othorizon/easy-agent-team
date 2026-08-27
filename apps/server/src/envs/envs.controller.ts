import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  createAccessRequestSchema,
  createEnvironmentSchema,
  createGrantSchema,
  decideAccessRequestSchema,
  pullValuesRequestSchema,
  updateEnvironmentSchema,
  upsertVariableSchema,
  type CreateAccessRequest,
  type CreateEnvironmentRequest,
  type CreateGrantRequest,
  type DecideAccessRequest,
  type PullValuesRequest,
  type UpdateEnvironmentRequest,
  type UpsertVariableRequest,
} from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AccessRequestsService } from './access-requests.service';
import { EnvsService } from './envs.service';

@Controller('api')
export class EnvsController {
  constructor(
    private readonly envs: EnvsService,
    private readonly accessRequests: AccessRequestsService,
  ) {}

  // ---------- 环境 ----------

  @Get('envs')
  listEnvironments() {
    return this.envs.listEnvironments();
  }

  @Post('envs')
  createEnvironment(
    @Body(new ZodValidationPipe(createEnvironmentSchema)) body: CreateEnvironmentRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.envs.createEnvironment(user, body);
  }

  @Patch('envs/:slug')
  updateEnvironment(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateEnvironmentSchema)) body: UpdateEnvironmentRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.envs.updateEnvironment(user, slug, body);
  }

  @Delete('envs/:slug')
  deleteEnvironment(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.envs.deleteEnvironment(user, slug);
  }

  // ---------- 变量 ----------

  /** 全量清单（跨环境，不含值），供 CLI / MCP 认路 */
  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser) {
    return this.envs.catalog(user);
  }

  @Get('envs/:slug/variables')
  listVariables(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.envs.listVariables(user, slug);
  }

  @Post('envs/:slug/variables')
  upsertVariable(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(upsertVariableSchema)) body: UpsertVariableRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.envs.upsertVariable(user, slug, body);
  }

  @Delete('envs/:slug/variables/:key')
  deleteVariable(@Param('slug') slug: string, @Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.envs.deleteVariable(user, slug, key);
  }

  /** 拉取变量值（敏感读取，审计落库） */
  @Post('envs/:slug/values')
  pullValues(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(pullValuesRequestSchema)) body: PullValuesRequest,
    @CurrentUser() user: AuthUser,
    @Req() req: FastifyRequest,
  ) {
    return this.envs.pullValues(user, slug, body.keys, req.ip);
  }

  // ---------- 授权 ----------

  @Get('envs/:slug/grants')
  listGrants(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.envs.listGrants(user, slug);
  }

  @Post('envs/:slug/grants')
  createGrant(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(createGrantSchema)) body: CreateGrantRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.envs.createGrant(user, slug, body);
  }

  @Delete('grants/:id')
  revokeGrant(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.envs.revokeGrant(user, id);
  }

  // ---------- 权限申请 ----------

  @Post('access-requests')
  createAccessRequest(
    @Body(new ZodValidationPipe(createAccessRequestSchema)) body: CreateAccessRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.accessRequests.create(user, body);
  }

  @Get('access-requests/mine')
  myAccessRequests(@CurrentUser() user: AuthUser) {
    return this.accessRequests.listMine(user);
  }

  @Get('access-requests/inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.accessRequests.listInbox(user);
  }

  @Get('access-requests/:id')
  getAccessRequest(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.accessRequests.get(user, id);
  }

  @Post('access-requests/:id/decision')
  decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideAccessRequestSchema)) body: DecideAccessRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.accessRequests.decide(user, id, body);
  }
}
