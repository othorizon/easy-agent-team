import { Module } from '@nestjs/common';
import { RamModule } from '../ram/ram.module';
import { CloudIdentitiesService } from './cloud-identities.service';

@Module({ imports: [RamModule], providers: [CloudIdentitiesService], exports: [CloudIdentitiesService] })
export class CloudIdentitiesModule {}
