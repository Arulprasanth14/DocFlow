"""
Email pipeline: templates, provider layer, dispatch/fallback, worker retries,
and the four user-facing events end to end (org created, join request,
accepted, rejected) - including that a failing mail path never breaks them.

No real mail is ever sent: SMTP is faked at the smtplib boundary, and event
tests record what would have been dispatched.
"""
from __future__ import annotations

import smtplib
import uuid
from email import message_from_bytes, policy
from unittest.mock import MagicMock

import pytest

from app.config import settings
from app.core import email_dispatch, email_sender
from app.core.email_sender import EmailSendError, redact
from app.emails import templates
from app.services.notification_service import NotificationService, drain_email_tasks
from conftest import REAL_SEND_EMAILS, TestSessionFactory, auth_headers
from test_account_flows import _create_org, _login, _requester, _role_id, _tok, firebase  # noqa: F401

KINDS = {
    "org_created": {"org_name": "Acme", "name": "Arul K"},
    "join_request_received": {"org_name": "Acme", "requester_name": "Sam", "requester_email": "s@x.com", "name": "Arul"},
    "join_accepted": {"org_name": "Acme", "approver_name": "Alex", "role": "worker", "name": "Sam"},
    "join_rejected": {"org_name": "Acme", "approver_name": "Alex", "name": "Sam"},
}


# ═══ Templates ═══════════════════════════════════════════════════════════════

@pytest.mark.parametrize("kind", sorted(KINDS))
def test_every_event_has_themed_responsive_html_and_a_text_alternative(kind):
    mail = templates.render(kind, KINDS[kind])
    assert mail.subject and mail.text.strip()
    h = mail.html
    assert "#2F6FD6" in h and "Inter" in h                      # app colors + typography
    assert "cid:docflow-logo" in h                              # real logo, inline
    assert "max-width: 620px" in h and 'name="viewport"' in h   # responsive
    assert "http://localhost:5173" in h and "http://localhost:5173" in mail.text  # CTA in both parts
    assert mail.text.startswith("Hi ")


def test_org_created_uses_the_required_wording_and_personal_greeting():
    mail = templates.render("org_created", KINDS["org_created"])
    assert mail.subject == "You created the organization 'Acme'"
    assert mail.text.startswith("Hi Arul,")
    assert ("You created the organization 'Acme'. You are the admin of this organization. "
            "Thank you for choosing DocFlow.") in mail.text


def test_user_controlled_values_are_html_escaped():
    mail = templates.render("org_created", {"org_name": "<script>alert(1)</script>", "name": "<b>x</b>"})
    assert "<script>" not in mail.html and "&lt;script&gt;" in mail.html
    assert "<b>x</b>" not in mail.html


# ═══ Provider layer ══════════════════════════════════════════════════════════

def test_message_is_multipart_with_inline_logo_and_deliverability_headers():
    mail = templates.render("org_created", KINDS["org_created"])
    msg = email_sender.build_message(to="a@b.com", subject=mail.subject, html=mail.html, text=mail.text)
    parsed = message_from_bytes(msg.as_bytes(), policy=policy.default)
    assert parsed["Message-ID"] and parsed["Date"] and parsed["Auto-Submitted"] == "auto-generated"
    assert parsed.get_body(("plain",)) is not None and parsed.get_body(("html",)) is not None
    assert any(p.get_content_type() == "image/png" and p["Content-ID"] == "<docflow-logo>" for p in parsed.walk())


class FakeSMTP:
    behaviour: dict = {}
    sent: list = []

    def __init__(self, host, port, timeout=None, **kw):
        if FakeSMTP.behaviour.get("connect_error"):
            raise ConnectionRefusedError("connection refused")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def ehlo(self): return (250, b"ok")
    def starttls(self, **kw): return (220, b"go")

    def login(self, u, p):
        if FakeSMTP.behaviour.get("auth_error"):
            raise smtplib.SMTPAuthenticationError(535, b"5.7.8 bad credentials")

    def mail(self, a): return (250, b"ok")

    def rcpt(self, a):
        return FakeSMTP.behaviour.get("rcpt", (250, b"ok"))

    def data(self, payload):
        code = FakeSMTP.behaviour.get("data_code", 250)
        if code >= 400:
            raise smtplib.SMTPDataError(code, b"mailbox busy")
        FakeSMTP.sent.append(payload)
        return (250, b"2.0.0 Ok: queued as ABC123")


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSMTP.behaviour, FakeSMTP.sent = {}, []
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(settings, "EMAIL_PROVIDER", "smtp")
    return FakeSMTP


def _send():
    return email_sender.send_email_message(to="a@b.com", subject="s", html="<p>x</p>", text="x")


def test_smtp_success_returns_the_servers_actual_reply(fake_smtp):
    r = _send()
    assert r.accepted and "queued as ABC123" in r.response and len(fake_smtp.sent) == 1


@pytest.mark.parametrize("behaviour,transient", [
    ({"connect_error": True}, True),
    ({"data_code": 451}, True),
    ({"data_code": 550}, False),
    ({"auth_error": True}, False),
])
def test_failures_are_classified_transient_or_permanent(fake_smtp, monkeypatch, behaviour, transient):
    fake_smtp.behaviour = behaviour
    if behaviour.get("auth_error"):
        monkeypatch.setattr(settings, "SMTP_USER", "u")
    with pytest.raises(EmailSendError) as ei:
        _send()
    assert ei.value.transient is transient


def test_secrets_never_appear_in_errors(monkeypatch):
    monkeypatch.setattr(settings, "SMTP_PASSWORD", "s3cretpassw0rd")
    monkeypatch.setattr(settings, "RESEND_API_KEY", "re_abcdefgh12345678")
    out = redact("login failed password=s3cretpassw0rd key re_abcdefgh12345678 Authorization: Bearer abc.def")
    assert "s3cretpassw0rd" not in out and "re_abcdefgh12345678" not in out and "abc.def" not in out


# ═══ Dispatch / dev fallback ═════════════════════════════════════════════════

def test_no_worker_with_fallback_sends_inline(fake_smtp, monkeypatch):
    monkeypatch.setattr(settings, "EMAIL_SYNC_FALLBACK", True)
    monkeypatch.setattr(settings, "EMAIL_DELIVERY_MODE", "queue")
    monkeypatch.setattr(email_dispatch, "worker_available", lambda force=False: False)
    assert email_dispatch.dispatch_email(to="a@b.com", subject="s", html="<p>x</p>") == "sent_inline"
    assert len(fake_smtp.sent) == 1


def test_worker_available_enqueues(monkeypatch):
    import app.workers.email_tasks as et

    monkeypatch.setattr(settings, "EMAIL_DELIVERY_MODE", "queue")
    monkeypatch.setattr(email_dispatch, "worker_available", lambda force=False: True)
    delay = MagicMock(return_value=MagicMock(id="t1"))
    monkeypatch.setattr(et.send_email, "apply_async", delay)
    assert email_dispatch.dispatch_email(to="a@b.com", subject="s", html="x") == "queued"
    assert delay.call_args.kwargs["queue"] == "email"


def test_dispatch_never_raises_even_if_everything_is_down(fake_smtp, monkeypatch):
    fake_smtp.behaviour = {"connect_error": True}
    monkeypatch.setattr(settings, "EMAIL_DELIVERY_MODE", "inline")
    assert email_dispatch.dispatch_email(to="a@b.com", subject="s", html="x") in ("logged", "failed")
    monkeypatch.setattr(email_dispatch, "worker_available", lambda force=False: (_ for _ in ()).throw(RuntimeError("x")))
    monkeypatch.setattr(settings, "EMAIL_DELIVERY_MODE", "queue")
    assert email_dispatch.dispatch_email(to="a@b.com", subject="s", html="x") in ("logged", "failed", "sent_inline")


# ═══ Worker task: retries + backoff ══════════════════════════════════════════

def test_backoff_grows_exponentially_and_is_capped(monkeypatch):
    from app.workers.email_tasks import MAX_BACKOFF_SECONDS, backoff_seconds

    monkeypatch.setattr(settings, "EMAIL_RETRY_BASE_SECONDS", 5)
    assert [5 <= backoff_seconds(0) <= 6, 10 <= backoff_seconds(1) <= 12, 20 <= backoff_seconds(2) <= 24] == [True] * 3
    assert backoff_seconds(30) <= MAX_BACKOFF_SECONDS * 1.2


def test_transient_failure_is_retried_permanent_is_not(monkeypatch):
    import app.workers.email_tasks as et

    calls = {"n": 0}

    def make(transient):
        def boom(*a, **k):
            calls["n"] += 1
            raise EmailSendError("nope", transient=transient, provider="smtp")
        return boom

    monkeypatch.setattr(et, "deliver", make(True))
    res = et.send_email.apply(kwargs={"to": "a@b.com", "subject": "s", "html": "x"}, throw=False)
    assert res.failed() and calls["n"] == et.send_email.max_retries + 1

    calls["n"] = 0
    monkeypatch.setattr(et, "deliver", make(False))
    res = et.send_email.apply(kwargs={"to": "a@b.com", "subject": "s", "html": "x"}, throw=False)
    assert res.failed() and calls["n"] == 1


# ═══ The four events, end to end through the API ═════════════════════════════

@pytest.fixture
def outbox(monkeypatch):
    """Real _send_emails + real templates; dispatch recorded instead of sent."""
    sent: list[dict] = []
    monkeypatch.setattr(NotificationService, "_send_emails", REAL_SEND_EMAILS)
    monkeypatch.setattr("app.database.async_session_factory", TestSessionFactory)

    def record(**kw):
        sent.append(kw)
        return "queued"

    monkeypatch.setattr(email_dispatch, "dispatch_email", record)
    return sent


async def test_org_creation_sends_the_org_created_email(client, firebase, outbox):
    t = firebase.add(_tok(), uid="u-oc", email="founder@example.com", name="Founder Person")
    assert (await _create_org(client, t, "Mailco")).status_code == 200
    await drain_email_tasks()
    mails = [m for m in outbox if m["to"] == "founder@example.com"]
    assert len(mails) == 1
    assert mails[0]["subject"] == "You created the organization 'Mailco'"
    assert mails[0]["text"].startswith("Hi Founder,")
    assert "You are the admin of this organization" in mails[0]["html"]


async def test_join_request_emails_admins_and_hr_only(client, firebase, org, admin, hr, worker, outbox):
    _t, token, _ = await _requester(client, firebase, "joiner@example.com")
    assert (await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name},
                              headers=auth_headers(token))).status_code == 201
    await drain_email_tasks()
    assert {m["to"] for m in outbox} == {admin[0].email, hr[0].email}
    assert all("wants to join" in m["subject"] and "joiner@example.com" in m["text"] for m in outbox)


async def test_accept_and_reject_email_the_requester(client, firebase, org, admin, db_session, outbox):
    _t, token, _ = await _requester(client, firebase, "yes@example.com")
    _t2, token2, _ = await _requester(client, firebase, "no@example.com")
    for tk in (token, token2):
        await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(tk))
    await drain_email_tasks()
    outbox.clear()

    pending = {p["email"]: p["id"] for p in
               (await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin[1]))).json()}
    worker_role = await _role_id(db_session, org, "worker")
    r = await client.post(f"/api/v1/orgs/me/join-requests/{pending['yes@example.com']}/accept",
                          json={"role_id": str(worker_role)}, headers=auth_headers(admin[1]))
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/v1/orgs/me/join-requests/{pending['no@example.com']}/reject",
                          headers=auth_headers(admin[1]))
    assert r.status_code == 200, r.text
    await drain_email_tasks()

    by_to = {m["to"]: m for m in outbox}
    assert by_to["yes@example.com"]["subject"] == f"You've been admitted to '{org.name}'"
    assert "worker" in by_to["yes@example.com"]["text"]
    assert by_to["no@example.com"]["subject"] == f"Your request to join '{org.name}' was not approved"


async def test_failing_mail_path_never_breaks_org_creation_or_login(client, firebase, monkeypatch):
    monkeypatch.setattr(NotificationService, "_send_emails", REAL_SEND_EMAILS)
    monkeypatch.setattr("app.database.async_session_factory", TestSessionFactory)

    def explode(**kw):
        raise RuntimeError("smtp exploded")

    monkeypatch.setattr(email_dispatch, "dispatch_email", explode)
    t = firebase.add(_tok(), uid="u-fail", email="fail@example.com")
    resp = await _create_org(client, t, "Failco")
    assert resp.status_code == 200 and resp.json()["state"] == "HAS_ORG"
    await drain_email_tasks()
    assert (await _login(client, t)).json()["state"] == "HAS_ORG"
