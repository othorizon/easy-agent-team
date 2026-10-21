-- Business writes and their approval snapshots commit together. Snapshots deliberately
-- have no resource/user foreign keys: deleting a resource must not erase decisions.
ALTER TABLE access_request ADD COLUMN rejection_reason text;
ALTER TABLE mcp_subscription ADD COLUMN rejection_reason text;
ALTER TABLE db_assignment ADD COLUMN rejection_reason text;
CREATE TABLE approval_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('env','mcp','db','oss','app')),
  source_id uuid NOT NULL, resource_id uuid NOT NULL, requester_id uuid NOT NULL,
  owner_id uuid, group_key text NOT NULL, round integer NOT NULL,
  latest boolean NOT NULL DEFAULT true,
  target_name text NOT NULL, resource_url text NOT NULL, reason text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn','invalid')),
  rejection_reason text, closed_reason text, execution text, execution_error text,
  decided_by uuid, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
  reminded_at timestamptz, notification_error text
);
CREATE UNIQUE INDEX approval_request_latest_idx ON approval_request(group_key) WHERE latest;
CREATE UNIQUE INDEX approval_request_pending_idx ON approval_request(group_key) WHERE status='pending';
CREATE INDEX approval_request_source_idx ON approval_request(type, source_id);
CREATE INDEX approval_request_requester_idx ON approval_request(requester_id, created_at DESC);
CREATE INDEX approval_request_status_idx ON approval_request(status, created_at DESC);
CREATE TABLE approval_notification (
  id bigserial PRIMARY KEY, request_id uuid NOT NULL REFERENCES approval_request(id) ON DELETE CASCADE,
  event text NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(), last_error text, sent_to jsonb NOT NULL DEFAULT '[]',
  UNIQUE(request_id,event)
);
--> statement-breakpoint
CREATE FUNCTION eat_request_record(k text, s uuid, r uuid, u uuid, o uuid, g text, n text, href text,
  why text, data jsonb, st text, rejection text, execution_state text, execution_error text,
  actor uuid, created timestamptz, decided timestamptz, new_round boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE prev approval_request; next_round integer; rid uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('approval-group:' || g,0));
  SELECT * INTO prev FROM approval_request WHERE group_key=g AND latest FOR UPDATE;
  IF prev.id IS NOT NULL AND NOT new_round AND prev.source_id=s THEN
    UPDATE approval_request SET
      status=CASE WHEN prev.status<>'pending' THEN prev.status ELSE st END,
      rejection_reason=CASE WHEN prev.status='pending' AND st='rejected' THEN rejection ELSE prev.rejection_reason END,
      execution=execution_state, execution_error=eat_request_record.execution_error,
      details=CASE WHEN k='env' AND st='approved' THEN prev.details || jsonb_build_object('grantExpiresAt',data->'grantExpiresAt') ELSE prev.details END,
      decided_by=CASE WHEN prev.status='pending' AND st<>'pending' THEN actor ELSE prev.decided_by END,
      decided_at=CASE WHEN prev.status='pending' AND st<>'pending' THEN decided ELSE prev.decided_at END
    WHERE id=prev.id;
    IF prev.status='pending' AND st IN ('approved','rejected') THEN
      INSERT INTO approval_notification(request_id,event) VALUES(prev.id,st) ON CONFLICT DO NOTHING;
    END IF;
    RETURN;
  END IF;
  IF prev.status='pending' THEN
    RAISE EXCEPTION '同一事项已有待审批申请' USING ERRCODE='23505';
  END IF;
  next_round := coalesce(prev.round,0)+1;
  UPDATE approval_request SET latest=false WHERE group_key=g AND latest;
  INSERT INTO approval_request(type,source_id,resource_id,requester_id,owner_id,group_key,round,
    target_name,resource_url,reason,details,status,rejection_reason,execution,execution_error,
    decided_by,created_at,decided_at)
  VALUES(k,s,r,u,o,g,next_round,n,href,coalesce(why,''),data,st,rejection,execution_state,
    eat_request_record.execution_error,actor,created,decided) RETURNING id INTO rid;
  IF st='pending' THEN INSERT INTO approval_notification(request_id,event) VALUES(rid,'submitted'); END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION eat_request_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb; oldj jsonb; k text; st text; x text; rid uuid; uid uuid; oid uuid;
  g text; n text; href text; why text; data jsonb; actor uuid; decided timestamptz; again boolean := false;
BEGIN
  j := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  oldj := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  k := CASE TG_TABLE_NAME WHEN 'access_request' THEN 'env' WHEN 'mcp_subscription' THEN 'mcp'
    WHEN 'db_assignment' THEN 'db' WHEN 'oss_space' THEN 'oss' ELSE 'app' END;
  IF TG_OP='DELETE' THEN
    IF k='mcp' AND EXISTS(SELECT 1 FROM mcp_config WHERE id=(j->>'config_id')::uuid) THEN
      UPDATE approval_request SET status='withdrawn',closed_reason='申请人撤回订阅',decided_at=now()
        WHERE type=k AND source_id=(j->>'id')::uuid AND status='pending';
      UPDATE approval_request SET execution='revoked' WHERE type=k AND source_id=(j->>'id')::uuid AND status='approved' AND latest;
      RETURN OLD;
    END IF;
    UPDATE approval_request SET execution='deleted' WHERE type=k AND source_id=(j->>'id')::uuid AND status='approved' AND latest;
    UPDATE approval_request SET status='invalid', closed_reason='资源或申请记录已删除', decided_at=now()
      WHERE type=k AND source_id=(j->>'id')::uuid AND status='pending';
    RETURN OLD;
  END IF;
  st := j->>'status';
  actor := (j->>'decided_by')::uuid;
  decided := (j->>'decided_at')::timestamptz;
  data := '{}'::jsonb;
  IF k='env' THEN
    rid := (j->>'environment_id')::uuid; uid := (j->>'requester_id')::uuid;
    SELECT owner_id, name, '/envs/' || slug INTO oid,n,href FROM environment WHERE id=rid;
    data := jsonb_build_object('keys',j->'keys','environmentSlug',substring(href from 7),'grantExpiresAt',j->'grant_expires_at');
    SELECT string_agg(v,',' ORDER BY v) INTO g FROM (SELECT DISTINCT jsonb_array_elements_text(j->'keys') v) q;
    why := j->>'reason';
  ELSIF k='mcp' THEN
    IF j->>'source'<>'manual' OR ((j->>'excluded')::boolean) OR (st='approved' AND j->>'decided_by'=j->>'user_id') THEN
      UPDATE approval_request SET status='withdrawn',closed_reason='已通过其他方式取得权限或撤回订阅',decided_at=now()
        WHERE type=k AND source_id=(j->>'id')::uuid AND status='pending';
      RETURN NEW;
    END IF;
    rid := (j->>'config_id')::uuid; uid := (j->>'user_id')::uuid;
    SELECT owner_id,name,'/mcp-configs' INTO oid,n,href FROM mcp_config WHERE id=rid;
    data := jsonb_build_object('configId',rid); why := j->>'reason';
  ELSIF k='db' THEN
    rid := (j->>'instance_id')::uuid; uid := (j->>'requester_id')::uuid;
    SELECT name INTO n FROM db_instance WHERE id=rid;
    n := (j->>'db_name') || ' @ ' || coalesce(n,'已删除实例');
    href := '/db/' || (j->>'id'); why := j->>'purpose';
    data := jsonb_build_object('instanceId',rid,'dbName',j->>'db_name');
    g := j->>'db_name';
    IF st IN ('provisioning','active','failed','disabled','deleted') THEN x:=st; st:='approved'; END IF;
    -- Legacy updated_at includes later lifecycle changes; never invent a decision time.
    IF TG_OP='UPDATE' AND oldj->>'status'='pending' AND st<>'pending' THEN decided:=now(); END IF;
  ELSIF k='oss' THEN
    rid := (j->>'id')::uuid; uid := (j->>'owner_id')::uuid;
    n := j->>'name'; href := '/oss/' || rid; why := j->>'purpose';
    data := jsonb_build_object('prefix',j->>'prefix','name',n);
    IF st IN ('provisioning','active','failed','revoking','revoked') THEN x:=st; st:='approved'; END IF;
    IF TG_OP='UPDATE' AND oldj->>'status'='pending' AND st<>'pending' THEN decided:=now(); END IF;
  ELSE
    rid := (j->>'id')::uuid; uid := (j->>'owner_id')::uuid;
    n := j->>'name'; href := '/apps/' || (j->>'slug');
    data := jsonb_build_object('repoVersion',j->'repo_version','repoUrl',j->>'repo_url','branch',j->>'branch','slug',j->>'slug');
    why := '申请当前仓库的部署权限'; actor := (j->>'approved_by')::uuid; decided := (j->>'approved_at')::timestamptz;
    st := CASE WHEN (j->>'deploy_approved')::boolean AND j->>'approved_repo_version'=j->>'repo_version' THEN 'approved' ELSE 'pending' END;
    IF TG_OP='UPDATE' AND oldj->>'repo_version' IS DISTINCT FROM j->>'repo_version' THEN
      UPDATE approval_request SET status='invalid',closed_reason='应用已更换仓库',decided_at=now()
        WHERE type='app' AND source_id=rid AND status='pending';
      again := true;
    ELSIF TG_OP='UPDATE' AND st='pending' THEN
      -- Revocation / deployment retries do not silently resubmit rejected requests.
      IF (oldj->>'deploy_approved')::boolean THEN
        UPDATE approval_request SET execution='revoked' WHERE type='app' AND source_id=rid AND latest;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  g := k || ':' || rid || ':' || uid || ':' || coalesce(g,'');
  IF TG_OP='UPDATE' AND st='pending' AND oldj->>'status' IS DISTINCT FROM 'pending' THEN again:=true; END IF;
  PERFORM eat_request_record(k,(j->>'id')::uuid,rid,uid,oid,g,coalesce(n,'已删除资源'),coalesce(href,'/requests'),
    why,data,st,j->>'rejection_reason',x,coalesce(j->>'last_error',j->>'error'),actor,
    CASE WHEN again THEN now() ELSE (j->>'created_at')::timestamptz END,decided,again);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER approval_env AFTER INSERT OR UPDATE OR DELETE ON access_request FOR EACH ROW EXECUTE FUNCTION eat_request_source();
CREATE TRIGGER approval_mcp AFTER INSERT OR UPDATE OR DELETE ON mcp_subscription FOR EACH ROW EXECUTE FUNCTION eat_request_source();
CREATE TRIGGER approval_db AFTER INSERT OR UPDATE OR DELETE ON db_assignment FOR EACH ROW EXECUTE FUNCTION eat_request_source();
CREATE TRIGGER approval_oss AFTER INSERT OR UPDATE OR DELETE ON oss_space FOR EACH ROW EXECUTE FUNCTION eat_request_source();
CREATE TRIGGER approval_app AFTER INSERT OR UPDATE OR DELETE ON app FOR EACH ROW EXECUTE FUNCTION eat_request_source();
-- Backfill in creation order; collapse duplicate legacy pending env requests explicitly.
UPDATE access_request a SET status='invalid' WHERE status='pending' AND EXISTS (
 SELECT 1 FROM access_request b WHERE b.status='pending' AND b.environment_id=a.environment_id
 AND b.requester_id=a.requester_id AND b.keys @> a.keys AND a.keys @> b.keys
 AND (b.created_at,b.id)>(a.created_at,a.id));
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT id FROM access_request ORDER BY created_at,id LOOP UPDATE access_request SET reason=reason WHERE id=r.id; END LOOP;
END $$;
UPDATE mcp_subscription SET reason=reason;
UPDATE db_assignment SET purpose=purpose;
UPDATE oss_space SET purpose=purpose;
-- Backfill apps through INSERT-equivalent function invocation requires approved/pending branch.
-- No-op UPDATE app is intentionally ignored for unapproved apps; explicitly seed snapshots.
SELECT eat_request_record('app',id,id,owner_id,NULL,'app:'||id||':'||owner_id||':',name,'/apps/'||slug,
 '申请当前仓库的部署权限',jsonb_build_object('repoVersion',repo_version,'repoUrl',repo_url,'branch',branch,'slug',slug),
 CASE WHEN deploy_approved AND approved_repo_version=repo_version THEN 'approved' ELSE 'pending' END,
 NULL,NULL,NULL,approved_by,created_at,approved_at) FROM app;
UPDATE approval_request SET closed_reason='旧重复申请已合并' WHERE status='invalid' AND closed_reason IS NULL;
-- Importing history does not send a burst of notifications.
DELETE FROM approval_notification;
