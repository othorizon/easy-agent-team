import { z } from 'zod';

/**
 * 表单校验直接复用 `@eat/shared` 的 zod 契约（与服务端同一份规则），但 shared 的 schema 多数没写中文报错，
 * 这里给控制台装一个全局的中文兜底。优先级：schema 自带的 message > 这里 > zod 默认英文。
 * shared 与控制台解析到同一个 zod 实例（pnpm 同版本同一份），所以对 shared 里的 schema 同样生效。
 * 在 main.tsx 里 import 一次即可。
 */
z.config({
  customError: (iss) => {
    switch (iss.code) {
      case 'invalid_type':
        if (iss.input === undefined || iss.input === null || iss.input === '') return '必填';
        if (iss.expected === 'number') return '请输入数字';
        if (iss.expected === 'int') return '请输入整数';
        return '格式不正确';
      case 'too_small': {
        const min = Number(iss.minimum);
        if (iss.origin === 'string') return min <= 1 ? '必填' : `至少 ${min} 个字符`;
        if (iss.origin === 'array' || iss.origin === 'set') return `至少 ${min} 项`;
        return `不能小于 ${min}`;
      }
      case 'too_big': {
        const max = Number(iss.maximum);
        if (iss.origin === 'string') return `最多 ${max} 个字符`;
        if (iss.origin === 'array' || iss.origin === 'set') return `最多 ${max} 项`;
        return `不能大于 ${max}`;
      }
      case 'invalid_format':
        if (iss.input === '') return '必填';
        if (iss.format === 'email') return '请输入有效邮箱';
        if (iss.format === 'url') return '请输入有效的 URL';
        return '格式不正确';
      case 'invalid_value':
        return '请选择有效的选项';
      default:
        return undefined;
    }
  },
});

export { z };

/**
 * 从 shared 契约里挑几个字段组成表单 schema（表单只覆盖请求体的一部分时用）。
 * 带 refine 的对象 schema 在 zod 4 里不能 `.pick()`（直接抛错），所以从 `.shape` 取字段重新组装。
 */
export function pickFields<S extends z.ZodObject, K extends keyof S['shape'] & string>(schema: S, keys: readonly K[]) {
  return z.object(Object.fromEntries(keys.map((k) => [k, schema.shape[k]])) as Pick<S['shape'], K>);
}
