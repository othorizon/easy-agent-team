#!/usr/bin/env node
/** Reply form visibility and real API sequencing, without a browser or database. */
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
const webRequire = createRequire(join(webRoot, 'package.json'));
const { build } = createRequire(webRequire.resolve('vite/package.json'))('esbuild');
const scratch = await mkdtemp(join(tmpdir(), 'eat-help-reply-'));
try {
  const outfile = join(scratch, 'check.cjs');
  await build({
    stdin: {
      resolveDir: webRoot,
      loader: 'tsx',
      contents: String.raw`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { HelpDetailPage } from './src/pages/HelpDetail';
import { sendHelpReply } from './src/lib/help-reply';

const request = {
  id: 'test', title: '求助测试', description: '问题', tried: '已尝试', status: 'open',
  requesterId: 'requester', requesterName: '求助者', helperId: 'helper', helperName: '回答者',
  skillSlug: null, experienceSkillSlug: null, messages: [],
  createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z',
};
function renderForm(userId, status) {
  globalThis.localStorage = {getItem: key => key === 'eat.user' ? JSON.stringify({id: userId, role: userId === 'admin' ? 'admin' : 'member'}) : null};
  const client = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, gcTime: Infinity}}});
  client.setQueryData(['help', 'test'], {...request, status});
  const originalError = console.error;
  console.error = (...args) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) originalError(...args);
  };
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/help/test']}>
          <Routes><Route path='/help/:id' element={<HelpDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    return html.match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0] ?? '';
  } finally {
    console.error = originalError;
    client.clear();
  }
}
async function withApi(failAt, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.localStorage = {getItem: () => null};
  globalThis.fetch = async (url, options) => {
    calls.push({url, method: options.method, body: JSON.parse(options.body)});
    const failed = url.endsWith('/' + failAt);
    return new Response(JSON.stringify(failed ? {error: 'TEST', message: failAt + ' failed'} : {}), {status: failed ? 503 : 200});
  };
  try { await run(calls); } finally { globalThis.fetch = originalFetch; }
}
export async function run() {
  const originalStorage = globalThis.localStorage;
  try {
    await test('求助双方可在未解决的求助中回复并标记为已解决', () => {
      for (const userId of ['helper', 'requester']) {
        for (const status of ['open', 'answered']) {
          const form = renderForm(userId, status);
          assert.ok(form.includes('回复并标记为已解决'));
          assert.match(form, /type="submit"/);
        }
      }
    });
    await test('旁观管理员不显示解决选项；已解决保留重新打开选项；已关闭不可回复', () => {
      assert.ok(!renderForm('admin', 'open').includes('回复并标记为已解决'));
      const resolved = renderForm('helper', 'resolved');
      assert.ok(!resolved.includes('回复并标记为已解决'));
      assert.ok(resolved.includes('发送后重新打开这条求助'));
      assert.equal(renderForm('helper', 'closed'), '');
    });
    await test('合并操作先保存回复，再标记已解决，前端选项不泄漏到回复 API', async () => {
      await withApi(null, async calls => {
        const result = await sendHelpReply('test', {content: '解决方法', reopen: true, resolve: true});
        assert.equal(result.resolveError, null);
        assert.deepEqual(calls, [
          {url: '/api/help-requests/test/reply', method: 'POST', body: {content: '解决方法', reopen: true}},
          {url: '/api/help-requests/test/resolve', method: 'POST', body: {}},
        ]);
      });
    });
    await test('普通回复不会标记解决，仍透传 reopen=false', async () => {
      await withApi(null, async calls => {
        await sendHelpReply('test', {content: '谢谢', reopen: false});
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body, {content: '谢谢', reopen: false});
      });
    });
    await test('回复失败时抛错且不执行标记，表单可保留草稿', async () => {
      await withApi('reply', async calls => {
        await assert.rejects(sendHelpReply('test', {content: '解决方法', reopen: true, resolve: true}), /reply failed/);
        assert.equal(calls.length, 1);
      });
    });
    await test('回复成功但标记失败时返回部分成功，不重复发送已保存的回复', async () => {
      await withApi('resolve', async calls => {
        const result = await sendHelpReply('test', {content: '解决方法', reopen: true, resolve: true});
        assert.equal(result.resolveError?.message, 'resolve failed');
        assert.equal(calls.filter(call => call.url.endsWith('/reply')).length, 1);
        assert.equal(calls.length, 2);
      });
    });
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
}
`,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
  });
  await webRequire(outfile).run();
} finally {
  await rm(scratch, { recursive: true, force: true });
}
