import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  createHelpRequestSchema,
  distillRequestSchema,
  replyHelpRequestSchema,
  upsertHelperProfileSchema,
  type CreateHelpRequest,
  type DistillRequest,
  type ReplyHelpRequest,
  type UpsertHelperProfileRequest,
} from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { ExperiencesService } from './experiences.service';
import { HelpService } from './help.service';
import { HelpersService } from './helpers.service';

@Controller('api')
export class HelpController {
  constructor(
    private readonly helpers: HelpersService,
    private readonly help: HelpService,
    private readonly experiences: ExperiencesService,
  ) {}

  // ---------- 可求助者登记 ----------

  @Get('helpers')
  targets() {
    return this.helpers.targets();
  }

  @Get('helpers/me')
  myProfile(@CurrentUser() user: AuthUser) {
    return this.helpers.getMine(user);
  }

  @Put('helpers/me')
  upsertProfile(
    @Body(new ZodValidationPipe(upsertHelperProfileSchema)) body: UpsertHelperProfileRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.helpers.upsertMine(user, body);
  }

  @Delete('helpers/me')
  removeProfile(@CurrentUser() user: AuthUser) {
    return this.helpers.removeMine(user);
  }

  // ---------- 求助 ----------

  @Post('help-requests')
  create(@Body(new ZodValidationPipe(createHelpRequestSchema)) body: CreateHelpRequest, @CurrentUser() user: AuthUser) {
    return this.help.create(user, body);
  }

  @Get('help-requests/mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.help.listMine(user);
  }

  @Get('help-requests/inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.help.listInbox(user);
  }

  @Get('help-requests/:id')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.help.detail(user, id);
  }

  @Post('help-requests/:id/reply')
  reply(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replyHelpRequestSchema)) body: ReplyHelpRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.help.reply(user, id, body.content);
  }

  @Post('help-requests/:id/resolve')
  resolve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.help.resolve(user, id);
  }

  @Post('help-requests/:id/close')
  close(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.help.close(user, id);
  }

  // ---------- 经验 ----------

  @Post('help-requests/:id/distill')
  distill(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(distillRequestSchema)) body: DistillRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.experiences.distill(user, id, body);
  }

  @Get('experiences')
  search(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.experiences.search(user, q);
  }
}
