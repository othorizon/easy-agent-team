import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { githubCollaboratorChangeSchema, type GithubCollaboratorChange, githubRoleSchema, githubSettingsSchema, githubSetupSchema, type GithubSetupRequest, type UpdateGithubSettings, type GithubRole } from '@eat/shared';
import { AllowIncompleteProfile, CurrentUser, Public, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { loadConfig } from '../config';
import { GithubService } from './github.service';
import { GithubError } from './github.client';
import { GithubSetupService } from './github-setup.service';
import { GithubCollaboratorsService } from './github-collaborators.service';

const roleBody = z.object({ role: githubRoleSchema });
const actionBody = z.object({ action: z.enum(['refresh', 'join', 'accept', 'remove-org']) });
@Controller('api')
export class GithubController {
  constructor(private readonly github: GithubService, private readonly setup: GithubSetupService,
    private readonly collaborators: GithubCollaboratorsService) {}
  private userId(value: string) {
    const result = z.uuid().safeParse(value);
    if (!result.success) throw new BadRequestException('用户 ID 无效');
    return result.data;
  }
  private async run<T>(f: () => Promise<T>) {
    try { return await f(); } catch (e) { if (e instanceof GithubError) throw new BadRequestException(e.message); throw e; }
  }
  @Get('settings/github') @Roles('admin')
  settings() { return this.github.store.settings(); }
  @Put('settings/github') @Roles('admin')
  save(@Body(new ZodValidationPipe(githubSettingsSchema)) body: UpdateGithubSettings) {
    return this.run(() => this.github.store.save(body));
  }
  @Post('settings/github/check') @Roles('admin')
  check() { return this.run(() => this.github.check()); }
  private setupCookie(reply: FastifyReply, browser = '') {
    const secure = loadConfig().publicUrl.startsWith('https:') ? '; Secure' : '';
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    reply.header('Set-Cookie', `eat_github_setup=${browser}; Path=/api/github/setup; HttpOnly; SameSite=Lax; Max-Age=${browser ? 1800 : 0}${secure}`);
  }
  private setupBrowser(request: FastifyRequest) {
    return request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('eat_github_setup='))?.slice('eat_github_setup='.length) ?? '';
  }
  @Post('settings/github/initialize') @Roles('admin')
  async initialize(@Body(new ZodValidationPipe(githubSetupSchema)) body: GithubSetupRequest,
    @CurrentUser() user: AuthUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const { browser, ...result } = await this.run(() => this.setup.create(user, body));
    this.setupCookie(reply, browser); return result;
  }
  @Post('settings/github/install') @Roles('admin')
  async install(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const { browser, ...result } = await this.run(() => this.setup.install(user));
    this.setupCookie(reply, browser); return result;
  }
  @Post('settings/github/enabled') @Roles('admin')
  async enabled(@Body(new ZodValidationPipe(z.object({ enabled: z.boolean() }))) body: { enabled: boolean }) {
    const result = await this.run(() => this.setup.setEnabled(body.enabled));
    this.github.wake(); return result;
  }
  @Get('github/setup/manifest') @Public()
  async manifestCallback(@Query('state') state: string, @Query('code') code: string,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    let result = 'failed';
    try { await this.setup.finishCreate(state, this.setupBrowser(request), code); result = 'created'; } catch { /* No provider secrets in responses. */ }
    this.setupCookie(reply);
    // Nest sets 200 before this handler; Fastify otherwise reuses it instead of redirecting.
    return reply.redirect(`${loadConfig().publicUrl.replace(/\/$/, '')}/settings?section=github&github_setup=${result}`, 302);
  }
  // The manifest registers an inactive webhook (GitHub wants a URL), yet GitHub still sends a `ping` when the
  // App is created and on "Redeliver". EAT subscribes to no events and never acts on deliveries: acknowledge
  // without reading the body, so the App's Recent Deliveries shows success instead of 404.
  @Post('github/events') @Public() @HttpCode(204)
  events() { /* Intentionally ignored. */ }
  @Get('github/setup/installation') @Public()
  async installationCallback(@Query('state') state: string, @Query('installation_id') installationId: string,
    @Query('setup_action') action: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    let result = 'failed';
    try { result = await this.setup.finishInstall(state, this.setupBrowser(request), installationId, action); this.github.wake(); } catch { /* No provider secrets in responses. */ }
    this.setupCookie(reply);
    return reply.redirect(`${loadConfig().publicUrl.replace(/\/$/, '')}/settings?section=github&github_setup=${result}`, 302);
  }
  @Get('account/github') @AllowIncompleteProfile()
  account(@CurrentUser() user: AuthUser) { return this.github.accountInfo(user.id); }
  @Post('account/github/authorize') @AllowIncompleteProfile()
  async authorize(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.run(() => this.github.authorize(user));
    const secure = loadConfig().publicUrl.startsWith('https:') ? '; Secure' : '';
    reply.header('Set-Cookie', `eat_github_browser=${result.browser}; Path=/api/github/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
    return { url: result.url };
  }
  @Get('github/callback') @Public()
  async callback(@Query('state') state: string, @Query('code') code: string,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const browser = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('eat_github_browser='))?.slice('eat_github_browser='.length) ?? '';
    let success = false;
    try { await this.github.callback(state, browser, code); success = true; } catch { /* Never put provider errors or tokens into the redirect. */ }
    reply.header('Set-Cookie', 'eat_github_browser=; Path=/api/github/callback; HttpOnly; SameSite=Lax; Max-Age=0');
    return reply.redirect(`${loadConfig().publicUrl.replace(/\/$/, '')}/account?github=${success ? 'linked' : 'failed'}`, 302);
  }
  @Delete('account/github') @AllowIncompleteProfile()
  unlink(@CurrentUser() user: AuthUser) { return this.github.unlink(user.id); }
  @Post('account/github/accept') @AllowIncompleteProfile()
  accept(@CurrentUser() user: AuthUser) { return this.run(() => this.github.accountAction(user, user.id, 'accept')); }
  @Post('account/github/refresh') @AllowIncompleteProfile()
  refresh(@CurrentUser() user: AuthUser) { return this.run(() => this.github.accountAction(user, user.id, 'refresh')); }
  @Get('users/:id/github') @Roles('admin')
  userAccount(@Param('id') id: string) { return this.github.accountInfo(this.userId(id)); }
  @Post('users/:id/github') @Roles('admin')
  userAction(@Param('id') id: string, @Body(new ZodValidationPipe(actionBody)) body: z.infer<typeof actionBody>, @CurrentUser() user: AuthUser) {
    return this.run(() => this.github.accountAction(user, this.userId(id), body.action));
  }
  @Get('apps/:slug/github')
  app(@Param('slug') slug: string, @CurrentUser() user: AuthUser) { return this.github.appInfo(slug, user); }
  @Get('apps/:slug/github/collaborators')
  repositoryMembers(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.run(() => this.collaborators.list(slug, user));
  }
  @Put('apps/:slug/github/collaborators/:githubId')
  changeCollaborator(@Param('slug') slug: string, @Param('githubId') githubId: string,
    @Body(new ZodValidationPipe(githubCollaboratorChangeSchema)) body: GithubCollaboratorChange, @CurrentUser() user: AuthUser) {
    if (!/^\d+$/.test(githubId)) throw new BadRequestException('GitHub 用户 ID 无效');
    return this.run(async () => {
      try { return await this.collaborators.change(slug, githubId, body, user); }
      finally { this.github.wake(); }
    });
  }
  @Post('apps/:slug/github/refresh')
  refreshApp(@Param('slug') slug: string) { return this.run(() => this.github.refreshApp(slug)); }
  @Post('apps/:slug/github/members/:id/retry')
  retry(@Param('slug') slug: string, @Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.run(() => this.github.grant(slug, this.userId(id), user));
  }
  @Post('apps/:slug/github/members/:id/add')
  add(@Param('slug') slug: string, @Param('id') id: string,
    @Body(new ZodValidationPipe(roleBody)) body: { role: GithubRole }, @CurrentUser() user: AuthUser) {
    // An explicit add is a new intent, never a retry of an older requested role.
    return this.run(() => this.github.grant(slug, this.userId(id), user, body.role === 'write' ? undefined : body.role, false));
  }
  @Put('apps/:slug/github/members/:id/role')
  role(@Param('slug') slug: string, @Param('id') id: string, @Body(new ZodValidationPipe(roleBody)) body: { role: GithubRole }, @CurrentUser() user: AuthUser) {
    return this.run(() => this.github.grant(slug, this.userId(id), user, body.role));
  }
  @Get('settings/github/cleanup') @Roles('admin')
  cleanupState() { return this.github.cleanupState(); }
  @Post('settings/github/cleanup') @Roles('admin')
  cleanup() { return this.run(() => this.github.retryCleanup()); }
}
