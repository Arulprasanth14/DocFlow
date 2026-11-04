"""
DocFlow Backend - transactional email templates.

Every email the application sends - the four account events below AND the
generic notification email - is rendered through the same layout, so all of
them carry the same identity as the app:

  * logo  : the in-app mark (gradient rounded square + document glyph), shipped
            as an inline image (docflow-logo.png, CID `docflow-logo`)
  * colors: the app's LIGHT theme tokens (Frontend/src/index.css): primary
            #2F6FD6, accent #6256B8, page #EEF5FC, card #F8FBFF, text #183153 /
            #49627D, border #D3E2F2
  * type  : Inter, with the safe fallbacks email clients actually render
            (webfonts only load in a few clients; the fallback stack matters)

Email-client reality drives the markup: table layout, inline styles, no CSS
gradients/SVG (clients strip them), a "bulletproof" button built from a table
cell with a solid background, a hidden preheader, and one small <style> block
only for the responsive tweak and dark-mode opt-out (ignored by clients that
drop <style>, which still get the fully inline layout).

Each render returns (subject, html, text). The text part is a real
alternative, not a stripped copy: it carries the same sentences and the same
call-to-action URL.

All interpolated values are HTML-escaped - organization and person names are
user-controlled, so an org called  <script>...  must not become markup.
"""
from __future__ import annotations

from dataclasses import dataclass
from html import escape

from app.config import settings

# ── Brand tokens (light theme, Frontend/src/index.css) ───────────────────────
PRIMARY = "#2F6FD6"
PRIMARY_DARK = "#255FBD"
ACCENT = "#6256B8"
PAGE_BG = "#EEF5FC"
CARD_BG = "#F8FBFF"
TEXT = "#183153"
TEXT_MUTED = "#49627D"
BORDER = "#D3E2F2"
SUCCESS = "#4FAF83"
DANGER = "#D96B6B"
FONT = "Inter, 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif"

LOGO_CID = "docflow-logo"

# Kinds that have a dedicated template.
ORG_CREATED = "org_created"
JOIN_REQUEST = "join_request_received"
JOIN_ACCEPTED = "join_accepted"
JOIN_REJECTED = "join_rejected"
GENERIC = "generic"


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    html: str
    text: str


def _e(v: object) -> str:
    return escape(str(v if v is not None else ""), quote=True)


def _abs(url: str) -> str:
    """Turn an in-app path (/dashboard) into an absolute link."""
    if url.startswith(("http://", "https://")):
        return url
    return settings.FRONTEND_URL.rstrip("/") + "/" + url.lstrip("/")


def _greeting(name: str | None) -> str:
    first = (name or "").strip().split(" ")[0]
    return f"Hi {first}," if first else "Hi,"


def _logo_html() -> str:
    """Inline image when we can embed it (SMTP), hosted URL if configured,
    otherwise just the wordmark - never a broken-image box."""
    src = settings.EMAIL_LOGO_URL or (f"cid:{LOGO_CID}" if settings.EMAIL_PROVIDER != "resend" else "")
    if not src:
        return ""
    return (
        f'<img src="{_e(src)}" width="40" height="40" alt="DocFlow" '
        'style="display:block;border:0;outline:none;text-decoration:none;'
        'border-radius:10px;width:40px;height:40px;" />'
    )


def _layout(
    *,
    preheader: str,
    heading: str,
    paragraphs: list[str],
    cta_label: str | None,
    cta_url: str | None,
    accent: str = PRIMARY,
    footer_note: str,
    details: list[tuple[str, str]] | None = None,
) -> str:
    logo = _logo_html()
    logo_cell = (
        f'<td width="40" valign="middle" style="padding-right:12px;">{logo}</td>' if logo else ""
    )

    body = "".join(
        f'<p style="margin:0 0 16px 0;font-family:{FONT};font-size:15px;line-height:24px;color:{TEXT_MUTED};">{p}</p>'
        for p in paragraphs
    )

    details_html = ""
    if details:
        rows = "".join(
            f'<tr><td style="padding:6px 0;font-family:{FONT};font-size:13px;color:{TEXT_MUTED};width:110px;">{_e(k)}</td>'
            f'<td style="padding:6px 0;font-family:{FONT};font-size:14px;color:{TEXT};font-weight:600;">{_e(v)}</td></tr>'
            for k, v in details
        )
        details_html = (
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            f'style="margin:4px 0 20px 0;border:1px solid {BORDER};border-radius:10px;background:#FFFFFF;">'
            f'<tr><td style="padding:10px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table></td></tr></table>'
        )

    button = ""
    fallback_link = ""
    if cta_label and cta_url:
        button = (
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;">'
            f'<tr><td align="center" bgcolor="{accent}" style="border-radius:10px;background-color:{accent};">'
            f'<a href="{_e(cta_url)}" target="_blank" style="display:inline-block;padding:13px 26px;'
            f'font-family:{FONT};font-size:15px;font-weight:600;line-height:20px;color:#FFFFFF;'
            f'text-decoration:none;border-radius:10px;">{_e(cta_label)}</a></td></tr></table>'
        )
        fallback_link = (
            f'<p style="margin:0 0 4px 0;font-family:{FONT};font-size:12px;line-height:18px;color:{TEXT_MUTED};">'
            f'Button not working? Paste this link into your browser:<br />'
            f'<a href="{_e(cta_url)}" style="color:{PRIMARY};word-break:break-all;">{_e(cta_url)}</a></p>'
        )

    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>{_e(heading)}</title>
<style>
  @media only screen and (max-width: 620px) {{
    .container {{ width: 100% !important; }}
    .px {{ padding-left: 20px !important; padding-right: 20px !important; }}
    .h1 {{ font-size: 22px !important; line-height: 30px !important; }}
  }}
  :root {{ color-scheme: light only; supported-color-schemes: light only; }}
</style>
</head>
<body style="margin:0;padding:0;background-color:{PAGE_BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:{PAGE_BG};">{_e(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{PAGE_BG}" style="background-color:{PAGE_BG};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
    <tr><td style="padding:0 4px 20px 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        {logo_cell}
        <td valign="middle" style="font-family:{FONT};font-size:22px;font-weight:800;letter-spacing:-0.02em;color:{PRIMARY};">DocFlow</td>
      </tr></table>
    </td></tr>
    <tr><td class="px" bgcolor="{CARD_BG}" style="background-color:{CARD_BG};border:1px solid {BORDER};border-radius:16px;padding:32px 36px;border-top:4px solid {accent};">
      <h1 class="h1" style="margin:0 0 16px 0;font-family:{FONT};font-size:24px;line-height:32px;font-weight:700;color:{TEXT};">{_e(heading)}</h1>
      {body}
      {details_html}
      {button}
      {fallback_link}
    </td></tr>
    <tr><td style="padding:20px 8px 0 8px;">
      <p style="margin:0;font-family:{FONT};font-size:12px;line-height:18px;color:{TEXT_MUTED};">{footer_note}</p>
      <p style="margin:8px 0 0 0;font-family:{FONT};font-size:12px;line-height:18px;color:{TEXT_MUTED};">DocFlow &middot; Document workflow &amp; approvals</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>"""


def _text(greeting: str, paragraphs: list[str], cta_label: str | None, cta_url: str | None,
          footer_note: str, details: list[tuple[str, str]] | None = None) -> str:
    lines = [greeting, ""]
    for p in paragraphs:
        lines += [p, ""]
    if details:
        lines += [f"  {k}: {v}" for k, v in details] + [""]
    if cta_label and cta_url:
        lines += [f"{cta_label}:", cta_url, ""]
    lines += ["--", footer_note, "DocFlow - Document workflow & approvals"]
    return "\n".join(lines)


# ── Event templates ──────────────────────────────────────────────────────────

def render(kind: str, ctx: dict) -> RenderedEmail:
    """Render an email by kind. Unknown kinds fall back to the generic layout."""
    fn = _RENDERERS.get(kind, _generic)
    return fn(ctx)


def _org_created(ctx: dict) -> RenderedEmail:
    org = ctx["org_name"]
    url = _abs(ctx.get("cta_url") or "/dashboard")
    sentence = (
        f"You created the organization '{org}'. You are the admin of this "
        "organization. Thank you for choosing DocFlow."
    )
    subject = f"You created the organization '{org}'"
    foot = "You received this email because you created an organization on DocFlow."
    paragraphs_html = [_e(sentence),
                       "Invite your team from <strong>Members</strong>, and review the default "
                       "Workflow Templates and Document Types we set up for you."]
    paragraphs_text = [sentence,
                       "Invite your team from Members, and review the default Workflow "
                       "Templates and Document Types we set up for you."]
    return RenderedEmail(
        subject,
        _layout(preheader=f"You are the admin of {org}.", heading="Your organization is ready",
                paragraphs=[_e(_greeting(ctx.get("name")))] + paragraphs_html,
                cta_label="Open your dashboard", cta_url=url, footer_note=_e(foot),
                details=[("Organization", org), ("Your role", "Admin")]),
        _text(_greeting(ctx.get("name")), paragraphs_text, "Open your dashboard", url, foot,
              [("Organization", org), ("Your role", "Admin")]),
    )


def _join_request(ctx: dict) -> RenderedEmail:
    org, who = ctx["org_name"], ctx["requester_name"]
    email = ctx.get("requester_email", "")
    url = _abs(ctx.get("cta_url") or "/admin/members")
    subject = f"{who} wants to join {org}"
    sentence = f"{who} ({email}) asked to join '{org}'. Review the request and choose their role."
    foot = f"You received this because you are an admin or HR user of {org}. Only one of you needs to respond: the first decision closes the request."
    return RenderedEmail(
        subject,
        _layout(preheader=f"{who} is waiting for access to {org}.", heading="New request to join your organization",
                paragraphs=[_e(_greeting(ctx.get("name"))), _e(sentence)],
                cta_label="Review request", cta_url=url, footer_note=_e(foot),
                details=[("Requester", who), ("Email", email), ("Organization", org)]),
        _text(_greeting(ctx.get("name")), [sentence], "Review request", url, foot,
              [("Requester", who), ("Email", email), ("Organization", org)]),
    )


def _join_accepted(ctx: dict) -> RenderedEmail:
    org, by, role = ctx["org_name"], ctx["approver_name"], ctx["role"]
    url = _abs(ctx.get("cta_url") or "/dashboard")
    sentence = f"You have been admitted to '{org}' by {by}, with the role {role}."
    foot = f"You received this because you asked to join {org} on DocFlow."
    return RenderedEmail(
        f"You've been admitted to '{org}'",
        _layout(preheader=f"Welcome to {org}.", heading="Welcome aboard", accent=SUCCESS,
                paragraphs=[_e(_greeting(ctx.get("name"))), _e(sentence), "Sign in to start working with your team."],
                cta_label="Open DocFlow", cta_url=url, footer_note=_e(foot),
                details=[("Organization", org), ("Your role", role), ("Admitted by", by)]),
        _text(_greeting(ctx.get("name")), [sentence, "Sign in to start working with your team."],
              "Open DocFlow", url, foot, [("Organization", org), ("Your role", role), ("Admitted by", by)]),
    )


def _join_rejected(ctx: dict) -> RenderedEmail:
    org, by = ctx["org_name"], ctx["approver_name"]
    url = _abs(ctx.get("cta_url") or "/onboarding")
    sentence = f"Your request to join '{org}' was not approved by {by}."
    extra = ("You can contact the organization's administrators directly, request to join a "
             "different organization, or create your own.")
    foot = f"You received this because you asked to join {org} on DocFlow."
    return RenderedEmail(
        f"Your request to join '{org}' was not approved",
        _layout(preheader=f"Update on your request to join {org}.", heading="Your request was not approved",
                accent=DANGER, paragraphs=[_e(_greeting(ctx.get("name"))), _e(sentence), _e(extra)],
                cta_label="Back to DocFlow", cta_url=url, footer_note=_e(foot)),
        _text(_greeting(ctx.get("name")), [sentence, extra], "Back to DocFlow", url, foot),
    )


def _generic(ctx: dict) -> RenderedEmail:
    title = ctx.get("title") or "Notification"
    body = ctx.get("body") or ""
    url = _abs(ctx["cta_url"]) if ctx.get("cta_url") else None
    foot = "You received this because of activity in your DocFlow workspace."
    paragraphs = [_e(_greeting(ctx.get("name")))] + ([_e(body)] if body else [])
    return RenderedEmail(
        title,
        _layout(preheader=body[:110] or title, heading=title, paragraphs=paragraphs,
                cta_label="Open in DocFlow" if url else None, cta_url=url, footer_note=_e(foot)),
        _text(_greeting(ctx.get("name")), [body] if body else [], "Open in DocFlow" if url else None, url, foot),
    )


_RENDERERS = {
    ORG_CREATED: _org_created,
    JOIN_REQUEST: _join_request,
    JOIN_ACCEPTED: _join_accepted,
    JOIN_REJECTED: _join_rejected,
    GENERIC: _generic,
}
