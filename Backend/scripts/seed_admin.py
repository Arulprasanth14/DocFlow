"""
DocFlow Backend — Admin Seed Script
====================================
Creates (or verifies) the initial DocFlow Admin account.

What it does:
  1. Reads ADMIN_EMAIL + ADMIN_PASSWORD from .env (via Settings).
  2. Creates the Firebase user if not already present.
  3. Upserts the DB User row with is_superadmin=True, role='super_admin'.
  4. Ensures a default Organization exists and the admin is a member
     with the 'super_admin' role.
  5. Seeds the full SYSTEM_ROLES permission catalog for that org.

Usage:
  # From the Backend/ directory, with .venv activated:
  python -m scripts.seed_admin

  # Or directly:
  cd Backend
  python scripts/seed_admin.py

Rules:
  - Idempotent: safe to run multiple times; re-running won't duplicate data.
  - Credentials are read ONLY from .env — never hardcoded here.
  - This script NEVER logs or prints the password at any point.
"""
from __future__ import annotations

import asyncio
import os
import sys

# Allow running as `python scripts/seed_admin.py` from the Backend/ dir
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import structlog
from sqlalchemy import select

from app.config import settings
from app.core.firebase import initialize_firebase
from app.database import AsyncSessionFactory
from app.domain.enums import SYSTEM_ROLES
from app.models.organization import (
    Organization,
    OrganizationMember,
    Permission as PermissionModel,
    Role,
    RolePermission,
)
from app.models.user import User
from app.repositories.org_repo import OrgMemberRepository, OrganizationRepository

logger = structlog.get_logger("seed_admin")

_ORG_NAME = "DocFlow"
_ORG_SLUG = "docflow"
# The org-level Role name (SYSTEM_ROLES key) to assign — NOT the same as the
# coarse User.role column below, which legitimately stays "super_admin"
# (platform-level flag, a separate concept from org RBAC roles).
_ADMIN_ROLE_NAME = "admin"


async def seed() -> None:
    if not settings.ADMIN_EMAIL:
        logger.error("ADMIN_EMAIL is not set in .env — aborting seed")
        sys.exit(1)
    if not settings.ADMIN_PASSWORD:
        logger.error("ADMIN_PASSWORD is not set in .env — aborting seed")
        sys.exit(1)

    # ── 1. Initialize Firebase Admin SDK ─────────────────────────────────────
    firebase_ok = initialize_firebase()
    if not firebase_ok:
        logger.warning(
            "Firebase not initialized — skipping Firebase user creation. "
            "DB user will still be seeded."
        )

    firebase_uid: str | None = None

    if firebase_ok:
        import firebase_admin.auth as firebase_auth

        try:
            fb_user = firebase_auth.get_user_by_email(settings.ADMIN_EMAIL)
            firebase_uid = fb_user.uid
            logger.info("Firebase user already exists", uid=firebase_uid)
        except firebase_auth.UserNotFoundError:
            fb_user = firebase_auth.create_user(
                email=settings.ADMIN_EMAIL,
                password=settings.ADMIN_PASSWORD,
                display_name="DocFlow Admin",
                email_verified=True,
            )
            firebase_uid = fb_user.uid
            logger.info("Firebase user created", uid=firebase_uid)
        except Exception as exc:
            logger.warning("Could not create/get Firebase user", error=str(exc))

    # ── 2. Upsert DB User ─────────────────────────────────────────────────────
    async with AsyncSessionFactory() as db:
        # Check by email
        result = await db.execute(
            select(User).where(User.email == settings.ADMIN_EMAIL)
        )
        user = result.scalar_one_or_none()

        if not user:
            user = User(
                email=settings.ADMIN_EMAIL,
                name="DocFlow Admin",
                firebase_uid=firebase_uid,
                is_superadmin=True,
                role="super_admin",
                status="active",
                is_active=True,
            )
            db.add(user)
            await db.flush()
            logger.info("DB user created", user_id=str(user.id))
        else:
            # Update fields if they've drifted
            user.is_superadmin = True
            user.role = "super_admin"
            user.status = "active"
            user.is_active = True
            if firebase_uid and not user.firebase_uid:
                user.firebase_uid = firebase_uid
            await db.flush()
            logger.info("DB user already exists — updated flags", user_id=str(user.id))

        # ── 3. Ensure default org exists ────────────────────────────────────
        org_result = await db.execute(
            select(Organization).where(Organization.slug == _ORG_SLUG)
        )
        org = org_result.scalar_one_or_none()

        if not org:
            org_repo = OrganizationRepository(db)
            org = await org_repo.create(name=_ORG_NAME, plan="enterprise")
            logger.info("Default org created", org_id=str(org.id), slug=org.slug)
        else:
            logger.info("Default org already exists", org_id=str(org.id))

        # ── 4. Seed all system roles + permissions for this org ──────────────
        # Atomic upsert — see org_repo.py::create_default_roles for why a
        # plain select-then-insert races on the shared permissions catalog.
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        all_codes = {
            str(perm_code)
            for role_def in SYSTEM_ROLES.values()
            for perm_code in role_def["permissions"]
        }
        if all_codes:
            stmt = pg_insert(PermissionModel).values([
                {"code": code, "category": code.split(":")[0]}
                for code in all_codes
            ]).on_conflict_do_nothing(index_elements=["code"])
            await db.execute(stmt)

        await db.flush()

        # Create roles for the org if they don't already exist
        for role_name, role_def in SYSTEM_ROLES.items():
            existing_role = await db.execute(
                select(Role).where(
                    Role.org_id == org.id,
                    Role.name == role_name,
                )
            )
            existing_role_obj = existing_role.scalar_one_or_none()

            if not existing_role_obj:
                role_obj = Role(
                    org_id=org.id,
                    name=role_name,
                    description=role_def["description"],
                    is_system=True,
                )
                db.add(role_obj)
                await db.flush()

                for perm_code in role_def["permissions"]:
                    rp = RolePermission(role_id=role_obj.id, permission_code=str(perm_code))
                    db.add(rp)

                await db.flush()
                logger.info("Role created", role=role_name, org=str(org.id))

        await db.flush()

        # ── 5. Add admin as org member with super_admin role ────────────────
        member_result = await db.execute(
            select(OrganizationMember).where(
                OrganizationMember.user_id == user.id,
                OrganizationMember.org_id == org.id,
            )
        )
        existing_member = member_result.scalar_one_or_none()

        if not existing_member:
            # Get the super_admin Role object for this org
            admin_role_result = await db.execute(
                select(Role).where(
                    Role.org_id == org.id,
                    Role.name == _ADMIN_ROLE_NAME,
                )
            )
            admin_role = admin_role_result.scalar_one_or_none()

            if admin_role:
                member_repo = OrgMemberRepository(db)
                await member_repo.add_member(
                    org_id=org.id,
                    user_id=user.id,
                    role_id=admin_role.id,
                )
                logger.info("Admin added to org with role", role=_ADMIN_ROLE_NAME)
            else:
                logger.error("Could not find admin role for org — membership not created")
        else:
            logger.info("Admin is already an org member")

        await db.commit()
        logger.info(
            "[SUCCESS] Admin seed complete",
            email=settings.ADMIN_EMAIL,
            org=_ORG_NAME,
            user_id=str(user.id),
        )


if __name__ == "__main__":
    asyncio.run(seed())
