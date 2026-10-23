"""
DocFlow - account / organization consistency diagnostic (READ-ONLY).

Reports anything that can leave a user unable to log in or stuck on the
onboarding screen. It NEVER modifies data; every finding prints the exact,
reviewable remediation so you can decide what to run.

    cd Backend
    python -m scripts.diagnose_accounts
    python -m scripts.diagnose_accounts --email someone@example.com

Checks:
  1. users sharing an email case-insensitively
  2. users with an SSO identity but no active membership and no pending
     request (legitimate NO_ORG state - listed for awareness, not an error)
  3. organizations with no active ADMIN (nobody can administer or approve)
  4. organizations with no active members at all (orphaned by a failed create)
  5. pending join requests pointing at a deleted organization
  6. memberships whose role no longer exists / belongs to another org
  7. members still on a legacy role name (pre 4-role model)
  8. duplicate organization names (case-insensitive)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text  # noqa: E402

from app.database import AsyncSessionFactory  # noqa: E402

NEW_ROLES = ("admin", "hr", "worker", "trainee")


async def rows(db, sql: str, **params):
    return [dict(r._mapping) for r in (await db.execute(text(sql), params)).all()]


async def main(email: str | None) -> int:
    problems = 0
    async with AsyncSessionFactory() as db:
        if email:
            print(f"== account: {email} ==")
            for r in await rows(
                db,
                """select u.id, u.email, u.status, u.firebase_uid is not null as has_sso,
                          u.deleted_at is not null as deleted
                     from users u where lower(u.email) = lower(:e)""",
                e=email,
            ):
                print(" user:", r)
            for r in await rows(
                db,
                """select o.name org, r.name role, m.status, m.deleted_at is not null as deleted
                     from organization_members m
                     join users u on u.id = m.user_id
                     join organizations o on o.id = m.org_id
                     join roles r on r.id = m.role_id
                    where lower(u.email) = lower(:e)""",
                e=email,
            ):
                print(" membership:", r)
            print()

        def report(title: str, found: list, fix: str = ""):
            nonlocal problems
            if not found:
                print(f"[ok]   {title}")
                return
            problems += len(found)
            print(f"[FAIL] {title}: {len(found)}")
            for f in found:
                print("       ", f)
            if fix:
                print(f"       fix: {fix}")

        report(
            "users sharing an email (case-insensitive)",
            await rows(db, "select lower(email) e, count(*) n from users group by 1 having count(*) > 1"),
            "merge the duplicate rows manually (keep the one with memberships)",
        )
        report(
            "organizations with no active admin",
            await rows(
                db,
                """select o.name from organizations o
                    where o.deleted_at is null and not exists (
                      select 1 from organization_members m join roles r on r.id = m.role_id
                       where m.org_id = o.id and m.status = 'active'
                         and m.deleted_at is null and r.name = 'admin')""",
            ),
            "promote a trusted member to admin from the database or as a superadmin",
        )
        report(
            "organizations with no active members (orphaned)",
            await rows(
                db,
                """select o.name, o.created_at from organizations o
                    where o.deleted_at is null and not exists (
                      select 1 from organization_members m
                       where m.org_id = o.id and m.status = 'active' and m.deleted_at is null)""",
            ),
            "soft-delete the empty organization so its name can be reused",
        )
        report(
            "pending join requests for a deleted organization",
            await rows(
                db,
                """select u.email, o.name from organization_members m
                    join users u on u.id = m.user_id
                    join organizations o on o.id = m.org_id
                   where m.status = 'pending' and o.deleted_at is not null""",
            ),
            "reject them: UPDATE organization_members SET status='rejected' WHERE ...",
        )
        report(
            "memberships whose role belongs to a different organization",
            await rows(
                db,
                """select u.email, o.name from organization_members m
                    join users u on u.id = m.user_id
                    join organizations o on o.id = m.org_id
                    join roles r on r.id = m.role_id
                   where r.org_id <> m.org_id""",
            ),
        )
        report(
            "members on a legacy (pre 4-role) role name",
            await rows(
                db,
                """select u.email, r.name role from organization_members m
                    join users u on u.id = m.user_id
                    join roles r on r.id = m.role_id
                   where m.deleted_at is null and r.name <> all(:keep)""",
                keep=list(NEW_ROLES),
            ),
            "run `alembic upgrade head` (migration d4a1f0c2b7e9 remaps them)",
        )
        report(
            "duplicate organization names (case-insensitive)",
            await rows(
                db,
                """select lower(name) n, count(*) from organizations
                    where deleted_at is null group by 1 having count(*) > 1""",
            ),
            "run `alembic upgrade head` (migration e5b2a9d1c3f7 de-duplicates)",
        )

        no_org = await rows(
            db,
            """select u.email from users u
                where u.deleted_at is null and not exists (
                  select 1 from organization_members m
                   where m.user_id = u.id and m.deleted_at is null
                     and m.status in ('active', 'pending'))""",
        )
        print(f"[info] users with no organization and no pending request: {len(no_org)}")
        for r in no_org:
            print("       ", r["email"], "(will see Create / Join - this is correct)")

    print("\nRESULT:", "no inconsistencies" if problems == 0 else f"{problems} issue(s) found")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", help="also print one account's user + memberships")
    args = ap.parse_args()
    raise SystemExit(asyncio.run(main(args.email)))
