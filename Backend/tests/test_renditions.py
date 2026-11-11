"""
Workflow module section 6.4.1 (renditions), section 6.4.2 (AP-VWR-04),
WF-REV-09, E15. Tasks P3-3 and P3-4.

Two things being pinned down:

**A document that cannot be opened must not enter review** (WF-REV-09, E15).
By the time an approver discovered it, the run would be live, an approver
notified and the owner told their document was in review. Refusing at submit
leaves the owner a file they can fix and nothing to undo.

**The viewer's URL is inline and short-lived** (AP-VWR-04, defect 11). The
only pre-existing way to get a document's bytes was the attachment download:
a one-hour URL with `Content-Disposition: attachment`. A PDF viewer cannot
use an `attachment` URL at all, and an hour outlives the page that minted it.
"""
from __future__ import annotations

import io as _io
import uuid

import pytest

from app.core.exceptions import NotFoundException, UnprocessableEntityException
from app.core.storage import (
    MAX_INLINE_URL_SECONDS,
    generate_presigned_download_url,
)
from app.domain.permissions import AuthUser
from app.models.document import Document, DocumentType, DocumentVersion
from app.services.document_importer import (
    RenditionError,
    assert_pdf_is_reviewable,
    needs_rendition,
)
from app.services.rendition_service import RenditionService


# -- The PDF gate ----------------------------------------------------------

def _minimal_pdf(pages: int = 1) -> bytes:
    """A real, readable PDF built with pypdf, so the gate is tested against
    a genuine file rather than a hand-rolled byte string."""
    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    buf = _io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_a_readable_pdf_passes_and_reports_its_pages():
    assert assert_pdf_is_reviewable(_minimal_pdf(3)) == 3


def test_a_corrupt_pdf_is_refused():
    """E15 — and the message has to tell the owner what to do about it."""
    with pytest.raises(RenditionError) as exc:
        assert_pdf_is_reviewable(b"%PDF-1.7\nthis is not a pdf at all")
    assert "damaged" in str(exc.value).lower() or "could not be read" in str(exc.value).lower()


def test_something_that_is_not_a_pdf_at_all_is_refused():
    with pytest.raises(RenditionError):
        assert_pdf_is_reviewable(b"PK\x03\x04 this is a zip")


def test_a_password_protected_pdf_is_refused_with_its_own_message():
    """WF-REV-09 — a distinct message from "corrupt", because the fix is
    different: the owner removes the password and uploads again."""
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt("secret")
    buf = _io.BytesIO()
    writer.write(buf)

    with pytest.raises(RenditionError) as exc:
        assert_pdf_is_reviewable(buf.getvalue())
    assert "password" in str(exc.value).lower()


def test_an_empty_password_pdf_is_still_refused():
    """Encrypted-but-openable-with-"" is still unreviewable: the viewer
    cannot supply even an empty password."""
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt("")
    buf = _io.BytesIO()
    writer.write(buf)

    with pytest.raises(RenditionError):
        assert_pdf_is_reviewable(buf.getvalue())


# -- Which files need converting --------------------------------------------

@pytest.mark.parametrize("filename,mime,expected", [
    ("report.pdf", "application/pdf", False),
    ("report.PDF", None, False),
    ("scan.png", "image/png", False),
    ("photo.jpeg", None, False),
    ("contract.docx",
     "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
     True),
    ("legacy.doc", "application/msword", True),
    ("notes.odt", "application/vnd.oasis.opendocument.text", True),
    ("sheet.xlsx", None, True),
    ("readme.txt", "text/plain", True),
    ("archive.zip", "application/zip", False),
])
def test_needs_rendition(filename, mime, expected):
    """A PDF is its own rendition; an image the viewer shows directly, and
    rasterising one into a PDF would lose quality for nothing."""
    assert needs_rendition(filename, mime) is expected


# -- The inline URL (AP-VWR-04, defect 11) ----------------------------------

def test_an_inline_url_is_inline_and_capped(monkeypatch):
    """Both halves of defect 11 at once."""
    captured: dict = {}

    class _FakeClient:
        def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
            captured["op"] = op
            captured["params"] = Params
            captured["expires"] = ExpiresIn
            return "https://example.invalid/signed"

    monkeypatch.setattr(
        "app.core.storage._get_s3_client", lambda: _FakeClient()
    )

    url = generate_presigned_download_url(
        bucket="b", storage_key="k", filename="Report.pdf",
        expires_in_seconds=3600, inline=True,
    )
    assert url == "https://example.invalid/signed"
    assert captured["params"]["ResponseContentDisposition"].startswith("inline;")
    assert captured["expires"] == MAX_INLINE_URL_SECONDS, (
        "an hour-long inline URL outlives the page that minted it; the cap "
        "has to be applied here, not left to callers"
    )
    assert MAX_INLINE_URL_SECONDS <= 300


def test_a_download_url_keeps_its_attachment_behaviour(monkeypatch):
    """The ordinary download path must not change: a one-hour attachment
    link is correct for clicking, and other callers rely on it."""
    captured: dict = {}

    class _FakeClient:
        def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
            captured["params"] = Params
            captured["expires"] = ExpiresIn
            return "u"

    monkeypatch.setattr(
        "app.core.storage._get_s3_client", lambda: _FakeClient()
    )
    generate_presigned_download_url(
        bucket="b", storage_key="k", filename="Report.pdf",
    )
    assert captured["params"]["ResponseContentDisposition"].startswith("attachment;")
    assert captured["expires"] == 3600


def test_a_quote_in_the_filename_cannot_break_the_header(monkeypatch):
    """A document title is user input and lands in a header value; an
    unescaped quote would terminate it early and let the rest be read as
    further header parameters."""
    captured: dict = {}

    class _FakeClient:
        def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
            captured["params"] = Params
            return "u"

    monkeypatch.setattr(
        "app.core.storage._get_s3_client", lambda: _FakeClient()
    )
    generate_presigned_download_url(
        bucket="b", storage_key="k",
        filename='evil"; attachment; filename="other.pdf',
    )
    disposition = captured["params"]["ResponseContentDisposition"]
    assert disposition.count('"') == 2, disposition


# -- Rendition state machine ------------------------------------------------

async def _version(db_session, org, owner, *, storage_key, mime):
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    doc = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title="Spec",
        submitted_by=owner.id,
    )
    db_session.add(doc)
    await db_session.flush()
    v = DocumentVersion(
        document_id=doc.id, version_num=1, title=doc.title,
        uploaded_by=owner.id, storage_key=storage_key, mime_type=mime,
    )
    db_session.add(v)
    await db_session.flush()
    return doc, v


async def test_a_pdf_upload_needs_no_rendition(db_session, org, trainee):
    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/report.pdf", mime="application/pdf",
    )
    assert await RenditionService(db_session).mark_initial_state(v) == "not_needed"


async def test_a_docx_upload_is_queued_for_conversion(db_session, org, trainee):
    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/contract.docx",
        mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    assert await RenditionService(db_session).mark_initial_state(v) == "pending"


async def test_a_form_only_version_needs_no_rendition(db_session, org, trainee):
    """No uploaded file at all — it is rendered from its own content by the
    documents module's own PDF pipeline, not by this one."""
    owner, _ = trainee
    _doc, v = await _version(db_session, org, owner, storage_key=None, mime=None)
    assert await RenditionService(db_session).mark_initial_state(v) == "not_needed"


async def test_a_pending_rendition_is_reported_not_guessed(
    db_session, org, trainee
):
    """UX-INT-01 — the viewer needs a state to render, not a broken frame."""
    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/contract.docx", mime=None,
    )
    v.rendition_status = "pending"
    await db_session.flush()

    asset, state, message = await RenditionService(db_session).viewable_file(v)
    assert asset is None
    assert state == "pending"
    assert message is None


async def test_a_failed_rendition_carries_its_reason(db_session, org, trainee):
    """The person who can fix a password-protected file is the owner, and
    they will never read a worker log line."""
    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/contract.docx", mime=None,
    )
    v.rendition_status = "failed"
    v.rendition_error = "That PDF is password-protected."
    await db_session.flush()

    asset, state, message = await RenditionService(db_session).viewable_file(v)
    assert asset is None
    assert state == "failed"
    assert "password" in message


async def test_a_soft_deleted_rendition_is_requeued_not_served(
    db_session, org, trainee
):
    """The realistic way a rendition goes missing: the retention sweep
    soft-deletes the FileAsset.

    A foreign key makes a dangling id impossible, so this is the case that
    can actually happen - and it is the dangerous one, because this codebase
    has no global soft-delete filter. `db.get()` returns the retired row
    quite happily, and serving it would hand the viewer a presigned URL for
    an object that may no longer be in storage at all.
    """
    from datetime import datetime, timezone

    from app.config import settings
    from app.models.document import FileAsset

    owner, _ = trainee
    doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/contract.docx", mime=None,
    )
    asset = FileAsset(
        org_id=org.id, document_id=doc.id, uploaded_by=owner.id,
        filename="contract.pdf", mime_type="application/pdf",
        size_bytes=1024, storage_key="orgs/x/files/renditions/contract.pdf",
        bucket=settings.S3_BUCKET_DOCUMENTS, storage_mode="minio",
        deleted_at=datetime.now(timezone.utc),
    )
    db_session.add(asset)
    await db_session.flush()

    v.rendition_status = "ready"
    v.rendition_file_id = asset.id
    await db_session.flush()

    served, state, _message = await RenditionService(db_session).viewable_file(v)
    assert served is None, (
        "a soft-deleted rendition must not be served - db.get() returns it, "
        "so the check has to be explicit"
    )
    assert state == "pending"
    assert v.rendition_file_id is None


# -- Endpoint access control ------------------------------------------------

async def test_an_unrelated_user_gets_404_for_the_file(
    db_session, org, trainee, hr
):
    """The file endpoint must not become the way to confirm a document
    exists — same 404 as the approval detail endpoint (section 9.4, E28)."""
    from app.services.approval_service import ApprovalService

    owner, _ = trainee
    stranger, _ = hr
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/report.pdf", mime="application/pdf",
    )

    actor = AuthUser(
        id=stranger.id, email=stranger.email, org_id=org.id,
        roles=["worker"], permissions=[],
    )
    svc = ApprovalService(db_session)
    with pytest.raises(NotFoundException) as real:
        await svc.version_file_for_viewer(version_id=v.id, actor=actor)
    with pytest.raises(NotFoundException) as fake:
        await svc.version_file_for_viewer(version_id=uuid.uuid4(), actor=actor)
    assert str(real.value) == str(fake.value)


async def test_another_org_gets_404_for_the_file(db_session, org, trainee):
    from app.services.approval_service import ApprovalService

    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/report.pdf", mime="application/pdf",
    )
    outsider = AuthUser(
        id=owner.id, email=owner.email, org_id=uuid.uuid4(),
        roles=["admin"], permissions=[],
    )
    with pytest.raises(NotFoundException):
        await ApprovalService(db_session).version_file_for_viewer(
            version_id=v.id, actor=outsider,
        )


# -- The submit gate --------------------------------------------------------

async def test_submit_refuses_an_unreadable_pdf(
    db_session, org, trainee, monkeypatch
):
    """WF-REV-09 / E15 — and the reason is recorded on the row, so a retry
    and the approval screen both show the same message."""
    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/report.pdf", mime="application/pdf",
    )

    async def _fake_download(self, version):
        return b"%PDF-1.7 not really a pdf"

    monkeypatch.setattr(RenditionService, "_download", _fake_download)

    with pytest.raises(UnprocessableEntityException):
        await RenditionService(db_session).assert_version_reviewable(v)

    assert v.rendition_status == "failed"
    assert v.rendition_error


async def test_a_storage_outage_does_not_block_a_submission(
    db_session, org, trainee, monkeypatch
):
    """The file may be perfectly fine. Blocking a submission on our own
    infrastructure failing would be the wrong trade."""
    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/report.pdf", mime="application/pdf",
    )

    async def _boom(self, version):
        raise RuntimeError("S3 unreachable")

    monkeypatch.setattr(RenditionService, "_download", _boom)

    # No exception.
    await RenditionService(db_session).assert_version_reviewable(v)
    assert v.rendition_status != "failed"


async def test_the_gate_only_parses_pdfs(db_session, org, trainee, monkeypatch):
    """An office file needs a full conversion — minutes — so it is not
    checked synchronously in the submit request."""
    owner, _ = trainee
    _doc, v = await _version(
        db_session, org, owner,
        storage_key="orgs/x/files/a/contract.docx", mime=None,
    )
    called = {"n": 0}

    async def _counting(self, version):
        called["n"] += 1
        return b""

    monkeypatch.setattr(RenditionService, "_download", _counting)

    await RenditionService(db_session).assert_version_reviewable(v)
    assert called["n"] == 0, "a .docx must not be downloaded during submit"
