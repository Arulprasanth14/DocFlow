"""
Deliverability self-check for the configured sender (READ-ONLY, no mail sent).

    cd Backend
    python -m scripts.check_email_deliverability
    python -m scripts.check_email_deliverability --domain example.com --dkim-selector s1

Checks the sender domain's SPF / DMARC / DKIM / MX DNS records, probes the
SMTP server's TLS and AUTH support, and prints what to fix. It cannot
guarantee inbox placement - nobody can: receivers also weigh sender
reputation, content, engagement and complaint rates. This tells you whether
the *technical* prerequisites are in place.

DKIM note: the selector is chosen by your provider (Resend: `resend._domainkey`,
SES: three CNAMEs, Google: `google._domainkey`, SendGrid: `s1`/`s2`). Pass
--dkim-selector, or the script tries a list of common ones.
"""
from __future__ import annotations

import argparse
import os
import smtplib
import ssl
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings  # noqa: E402

COMMON_SELECTORS = ["default", "google", "resend", "s1", "s2", "selector1", "selector2", "k1", "mail", "dkim"]
problems = 0


def say(level: str, msg: str) -> None:
    global problems
    if level == "FAIL":
        problems += 1
    print(f"[{level:4}] {msg}")


def txt(name: str) -> list[str]:
    import dns.resolver

    try:
        return ["".join(p.decode() for p in r.strings) for r in dns.resolver.resolve(name, "TXT", lifetime=5)]
    except Exception:
        return []


def check_dns(domain: str, selector: str | None) -> None:
    import dns.resolver

    if domain.endswith((".local", ".test", ".invalid", ".example")) or domain == "localhost":
        say("FAIL", f"'{domain}' is not a real, publicly resolvable domain: SPF/DKIM/DMARC cannot exist "
                    "for it. Mail from it will be rejected or junked by real providers (Gmail, Outlook...). "
                    "Use a domain you own (or a provider's verified sender) as EMAIL_FROM.")
        return

    spf = [r for r in txt(domain) if r.lower().startswith("v=spf1")]
    if not spf:
        say("FAIL", f"No SPF record on {domain}. Add a TXT record, e.g. v=spf1 include:<provider> ~all")
    elif len(spf) > 1:
        say("FAIL", f"{len(spf)} SPF records on {domain}; there must be exactly one.")
    else:
        say("ok", f"SPF: {spf[0]}")
        if "+all" in spf[0] or spf[0].strip().endswith("?all"):
            say("WARN", "SPF ends in +all/?all, which authorizes everyone / nobody-in-particular.")

    dmarc = [r for r in txt(f"_dmarc.{domain}") if r.lower().startswith("v=dmarc1")]
    if not dmarc:
        say("FAIL", f"No DMARC record. Add TXT _dmarc.{domain}: v=DMARC1; p=none; rua=mailto:dmarc@{domain} "
                    "(start with p=none, move to quarantine/reject once reports look clean).")
    else:
        say("ok", f"DMARC: {dmarc[0]}")
        if "p=none" in dmarc[0].replace(" ", "").lower():
            say("WARN", "DMARC policy is p=none (monitor only) - fine to start, tighten later.")

    selectors = [selector] if selector else COMMON_SELECTORS
    found = [s for s in selectors if any("p=" in r for r in txt(f"{s}._domainkey.{domain}"))]
    if found:
        say("ok", f"DKIM: key published at selector(s) {', '.join(found)}")
    else:
        say("FAIL" if selector else "WARN",
            f"No DKIM key found at {', '.join(selectors)}._domainkey.{domain}. Publish the key your provider "
            "gives you (pass --dkim-selector if yours is custom). DKIM CNAME-style records may not appear as TXT.")

    try:
        mx = dns.resolver.resolve(domain, "MX", lifetime=5)
        say("ok", f"MX: {', '.join(str(r.exchange) for r in mx)} (replies/bounces can reach the domain)")
    except Exception:
        say("WARN", f"No MX on {domain}: replies and some bounces can't be delivered to it.")


def check_smtp() -> None:
    if settings.EMAIL_PROVIDER != "smtp":
        say("info", f"EMAIL_PROVIDER={settings.EMAIL_PROVIDER}: SMTP probe skipped.")
        return
    host, port = settings.SMTP_HOST, settings.SMTP_PORT
    try:
        ctx = ssl.create_default_context()
        s = smtplib.SMTP_SSL(host, port, timeout=10, context=ctx) if settings.SMTP_SSL else smtplib.SMTP(host, port, timeout=10)
        with s:
            s.ehlo()
            starttls = s.has_extn("starttls")
            say("ok", f"SMTP {host}:{port} reachable")
            if settings.SMTP_SSL:
                say("ok", "TLS: implicit SSL")
            elif starttls and settings.SMTP_TLS:
                s.starttls(context=ctx)
                say("ok", "TLS: STARTTLS negotiated with a verified certificate")
            elif starttls:
                say("FAIL", "Server offers STARTTLS but SMTP_TLS=false - credentials/mail would travel in clear text.")
            else:
                say("WARN" if host in ("localhost", "127.0.0.1") else "FAIL",
                    "Server does not offer TLS (acceptable only for local Mailpit).")
            if settings.SMTP_USER:
                say("ok" if s.has_extn("auth") else "WARN", "AUTH advertised" if s.has_extn("auth") else "AUTH not advertised")
            elif host not in ("localhost", "127.0.0.1"):
                say("FAIL", "Remote SMTP host but SMTP_USER/SMTP_PASSWORD are empty - relays require authentication.")
    except Exception as exc:
        say("FAIL", f"SMTP {host}:{port} not reachable: {type(exc).__name__}: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain")
    ap.add_argument("--dkim-selector")
    a = ap.parse_args()
    sender = settings.EMAIL_FROM
    domain = a.domain or sender.partition("@")[2]
    print(f"Sender: {sender}   provider: {settings.EMAIL_PROVIDER}   domain: {domain}\n")
    check_dns(domain, a.dkim_selector)
    check_smtp()

    env = settings.EMAIL_ENVELOPE_FROM
    if env and env.partition("@")[2] != domain:
        say("WARN", "Envelope sender domain differs from From domain: SPF alignment (DMARC) may fail.")
    print("\nChecklist this script cannot verify:")
    print(" - One-click unsubscribe is not needed for these transactional messages, but keep volume low and relevant.")
    print(" - Bounces: set EMAIL_ENVELOPE_FROM to a mailbox/provider bounce address you monitor, or use provider webhooks.")
    print(" - Delivery confirmation: only provider webhooks/status APIs (e.g. Resend) report delivered/bounced/complained.")
    print(" - Inbox placement depends on sender reputation and recipient behaviour; no setting can guarantee it.")
    print(f"\nRESULT: {'no blocking problems found' if problems == 0 else f'{problems} blocking problem(s)'}")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
