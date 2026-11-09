import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { aliyunConnections, ossSettings } from '../db/schema';
import { decryptSecret } from '../common/crypto';
import type { RamCredentials } from '../ram/ram-cloud';

/** Shared control-plane credentials; independent of capability availability and pause state. */
@Injectable()
export class CloudIdentityCredentialsService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async forAccount(accountId: string): Promise<RamCredentials> {
    const [connection] = await this.db.select().from(aliyunConnections).where(eq(aliyunConnections.accountId, accountId));
    const [oss] = connection && !connection.cleanupState ? [] : await this.db.select().from(ossSettings).where(eq(ossSettings.accountId, accountId));
    const source = oss ?? connection;
    if (!source) throw new ServiceUnavailableException('缺少此云账号的管理凭证，请检查接入或 OSS 配置');
    return { accessKeyId: decryptSecret(source.accessKeyIdEncrypted), accessKeySecret: decryptSecret(source.accessKeySecretEncrypted) };
  }
}
