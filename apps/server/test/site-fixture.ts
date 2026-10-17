import { mkdir, readFile, writeFile, rm, stat, copyFile } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { BadRequestException } from '@nestjs/common';
import { SiteStorage } from '../src/sites/site-storage.service';
import { SiteSettingsStore } from '../src/sites/site-settings.store';

/** Controlled OSS substitute: writable staging, server-only atomic snapshots, immutable blobs. */
export class TestSiteStorage extends SiteStorage {
  server?: Server;
  origin = '';
  puts = 0;
  active = 0;
  maxActive = 0;
  failPuts = 0;
  constructor(settings: SiteSettingsStore, readonly root: string) { super(settings); }
  async start() {
    this.server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
      res.setHeader('Access-Control-Allow-Methods', 'PUT');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      const url = new URL(req.url!, 'http://test');
      if (req.headers.authorization || req.headers.cookie) { res.writeHead(400).end(); return; }
      if (Number(url.searchParams.get('expires')) < Date.now()) { res.writeHead(403).end(); return; }
      const match = /^\/sites\/([a-f0-9-]+)\/staging\/([a-f0-9-]+)\/([a-f0-9]{64})$/.exec(url.pathname);
      if (req.method !== 'PUT' || !match) { res.writeHead(403).end(); return; }
      this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      try {
        if (this.failPuts-- > 0) { req.resume(); res.writeHead(503).end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        await this.putStaging(match[1], match[2], match[3], Buffer.concat(chunks));
        this.puts++;
        res.writeHead(200).end();
      } catch { res.writeHead(500).end(); }
      finally { this.active--; }
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async close() { await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); }
  file(key: string) { return join(this.root, key); }
  override async signUpload(site: string, session: string, hash: string, seconds: number) {
    return { url: `${this.origin}/${this.stagingKey(site, session, hash)}?expires=${Date.now() + seconds * 1000}`,
      headers: { 'Content-Type': 'application/octet-stream' } };
  }
  override async hasBlob(site: string, hash: string, size: number) {
    try { return (await stat(this.file(this.blobKey(site, hash)))).size === size; }
    catch { return false; }
  }
  override async putStaging(site: string, session: string, hash: string, bytes: Buffer) {
    const path = this.file(this.stagingKey(site, session, hash));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  async snapshot(site: string, session: string, hash: string) {
    const path = this.file(`sites/${site}/snapshots/${randomUUID()}`);
    await mkdir(dirname(path), { recursive: true });
    try { await copyFile(this.file(this.stagingKey(site, session, hash)), path, constants.COPYFILE_EXCL); }
    catch { throw new BadRequestException('缺少上传对象'); }
    return path;
  }
  override async verifyAndSeal(site: string, session: string, file: { hash: string; size: number }) {
    const snapshot = await this.snapshot(site, session, file.hash);
    try {
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(snapshot)) { hash.update(chunk); size += chunk.length; }
      if (hash.digest('hex') !== file.hash || size !== file.size) throw new BadRequestException('上传对象大小或 SHA-256 不符');
      const blob = this.file(this.blobKey(site, file.hash));
      await mkdir(dirname(blob), { recursive: true });
      try { await copyFile(snapshot, blob, constants.COPYFILE_EXCL); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (createHash('sha256').update(await readFile(blob)).digest('hex') !== file.hash)
          throw new BadRequestException('已有内容损坏');
      }
    } finally { await rm(snapshot, { force: true }); }
  }
  override async getBlob(site: string, hash: string) { return readFile(this.file(this.blobKey(site, hash))); }
  override async discardSite(site: string) { await rm(this.file(`sites/${site}`), { recursive: true, force: true }); }
}
