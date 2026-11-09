import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { dbAccessGrantQuerySchema, dbPersonalPasswordResetSchema, type DbAccessGrantQuery, dbAccessCredentialsSchema, dbAccessGrantInfoSchema, dbAccessGrantListSchema, dbCatalogInfoSchema, dbCatalogListSchema, grantDbAccessSchema, openDbAccessSchema, registerExternalDbSchema, revokeDbAccessSchema, type GrantDbAccessRequest, type OpenDbAccessRequest, type RegisterExternalDbRequest, type RevokeDbAccessRequest } from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DbAccessRequests } from './db-access-requests';
import { requestDbAccessSchema, dbAccessRequestResultSchema, type RequestDbAccess } from '@eat/shared';
import { DbAccessService } from './db-access.service';

@Controller('api/db')
export class DbAccessController {
  constructor(private readonly access: DbAccessService, private readonly requests: DbAccessRequests) {}
  @Post('access/catalog/:id/requests')
  async request(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(requestDbAccessSchema)) body: RequestDbAccess) { return dbAccessRequestResultSchema.parse(await this.requests.submit(user, id, body)); }
  @Get('access/catalog')
  async catalog(@CurrentUser() user: AuthUser) { return dbCatalogListSchema.parse(await this.access.listCatalog(user)); }
  @Post('instances/:id/access/catalog')
  async registerExternal(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(registerExternalDbSchema)) body: RegisterExternalDbRequest) { return dbCatalogInfoSchema.parse(await this.access.registerExternal(user, id, body)); }
  @Post('access/catalog/:id/access')
  async configureExternal(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(openDbAccessSchema)) body: OpenDbAccessRequest) { return dbCatalogInfoSchema.parse(await this.access.configureExternal(user, id, body)); }
  @Post('assignments/:id/access')
  async open(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(openDbAccessSchema)) body: OpenDbAccessRequest) { return dbCatalogInfoSchema.parse(await this.access.open(user, id, body)); }
  @Post('access/catalog/:id/reapply')
  async reapply(@CurrentUser() user: AuthUser, @Param('id') id: string) { return dbCatalogInfoSchema.parse(await this.access.reapply(user, id)); }
  @Get('access/grants')
  async grants(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(dbAccessGrantQuerySchema)) query: DbAccessGrantQuery) { return dbAccessGrantListSchema.parse(await this.access.listGrants(user, query.scope)); }
  @Post('access/catalog/:id/grants')
  async give(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(grantDbAccessSchema)) body: GrantDbAccessRequest) { return dbAccessGrantInfoSchema.parse(await this.access.give(user, id, body)); }
  @Post('access/catalog/:id/credentials')
  @Header('Cache-Control', 'no-store')
  async credentials(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: FastifyRequest) { return dbAccessCredentialsSchema.parse(await this.access.credentials(user, id, req.ip)); }
  @Post('access/catalog/:id/reset-password')
  @Header('Cache-Control', 'no-store')
  async resetPassword(@CurrentUser() user: AuthUser, @Param('id') id: string) { return dbPersonalPasswordResetSchema.parse(await this.access.resetPassword(user, id)); }
  @Post('access/grants/:id/revoke')
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(revokeDbAccessSchema)) body: RevokeDbAccessRequest) { return dbAccessGrantInfoSchema.parse(await this.access.revoke(user, id, body.reason)); }
  @Post('access/grants/:id/relinquish')
  async relinquish(@CurrentUser() user: AuthUser, @Param('id') id: string) { return dbAccessGrantInfoSchema.parse(await this.access.revoke(user, id, '', true)); }
  @Post('access/grants/:id/retry')
  async retry(@CurrentUser() user: AuthUser, @Param('id') id: string) { return dbAccessGrantInfoSchema.parse(await this.access.retry(user, id)); }
}
