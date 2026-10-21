import { Global, Module } from '@nestjs/common';
import { GithubClient } from './github.client';
import { GithubStore } from './github.store';
import { GithubService } from './github.service';
import { GithubController } from './github.controller';
import { GithubSetupService } from './github-setup.service';
import { GithubCollaboratorsService } from './github-collaborators.service';
@Global()
@Module({ controllers: [GithubController], providers: [GithubClient, GithubStore, GithubSetupService, GithubService, GithubCollaboratorsService], exports: [GithubStore, GithubService] })
export class GithubModule {}
