import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  deviceApproveRequestSchema,
  devicePollRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  type DeviceApproveRequest,
  type DevicePollRequest,
  type LoginRequest,
  type RegisterRequest,
} from '@eat/shared';
import { ZodValidationPipe } from '../common/zod.pipe';
import { CurrentUser, Public, type AuthUser } from './auth.decorators';
import { AuthService } from './auth.service';
import { RegistrationService } from './registration.service';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly registration: RegistrationService,
  ) {}

  @Public()
  @Post('login')
  login(@Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest, @Req() req: FastifyRequest) {
    return this.auth.login(body.email, body.password, req.ip);
  }

  /** 登录页探测：是否开放注册与后缀限制（后缀本身不敏感，用于表单提示） */
  @Public()
  @Get('registration')
  registrationInfo() {
    return this.registration.getSettings();
  }

  @Public()
  @Post('register')
  register(@Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest, @Req() req: FastifyRequest) {
    return this.registration.register(body, req.ip);
  }

  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser) {
    const { tokenId: _tokenId, ...rest } = user;
    return rest;
  }

  @Public()
  @Post('device/start')
  deviceStart() {
    return this.auth.deviceStart();
  }

  @Post('device/approve')
  deviceApprove(
    @Body(new ZodValidationPipe(deviceApproveRequestSchema)) body: DeviceApproveRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.auth.deviceApprove(user, body.userCode, body.tokenName);
  }

  @Public()
  @Post('device/poll')
  devicePoll(@Body(new ZodValidationPipe(devicePollRequestSchema)) body: DevicePollRequest) {
    return this.auth.devicePoll(body.deviceCode);
  }

  @Get('tokens')
  listTokens(@CurrentUser() user: AuthUser) {
    return this.auth.listTokens(user.id);
  }

  @Delete('tokens/:id')
  revokeToken(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.auth.revokeToken(user, id);
  }
}
