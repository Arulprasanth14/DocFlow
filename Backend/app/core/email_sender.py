"""
DocFlow Backend - email provider layer.

One function, `send_email_message`, builds a multipart message (text + HTML,
inline logo) and hands it to the configured provider:

  smtp     any SMTP server (Mailpit in dev; Gmail/SES/SendGrid/Mailgun/... in prod)
  resend   Resend HTTPS API (returns a message id that can be queried later)
  console  log the full message instead of sending (dev fallback)

What a successful return means - and does not mean
--------------------------------------------------
`SendResult.accepted` is True when the PROVIDER accepted the message for
delivery (SMTP "250 ..." after DATA, or an HTTP 2xx with an id). That is NOT
confirmation that the message reached the mailbox, and certainly not that it
landed in the inbox rather than spam. Only a provider with delivery webhooks /
status lookup (e.g. Resend) can tell you more, and inbox placement can never
be observed from the sending side. The logs therefore say "accepted", never
"delivered".

Failures raise `EmailSendError` with `.transient` set: network errors, timeouts
and 4xx SMTP replies (greylisting, throttling) are retryable; 5xx replies,
authentication failures and bad recipients are permanent.

Nothing in here ever logs a secret: every error string goes through `redact`.
"""
from __future__ import annotations

import logging
import mimetypes
import re
import smtplib
import ssl
import uuid
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

LOGO_PATH = Path(__file__).resolve().parent.parent / "emails" / "assets" / "docflow-logo.png"
LOGO_CID = "docflow-logo"


# ── Redaction ────────────────────────────────────────────────────────────────

def _secrets() -> list[str]:
    return [s for s in (settings.SMTP_PASSWORD, settings.RESEND_API_KEY) if s and len(s) >= 4]


_TOKEN_RE = re.compile(
    r"(?i)(password|passwd|pwd|api[_-]?key|secret|token|authorization)(\s*[=:]\s*|\s+)(bearer\s+)?[^\s,;'\"]+"
)
_BEARER_RE = re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+")
_RESEND_KEY_RE = re.compile(r"\bre_[A-Za-z0-9_]{8,}\b")


def redact(text: object) -> str:
    """Strip configured secrets and anything that looks like a credential."""
    s = str(text)
    for secret in _secrets():
        s = s.replace(secret, "***")
    s = _BEARER_RE.sub("Bearer ***", s)
    s = _RESEND_KEY_RE.sub("re_***", s)
    s = _TOKEN_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***", s)
    return s


def mask_email(addr: str) -> str:
    """a***@gmail.com - enough to recognise in logs, not enough to harvest."""
    _, a = parseaddr(addr)
    if "@" not in a:
        return "***"
    local, _, domain = a.partition("@")
    return f"{local[:1]}***@{domain}"


# ── Result / error types ─────────────────────────────────────────────────────

class EmailSendError(Exception):
    def __init__(self, message: str, *, transient: bool, provider: str, code: int | None = None):
        super().__init__(redact(message))
        self.transient = transient
        self.provider = provider
        self.code = code


@dataclass
class SendResult:
    provider: str
    accepted: bool
    message_id: str
    response: str = ""
    extra: dict = field(default_factory=dict)


# ── Message construction ─────────────────────────────────────────────────────

def _from_header() -> str:
    return formataddr((settings.EMAIL_FROM_NAME, settings.EMAIL_FROM))


def _envelope_from() -> str:
    # Bounces (DSNs) go to the envelope sender (Return-Path). Defaulting it to
    # the From address keeps SPF aligned with the visible domain.
    return settings.EMAIL_ENVELOPE_FROM or settings.EMAIL_FROM


def build_message(
    *,
    to: str,
    subject: str,
    html: str,
    text: str | None = None,
    entity_ref: str | None = None,
    embed_logo: bool = True,
) -> EmailMessage:
    """multipart/alternative (text, html[+inline logo]) with deliverability headers."""
    if not text:
        text = re.sub(r"<[^>]+>", "", re.sub(r"(?i)<br\s*/?>|</p>", "\n", html)).strip()

    msg = EmailMessage()
    domain = parseaddr(settings.EMAIL_FROM)[1].partition("@")[2] or "docflow.local"
    msg["Subject"] = subject
    msg["From"] = _from_header()
    msg["To"] = to
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=domain)
    if settings.EMAIL_REPLY_TO:
        msg["Reply-To"] = settings.EMAIL_REPLY_TO
    # Transactional/automatic: suppress out-of-office replies and auto-reply loops.
    msg["Auto-Submitted"] = "auto-generated"
    msg["X-Auto-Response-Suppress"] = "OOF, AutoReply"
    msg["X-Entity-Ref-ID"] = entity_ref or uuid.uuid4().hex

    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    if embed_logo and f"cid:{LOGO_CID}" in html and LOGO_PATH.exists():
        ctype = mimetypes.guess_type(LOGO_PATH.name)[0] or "image/png"
        maintype, subtype = ctype.split("/", 1)
        html_part = msg.get_payload()[1]
        html_part.add_related(
            LOGO_PATH.read_bytes(), maintype=maintype, subtype=subtype,
            cid=f"<{LOGO_CID}>", filename=LOGO_PATH.name, disposition="inline",
        )
    return msg


# ── Providers ────────────────────────────────────────────────────────────────

def _classify_smtp_code(code: int) -> bool:
    """True if the SMTP reply code is transient (retryable)."""
    return 400 <= code < 500


def _send_smtp(msg: EmailMessage, to: str) -> SendResult:
    host, port = settings.SMTP_HOST, settings.SMTP_PORT
    timeout = settings.SMTP_TIMEOUT_SECONDS
    ctx = ssl.create_default_context()
    try:
        if settings.SMTP_SSL:
            server = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ctx)
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
        with server:
            server.ehlo()
            if settings.SMTP_TLS and not settings.SMTP_SSL:
                server.starttls(context=ctx)
                server.ehlo()
            if settings.SMTP_USER:
                server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            # Manual MAIL/RCPT/DATA so we keep the server's exact final reply.
            code, resp = server.mail(_envelope_from())
            if code >= 400:
                raise smtplib.SMTPSenderRefused(code, resp, _envelope_from())
            _, addr = parseaddr(to)
            code, resp = server.rcpt(addr)
            if code >= 400:
                raise smtplib.SMTPRecipientsRefused({addr: (code, resp)})
            code, resp = server.data(msg.as_bytes())
            text = resp.decode("utf-8", "replace") if isinstance(resp, bytes) else str(resp)
            if code >= 400:
                raise smtplib.SMTPDataError(code, resp)
            return SendResult("smtp", True, msg["Message-ID"], f"{code} {text}",
                              {"host": host, "port": port, "tls": settings.SMTP_TLS or settings.SMTP_SSL})
    except smtplib.SMTPAuthenticationError as exc:
        raise EmailSendError(f"SMTP authentication failed ({exc.smtp_code}): check SMTP_USER/SMTP_PASSWORD",
                             transient=False, provider="smtp", code=exc.smtp_code) from None
    except smtplib.SMTPRecipientsRefused as exc:
        code = next(iter(exc.recipients.values()))[0]
        raise EmailSendError(f"Recipient refused by server: {exc.recipients}", transient=_classify_smtp_code(code),
                             provider="smtp", code=code) from None
    except (smtplib.SMTPResponseException,) as exc:
        raise EmailSendError(f"SMTP {exc.smtp_code}: {exc.smtp_error!r}",
                             transient=_classify_smtp_code(exc.smtp_code), provider="smtp", code=exc.smtp_code) from None
    except (smtplib.SMTPException, OSError, ssl.SSLError, TimeoutError) as exc:
        # connection refused / DNS / timeout / TLS handshake: retryable
        raise EmailSendError(f"SMTP connection to {host}:{port} failed: {type(exc).__name__}: {exc}",
                             transient=True, provider="smtp") from None


def _send_resend(msg: EmailMessage, to: str, html: str, text: str, subject: str) -> SendResult:
    import httpx  # local import: only needed for this provider

    if not settings.RESEND_API_KEY:
        raise EmailSendError("RESEND_API_KEY is not set", transient=False, provider="resend")
    payload = {"from": _from_header(), "to": [to], "subject": subject, "html": html, "text": text,
               "headers": {"X-Entity-Ref-ID": msg["X-Entity-Ref-ID"], "Auto-Submitted": "auto-generated"}}
    if settings.EMAIL_REPLY_TO:
        payload["reply_to"] = settings.EMAIL_REPLY_TO
    try:
        r = httpx.post("https://api.resend.com/emails", json=payload, timeout=settings.SMTP_TIMEOUT_SECONDS,
                       headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"})
    except httpx.HTTPError as exc:
        raise EmailSendError(f"Resend request failed: {type(exc).__name__}: {exc}",
                             transient=True, provider="resend") from None
    if r.status_code >= 400:
        transient = r.status_code in (408, 425, 429) or r.status_code >= 500
        raise EmailSendError(f"Resend HTTP {r.status_code}: {r.text[:500]}", transient=transient,
                             provider="resend", code=r.status_code)
    mid = (r.json() or {}).get("id", "")
    return SendResult("resend", True, mid, f"HTTP {r.status_code} id={mid}", {"resend_id": mid})


def _send_console(msg: EmailMessage, to: str) -> SendResult:
    body = msg.get_body(preferencelist=("plain",))
    logger.warning(
        "email_console_provider: NOT SENT (EMAIL_PROVIDER=console)\n  To: %s\n  Subject: %s\n\n%s",
        to, msg["Subject"], body.get_content() if body else "(no text part)",
    )
    return SendResult("console", False, msg["Message-ID"], "logged only, nothing was sent")


# ── Public entry point ───────────────────────────────────────────────────────

def send_email_message(
    *,
    to: str,
    subject: str,
    html: str,
    text: str | None = None,
    entity_ref: str | None = None,
    provider: str | None = None,
) -> SendResult:
    """Send one email through the configured provider. Raises EmailSendError."""
    provider = provider or settings.EMAIL_PROVIDER
    msg = build_message(to=to, subject=subject, html=html, text=text, entity_ref=entity_ref,
                        embed_logo=provider == "smtp")
    plain = msg.get_body(preferencelist=("plain",)).get_content()
    if provider == "smtp":
        return _send_smtp(msg, to)
    if provider == "resend":
        return _send_resend(msg, to, html, plain, subject)
    if provider == "console":
        return _send_console(msg, to)
    raise EmailSendError(f"Unknown EMAIL_PROVIDER '{provider}'", transient=False, provider=str(provider))
