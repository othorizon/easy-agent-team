import { Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const identifier = (value?: string) =>
  value && /^[a-z][a-z0-9_]{0,79}$/i.test(value) ? value : undefined;
interface CdnErrorDetails {
  functionName?: string;
  parameter?: string;
}

export class CdnApiError extends Error {
  readonly functionName?: string;
  readonly parameter?: string;
  constructor(
    readonly action: string,
    readonly code: string,
    details: CdnErrorDetails = {},
  ) {
    const fn = identifier(details.functionName),
      parameter = identifier(details.parameter);
    const context = [code, fn && `功能：${fn}`, parameter && `参数：${parameter}`]
      .filter(Boolean)
      .join('；');
    super(
      `阿里云 CDN ${action} 失败（${context}），` +
        (/^(InvalidArg|InvalidFunction|MissingParameter)/.test(code)
          ? '请核对该功能的 API 参数'
          : '请检查服务开通、RAM 权限及配置'),
    );
    this.functionName = fn;
    this.parameter = parameter;
  }
}
/** Include identifiers only when they were sent as names, never echo response text or values. */
function errorDetails(extra: Record<string, string>, message: unknown): CdnErrorDetails {
  let functions: { functionName?: string; functionArgs?: { argName?: string }[] }[] = [];
  try {
    const parsed = JSON.parse(extra.Functions ?? '[]');
    if (Array.isArray(parsed)) functions = parsed;
  } catch {}
  const parameter =
    typeof message === 'string'
      ? /\b(?:ArgName|parameter)\s*(?:\[\s*|["']|:\s*|\s+)([a-z][a-z0-9_]*)/i.exec(message)?.[1]
      : undefined;
  const matched = parameter
    ? functions.filter(
        (f) =>
          Array.isArray(f?.functionArgs) && f.functionArgs.some((a) => a?.argName === parameter),
      )
    : [];
  return {
    functionName:
      functions.length === 1
        ? functions[0]?.functionName
        : matched.length === 1
          ? matched[0].functionName
          : undefined,
    parameter: matched.length ? parameter : undefined,
  };
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
  private configurationSlot = Promise.resolve();
  private nextConfigurationAt = 0;
  async call(credentials: CdnCredentials, action: string, extra: Record<string, string> = {}): Promise<any> {
    if (action === 'BatchSetCdnDomainConfig') {
      // Official per-user limit: 3 calls/second. Serial slots also cover concurrent callers.
      const slot = this.configurationSlot.then(async () => {
        const wait = this.nextConfigurationAt - Date.now();
        if (wait > 0) await delay(wait);
        this.nextConfigurationAt = Date.now() + 350;
      });
      this.configurationSlot = slot.catch(() => {});
      await slot;
    }
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
        errorDetails(extra, json.Message),
      );
    return json;
  }
}

export const cdnFunction = (functionName: string, args: Record<string, string>) => ({
  functionName,
  functionArgs: Object.entries(args).map(([argName, argValue]) => ({ argName, argValue })),
});
