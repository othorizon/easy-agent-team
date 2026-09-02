/**
 * 一次性读取一个 WebSocket 端点的输出（连上 → 收完这一批 → 断开），不做长连、不往回发数据。
 *
 * 为什么平台里会有手写的 WebSocket 客户端：
 *   1. Dokploy 的容器运行日志只有 WS 这一条路——v0.30.4 上把 tRPC router 全枚举过一遍，
 *      REST 侧没有任何读容器日志的过程（只有 deployment.readLogs 读构建日志文件）；
 *   2. 鉴权靠 upgrade 请求头上的 x-api-key，而 Node 内置的 WHATWG WebSocket 不支持自定义请求头；
 *   3. 我们要的只是「拿最近 N 行就走」，用不上 ws 那套完整实现（分片重组、心跳、发送、扩展协商），
 *      为这点需求引入运行时依赖不划算。
 * 所以这里只实现读方向所需的最小子集：握手 + 解析服务端帧 + 三条退出边界。
 */
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';

export interface WsTailOptions {
  /** ws:// 或 wss:// 地址 */
  url: string;
  headers: Record<string, string>;
  /** 收到数据后静默多久就认为这一批读完了 */
  idleMs: number;
  /** 不管收没收到，最多等多久 */
  hardMs: number;
  /** 最多收多少字节，超了截断（保留末尾，日志是越靠后越有用） */
  maxBytes: number;
}

/** WebSocket 帧的操作码，只用得上这几个 */
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export async function readWebSocketOnce(opts: WsTailOptions): Promise<string> {
  const url = new URL(opts.url);
  const secure = url.protocol === 'wss:';
  const request = secure ? https.request : http.request;

  return new Promise<string>((resolve, reject) => {
    const req = request({
      protocol: secure ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        ...opts.headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      },
    });

    const chunks: Buffer[] = [];
    let received = 0;
    let pending = Buffer.alloc(0);
    let socket: Socket | undefined;
    let idle: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(idle);
      socket?.destroy();
      req.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const hard = setTimeout(() => finish(), opts.hardMs);

    /** 服务端帧不带掩码，但按协议掩码位是允许的，照解（原地异或） */
    const unmask = (payload: Buffer, mask: Buffer): void => {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ mask[i % 4];
    };

    const consume = (): void => {
      // 一个 TCP 分段里可能有半帧，也可能有好几帧，所以解到解不动为止
      for (;;) {
        if (pending.length < 2) return;
        const opcode = pending[0] & 0x0f;
        const masked = (pending[1] & 0x80) !== 0;
        let len = pending[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (pending.length < off + 2) return;
          len = pending.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          if (pending.length < off + 8) return;
          const big = pending.readBigUInt64BE(off);
          if (big > BigInt(opts.maxBytes)) {
            finish(new Error('WebSocket 单帧超出允许的长度'));
            return;
          }
          len = Number(big);
          off += 8;
        }
        let mask: Buffer | undefined;
        if (masked) {
          if (pending.length < off + 4) return;
          mask = pending.subarray(off, off + 4);
          off += 4;
        }
        if (pending.length < off + len) return;
        const payload = pending.subarray(off, off + len);
        pending = pending.subarray(off + len);
        if (mask) unmask(payload, mask);

        if (opcode === OP_CLOSE) {
          // 4000+ 是 Dokploy 自己的拒绝码（参数非法 / 无权限），要如实报出来而不是当成正常收尾
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          finish(code >= 4000 ? new Error(`对端拒绝了这次读取（${code} ${reason || '无权限或参数非法'}）`) : undefined);
          return;
        }
        // 心跳不用回：我们只读几秒就断，碰不上对端 45 秒一次的 ping
        if (opcode === OP_PING || opcode === OP_PONG) continue;
        if (opcode !== OP_TEXT && opcode !== OP_BINARY && opcode !== OP_CONTINUATION) continue;

        // 多字节字符可能被切在两帧里，所以先攒 Buffer，最后一起解码
        chunks.push(payload);
        received += payload.length;
        if (received > opts.maxBytes) {
          finish();
          return;
        }
        clearTimeout(idle);
        idle = setTimeout(() => finish(), opts.idleMs);
      }
    };

    req.on('upgrade', (_res, sock, head: Buffer) => {
      socket = sock;
      sock.on('data', (d: Buffer) => {
        pending = Buffer.concat([pending, d]);
        consume();
      });
      sock.on('error', (err: Error) => finish(new Error(`WebSocket 连接出错: ${err.message}`)));
      // 对端主动断开（比如容器没了）就按正常收尾处理，已经收到的日志照样返回
      sock.on('close', () => finish());
      // 握手响应可能已经捎带了第一批数据
      if (head?.length) {
        pending = Buffer.concat([pending, head]);
        consume();
      }
      // 对端可能一直不说话（容器没有任何输出），到点就收工
      idle = setTimeout(() => finish(), Math.max(opts.idleMs, 2000));
    });

    // 没升级成功说明被拒了（鉴权失败等），把状态码和响应体带出去
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d: Buffer) => {
        if (body.length < 500) body += d.toString('utf8');
      });
      res.on('end', () => finish(new Error(`WebSocket 握手被拒（HTTP ${res.statusCode}）: ${body.slice(0, 200)}`)));
    });
    req.on('error', (err: Error) => finish(new Error(`WebSocket 连接失败: ${err.message}`)));
    req.end();
  });
}
