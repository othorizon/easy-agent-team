import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  deviceApproveRequestSchema,
  devicePollRequestSchema,
  loginRequestSchema,
  type DeviceApproveRequest,
  type DevicePollRequest,
  type LoginRequest,
} from '@eat/shared';
import { ZodValidationPipe } from '../common/zod.pipe';
import { CurrentUser, Public, type AuthUser } from './auth.decorators';
import { AuthService } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest, @Req() req: FastifyRequest) {
    return this.auth.login(body.email, body.password, req.ip);
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
