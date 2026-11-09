import { Module } from '@nestjs/common';
import { RamCloud } from './ram-cloud';

@Module({ providers: [RamCloud], exports: [RamCloud] })
export class RamModule {}
