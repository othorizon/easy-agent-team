import { AliyunRequests } from '../aliyun/aliyun-requests';
import { ConflictException, type Provider } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessRequestsService } from '../envs/access-requests.service';
import { McpConfigsService } from '../mcp-configs/mcp-configs.service';
import { DbAccessRequests } from '../dbs/db-access-requests';
import { DbsService } from '../dbs/dbs.service';
import { OssService } from '../oss/oss.service';
import { AppsService } from '../deploy/apps.service';
import { RequestTypes, sourceRequest, type RequestAction } from './request-types';

export const builtinRequestTypes: Provider = {
  provide: RequestTypes,
  inject: [AccessRequestsService, McpConfigsService, DbsService, OssService, AppsService, AuditService, DbAccessRequests, AliyunRequests],
  useFactory(env: AccessRequestsService, mcp: McpConfigsService, dbs: DbsService, oss: OssService, apps: AppsService, audit: AuditService, dbAccess: DbAccessRequests, aliyun: AliyunRequests) {
    const types = new RequestTypes();
    types.register(dbAccess.type());
    types.register(aliyun.type());
    const legacy = (name: string, target: string, resource = false) => async ({ row, user }: RequestAction) => audit.record({
      actorId: user.id, action: name, targetType: target,
      targetId: resource ? row.resource_id : row.source_id, meta: { decision: 'rejected' },
    });
    types.register(sourceRequest({
      type: 'env', label: '环境变量读取', table: 'access_request', reasonColumn: 'reason', timeColumn: 'decided_at',
      owner: 'coalesce((SELECT owner_id FROM environment WHERE id=r.resource_id),r.owner_id)',
      visible: `NOT EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id AND visibility='private' AND owner_id<>$1)`,
      notificationsAllowed: `NOT EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id AND visibility='private')`,
      resourceExists: 'EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id)',
      invalidReason: `CASE WHEN NOT EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id) THEN '环境已删除'
        WHEN EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id AND visibility='private') THEN '环境已设为私有'
        WHEN EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.details->'keys') requested(key) WHERE NOT EXISTS(SELECT 1 FROM env_variable v WHERE v.environment_id=r.resource_id AND v.key=requested.key)) THEN '申请的变量已删除或变化' END`,
      async invalidated(client, ids) { await client.query(`UPDATE access_request SET status='invalid' WHERE id=ANY($1::uuid[]) AND status='pending'`, [ids]); },
      approve: ({ user, row, decision }) => env.decide(user, row.source_id, { decision: 'approved', grantExpiresAt: decision.grantExpiresAt }),
      afterReject: legacy('access_request.decided', 'access_request'),
      presentation: row => ({
        lines: Array.isArray(row.details?.keys) ? [`变量：${row.details.keys.join('、')}`] : [],
        cardLines: Array.isArray(row.details?.keys) ? [`申请变量：${row.details.keys.join('、')}`] : [],
        allowExpiry: true,
        approvalHint: '同意将授权本次申请的全部变量，不设置到期时间；需要限制有效期请查看详情。',
      }),
    }));
    types.register(sourceRequest({
      type: 'mcp', label: 'MCP 配置订阅', table: 'mcp_subscription', reasonColumn: 'reason', timeColumn: 'decided_at',
      owner: 'coalesce((SELECT owner_id FROM mcp_config WHERE id=r.resource_id),r.owner_id)',
      resourceExists: "EXISTS(SELECT 1 FROM mcp_config WHERE id=r.resource_id AND visibility='team')",
      invalidReason: "CASE WHEN NOT EXISTS(SELECT 1 FROM mcp_config WHERE id=r.resource_id) THEN 'MCP 配置已删除' END",
      approve: ({ user, row }) => mcp.decide(user, row.source_id, { decision: 'approved' }),
      afterReject: legacy('mcp_config.subscription_decided', 'mcp_config', true),
      async withdraw({ row, client }) {
        await client.query(`DELETE FROM mcp_subscription WHERE id=$1 AND status='pending'`, [row.source_id]);
      },
      async resubmit({ row, client, user, reason }) {
        const { rows: [config] } = await client.query('SELECT id,visibility FROM mcp_config WHERE id=$1', [row.resource_id]);
        if (!config || config.visibility === 'private') throw new ConflictException('配置已删除或不再公开，请联系 owner');
        const result = await client.query(`INSERT INTO mcp_subscription(user_id,config_id,source,status,reason) VALUES($1,$2,'manual','pending',$3)
          ON CONFLICT(user_id,config_id) DO UPDATE SET status='pending',reason=$3,decided_by=NULL,decided_at=NULL,rejection_reason=NULL,excluded=false WHERE mcp_subscription.status='rejected' RETURNING id`, [user.id, row.resource_id, reason]);
        if (!result.rowCount) throw new ConflictException('订阅已生效或正在申请，请刷新状态');
      },
    }));
    types.register(sourceRequest({
      type: 'db', label: '数据库申请', table: 'db_assignment', owner: 'NULL::uuid',
      resourceExists: "EXISTS(SELECT 1 FROM db_assignment WHERE id=r.source_id AND status IN ('rejected','withdrawn'))",
      invalidReason: "CASE WHEN NOT EXISTS(SELECT 1 FROM db_instance WHERE id=r.resource_id) THEN '数据库实例已删除' END",
      approve: ({ user, row }) => dbs.approve(user, row.source_id),
      afterReject: legacy('db_assignment.rejected', 'db_assignment'),
      presentation: () => ({ approvalNotice: '批准后将执行资源开通。开通中或失败的状态会独立显示。' }),
    }));
    types.register(sourceRequest({
      type: 'oss', label: 'OSS 空间申请', table: 'oss_space', owner: 'NULL::uuid',
      runAction: (kind, work) => kind === 'approve' ? work(() => {}) : oss.store.exclusive(guard => work(guard)),
      resourceExists: "EXISTS(SELECT 1 FROM oss_space WHERE id=r.source_id AND status IN ('rejected','withdrawn'))",
      invalidReason: "CASE WHEN NOT EXISTS(SELECT 1 FROM oss_space WHERE id=r.resource_id) THEN '存储空间已删除' END",
      approve: ({ user, row }) => oss.decide(user, row.source_id, 'approve'),
      afterReject: legacy('oss_space.reject', 'oss_space'),
      presentation: row => ({ cardLines: [], lines: row.details?.prefix ? [`存储目录：${row.details.prefix}`] : [], approvalNotice: '批准后将执行资源开通。开通中或失败的状态会独立显示。' }),
    }));
    types.register({
      type: 'app', label: '应用部署授权', owner: 'NULL::uuid',
      resourceExists: "EXISTS(SELECT 1 FROM app WHERE id=r.resource_id AND owner_id=r.requester_id AND repo_version=(r.details->>'repoVersion')::int)",
      invalidReason: `CASE WHEN NOT EXISTS(SELECT 1 FROM app WHERE id=r.resource_id) THEN '应用已删除'
        WHEN NOT EXISTS(SELECT 1 FROM app WHERE id=r.resource_id AND repo_version=(r.details->>'repoVersion')::int) THEN '应用已更换仓库' END`,
      resubmittable: row => row.execution === 'revoked',
      async approve({ user, row, client }) {
        const { rows: [app] } = await client.query('SELECT slug,repo_version FROM app WHERE id=$1', [row.source_id]);
        if (!app || app.repo_version !== row.details.repoVersion) throw new ConflictException('仓库已变化，请刷新');
        await apps.approveDeploy(user, app.slug, row.details.repoVersion);
      },
      async reject({ row, client, decision, user }) {
        await client.query(`UPDATE approval_request SET status='rejected',rejection_reason=$2,decided_by=$3,decided_at=now() WHERE id=$1`, [row.id, decision.reason, user.id]);
        await client.query(`INSERT INTO approval_notification(request_id,event) VALUES($1,'rejected') ON CONFLICT DO NOTHING`, [row.id]);
      },
      async withdraw() {},
      async resubmit({ row, client, user, reason }) {
        const { rows: [app] } = await client.query('SELECT * FROM app WHERE id=$1 AND owner_id=$2 FOR UPDATE', [row.source_id, user.id]);
        if (!app || app.repo_version !== row.details.repoVersion) throw new ConflictException('应用或仓库已变化，请查看当前申请');
        await client.query(`SELECT eat_request_record('app',$1,$1,$2,NULL,$3,$4,$5,$6,$7,'pending',NULL,NULL,NULL,NULL,now(),NULL,true)`,
          [app.id, user.id, row.group_key, app.name, '/apps/' + app.slug, reason, JSON.stringify(row.details)]);
      },
      presentation: row => ({ appSlug: row.details?.slug, approvalNotice: '批准当前仓库版本的部署权限，并允许管理应用成员。', lines: row.details?.repoUrl ? [`仓库：${row.details.repoUrl}`, `分支：${row.details.branch ?? '未记录'}`] : [] }),
    });
    return types;
  },
};
