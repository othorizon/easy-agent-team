/** Website comment screenshots use isolated fixture data, never production records. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

export async function captureWebsiteUI({ context, platform, published, output, threads }) {
  const directory = output + '/website';
  await mkdir(directory, { recursive: true });
  const samples = structuredClone(threads);
  const original = samples.find((thread) => thread.id === 'old');
  original.comments.push(
    {
      ...original.comments[0],
      id: 'design-reply',
      authorName: '陈沐',
      canDelete: false,
      content: '已调整标题层级，重点信息现在更清晰了。',
    },
    {
      ...original.comments[0],
      id: 'design-reply-2',
      content: '这个方向可以，移动端也一起看一下。',
    },
  );
  samples.push({
    ...structuredClone(original),
    id: 'design-page',
    anchor: { type: 'page' },
    comments: [
      { ...original.comments[0], id: 'design-page-first', content: '建议把主要行动按钮再突出一些。' },
    ],
  });
  const setup = async (ctx) => {
    const page = await ctx.newPage();
    await page.route(platform + '/api/sites/demo/threads?*', (route) =>
      route.fulfill({
        json: samples.filter(
          (thread) => thread.page === new URL(route.request().url()).searchParams.get('page'),
        ),
      }),
    );
    await page.goto(published);
    const toggle = page.locator('#__eat_widget .toggle');
    await toggle.waitFor();
    assert.equal(
      await toggle.evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgb(255, 255, 255)',
      'original white launcher',
    );
    await toggle.click();
    const frame = page.frameLocator('iframe[title="Folio 评论"]');
    await frame.locator('#thread-old').waitFor();
    return { page, frame };
  };
  const shot = async (page, name, full = false) => {
    const iframe = page.locator('iframe[title="Folio 评论"]');
    assert.equal(await iframe.evaluate((el) => el.clientWidth > 0), true);
    assert.equal(
      await page
        .frameLocator('iframe[title="Folio 评论"]')
        .locator('body')
        .evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'no iframe horizontal overflow',
    );
    await (full ? page : iframe).screenshot({ path: `${directory}/${name}.png`, animations: 'disabled' });
  };
  const desktop = await context();
  const { page, frame } = await setup(desktop);
  await shot(page, '01-default-full', true);
  await shot(page, '02-default');
  await frame.locator('#thread-old').getByRole('button', { name: '展开讨论并定位标注' }).click();
  await frame.getByRole('textbox', { name: '回复内容' }).fill('我再确认一下手机上的显示效果。');
  await shot(page, '03-thread');
  await frame.locator('#thread-old').getByRole('button', { name: '讨论操作' }).click();
  await frame.getByRole('menuitem', { name: '标记解决' }).waitFor();
  await shot(page, '04-menu');
  await frame.getByRole('menu').press('Escape');
  await frame.getByRole('textbox', { name: '回复内容' }).press('Escape');
  await frame.getByRole('button', { name: /^已解决/ }).click();
  await frame.locator('#thread-new').getByRole('button', { name: '展开讨论并定位标注' }).click();
  await shot(page, '05-resolved');
  await frame.getByRole('button', { name: '添加评论…', exact: true }).click();
  await frame.getByRole('textbox', { name: '评论内容' }).fill('这里的留白可以稍微收紧一点。');
  await shot(page, '06-new-comment');
  await frame.getByRole('button', { name: '选择标注位置' }).click();
  await frame.getByRole('menuitem', { name: '框选区域' }).waitFor();
  await shot(page, '07-position-menu');
  await desktop.close();

  const mobile = await context(true, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  const phone = await setup(mobile);
  await shot(phone.page, '08-mobile-default', true);
  await phone.frame.locator('#thread-old').getByRole('button', { name: '展开讨论并定位标注' }).click();
  const input = phone.frame.getByRole('textbox', { name: '回复内容' });
  assert.equal(
    await input.evaluate((el) => el === document.activeElement),
    false,
    'selection leaves touch keyboard closed',
  );
  await input.fill('手机上也能在同一组里继续讨论。');
  await shot(phone.page, '09-mobile-thread', true);
  await phone.frame.locator('#thread-old').getByRole('button', { name: '讨论操作' }).click();
  await shot(phone.page, '10-mobile-menu', true);
  await mobile.close();
  console.log(
    'PASS website evidence: white launcher, default open threads, grouped replies, menus, folded resolved threads, new comment, location picker and touch layouts',
  );
}
