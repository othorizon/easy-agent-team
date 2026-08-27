import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { loadConfig } from '../config';

/**
 * 秘密值信封加密：
 * 每个值生成独立数据密钥 DEK（AES-256-GCM 加密明文），DEK 再由主密钥 KEK 包裹。
 * 存储格式: v1.<b64(iv|tag|wrappedDek)>.<b64(iv|tag|ciphertext)>
 */

function kekBytes(): Buffer {
  const kek = Buffer.from(loadConfig().kek, 'base64');
  if (kek.length !== 32) throw new Error('EAT_KEK 必须是 base64 编码的 32 字节密钥');
  return kek;
}

function aeadEncrypt(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function aeadDecrypt(key: Buffer, packed: string): Buffer {
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptSecret(plaintext: string): string {
  const dek = randomBytes(32);
  const wrappedDek = aeadEncrypt(kekBytes(), dek);
  const body = aeadEncrypt(dek, Buffer.from(plaintext, 'utf8'));
  return `v1.${wrappedDek}.${body}`;
}

export function decryptSecret(stored: string): string {
  const [version, wrappedDek, body] = stored.split('.');
  if (version !== 'v1' || !wrappedDek || !body) throw new Error('密文格式不合法');
  const dek = aeadDecrypt(kekBytes(), wrappedDek);
  return aeadDecrypt(dek, body).toString('utf8');
}

/** Token 等凭证的不可逆指纹（存库用，不存明文） */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(prefix = 'eat'): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}
