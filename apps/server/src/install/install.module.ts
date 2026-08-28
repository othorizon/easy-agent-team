import { Module } from '@nestjs/common';
import { InstallController } from './install.controller';

@Module({ controllers: [InstallController] })
export class InstallModule {}
