import { Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';

export class CdnApiError extends Error {
  constructor(
    readonly action: string,
    readonly code: string,
  ) {
    super(`阿里云 CDN ${action} 失败（${code}），请检查服务开通、RAM 权限及配置`);
  }
}
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export interface CdnCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}
/** Injectable boundary: no provider responses, request bodies or credentials are logged. */
@Injectable()
export class SiteCdnClient {
  async call(credentials: CdnCredentials, action: string, extra: Record<string, string> = {}): Promise<any> {
    const params: Record<string, string> = {
      Format: 'JSON',
      Version: '2018-05-10',
      AccessKeyId: credentials.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Action: action,
      ...extra,
    };
    const canonical = Object.keys(params)
      .sort()
      .map((k) => `${encode(k)}=${encode(params[k])}`)
      .join('&');
    params.Signature = createHmac('sha1', `${credentials.accessKeySecret}&`)
      .update(`POST&%2F&${encode(canonical)}`)
      .digest('base64');
    let response: Response;
    try {
      response = await fetch('https://cdn.aliyuncs.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
    } catch {
      throw new CdnApiError(action, 'NETWORK_ERROR');
    }
    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new CdnApiError(action, 'INVALID_RESPONSE');
    }
    if (!response.ok || json.Code)
      throw new CdnApiError(
        action,
        String(json.Code ?? response.status)
          .replace(/[^a-zA-Z0-9._-]/g, '')
          .slice(0, 100),
      );
    return json;
  }
}

export const cdnFunction = (functionName: string, args: Record<string, string>) => ({
  functionName,
  functionArgs: Object.entries(args).map(([argName, argValue]) => ({ argName, argValue })),
});
