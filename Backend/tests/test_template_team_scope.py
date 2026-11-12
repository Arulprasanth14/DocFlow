"""
Decision 3: the "team" template scope works for an HTTP caller.

`AuthUser.dept_id` was never populated from a token, so
`TemplateStudioService` compared the caller's department against None on every
request: a team-scoped template was invisible to the department that owned it,
and the edit branch that checks it could never be true. The department is now
loaded from `organization_members` on demand.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.domain.permissions import AuthUser
from app.models.organization import Department, OrganizationMember
from app.models.template import Template
from app.services.template_studio_service import TemplateStudioService


async def _department(db_session, org, name: str) -> Department:
    dept = Department(org_id=org.id, name=name)
    db_session.add(dept)
    await db_session.flush()
    return dept


async def _assign(db_session, user_id, org, dept: Department | None) -> None:
    member = (
        await db_session.execute(
            select(OrganizationMember).where(
                OrganizationMember.org_id == org.id,
                OrganizationMember.user_id == user_id,
            )
        )
    ).scalars().first()
    member.dept_id = dept.id if dept else None
    await db_session.commit()


async def _team_template(db_session, org, owner_id, dept: Department) -> Template:
    template = Template(
        org_id=org.id,
        name=f"Team template {uuid.uuid4().hex[:6]}",
        scope="team",
        status="published",
        owner_id=owner_id,
        dept_id=dept.id,
    )
    db_session.add(template)
    await db_session.commit()
    return template


def _auth_user(user, org) -> AuthUser:
    """A request-scoped AuthUser: exactly what the dependency builds, with no
    dept_id, which is the whole point of the fix."""
    return AuthUser(
        id=user.id, org_id=org.id, roles=["worker"],
        permissions=["documents:read"], session_id=str(uuid.uuid4()),
    )


async def test_a_team_template_is_visible_to_its_own_department(
    db_session, org, worker, make_member
):
    worker_user, _ = worker
    dept = await _department(db_session, org, "Finance")
    await _assign(db_session, worker_user.id, org, dept)

    owner, _ = await make_member_in_dept(db_session, org, make_member, dept)
    template = await _team_template(db_session, org, owner.id, dept)

    svc = TemplateStudioService(db_session)
    found = await svc.repo.get_for_user(
        template.id, org.id, worker_user.id, False, await svc._dept_id(_auth_user(worker_user, org))
    )
    assert found is not None, "a department member could not see their own team template"


async def test_a_team_template_stays_invisible_to_another_department(
    db_session, org, worker, make_member
):
    worker_user, _ = worker
    finance = await _department(db_session, org, "Finance")
    legal = await _department(db_session, org, "Legal")
    await _assign(db_session, worker_user.id, org, legal)

    owner, _ = await make_member_in_dept(db_session, org, make_member, finance)
    template = await _team_template(db_session, org, owner.id, finance)

    svc = TemplateStudioService(db_session)
    found = await svc.repo.get_for_user(
        template.id, org.id, worker_user.id, False, await svc._dept_id(_auth_user(worker_user, org))
    )
    assert found is None, "a team template leaked to another department"


async def test_a_member_of_the_department_may_edit_the_team_template(
    db_session, org, worker, make_member
):
    worker_user, _ = worker
    dept = await _department(db_session, org, "Finance")
    await _assign(db_session, worker_user.id, org, dept)
    owner, _ = await make_member_in_dept(db_session, org, make_member, dept)
    template = await _team_template(db_session, org, owner.id, dept)

    svc = TemplateStudioService(db_session)
    # Does not raise: before the fix this branch could never match.
    await svc._require_can_edit(template, _auth_user(worker_user, org))


async def test_someone_from_another_department_may_not_edit_it(
    db_session, org, worker, make_member
):
    from app.core.exceptions import ForbiddenException

    worker_user, _ = worker
    finance = await _department(db_session, org, "Finance")
    legal = await _department(db_session, org, "Legal")
    await _assign(db_session, worker_user.id, org, legal)
    owner, _ = await make_member_in_dept(db_session, org, make_member, finance)
    template = await _team_template(db_session, org, owner.id, finance)

    svc = TemplateStudioService(db_session)
    with pytest.raises(ForbiddenException):
        await svc._require_can_edit(template, _auth_user(worker_user, org))


async def test_a_member_with_no_department_sees_no_team_templates(
    db_session, org, worker, make_member
):
    """The lookup returning None is a real answer, not a reason to fall back
    to something broader."""
    worker_user, _ = worker
    dept = await _department(db_session, org, "Finance")
    await _assign(db_session, worker_user.id, org, None)
    owner, _ = await make_member_in_dept(db_session, org, make_member, dept)
    template = await _team_template(db_session, org, owner.id, dept)

    svc = TemplateStudioService(db_session)
    auth = _auth_user(worker_user, org)
    assert await svc._dept_id(auth) is None
    assert await svc.repo.get_for_user(
        template.id, org.id, worker_user.id, False, None
    ) is None


async def test_the_department_is_read_once_per_service_instance(
    db_session, org, worker
):
    """One query per request, not one per template card."""
    worker_user, _ = worker
    dept = await _department(db_session, org, "Finance")
    await _assign(db_session, worker_user.id, org, dept)

    svc = TemplateStudioService(db_session)
    auth = _auth_user(worker_user, org)
    first = await svc._dept_id(auth)
    assert first == dept.id

    # Change it underneath: a cached value proves the second call did not query.
    await _assign(db_session, worker_user.id, org, None)
    assert await svc._dept_id(auth) == dept.id
    # A fresh service (i.e. the next request) sees the new truth.
    assert await TemplateStudioService(db_session)._dept_id(auth) is None


async def make_member_in_dept(db_session, org, make_member, dept: Department):
    """A second member who owns the template, in `dept`."""
    from sqlalchemy import select as _select

    from app.models.organization import Role

    role = (
        await db_session.execute(
            _select(Role).where(Role.org_id == org.id, Role.name == "worker")
        )
    ).scalars().first()
    user, token = await make_member(role, dept_id=dept.id)
    return user, token
