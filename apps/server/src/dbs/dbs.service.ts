import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type {
  CreateDbAssignmentRequest,
  CreateDbInstanceRequest,
  DbAssignmentInfo,
  DbCredentials,
  DbInstanceInfo,
} from "@eat/shared";
import { dbConnectionUrl } from "@eat/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser } from "../auth/auth.decorators";
import { decryptSecret, encryptSecret } from "../common/crypto";
import { isFullId } from "../common/short-id";
import { DB, type Db } from "../db/db.module";
import { dbAssignments, dbInstances, users } from "../db/schema";
import {
  assertProvisionAbsent,
  disablePostgres,
  enablePostgres,
  provisionPostgres,
  type AdminConn,
} from "./provisioner";

type AssignmentRow = typeof dbAssignments.$inferSelect;
type InstanceRow = typeof dbInstances.$inferSelect;

@Injectable()
export class DbsService {
  private readonly logger = new Logger(DbsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------- 实例（管理员维护，成员可见基本信息用于发起申请） ----------

  async listInstances(): Promise<DbInstanceInfo[]> {
    const rows = await this.db
      .select({
        instance: dbInstances,
        assignmentCount: count(dbAssignments.id),
      })
      .from(dbInstances)
      .leftJoin(
        dbAssignments,
        and(
          eq(dbAssignments.instanceId, dbInstances.id),
          ne(dbAssignments.status, "deleted"),
        ),
      )
      .groupBy(dbInstances.id);
    return rows.map((r) => ({
      id: r.instance.id,
      name: r.instance.name,
      engine: r.instance.engine,
      host: r.instance.host,
      port: r.instance.port,
      adminUser: r.instance.adminUser,
      note: r.instance.note,
      assignmentCount: Number(r.assignmentCount),
      createdAt: r.instance.createdAt.toISOString(),
    }));
  }

  async createInstance(user: AuthUser, dto: CreateDbInstanceRequest) {
    const [row] = await this.db
      .insert(dbInstances)
      .values({
        name: dto.name,
        engine: dto.engine,
        host: dto.host,
        port: dto.port,
        adminUser: dto.adminUser,
        adminPasswordEncrypted: encryptSecret(dto.adminPassword),
        note: dto.note,
        createdBy: user.id,
      })
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: "db_instance.created",
      targetType: "db_instance",
      targetId: row.id,
    });
    return { id: row.id };
  }

  async removeInstance(user: AuthUser, id: string) {
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: dbInstances.id })
        .from(dbInstances)
        .where(eq(dbInstances.id, id))
        .for("update");
      const [{ active }] = await tx
        .select({ active: count(dbAssignments.id) })
        .from(dbAssignments)
        .where(
          and(
            eq(dbAssignments.instanceId, id),
            inArray(dbAssignments.status, ["active", "provisioning"]),
          ),
        );
      if (Number(active) > 0) {
        throw new ConflictException({
          error: "CONFLICT",
          message:
            "实例上仍有使用中或开通中的分配，请等待开通完成并回收后再删除",
        });
      }
      await tx.delete(dbInstances).where(eq(dbInstances.id, id));
    });
    await this.audit.record({
      actorId: user.id,
      action: "db_instance.deleted",
      targetType: "db_instance",
      targetId: id,
    });
    return { ok: true };
  }

  private async getInstance(id: string): Promise<InstanceRow> {
    const row = (
      await this.db
        .select()
        .from(dbInstances)
        .where(eq(dbInstances.id, id))
        .limit(1)
    )[0];
    if (!row)
      throw new NotFoundException({
        error: "NOT_FOUND",
        message: "数据库实例不存在",
      });
    return row;
  }

  private adminConn(instance: InstanceRow): AdminConn {
    return {
      host: instance.host,
      port: instance.port,
      adminUser: instance.adminUser,
      adminPassword: decryptSecret(instance.adminPasswordEncrypted),
    };
  }

  // ---------- 分配 ----------

  /** 一批记录 → 契约对象：实例 / 用户各查一次，不逐行回表 */
  private async toInfos(rows: AssignmentRow[]): Promise<DbAssignmentInfo[]> {
    if (rows.length === 0) return [];
    const uniq = (ids: Array<string | null>) => [
      ...new Set(ids.filter((id): id is string => !!id)),
    ];
    const instanceIds = uniq(rows.map((r) => r.instanceId));
    const userIds = uniq(rows.flatMap((r) => [r.requesterId, r.decidedBy]));
    const instanceById = new Map(
      (
        await this.db
          .select()
          .from(dbInstances)
          .where(inArray(dbInstances.id, instanceIds))
      ).map((i) => [i.id, i]),
    );
    const userNameById = new Map(
      (
        await this.db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
      ).map((u) => [u.id, u.name]),
    );
    return rows.map((row) => {
      const instance = instanceById.get(row.instanceId);
      return {
        id: row.id,
        instanceId: row.instanceId,
        instanceName: instance?.name ?? "(已删除)",
        instanceHost: instance?.host ?? null,
        instancePort: instance?.port ?? null,
        engine: instance?.engine ?? "postgres",
        dbName: row.dbName,
        dbUser: row.dbUser,
        purpose: row.purpose,
        status: row.status,
        requesterId: row.requesterId,
        requesterName: userNameById.get(row.requesterId) ?? "(已删除)",
        decidedByName: row.decidedBy
          ? (userNameById.get(row.decidedBy) ?? "(已删除)")
          : null,
        hasCredentials: row.passwordEncrypted !== null,
        error: row.error,
        rejectionReason: row.rejectionReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private async toInfo(row: AssignmentRow): Promise<DbAssignmentInfo> {
    return (await this.toInfos([row]))[0];
  }

  async createAssignment(
    user: AuthUser,
    dto: CreateDbAssignmentRequest,
  ): Promise<DbAssignmentInfo> {
    await this.getInstance(dto.instanceId);
    const dbUser = `u_${dto.dbName}`.slice(0, 31);
    // 占用判定**包含已删除的分配**：删除只到记录级（决策 13），实例上的库与账号多半还在，
    // 放行会让批准时的 CREATE DATABASE / CREATE ROLE 当场失败。但两种情况得说清楚区别——
    // 只回一句「已被占用」时，申请人（尤其是 AI）在清单里一条都看不到，无从判断下一步该干嘛。
    const [exists] = await this.db
      .select({ id: dbAssignments.id, status: dbAssignments.status })
      .from(dbAssignments)
      .where(
        and(
          eq(dbAssignments.instanceId, dto.instanceId),
          eq(dbAssignments.dbName, dto.dbName),
        ),
      )
      .limit(1);
    if (exists) {
      throw new ConflictException({
        error: "CONFLICT",
        message:
          exists.status === "deleted"
            ? `该实例上库名 ${dto.dbName} 曾被分配过，分配记录已删除但实例上的库与账号未必清理过——换个库名，或请管理员在实例上清理后再申请`
            : `该实例上库名 ${dto.dbName} 已被占用`,
      });
    }
    const [row] = await this.db
      .insert(dbAssignments)
      .values({
        instanceId: dto.instanceId,
        requesterId: user.id,
        dbName: dto.dbName,
        dbUser,
        purpose: dto.purpose,
      })
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: "db_assignment.requested",
      targetType: "db_assignment",
      targetId: row.id,
      meta: { dbName: dto.dbName },
    });
    return this.toInfo(row);
  }

  // 已删除的分配不再出现在列表里（记录保留在库中供审计追溯）

  async listMine(user: AuthUser): Promise<DbAssignmentInfo[]> {
    const rows = await this.db
      .select()
      .from(dbAssignments)
      .where(
        and(
          eq(dbAssignments.requesterId, user.id),
          ne(dbAssignments.status, "deleted"),
        ),
      )
      .orderBy(desc(dbAssignments.createdAt));
    return this.toInfos(rows);
  }

  async listAll(user: AuthUser): Promise<DbAssignmentInfo[]> {
    const rows = await this.db
      .select()
      .from(dbAssignments)
      .where(ne(dbAssignments.status, "deleted"))
      .orderBy(desc(dbAssignments.createdAt))
      .limit(200);
    return this.toInfos(rows);
  }

  private async getAssignment(id: string): Promise<AssignmentRow> {
    // 乱写的 id（MCP / CLI 传进来的库名之类）直接 404，别让 uuid 列的类型错误冒成 500
    const row = !isFullId(id) ? undefined : (
      await this.db
        .select()
        .from(dbAssignments)
        .where(eq(dbAssignments.id, id))
        .limit(1)
    )[0];
    if (!row)
      throw new NotFoundException({
        error: "NOT_FOUND",
        message: "分配记录不存在",
      });
    return row;
  }

  /** 详情：申请人或管理员可看（已删除的记录留库供追溯，直接访问仍能看到，只是清单里不列） */
  async get(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (user.role !== "admin" && row.requesterId !== user.id) {
      throw new ForbiddenException({
        error: "FORBIDDEN",
        message: "仅申请人或管理员可查看该分配",
      });
    }
    return this.toInfo(row);
  }

  /**
   * 读取连接凭证（决策 91）：只有申请人与管理员能读，每次读取都 await 落审计（与 secret.read 同级）。
   * 凭证只在数据库这一处取——不进环境变量，也就没有「授权给别人读」这条路：
   * 和 OSS 的个人 AK/SK 一样，它是某个人的项目库账号，不是团队公共配置
   */
  async credentials(user: AuthUser, id: string, ip?: string): Promise<DbCredentials> {
    const row = await this.getAssignment(id);
    if (user.role !== "admin" && row.requesterId !== user.id) {
      throw new ForbiddenException({
        error: "FORBIDDEN",
        message: "仅申请人或管理员可读取该库的连接凭证",
      });
    }
    if (row.status !== "active") {
      throw new ConflictException({
        error: "CONFLICT",
        message:
          row.status === "disabled"
            ? "该库的账号已被管理员禁用，恢复后才能读取凭证"
            : "该分配尚未开通或已删除，没有可用的连接凭证",
      });
    }
    if (!row.passwordEncrypted) {
      throw new ConflictException({
        error: "DB_CREDENTIALS_MISSING",
        message:
          "平台上已没有这个账号的密码（旧版本里它所在的凭证环境被删除过），请管理员在实例上重置该账号密码",
      });
    }
    const instance = await this.getInstance(row.instanceId);
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: "db_credentials.read",
      targetType: "db_assignment",
      targetId: row.id,
      meta: { dbName: row.dbName },
      ip,
    });
    const base = {
      engine: instance.engine,
      host: instance.host,
      port: instance.port,
      database: row.dbName,
      user: row.dbUser,
      password: decryptSecret(row.passwordEncrypted),
    };
    return { assignmentId: row.id, ...base, url: dbConnectionUrl(base) };
  }

  /** 批准：在实例上真实建库建号，密码加密存在分配记录上（决策 91，不再生成凭证环境） */
  async approve(
    user: AuthUser,
    id: string,
    retry = false,
  ): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== (retry ? "failed" : "pending"))
      throw new ConflictException("仅待审批申请可批准，执行失败请使用重试");
    if (retry && user.role !== "admin")
      throw new ForbiddenException("仅管理员可重试资源开通");
    const instance = await this.getInstance(row.instanceId);
    if (instance.engine !== "postgres") {
      throw new BadRequestException({
        error: "NOT_SUPPORTED",
        message:
          "MySQL 实例暂不支持自动执行（后续版本提供），请先使用 postgres 实例",
      });
    }
    // Claim before external provisioning: a crash / repeated request cannot create
    // the same database twice. Approval and execution are separate states.
    const claimed = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: dbInstances.id })
        .from(dbInstances)
        .where(eq(dbInstances.id, row.instanceId))
        .for("update");
      if (!existing) throw new ConflictException("数据库实例已删除");
      const [assignment] = await tx
        .update(dbAssignments)
        .set({
          status: "provisioning",
          decidedBy: user.id,
          updatedAt: new Date(),
          error: null,
        })
        .where(
          and(
            eq(dbAssignments.id, id),
            eq(dbAssignments.status, retry ? "failed" : "pending"),
          ),
        )
        .returning({ id: dbAssignments.id });
      return assignment;
    });
    if (!claimed) throw new ConflictException("申请正在处理或已经结束");
    const password = randomBytes(18).toString("hex");
    try {
      if (retry)
        await assertProvisionAbsent(
          this.adminConn(instance),
          row.dbName,
          row.dbUser,
        );
      await provisionPostgres(
        this.adminConn(instance),
        row.dbName,
        row.dbUser,
        password,
      );
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await this.db
        .update(dbAssignments)
        .set({
          status: "failed",
          error: message,
          decidedBy: user.id,
          updatedAt: new Date(),
        })
        .where(eq(dbAssignments.id, id));
      this.logger.warn(`建库失败(${row.dbName}): ${message}`);
      return this.toInfo(await this.getAssignment(id));
    }

    await this.db
      .update(dbAssignments)
      .set({
        status: "active",
        passwordEncrypted: encryptSecret(password),
        error: null,
        decidedBy: user.id,
        updatedAt: new Date(),
      })
      .where(eq(dbAssignments.id, id));
    await this.audit.record({
      actorId: user.id,
      action: "db_assignment.provisioned",
      targetType: "db_assignment",
      targetId: id,
      meta: { dbName: row.dbName },
    });
    return this.toInfo(await this.getAssignment(id));
  }

  async reject(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== "pending")
      throw new ConflictException({
        error: "CONFLICT",
        message: "仅 pending 的申请可驳回",
      });
    await this.db
      .update(dbAssignments)
      .set({ status: "rejected", decidedBy: user.id, updatedAt: new Date() })
      .where(eq(dbAssignments.id, id));
    await this.audit.record({
      actorId: user.id,
      action: "db_assignment.rejected",
      targetType: "db_assignment",
      targetId: id,
    });
    return this.toInfo(await this.getAssignment(id));
  }

  /** 禁用账号（可恢复）：ALTER ROLE NOLOGIN + 断开现有连接 */
  async disable(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== "active")
      throw new ConflictException({
        error: "CONFLICT",
        message: "仅 active 的分配可禁用",
      });
    const instance = await this.getInstance(row.instanceId);
    await disablePostgres(this.adminConn(instance), row.dbName, row.dbUser);
    await this.db
      .update(dbAssignments)
      .set({ status: "disabled", decidedBy: user.id, updatedAt: new Date() })
      .where(eq(dbAssignments.id, id));
    await this.audit.record({
      actorId: user.id,
      action: "db_assignment.disabled",
      targetType: "db_assignment",
      targetId: id,
    });
    return this.toInfo(await this.getAssignment(id));
  }

  async enable(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== "disabled")
      throw new ConflictException({
        error: "CONFLICT",
        message: "仅 disabled 的分配可恢复",
      });
    const instance = await this.getInstance(row.instanceId);
    await enablePostgres(this.adminConn(instance), row.dbUser);
    await this.db
      .update(dbAssignments)
      .set({ status: "active", decidedBy: user.id, updatedAt: new Date() })
      .where(eq(dbAssignments.id, id));
    return this.toInfo(await this.getAssignment(id));
  }

  /** 删除（仅记录级，决策 13）：标记 deleted 并清掉平台上存的密码；实例上的数据库与账号不做物理删除，需管理员在实例上手动清理 */
  async remove(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(dbAssignments)
        .where(eq(dbAssignments.id, id))
        .for("update");
      if (!row) throw new NotFoundException("分配记录不存在");
      if (
        row.status !== "active" &&
        row.status !== "disabled" &&
        row.status !== "failed" &&
        row.status !== "rejected"
      ) {
        throw new ConflictException({
          error: "CONFLICT",
          message: "仅 active/disabled/failed/rejected 的分配可删除",
        });
      }
      await tx
        .update(dbAssignments)
        .set({
          status: "deleted",
          passwordEncrypted: null,
          decidedBy: user.id,
          updatedAt: new Date(),
        })
        .where(eq(dbAssignments.id, id));
      return row;
    });
    await this.audit.record({
      actorId: user.id,
      action: "db_assignment.deleted",
      targetType: "db_assignment",
      targetId: id,
      meta: { dbName: row.dbName, physicalDrop: false },
    });
    return this.toInfo(await this.getAssignment(id));
  }
}
