import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

/**
 * Windows 上 npm / pnpm 这类命令是 .cmd，不经 shell 找不到；拼成一条命令行交给 cmd 解析。
 * 只给含空白或引号的参数加双引号——cmd 的转义规则很多，这里覆盖日常用法即可。
 */
function windowsCommandLine(argv: string[]): string {
  return argv.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

/**
 * 把变量注入子进程后运行命令：`eat env run` 与 `eat db credentials run` 共用。
 * 值只进子进程、不落盘；退出码透传，终止信号转发给子进程。
 */
export async function runWithEnv(command: string[], injected: Map<string, string>): Promise<void> {
  // 平台值覆盖当前 shell 里的同名变量：是点名要的，静默用了 shell 里残留的那个更难查。
  // 覆盖了哪些只报 key 名，走 stderr，不干扰被运行命令的输出
  const shadowed = [...injected.keys()].filter((k) => process.env[k] !== undefined && process.env[k] !== injected.get(k));
  if (shadowed.length > 0) console.error(`eat: 覆盖了当前 shell 里已有的 ${shadowed.join(', ')}`);

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
