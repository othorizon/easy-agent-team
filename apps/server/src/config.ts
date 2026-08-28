import * as path from 'node:path';

/** 平台配置：全部来自环境变量，开发期有安全的默认值 */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** 值加密主密钥（base64，32 字节）。生产必须显式配置 */
  kek: string;
  /** 对外访问地址，用于设备码授权页等链接拼接 */
  publicUrl: string;
  /** CLI 单文件产物路径（平台自托管下载）。默认按 monorepo/镜像布局从 server dist 相对定位 */
  cliDistPath: string;
}

export function loadConfig(): AppConfig {
  const kek = process.env.EAT_KEK ?? '';
  if (!kek && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 EAT_KEK（base64 编码的 32 字节主密钥）');
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_dev',
    // 开发缺省密钥：仅为本地跑通，不用于任何真实数据
    kek: kek || Buffer.from('eat-dev-insecure-kek-32-bytes!!!').toString('base64'),
    publicUrl: process.env.EAT_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
    // 与 web dist 同一套相对布局约定：apps/server/dist → apps/cli/dist（镜像内 /app/server/dist → /app/cli/dist）
    cliDistPath: process.env.EAT_CLI_DIST ?? path.resolve(__dirname, '../../cli/dist/index.js'),
  };
}
