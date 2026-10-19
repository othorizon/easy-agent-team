import { describe, expect, it, vi } from 'vitest';
import OSS from 'ali-oss';
import { OssCloud } from '../src/oss/oss-cloud';
const connection = {
  bucket: 'bucket-test',
  region: 'cn-beijing',
  accessKeyId: 'test',
  accessKeySecret: 'test',
};
describe('OSS SDK boundary', () => {
  it('omits empty prefix from signed root-list requests', async () => {
    const cloud = new OssCloud(),
      list = vi.fn().mockResolvedValue({ objects: [] });
    vi.spyOn(cloud, 'client').mockReturnValue({ list } as unknown as OSS);
    await cloud.list(connection, '');
    expect(list).toHaveBeenCalledWith({ 'max-keys': 100 }, {});
    await cloud.list(connection, 'eat-storage/test/');
    expect(list).toHaveBeenLastCalledWith(
      { prefix: 'eat-storage/test/', 'max-keys': 100 },
      {},
    );
  });
  it('removes only exact probe object versions and delete markers', async () => {
    const cloud = new OssCloud(),
      remove = vi.fn().mockResolvedValue({});
    const getBucketVersions = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ name: 'probe/a', versionId: 'old' }],
        deleteMarker: [{ name: 'probe/a', versionId: 'marker' }],
      })
      .mockResolvedValue({ objects: [], deleteMarker: [] });
    vi.spyOn(cloud, 'client').mockReturnValue({
      getBucketVersions,
      delete: remove,
    } as unknown as OSS);
    await cloud.cleanProbeObjects(connection, 'probe/', ['probe/a']);
    expect(remove.mock.calls).toEqual([
      ['probe/a', { versionId: 'old' }],
      ['probe/a', { versionId: 'marker' }],
    ]);
  });
  it('refuses unexpected keys before deleting any version', async () => {
    const cloud = new OssCloud(),
      remove = vi.fn();
    vi.spyOn(cloud, 'client').mockReturnValue({
      getBucketVersions: vi.fn().mockResolvedValue({
        objects: [
          { name: 'probe/a', versionId: 'one' },
          { name: 'probe/foreign', versionId: 'two' },
        ],
        deleteMarker: [],
      }),
      delete: remove,
    } as unknown as OSS);
    await expect(
      cloud.cleanProbeObjects(connection, 'probe/', ['probe/a']),
    ).rejects.toThrow('UnexpectedObjectInProbePrefix');
    expect(remove).not.toHaveBeenCalled();
    await expect(
      cloud.cleanProbeObjects(connection, 'probe/', ['other/a']),
    ).rejects.toThrow('InvalidProbeScope');
  });
});
