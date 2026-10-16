import { Module, OnModuleInit, type NestModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { SiteCommentsService } from './site-comments.service';
import { SiteGateway } from './site-gateway.service';
import { SiteStorage } from './site-storage.service';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';
import { SiteToolsService } from './site-tools.service';

@Module({
  imports: [AuthModule],
  controllers: [SitesController],
  providers: [SitesService, SiteStorage, SiteCommentsService, SiteGateway, SiteToolsService],
  exports: [SitesService, SiteCommentsService, SiteToolsService],
})
export class SitesModule implements OnModuleInit, NestModule {
  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly gateway: SiteGateway,
  ) {}
  configure() {
    this.adapter.httpAdapter
      .getInstance()
      .addHook('onRoute', (options: { config?: { eatSiteUpload?: boolean }; bodyLimit?: number }) => {
        if (options.config?.eatSiteUpload) options.bodyLimit = 72 * 1024 * 1024;
      });
  }
  onModuleInit() {
    const instance = this.adapter.httpAdapter.getInstance();
    // 必须在控制台静态资源、API 和 SPA 回退之前拦截站点域名，防止跨源身份泄露。
    instance.addHook('onRequest', this.gateway.handle.bind(this.gateway));
  }
}
