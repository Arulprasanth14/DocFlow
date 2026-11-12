-- ===========================================================================
-- DocFlow Auth/RBAC - read-only data reports
--
-- SELECT only. Nothing here writes, locks or creates anything, so it is safe
-- against production (a read replica is kinder if you have one). Run them one
-- at a time and read the output: none of these "fixes" anything.
--
-- Generated 2026-11-12. Query 1's expected set is generated from
-- app.domain.enums.SYSTEM_ROLES as it stands today - regenerate this file if
-- the seed ever changes.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. role_permissions per organization vs. the seed
--
-- role_permissions is the RUNTIME source of truth and is written once, when
-- an organization is created. Changing SYSTEM_ROLES in code does NOT change
-- existing organizations, so orgs created at different times can disagree
-- with each other and with today's seed. This is what tells you whether that
-- has happened.
--
-- Expect zero rows. Each row is one (org, role, code) that differs.
-- ---------------------------------------------------------------------------
WITH expected (role_name, permission_code) AS (
  VALUES
    ('admin', 'documents:create'),
    ('admin', 'documents:read'),
    ('admin', 'documents:edit'),
    ('admin', 'documents:delete'),
    ('admin', 'documents:submit'),
    ('admin', 'documents:cancel'),
    ('admin', 'documents:comment'),
    ('admin', 'workflows:read'),
    ('admin', 'workflows:admin'),
    ('admin', 'approvals:decide'),
    ('admin', 'approvals:delegate'),
    ('admin', 'chat:read'),
    ('admin', 'chat:send'),
    ('admin', 'analytics:read'),
    ('admin', 'analytics:export'),
    ('admin', 'admin:users'),
    ('admin', 'admin:roles'),
    ('admin', 'admin:orgs'),
    ('admin', 'admin:audit'),
    ('admin', 'admin:doc_types'),
    ('admin', 'admin:workflow_templates'),
    ('admin', 'members:invite_standard'),
    ('admin', 'members:invite_hr'),
    ('admin', 'members:delete'),
    ('admin', 'agent:knowledge_manage'),
    ('admin', 'uploads:create'),
    ('hr', 'documents:create'),
    ('hr', 'documents:read'),
    ('hr', 'documents:edit'),
    ('hr', 'documents:submit'),
    ('hr', 'documents:cancel'),
    ('hr', 'documents:comment'),
    ('hr', 'workflows:read'),
    ('hr', 'approvals:decide'),
    ('hr', 'approvals:delegate'),
    ('hr', 'chat:read'),
    ('hr', 'chat:send'),
    ('hr', 'analytics:read'),
    ('hr', 'uploads:create'),
    ('hr', 'admin:roles'),
    ('hr', 'admin:users'),
    ('hr', 'admin:orgs'),
    ('hr', 'admin:doc_types'),
    ('hr', 'admin:workflow_templates'),
    ('hr', 'members:invite_standard'),
    ('worker', 'documents:create'),
    ('worker', 'documents:read'),
    ('worker', 'documents:edit'),
    ('worker', 'documents:submit'),
    ('worker', 'documents:cancel'),
    ('worker', 'documents:comment'),
    ('worker', 'workflows:read'),
    ('worker', 'approvals:decide'),
    ('worker', 'approvals:delegate'),
    ('worker', 'chat:read'),
    ('worker', 'chat:send'),
    ('worker', 'analytics:read'),
    ('worker', 'uploads:create'),
    ('trainee', 'documents:create'),
    ('trainee', 'documents:read'),
    ('trainee', 'documents:edit'),
    ('trainee', 'documents:submit'),
    ('trainee', 'documents:comment'),
    ('trainee', 'workflows:read'),
    ('trainee', 'analytics:read'),
    ('trainee', 'chat:read'),
    ('trainee', 'chat:send'),
    ('trainee', 'uploads:create')
),
org_roles AS (
  SELECT o.id AS org_id, o.name AS org_name, r.id AS role_id, r.name AS role_name
  FROM organizations o
  JOIN roles r ON r.org_id = o.id AND r.deleted_at IS NULL
  WHERE o.deleted_at IS NULL
),
actual AS (
  SELECT orl.org_id, orl.org_name, orl.role_name, rp.permission_code
  FROM org_roles orl
  JOIN role_permissions rp ON rp.role_id = orl.role_id
),
wanted AS (
  SELECT orl.org_id, orl.org_name, orl.role_name, e.permission_code
  FROM org_roles orl
  JOIN expected e ON e.role_name = orl.role_name
)
SELECT
  COALESCE(w.org_name, a.org_name)         AS org_name,
  COALESCE(w.role_name, a.role_name)       AS role_name,
  COALESCE(w.permission_code, a.permission_code) AS permission_code,
  CASE WHEN a.permission_code IS NULL
       THEN 'MISSING - the seed grants it, this org does not have it'
       ELSE 'EXTRA - this org has it, the seed does not grant it'
  END                                      AS discrepancy
FROM wanted w
FULL OUTER JOIN actual a
  ON  a.org_id = w.org_id
  AND a.role_name = w.role_name
  AND a.permission_code = w.permission_code
WHERE a.permission_code IS NULL OR w.permission_code IS NULL
ORDER BY org_name, role_name, permission_code;

-- Shape check, if the query above is noisy. Expect admin 26, hr 19,
-- worker 13, trainee 10 - those four numbers are the current seed.
SELECT o.name AS org_name, r.name AS role_name, COUNT(rp.permission_code) AS codes
FROM organizations o
JOIN roles r ON r.org_id = o.id AND r.deleted_at IS NULL
LEFT JOIN role_permissions rp ON rp.role_id = r.id
WHERE o.deleted_at IS NULL
GROUP BY o.name, r.name
ORDER BY o.name, r.name;


-- ---------------------------------------------------------------------------
-- 2. users.is_active vs users.status disagreements
--
-- The login rule is now `is_active AND status IN ('active','pending_invite')`
-- and it fails closed. Any row below is a user whose two columns disagree, so
-- they may be locked out (or still able to sign in) for a reason nobody
-- intended. Read this before consolidating the two columns.
-- ---------------------------------------------------------------------------
SELECT
  u.id,
  u.email,
  u.is_active,
  u.status,
  (u.firebase_uid IS NOT NULL) AS has_firebase_identity,
  (u.password_hash IS NOT NULL) AS has_password,
  u.created_at,
  u.last_seen_at,
  CASE
    WHEN u.status IS NULL
      THEN 'status is NULL - blocked, fail-closed'
    WHEN u.status NOT IN ('active','inactive','suspended','pending_invite')
      THEN 'unknown status value - blocked, fail-closed'
    WHEN u.is_active AND u.status NOT IN ('active','pending_invite')
      THEN 'is_active=true but status blocks login'
    WHEN NOT u.is_active AND u.status = 'active'
      THEN 'status=active but is_active=false blocks login'
  END AS problem
FROM users u
WHERE u.deleted_at IS NULL
  AND (
       u.status IS NULL
    OR u.status NOT IN ('active','inactive','suspended','pending_invite')
    OR (u.is_active AND u.status NOT IN ('active','pending_invite'))
    OR (NOT u.is_active AND u.status = 'active')
  )
ORDER BY u.created_at;

-- The overall distribution, for context.
SELECT is_active, status, COUNT(*) AS rows
FROM users
WHERE deleted_at IS NULL
GROUP BY is_active, status
ORDER BY rows DESC;


-- ---------------------------------------------------------------------------
-- 3. organization_members.status values
--
-- A VARCHAR with no CHECK constraint that accepted any string until the
-- service-layer validation landed. A value outside the known set makes that
-- member invisible to every status-filtered query.
-- Known set: active, pending, inactive, rejected, suspended.
-- (Alembic revision b2d4f6081a22 prints exactly this, report-only.)
-- ---------------------------------------------------------------------------
SELECT
  status,
  COUNT(*) AS rows,
  (status IN ('active','pending','inactive','rejected','suspended')) AS known
FROM organization_members
GROUP BY status
ORDER BY rows DESC;

-- The offending rows, with enough context to decide each one.
SELECT
  m.id AS member_id,
  o.name AS org_name,
  u.email,
  m.status,
  r.name AS role_name,
  m.joined_at,
  (m.deleted_at IS NOT NULL) AS soft_deleted
FROM organization_members m
JOIN organizations o ON o.id = m.org_id
JOIN users u ON u.id = m.user_id
LEFT JOIN roles r ON r.id = m.role_id
WHERE m.status IS NULL
   OR m.status NOT IN ('active','pending','inactive','rejected','suspended')
ORDER BY m.joined_at;


-- ---------------------------------------------------------------------------
-- 4. sessions: how many, how old, how much is dead weight
--
-- Sizes the rotation migration (it backfills family_id over every row) and
-- the nightly purge (SESSION_PURGE_AFTER_DAYS, default 7). With rotation
-- enabled this table grows by one row per REFRESH, not per login.
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*)                                                       AS total_rows,
  COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())  AS live,
  COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)                 AS revoked,
  COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now()) AS expired_not_revoked,
  COUNT(*) FILTER (WHERE expires_at < now() - interval '7 days')  AS purgeable_today,
  MIN(created_at)                                                AS oldest,
  MAX(created_at)                                                AS newest,
  COUNT(DISTINCT user_id)                                        AS distinct_users
FROM sessions;

-- Per-user concentration: an unusually high count is either a busy
-- integration or a client refreshing in a loop.
SELECT
  u.email,
  COUNT(*) AS sessions,
  COUNT(*) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at > now()) AS live
FROM sessions s
JOIN users u ON u.id = s.user_id
GROUP BY u.email
ORDER BY sessions DESC
LIMIT 25;

-- Age histogram, to see whether the 30-day cap is doing anything.
SELECT
  width_bucket(EXTRACT(EPOCH FROM (now() - created_at)) / 86400, 0, 30, 6)
    AS age_bucket_0_to_30_days,
  COUNT(*) AS rows
FROM sessions
GROUP BY 1
ORDER BY 1;

-- Only meaningful AFTER migration a1c3e5f70911 has run: what the backfill
-- would still have to touch, and whether anything is rotating.
-- SELECT COUNT(*) FILTER (WHERE family_id IS NULL)       AS without_family,
--        COUNT(*) FILTER (WHERE rotated_at IS NOT NULL)  AS rotated,
--        COUNT(DISTINCT family_id)                       AS families
-- FROM sessions;
