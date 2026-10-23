"""
Send ONE real test email straight through the configured provider, bypassing
Celery/Redis, and print exactly what the provider answered.

    cd Backend
    python -m scripts.test_email --to you@example.com
    python -m scripts.test_email --to you@example.com --kind org_created
    python -m scripts.test_email --to you@example.com --kind join_accepted --provider console

--kind: org_created | join_request_received | join_accepted | join_rejected | generic
Secrets are never printed (they are redacted from every error).

Reading the result
------------------
"ACCEPTED" means the provider took the message. It does NOT prove the mailbox
received it or that it reached the inbox instead of spam. Check the mailbox
(and spam folder) yourself; with SMTP_HOST=localhost:1025 the mail goes to
Mailpit (http://localhost:8025), NOT to a real inbox.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.trust import ensure_os_trust_store  # noqa: E402

ensure_os_trust_store()

from app.config import settings  # noqa: E402
from app.core.email_sender import EmailSendError, redact, send_email_message  # noqa: E402
from app.emails.templates import render  # noqa: E402

SAMPLES = {
    "org_created": {"org_name": "Acme Test Org"},
    "join_request_received": {"org_name": "Acme Test Org", "requester_name": "Sam Rivera",
                              "requester_email": "sam@example.com"},
    "join_accepted": {"org_name": "Acme Test Org", "approver_name": "Alex Admin", "role": "worker"},
    "join_rejected": {"org_name": "Acme Test Org", "approver_name": "Alex Admin"},
    "generic": {"title": "DocFlow test email", "body": "If you can read this, your email setup works."},
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--kind", default="org_created", choices=sorted(SAMPLES))
    ap.add_argument("--provider", choices=["smtp", "resend", "console"], help="override EMAIL_PROVIDER")
    args = ap.parse_args()

    provider = args.provider or settings.EMAIL_PROVIDER
    print("provider      :", provider)
    if provider == "smtp":
        print("smtp          :", f"{settings.SMTP_HOST}:{settings.SMTP_PORT}",
              f"starttls={settings.SMTP_TLS} ssl={settings.SMTP_SSL}",
              f"auth={'yes' if settings.SMTP_USER else 'no'}")
    print("from          :", f"{settings.EMAIL_FROM_NAME} <{settings.EMAIL_FROM}>")
    print("to            :", args.to)

    mail = render(args.kind, {**SAMPLES[args.kind], "name": args.to.split("@")[0].title()})
    print("subject       :", mail.subject)
    try:
        r = send_email_message(to=args.to, subject=mail.subject, html=mail.html, text=mail.text,
                               provider=provider)
    except EmailSendError as exc:
        print("\nRESULT        : FAILED")
        print("provider      :", exc.provider)
        print("code          :", exc.code)
        print("retryable     :", exc.transient)
        print("error         :", redact(exc))
        return 1
    except Exception as exc:
        print("\nRESULT        : CRASHED")
        print("error         :", redact(f"{type(exc).__name__}: {exc}"))
        return 2

    print("\nRESULT        :", "ACCEPTED by provider" if r.accepted else "NOT SENT (console provider)")
    print("message-id    :", r.message_id)
    print("provider reply:", redact(r.response))
    if r.accepted:
        print("\nNote: acceptance != delivery != inbox placement. Check the mailbox and spam folder.")
        if provider == "smtp" and settings.SMTP_HOST in ("localhost", "127.0.0.1"):
            print("      SMTP is localhost - this went to Mailpit (http://localhost:8025), not a real inbox.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
