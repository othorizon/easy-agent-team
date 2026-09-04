import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanWorkspace } from '../src/scan.js';

const SECRET = 'super-secret-platform-value-789';
const fingerprints = [
  {
    fingerprint: createHash('sha256').update(SECRET).digest('hex'),
    length: SECRET.length,
    environment: 'internal',
    key: 'API_TOKEN',
  },
];

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-scan-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  // 干净文件
  fs.writeFileSync(path.join(dir, 'src', 'ok.ts'), 'export const a = 1;\n');
  // 通用模式命中
  fs.writeFileSync(path.join(dir, 'src', 'aws.ts'), 'const k = "AKIAABCDEFGHIJKLMNOP";\n');
  // 平台指纹命中（真实密钥被硬编码）
  fs.writeFileSync(path.join(dir, 'src', 'leak.ts'), `const token = "${SECRET}";\n`);
  // 赋值形式的泄漏（KEY=<密钥>）：最常见的一种，指纹必须照样命中
  fs.writeFileSync(path.join(dir, 'deploy.conf'), `API_TOKEN=${SECRET}\n`);
  // .env 误提交
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=abc123\n');
  // .env.example 不算
  fs.writeFileSync(path.join(dir, '.env.example'), 'DB_PASSWORD=\n');
  // node_modules 内的问题应被跳过
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'bad.js'), 'AKIAABCDEFGHIJKLMNOP');
  // 二进制文件跳过
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanWorkspace', () => {
  it('三层规则各自命中，跳过 node_modules/二进制/.env.example', () => {
    const { scannedFiles, findings } = scanWorkspace(dir, fingerprints);
    expect(scannedFiles).toBeGreaterThanOrEqual(4);

    const rules = findings.map((f) => `${f.rule}:${f.file}`).sort();
    expect(rules).toContain('generic:src/aws.ts');
    expect(rules).toContain('fingerprint:src/leak.ts');
    expect(rules).toContain('dotenv:.env');
    // 不应报 node_modules、.env.example、干净文件
    expect(findings.some((f) => f.file.includes('node_modules'))).toBe(false);
    expect(findings.some((f) => f.file === '.env.example')).toBe(false);
    expect(findings.some((f) => f.file === 'src/ok.ts')).toBe(false);

    expect(rules).toContain('fingerprint:deploy.conf');

    const fp = findings.find((f) => f.rule === 'fingerprint')!;
    expect(fp.note).toContain('internal/API_TOKEN');
    expect(fp.line).toBe(1);
  });

  it('base64 padding 的密钥不被截断', () => {
    const padded = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE=';
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-scan-b64-'));
    fs.writeFileSync(path.join(clean, 'app.yaml'), `secret: ${padded}\n`);
    const { findings } = scanWorkspace(clean, [
      { fingerprint: createHash('sha256').update(padded).digest('hex'), length: padded.length, environment: 'internal', key: 'B64' },
    ]);
    expect(findings.map((f) => f.rule)).toEqual(['fingerprint']);
    fs.rmSync(clean, { recursive: true, force: true });
  });

  it('干净目录通过', () => {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-scan-clean-'));
    fs.writeFileSync(path.join(clean, 'a.ts'), 'export {};\n');
    const { findings } = scanWorkspace(clean, fingerprints);
    expect(findings).toEqual([]);
    fs.rmSync(clean, { recursive: true, force: true });
  });
});
