import { Module } from '@nestjs/common';
import { DbsController } from './dbs.controller';
import { DbsService } from './dbs.service';

@Module({
  controllers: [DbsController],
  providers: [DbsService],
})
export class DbsModule {}
