import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { Api } from '../src/client.js';
import { registerOssCommands } from '../src/commands/oss.js';
import { buildEatTools, ossToolRequest } from '@eat/shared';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const request = vi.fn().mockResolvedValue({});
  vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const run = async (...args: string[]) => {
    const p = new Command()
      .exitOverride()
      .configureOutput({ writeErr: () => {} });
    registerOssCommands(p);
    await p.parseAsync(['node', 'eat', 'oss', ...args]);
  };
  return { request, run };
}
describe('OSS CLI and MCP contracts', () => {
  it('reuses a supplied request id and sends the validated request', async () => {
    const { run, request } = fixture(),
      id = randomUUID();
    await run(
      'request',
      'Documents',
      '--purpose',
      'Project files',
      '--request-id',
      id,
    );
    expect(request).toHaveBeenCalledWith('POST', '/api/oss/spaces', {
      name: 'Documents',
      purpose: 'Project files',
      requestId: id,
    });
  });
  it('converts on/off to booleans and rejects invalid states before a request', async () => {
    const { run, request } = fixture(),
      id = randomUUID();
    await run('public-read', id, 'off');
    expect(request).toHaveBeenCalledWith(
      'PUT',
      `/api/oss/spaces/${id}/public-read`,
      { enabled: false },
    );
    request.mockClear();
    await expect(run('public-read', id, 'yes')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('requires --yes for rotating the shared key, without accidentally retrieving secrets', async () => {
    const { run, request } = fixture();
    await expect(run('credentials', 'reset')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await run('credentials', 'reset', '--yes');
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'POST',
      '/api/oss/me/credentials/reset',
      undefined,
    );
  });
  it('exposes the same operations in stdio and HTTP MCP', () => {
    const local = buildEatTools('local').filter((t) =>
        t.name.includes('_oss_'),
      ),
      remote = buildEatTools('remote').filter((t) => t.name.includes('_oss_'));
    expect(local).toEqual(remote);
    expect(local).toHaveLength(9);
    expect(ossToolRequest('get_oss_credentials', {}, randomUUID())).toEqual({
      method: 'POST',
      path: '/api/oss/me/credentials',
    });
  });
});
