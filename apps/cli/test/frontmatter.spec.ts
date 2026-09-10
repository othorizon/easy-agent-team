import { isBlockScalarIndicator, parseFrontmatter, parseSkillFrontmatter, toYamlScalar } from '@eat/shared';
import { describe, expect, it } from 'vitest';
import { resolvePushMeta } from '../src/commands/skill.js';

const md = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# 正文\n`;

describe('parseSkillFrontmatter：块标量', () => {
  it('折叠块 >- 把换行折成空格，不留结尾换行', () => {
    const fm = parseSkillFrontmatter(
      md('name: pdf-tools\ndescription: >-\n  处理 PDF 文件时使用：读取、合并、拆分、\n  填表单与 OCR。'),
    );
    expect(fm.name).toBe('pdf-tools');
    expect(fm.description).toBe('处理 PDF 文件时使用：读取、合并、拆分、 填表单与 OCR。');
  });

  it('折叠块 > （默认截断）等价，空行折成换行', () => {
    const fm = parseSkillFrontmatter(md('description: >\n  第一段第一行\n  第一段第二行\n\n  第二段'));
    expect(fm.description).toBe('第一段第一行 第一段第二行\n第二段');
  });

  it('保留块 | 逐行保留换行', () => {
    const fm = parseSkillFrontmatter(md('description: |\n  第一行\n  第二行'));
    expect(fm.description).toBe('第一行\n第二行');
  });

  it('带缩进数字与截断指示的 |2+ 也认，块内更深的缩进保留', () => {
    const fm = parseSkillFrontmatter(md('description: |2+\n  外层\n    内层\n'));
    expect(fm.description).toBe('外层\n  内层');
  });

  it('块标量之后的键仍能正常解析', () => {
    const fm = parseSkillFrontmatter(md('description: >-\n  跨行的\n  描述\nname: after-block'));
    expect(fm).toEqual({ name: 'after-block', description: '跨行的 描述' });
  });

  it('折叠块里更深缩进的行保留自己的换行（YAML more-indented 规则）', () => {
    const fm = parseSkillFrontmatter(md('description: >-\n  用于以下场景：\n    - 生成周报\n  以及其他'));
    expect(fm.description).toBe('用于以下场景：\n  - 生成周报\n以及其他');
  });
});

describe('parseSkillFrontmatter：其它写法', () => {
  it('单行纯标量（老写法）不受影响', () => {
    expect(parseSkillFrontmatter(md('name: demo\ndescription: 一句话描述'))).toEqual({
      name: 'demo',
      description: '一句话描述',
    });
  });

  it('缩进续行的纯标量折成空格', () => {
    expect(parseSkillFrontmatter(md('description: 第一行\n  第二行')).description).toBe('第一行 第二行');
  });

  it('引号标量：单引号 \'\' 转义、双引号反斜杠转义，均可跨行', () => {
    expect(parseSkillFrontmatter(md("description: 'it''s fine'")).description).toBe("it's fine");
    expect(parseSkillFrontmatter(md('description: "带\\"引号\\"与\\n换行"')).description).toBe('带"引号"与\n换行');
    expect(parseSkillFrontmatter(md('description: "跨行的\n  双引号描述"')).description).toBe('跨行的 双引号描述');
  });

  it('CRLF 换行不会把 \\r 带进值里', () => {
    expect(parseSkillFrontmatter('---\r\nname: demo\r\ndescription: 描述\r\n---\r\n\r\n正文').description).toBe('描述');
  });

  it('BOM 开头、整行注释、... 结束分隔符都能处理', () => {
    const content = '\uFEFF---\n# 注释行\nname: demo\ndescription: 描述\n...\n\n正文';
    expect(parseSkillFrontmatter(content)).toEqual({ name: 'demo', description: '描述' });
  });

  it('没有 frontmatter / 没有结束分隔符时返回空', () => {
    expect(parseSkillFrontmatter('# 只有正文')).toEqual({});
    expect(parseSkillFrontmatter('---\nname: demo\n\n正文没有闭合')).toEqual({});
  });

  it('嵌套结构的值被跳过，不会污染同级键', () => {
    const fm = parseFrontmatter(md('name: demo\nallowed-tools:\n  - Read\n  - Bash\ndescription: 描述'));
    expect(fm.fields['allowed-tools']).toBeUndefined();
    expect(fm.fields.name).toBe('demo');
    expect(fm.fields.description).toBe('描述');
  });

  it('正文与 frontmatter 分离', () => {
    const parsed = parseFrontmatter(md('name: demo'));
    expect(parsed.present).toBe(true);
    expect(parsed.body.trim()).toBe('# 正文');
  });
});

describe('正文永远不会被吸进描述里', () => {
  // frontmatter 只在开闭分隔符之间解析，块标量/续行再贪心也越不过闭合的 ---
  it('块标量是最后一个键、正文紧随其后且带缩进段落', () => {
    const md2 = [
      '---',
      'name: demo',
      'description: >-',
      '  第一行',
      '  第二行',
      '---',
      '',
      '# 正文标题',
      '',
      '    缩进 4 空格的代码块',
      '    description: 正文里也写了个像 key 的行',
    ].join('\n');
    expect(parseSkillFrontmatter(md2).description).toBe('第一行 第二行');
    expect(parseFrontmatter(md2).body.trim().split('\n')[0]).toBe('# 正文标题');
  });

  it('折叠块后面直接顶着正文（中间没有空行）', () => {
    const md2 = '---\ndescription: >-\n  只有描述\n---\n正文第一行紧贴分隔符\n';
    expect(parseSkillFrontmatter(md2).description).toBe('只有描述');
    expect(parseFrontmatter(md2).body.trim()).toBe('正文第一行紧贴分隔符');
  });

  it('保留块 + 正文里还有 --- 水平线', () => {
    const md2 = '---\ndescription: |\n  第一行\n  第二行\n---\n\n正文\n\n---\n\n水平线之后\n';
    expect(parseSkillFrontmatter(md2).description).toBe('第一行\n第二行');
    expect(parseFrontmatter(md2).body).toContain('水平线之后');
  });
});

describe('isBlockScalarIndicator / toYamlScalar', () => {
  it('识别旧版 CLI 推上来的块标量指示符', () => {
    for (const v of ['>-', '>', '|', '|-', '|2+', ' >- ']) expect(isBlockScalarIndicator(v)).toBe(true);
    for (const v of ['正常描述', '', '> 引用开头的描述']) expect(isBlockScalarIndicator(v)).toBe(false);
  });

  it('生成的标量能被自己解析回去', () => {
    for (const raw of ['普通描述', '经验沉淀：Redis: 连接超时', '# 井号开头', '带 # 注释歧义', '  前后空格  ', '多\n行']) {
      const md2 = `---\ndescription: ${toYamlScalar(raw)}\n---\n\n正文`;
      expect(parseFrontmatter(md2).fields.description).toBe(raw);
    }
  });
});

describe('resolvePushMeta：eat skill push 的元信息来源', () => {
  const content = md('name: pdf-tools\ndescription: >-\n  处理 PDF 时使用\n  含合并与拆分');

  it('默认取 frontmatter，slug 由 name 推导', () => {
    expect(resolvePushMeta(content, 'my-dir', {})).toEqual({
      slug: 'pdf-tools',
      name: 'pdf-tools',
      description: '处理 PDF 时使用 含合并与拆分',
    });
  });

  it('命令行参数优先于 frontmatter', () => {
    expect(resolvePushMeta(content, 'my-dir', { slug: 'x', name: 'N', description: 'D' })).toEqual({
      slug: 'x',
      name: 'N',
      description: 'D',
    });
  });

  it('没有 frontmatter 时只有 slug 回落到目录名，name/description 留空（服务端保持原值，决策 44）', () => {
    expect(resolvePushMeta('# 只有正文', 'weekly-report', {})).toEqual({
      slug: 'weekly-report',
      name: undefined,
      description: undefined,
    });
  });

  it('frontmatter 只写了 description 时，name 仍留空——不会被目录名顶掉', () => {
    const r = resolvePushMeta(md('description: 处理 PDF 时使用'), 'pdf-tools', {});
    expect(r).toEqual({ slug: 'pdf-tools', name: undefined, description: '处理 PDF 时使用' });
  });

  it('frontmatter 里写了空值等同没写（带上去只会被服务端 min(1) 拒掉）', () => {
    expect(resolvePushMeta(md('name:   \ndescription:'), 'my-dir', {})).toEqual({
      slug: 'my-dir',
      name: undefined,
      description: undefined,
    });
  });

  it('纯中文名推不出 slug（交由命令层报错提示 --slug）', () => {
    expect(resolvePushMeta(md('name: 周报生成'), '周报', {}).slug).toBe('');
  });
});
