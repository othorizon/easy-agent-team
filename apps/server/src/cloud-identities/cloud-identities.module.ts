import { CloudIdentityCredentialsService } from './cloud-identity-credentials.service';
import { CloudIdentityStatusService } from './cloud-identity-status.service';
import { Module } from '@nestjs/common';
import { RamModule } from '../ram/ram.module';
import { CloudIdentitiesService } from './cloud-identities.service';

@Module({ imports: [RamModule], providers: [CloudIdentitiesService, CloudIdentityCredentialsService, CloudIdentityStatusService], exports: [CloudIdentitiesService, CloudIdentityCredentialsService, CloudIdentityStatusService] })
export class CloudIdentitiesModule {}
