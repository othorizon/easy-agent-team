import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();

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
