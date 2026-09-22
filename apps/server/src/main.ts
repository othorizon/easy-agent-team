import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // 空闲连接活得比前置代理久，否则代理复用一条平台刚关掉的连接就是一个 502（决策 61）
    new FastifyAdapter({ keepAliveTimeout: config.keepAliveTimeoutMs }),
    { logger: ['log', 'warn', 'error'] },
  );
  app.enableShutdownHooks();

  // headersTimeout 必须比 keepAliveTimeout 大：这是同一个竞态的另一半——
  // 连接在请求头刚发到一半时被回收，同样以 502 的形式落到调用方身上。
  const httpServer = app.getHttpAdapter().getInstance().server;
  httpServer.headersTimeout = config.keepAliveTimeoutMs + 5_000;

  // 控制台前端静态资源（apps/web 构建产物）；SPA 路由回退在异常过滤器里处理
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(import('@fastify/static') as never, {
      root: path.join(webDist, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
    });
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`easy-agent-team server 已启动: http://localhost:${config.port}`);
}

void bootstrap();
