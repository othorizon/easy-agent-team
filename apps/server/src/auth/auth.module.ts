import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';

@Module({
  controllers: [AuthController, RegistrationController, AccountController],
  providers: [AuthService, AccountService, RegistrationService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
