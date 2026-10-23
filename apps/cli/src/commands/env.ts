import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { constants as osConstants } from 'node:os';
import type {
  AccessRequestInfo,
  EnvironmentInfo,
  ImportVariablesResult,
  PullValuesResponse,
  UpsertVariableRequest,
  UpsertVariableResult,
  VariableMeta,
} from '@eat/shared';
import { ENV_IMPORT_MAX_KEYS, formatDateTime } from '@eat/shared';
import { Api, ApiError } from '../client.js';
import { mergeEnvFile, printWriteResult, stripEatHeader, writeEnvFile } from '../dotenv-file.js';
import { formatDotenvLine, formatShellLine, parseEnvInput } from '../dotenv-format.js';

type CatalogEntry = { environment: EnvironmentInfo; variables: VariableMeta[] };

/** 变量清单：AI 与人共用的"认路"入口，展示 key + 备注 + 权限状态 */
export async function envList(envSlug?: string): Promise<void> {
  const api = Api.fromSaved();
  const catalog = await api.request<CatalogEntry[]>('GET', '/api/catalog');
  const entries = envSlug ? catalog.filter((c) => c.environment.slug === envSlug) : catalog;
  if (entries.length === 0) {
    console.log(envSlug ? `环境 ${envSlug} 不存在或不可见` : '暂无环境');
    return;
  }
  for (const { environment, variables } of entries) {
    console.log(`\n${environment.slug}  —  ${environment.name}（Owner: ${environment.ownerName}）`);
    if (environment.description) console.log(`  ${environment.description}`);
    if (variables.length === 0) {
      console.log('  (无可见变量)');
      continue;
    }
    const keyWidth = Math.max(...variables.map((v) => v.key.length), 3);
    for (const v of variables) {
      const access = v.hasAccess ? '✓ 可读取' : '✗ 无权限';
      // 非敏感变量在有权限时清单直接附带明文值
      const valueHint = v.value != null ? `（值: ${v.value}）` : '';
      console.log(`  ${v.key.padEnd(keyWidth)}  ${access}  ${v.description}${valueHint}`);
    }
  }
  console.log('\n提示：eat env pull <env> 拉取值；无权限时 eat env request <env> <KEY> --reason "..." 申请');
}

/** 拉取值：缺省 keys = 该环境下有权限的全部；敏感值的读取服务端照常落审计 */
async function pullOne(api: Api, envSlug: string, keys: string[] | undefined): Promise<PullValuesResponse> {
  return api.request<PullValuesResponse>('POST', `/api/envs/${envSlug}/values`, { keys });
}

/** 一个都没拉到时的引导：环境不存在 / 没有可见变量 / 都没权限，分别给出下一步 */
async function explainNothingReadable(api: Api, envSlug: string): Promise<void> {
  const entry = (await api.request<CatalogEntry[]>('GET', '/api/catalog')).find((c) => c.environment.slug === envSlug);
  if (!entry) {
    console.error(`环境 ${envSlug} 不存在或不可见`);
  } else if (entry.variables.length === 0) {
    console.error(`环境 ${envSlug} 下没有对你可见的变量`);
  } else {
    const keys = entry.variables.map((v) => v.key);
    console.error(`环境 ${envSlug} 下有 ${keys.length} 个变量，但你对它们都没有读取权限。`);
    console.error(`申请权限: eat env request ${envSlug} ${keys.join(' ')} --reason "<用途说明>"`);
  }
}

const PULL_FORMATS = ['dotenv', 'shell', 'json'] as const;
type PullFormat = (typeof PULL_FORMATS)[number];

function renderValues(values: Array<[string, string]>, format: PullFormat): string {
  if (format === 'json') return `${JSON.stringify(Object.fromEntries(values), null, 2)}\n`;
  const line = format === 'shell' ? formatShellLine : formatDotenvLine;
  return values.map(([k, v]) => `${line(k, v)}\n`).join('');
}

export async function envPull(
  envSlug: string,
  opts: { keys?: string; out?: string; print?: boolean; force?: boolean; merge?: boolean; format?: string },
): Promise<void> {
  if (opts.format !== undefined && !opts.print) {
    throw new Error('--format 只用于 --print（写文件一律是 dotenv）；导出到当前 shell：eval "$(eat env pull <env> --print --format shell)"');
  }
  const format = (opts.format ?? 'dotenv') as PullFormat;
  if (!PULL_FORMATS.includes(format)) throw new Error(`--format 只能是 ${PULL_FORMATS.join(' / ')}，收到 ${opts.format}`);
  if (opts.merge && opts.print) throw new Error('--merge 是合并进文件，不能和 --print 一起用');
  if (opts.merge && opts.force) throw new Error('--merge 只改同名 key、追加新 key，不会整份覆盖，不需要 --force');

  const api = Api.fromSaved();
  const keys = splitKeys(opts.keys);
  const res = await pullOne(api, envSlug, keys);

  const got = Object.entries(res.values);
  if (got.length > 0) {
    if (opts.print) {
      process.stdout.write(renderValues(got, format));
    } else if (opts.merge) {
      const merged = mergeEnvFile({ file: opts.out ?? '.env', values: got, command: `eat env pull ${envSlug}` });
      printWriteResult(merged, `合并 ${envSlug} 的 ${got.length} 个变量，其余内容原样保留`);
    } else {
      // 同名文件不是 eat 写的就中止，不静默覆盖用户自己的 .env（决策 63）
      const written = writeEnvFile({
        file: opts.out ?? '.env',
        content: got.map(([k, v]) => formatDotenvLine(k, v)).join('\n'),
        command: `eat env pull ${envSlug}`,
        force: opts.force,
        mergeHint: true,
      });
      printWriteResult(written, `${got.length} 个变量`);
    }
  }
  if (res.denied.length > 0) {
    console.error(`\n以下变量无权限（${res.denied.length} 个）：`);
    for (const d of res.denied) console.error(`  ${d.key}: ${d.message}`);
    console.error(
      `申请权限: eat env request ${envSlug} ${res.denied.map((d) => d.key).join(' ')} --reason "<用途说明>"`,
    );
    if (got.length === 0) process.exitCode = 1;
  }
  // 没带 --keys 时服务端只回「有权限的那些」，一个都没有就会 values / denied 双空。
  // 这种情况最常见（新同事第一次拉），不能什么都不说——照样给出该申请什么的引导。
  if (got.length === 0 && res.denied.length === 0) {
    await explainNothingReadable(api, envSlug);
    process.exitCode = 1;
  }
}

function splitKeys(raw: string | undefined): string[] | undefined {
  const keys = raw ? raw.split(',').map((k) => k.trim()).filter(Boolean) : [];
  return keys.length > 0 ? keys : undefined;
}

export async function envRequest(envSlug: string, keys: string[], opts: { reason: string }): Promise<void> {
  const api = Api.fromSaved();
  const res = await api.request<AccessRequestInfo>('POST', '/api/access-requests', {
    environmentSlug: envSlug,
    keys,
    reason: opts.reason,
  });
  console.log(`申请已提交（ID: ${res.id}），等待环境 Owner 审批。`);
  console.log(`查看进度: eat env requests`);
}

export async function envRequests(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<AccessRequestInfo[]>('GET', '/api/access-requests/mine');
  if (rows.length === 0) {
    console.log('暂无权限申请记录');
    return;
  }
  const statusLabel: Record<string, string> = { pending: '待审批', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回', invalid: '已失效' };
  for (const r of rows) {
    console.log(
      `${formatDateTime(r.createdAt)}  ${statusLabel[r.status] ?? r.status}  ${r.environmentSlug}: ${r.keys.join(', ')}${r.rejectionReason ? `\n  驳回原因：${r.rejectionReason}` : ''}`,
    );
  }
}

// ---------- 环境本身 ----------

const VISIBILITY_LABEL: Record<string, string> = { team: '团队可见', private: '私有（仅自己可见）' };

export async function envCreate(
  slug: string,
  opts: { name?: string; description?: string; private?: boolean },
): Promise<void> {
  const api = Api.fromSaved();
  await api.request('POST', '/api/envs', {
    slug,
    name: opts.name ?? slug,
    description: opts.description ?? '',
    visibility: opts.private ? 'private' : 'team',
  });
  console.log(`已创建环境 ${slug}（${VISIBILITY_LABEL[opts.private ? 'private' : 'team']}）`);
  console.log(`写入变量: eat env set ${slug} <KEY> --value-file <文件|->   或整份推送: eat env push ${slug} --file .env`);
}

export async function envUpdate(
  slug: string,
  opts: { name?: string; description?: string; visibility?: string },
): Promise<void> {
  if (opts.visibility !== undefined && opts.visibility !== 'team' && opts.visibility !== 'private') {
    throw new Error(`--visibility 只能是 team 或 private，收到 ${opts.visibility}`);
  }
  const body: Record<string, string> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.visibility !== undefined) body.visibility = opts.visibility;
  if (Object.keys(body).length === 0) throw new Error('没有要改的字段（eat env update --help 查看可选项）');

  const api = Api.fromSaved();
  const before = await api.request<EnvironmentInfo>('GET', `/api/envs/${slug}`);
  await api.request('PATCH', `/api/envs/${slug}`, body);
  console.log(`已更新环境 ${slug}`);
  if (opts.visibility === 'private' && before.visibility !== 'private') {
    // 服务端一并做了这三件事；静默做完会让人以为只是换了个标签
    console.log('  已改为私有：其他成员的读取授权全部撤销、待审批的申请作废，变量对他们不再可见');
  } else if (opts.visibility === 'team' && before.visibility !== 'team') {
    console.log('  已改为团队可见：变量默认仍对未授权成员隐藏，需要的话用 eat env set <env> <KEY> --no-hidden 逐个公开');
  }
}

export async function envDelete(slug: string, opts: { yes?: boolean }): Promise<void> {
  const api = Api.fromSaved();
  const env = await api.request<EnvironmentInfo>('GET', `/api/envs/${slug}`);
  if (!opts.yes) {
    console.error(`将删除环境 ${slug} 及其全部 ${env.variableCount} 个变量与读取授权，不可恢复。确认请加 --yes`);
    process.exitCode = 1;
    return;
  }
  await api.request('DELETE', `/api/envs/${slug}`);
  console.log(`已删除环境 ${slug}（${env.variableCount} 个变量）`);
}

// ---------- 单个变量 ----------

/** 读值文件；`-` 读 stdin。去掉恰好一个结尾换行：`echo` 与编辑器都会补一个，几乎从来不是值的一部分 */
function readValueFile(file: string): string {
  const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  return raw.replace(/\r?\n$/, '');
}

export async function envSet(
  envSlug: string,
  key: string,
  opts: { value?: string; valueFile?: string; description?: string; secret?: boolean; hidden?: boolean },
): Promise<void> {
  if (opts.value !== undefined && opts.valueFile !== undefined) throw new Error('--value 与 --value-file 只能二选一');
  // 值的来源必须显式给出：不学 vercel / wrangler 的「没给值就读 stdin 或弹提示」——
  // 那要靠 TTY 判断（决策 26/54 已定不做），而 Agent 的 stdin 可能一直开着，隐式去读会挂住
  const value = opts.valueFile !== undefined ? readValueFile(opts.valueFile) : opts.value;
  const body: UpsertVariableRequest = { key };
  if (value !== undefined) body.value = value;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.secret !== undefined) body.secret = opts.secret;
  if (opts.hidden !== undefined) body.visibleWithoutPermission = !opts.hidden;
  if (Object.keys(body).length === 1) {
    throw new Error('没有要改的内容：用 --value / --value-file 给值，或用 --description / --secret / --hidden 改元信息');
  }

  const api = Api.fromSaved();
  const r = await api.request<UpsertVariableResult>('POST', `/api/envs/${envSlug}/variables`, body);
  const traits = [r.secret ? '敏感' : '非敏感', ...(r.visibleWithoutPermission ? [] : ['对未授权成员隐藏'])].join('，');
  if (r.created) {
    console.log(`已新增 ${envSlug}/${r.key}（${traits}）`);
  } else if (r.valueChanged) {
    console.log(`已更新 ${envSlug}/${r.key}：值已更新为 v${r.version}（${traits}）`);
  } else {
    const why = value === undefined ? '值未改动' : '值与平台上相同，版本不变';
    console.log(`已更新 ${envSlug}/${r.key}：${why}（v${r.version}，${traits}）`);
  }
}

export async function envUnset(envSlug: string, keys: string[]): Promise<void> {
  const api = Api.fromSaved();
  // 先确认环境在、看得见：之后的 404 就只可能是变量不存在
  await api.request<EnvironmentInfo>('GET', `/api/envs/${envSlug}`);
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    try {
      await api.request('DELETE', `/api/envs/${envSlug}/variables/${encodeURIComponent(key)}`);
      deleted.push(key);
    } catch (err) {
      // 不存在的报出来但不中断：一次删多个时，前面删掉的已经删了，停在半路只会让人更难判断状态
      if (err instanceof ApiError && err.status === 404) missing.push(key);
      else throw err;
    }
  }
  if (deleted.length > 0) console.log(`已从 ${envSlug} 删除 ${deleted.join(', ')}（连同这些变量的读取授权）`);
  if (missing.length > 0) {
    console.error(`${envSlug} 里没有 ${missing.join(', ')}`);
    process.exitCode = 1;
  }
}

// ---------- 整份推送 ----------

export async function envPush(
  envSlug: string,
  opts: { file?: string; prune?: boolean; dryRun?: boolean; secret?: boolean },
): Promise<void> {
  const file = opts.file ?? '.env';
  const source = file === '-' ? '标准输入' : file;
  if (file !== '-' && !fs.existsSync(file)) throw new Error(`文件不存在: ${file}（--file 指定要推送的 dotenv / JSON 文件，- 表示标准输入）`);
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const parsed = parseEnvInput(stripEatHeader(text));
  if (parsed.errors.length > 0) {
    // 整批拒绝而不是跳过：静默少推几个 key，比推送失败更难发现
    const shown = parsed.errors.slice(0, 20).map((e) => `  第 ${e.line} 行: ${e.message}`);
    const more = parsed.errors.length > 20 ? [`  ……共 ${parsed.errors.length} 处`] : [];
    throw new Error([`${source} 有无法解析的内容，未推送任何变量：`, ...shown, ...more].join('\n'));
  }
  if (parsed.values.size === 0) throw new Error(`${source} 里没有解析出任何变量`);
  if (parsed.values.size > ENV_IMPORT_MAX_KEYS) {
    throw new Error(`${source} 有 ${parsed.values.size} 个变量，一次最多推送 ${ENV_IMPORT_MAX_KEYS} 个`);
  }
  if (parsed.duplicates.length > 0) {
    console.error(`注意：${parsed.duplicates.join(', ')} 在文件里出现了多次，按最后一次的值推送`);
  }

  const api = Api.fromSaved();
  const r = await api.request<ImportVariablesResult>('POST', `/api/envs/${envSlug}/variables/import`, {
    values: Object.fromEntries(parsed.values),
    prune: !!opts.prune,
    dryRun: !!opts.dryRun,
    secret: opts.secret !== false,
  });

  const mode = r.prune ? '全量模式：平台与文件一致，文件里没有的会删除' : '合并模式：只增改，不删除';
  console.log(`${r.dryRun ? '预演（未写入）：' : '已推送 '}${source} → ${envSlug}（${mode}）`);
  const line = (label: string, keys: string[], note = '') => {
    if (keys.length > 0) console.log(`  ${label}  ${keys.join(', ')}${note}`);
  };
  line(r.dryRun ? '将新增' : '新增', r.added, opts.secret === false ? '（新建为非敏感）' : '（新建的默认敏感）');
  line(r.dryRun ? '将修改' : '修改', r.changed);
  line(r.dryRun ? '将删除' : '删除', r.removed, '（连同这些变量的读取授权）');
  if (r.unchanged > 0) console.log(`  未变  ${r.unchanged} 个`);
  if (r.kept.length > 0) console.log(`  平台有、文件没有（已保留；要删除加 --prune）：${r.kept.join(', ')}`);
  if (r.added.length + r.changed.length + r.removed.length === 0) console.log('  没有变化');
}

// ---------- 以环境变量的形式使用 ----------

/**
 * Windows 上 npm / pnpm 这类命令是 .cmd，不经 shell 找不到；拼成一条命令行交给 cmd 解析。
 * 只给含空白或引号的参数加双引号——cmd 的转义规则很多，这里覆盖日常用法即可。
 */
function windowsCommandLine(argv: string[]): string {
  return argv.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

export async function envRun(environments: string, command: string[], opts: { keys?: string }): Promise<void> {
  const envs = environments.split(',').map((e) => e.trim()).filter(Boolean);
  if (envs.length === 0) throw new Error('至少指定一个环境');
  if (command.length === 0) throw new Error('缺少要运行的命令：eat env run <env> -- <命令...>');
  const keys = splitKeys(opts.keys);

  const api = Api.fromSaved();
  const injected = new Map<string, string>();
  const from = new Map<string, string>();
  const overlaps: string[] = [];
  const denied = new Map<string, string[]>();
  for (const env of envs) {
    const res = await pullOne(api, env, keys);
    const got = Object.entries(res.values);
    if (!keys && got.length === 0) {
      // 点名要的环境一个都读不到，多半是权限问题；带着缺失的配置跑下去只会在更远处报错
      await explainNothingReadable(api, env);
      throw new Error(`环境 ${env} 下没有可读取的变量，未启动命令`);
    }
    for (const [k, v] of got) {
      if (from.has(k) && from.get(k) !== env) overlaps.push(`${k}（${from.get(k)} → ${env}）`);
      injected.set(k, v);
      from.set(k, env);
    }
    // 同一个 key 只要有一个环境读到了就算满足；没读到的把每个环境给的原因都记下
    for (const d of res.denied) denied.set(d.key, [...(denied.get(d.key) ?? []), `${env}: ${d.message}`]);
  }
  if (keys) {
    const missing = keys.filter((k) => !injected.has(k));
    if (missing.length > 0) {
      console.error('以下变量没有拿到，未启动命令：');
      for (const k of missing) console.error(`  ${k}: ${(denied.get(k) ?? ['不存在']).join('；')}`);
      console.error(`没权限的申请: eat env request <env> ${missing.join(' ')} --reason "<用途说明>"`);
      process.exitCode = 1;
      return;
    }
  }

  // 平台值覆盖当前 shell 里的同名变量：环境是点名要的，静默用了 shell 里残留的那个更难查。
  // 覆盖了哪些只报 key 名，走 stderr，不干扰被运行命令的输出
  const shadowed = [...injected.keys()].filter((k) => process.env[k] !== undefined && process.env[k] !== injected.get(k));
  if (shadowed.length > 0) console.error(`eat: 覆盖了当前 shell 里已有的 ${shadowed.join(', ')}`);
  if (overlaps.length > 0) console.error(`eat: 多个环境有同名变量，后者生效：${overlaps.join(', ')}`);

  const env = { ...process.env, ...Object.fromEntries(injected) };
  const child =
    process.platform === 'win32'
      ? spawn(windowsCommandLine(command), { stdio: 'inherit', env, shell: true })
      : spawn(command[0], command.slice(1), { stdio: 'inherit', env });

  // 终止信号转给子进程、自己不先退出，等子进程退出后带着它的退出码走（同 cross-env 的做法）
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => {
    const h = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    };
    process.on(sig, h);
    return [sig, h] as const;
  });

  await new Promise<void>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      console.error(err.code === 'ENOENT' ? `找不到命令: ${command[0]}` : `启动失败: ${err.message}`);
      process.exitCode = 127;
      resolve();
    });
    child.on('exit', (code, signal) => {
      // 透传退出码；被信号杀掉的按 shell 惯例 128 + 信号值
      process.exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
      resolve();
    });
  });
  for (const [sig, h] of handlers) process.off(sig, h);
}
