import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrecheckFinding, SecretFingerprint } from '@eat/shared';

/**
 * 本地密钥扫描（决策 #8：检查在发起端执行，平台零基础设施）。
 * 三层：通用密钥模式 / 平台密钥指纹匹配 / .env 误提交。
 */

const GENERIC_PATTERNS: Array<{ re: RegExp; note: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, note: '私钥文件内容' },
  { re: /AKIA[0-9A-Z]{16}/, note: '疑似 AWS Access Key' },
  { re: /eat_[0-9a-f]{48}/, note: '平台访问 Token' },
  { re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, note: '疑似 JWT' },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.eat', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 1024 * 1024;
/** 候选 token：典型密钥字符集的连续串（含空格等特殊字符的密钥不在指纹匹配覆盖内） */
const TOKEN_RE = /[A-Za-z0-9_\-+/=.]{12,}/g;

function isDotenvFile(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) && name !== '.env.example' && !name.endsWith('.sample');
}

export interface ScanResult {
  scannedFiles: number;
  findings: PrecheckFinding[];
}

export function scanWorkspace(root: string, fingerprints: SecretFingerprint[]): ScanResult {
  const fpByHash = new Map(fingerprints.map((f) => [f.fingerprint, f]));
  const minLen = fingerprints.reduce((m, f) => Math.min(m, f.length), 12);
  const findings: PrecheckFinding[] = [];
  let scannedFiles = 0;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs);
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue; // 二进制
      scannedFiles++;
      const text = buf.toString('utf8');

      if (isDotenvFile(entry.name)) {
        const hasValue = text.split('\n').some((l) => /^[A-Za-z_][A-Za-z0-9_]*=.+/.test(l.trim()) && !l.trim().startsWith('#'));
        if (hasValue) {
          findings.push({ rule: 'dotenv', file: rel, note: '仓库中包含含值的 .env 文件，请移除并加入 .gitignore' });
        }
      }

      const lines = text.split('\n');
      const hitPatterns = new Set<string>();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const p of GENERIC_PATTERNS) {
          if (!hitPatterns.has(p.note) && p.re.test(line)) {
            hitPatterns.add(p.note);
            findings.push({ rule: 'generic', file: rel, line: i + 1, note: p.note });
          }
        }
        if (fpByHash.size > 0) {
          for (const m of line.matchAll(TOKEN_RE)) {
            const token = m[0];
            if (token.length < minLen) continue;
            const hit = fpByHash.get(createHash('sha256').update(token).digest('hex'));
            if (hit) {
              findings.push({
                rule: 'fingerprint',
                file: rel,
                line: i + 1,
                note: `命中平台下发的密钥 ${hit.environment}/${hit.key}——真实密钥被硬编码进了代码，请改为运行时读取环境变量`,
              });
            }
          }
        }
      }
      if (findings.length >= 200) return;
    }
  };
  walk(root);
  return { scannedFiles, findings };
}
