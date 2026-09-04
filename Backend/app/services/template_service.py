"""
DocFlow Backend — Service: Template

Admin operations for creating, reading, updating, and managing
WorkflowTemplate + WorkflowStage + StageApproverRule.

Only users with `admin:workflow_templates` permission may call this service.
"""
from __future__ import annotations

import uuid
from typing import Sequence

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.models.workflow import WorkflowStage, WorkflowTemplate
from app.repositories.workflow_repo import WorkflowStageRepository, WorkflowTemplateRepository
from app.schemas.workflow_instances import (
    WorkflowTemplateCreate,
    WorkflowTemplateResponse,
    WorkflowTemplateSummary,
    WorkflowTemplateUpdate,
)

logger = structlog.get_logger(__name__)


class TemplateService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.tmpl_repo = WorkflowTemplateRepository(db)
        self.stage_repo = WorkflowStageRepository(db)

    async def create(
        self,
        org_id: uuid.UUID,
        req: WorkflowTemplateCreate,
    ) -> WorkflowTemplateResponse:
        """
        Create a WorkflowTemplate with its stages and approver rules in one transaction.
        """
        # Validate stage sequence_orders are unique
        orders = [s.sequence_order for s in req.stages]
        if len(orders) != len(set(orders)):
            raise ConflictException("Stage sequence_order values must be unique within a template")

        tmpl = await self.tmpl_repo.create(
            org_id=org_id,
            name=req.name,
            description=req.description,
            department_id=req.department_id,
            doc_type_id=req.doc_type_id,
            document_type_scope=req.document_type_scope,
            is_active=req.is_active,
        )

        for stage_req in sorted(req.stages, key=lambda s: s.sequence_order):
            stage = await self.stage_repo.create(
                template_id=tmpl.id,
                name=stage_req.name,
                sequence_order=stage_req.sequence_order,
                stage_type=stage_req.stage_type,
                min_approvals_required=stage_req.min_approvals_required,
                sla_hours=stage_req.sla_hours,
                reapproval_on_revision=stage_req.reapproval_on_revision,
            )
            for rule in stage_req.approver_rules:
                await self.stage_repo.add_approver_rule(
                    stage_id=stage.id,
                    rule_type=rule.rule_type,
                    rule_value=rule.rule_value,
                )

        await self.db.commit()
        logger.info("template_created", template_id=str(tmpl.id), org_id=str(org_id))

        # Reload with stages
        tmpl = await self.tmpl_repo.get_by_id(tmpl.id, org_id)
        return WorkflowTemplateResponse.model_validate(tmpl)

    async def get(self, template_id: uuid.UUID, org_id: uuid.UUID) -> WorkflowTemplateResponse:
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        return WorkflowTemplateResponse.model_validate(tmpl)

    async def list(
        self,
        org_id: uuid.UUID,
        active_only: bool = True,
        department_id: uuid.UUID | None = None,
    ) -> list[WorkflowTemplateSummary]:
        templates = await self.tmpl_repo.list_for_org(org_id, active_only, department_id)
        return [WorkflowTemplateSummary.model_validate(t) for t in templates]

    async def update(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        req: WorkflowTemplateUpdate,
    ) -> WorkflowTemplateResponse:
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")

        updates = req.model_dump(exclude_none=True)
        if updates:
            # Bump version on any update
            updates["version"] = tmpl.version + 1
            await self.tmpl_repo.update(template_id, **updates)

        await self.db.commit()
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        return WorkflowTemplateResponse.model_validate(tmpl)

    async def delete(self, template_id: uuid.UUID, org_id: uuid.UUID) -> None:
        success = await self.tmpl_repo.soft_delete(template_id, org_id)
        if not success:
            raise NotFoundException("WorkflowTemplate not found")
        await self.db.commit()
        logger.info("template_deleted", template_id=str(template_id))
