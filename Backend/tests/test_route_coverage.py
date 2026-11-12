"""
Auth hardening — Phase E: no route reaches the app without a guard.

Static check, no DB, no HTTP: every registered route must either resolve
`get_current_user` / `get_current_firebase_user` somewhere in its dependency
tree, or be listed in PUBLIC_ROUTES below with a reason.

This is the test that makes "we forgot the auth dependency" impossible to
merge. Adding a route without either an auth dependency or an allowlist entry
fails CI.
"""
from __future__ import annotations

from fastapi.routing import APIRoute, APIWebSocketRoute

from app.dependencies import get_current_firebase_user, get_current_user
from app.main import app

#: (method, path) -> why it is reachable unauthenticated.
PUBLIC_ROUTES: dict[tuple[str, str], str] = {
    ("GET", "/health"): "liveness probe",
    ("GET", "/health/live"): "readiness probe (DB + Redis)",
    ("POST", "/api/v1/auth/firebase-login"): "sign-in: exchanges a Firebase ID token",
    ("POST", "/api/v1/auth/login"): "legacy password sign-in (deprecated, see G13)",
    ("POST", "/api/v1/auth/register"): "legacy password sign-up (deprecated, see G13)",
    ("POST", "/api/v1/auth/refresh"): "takes the HttpOnly refresh cookie, not a bearer token",
    ("POST", "/api/v1/auth/logout"): "idempotent: revokes whatever jti the bearer token names",
}

#: WebSocket routes authenticate inside the handler (a browser cannot send an
#: Authorization header on a WebSocket), so the dependency tree looks empty.
#: They call authenticate_token() on connect and re-check periodically.
WEBSOCKET_ROUTES_SELF_AUTHENTICATING = {
    "/ws/notifications",
    "/ws/chat/{conversation_id}",
}

AUTH_DEPENDENCY_CALLS = {get_current_user, get_current_firebase_user}


def _resolves_auth(dependant, seen=None) -> bool:
    """True when an auth dependency appears anywhere in the tree."""
    seen = seen or set()
    if id(dependant) in seen:
        return False
    seen.add(id(dependant))
    if dependant.call in AUTH_DEPENDENCY_CALLS:
        return True
    return any(_resolves_auth(sub, seen) for sub in dependant.dependencies)


def _http_routes():
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods or []):
                if method in ("HEAD", "OPTIONS"):
                    continue
                yield method, route.path, route


def test_every_http_route_is_guarded_or_explicitly_public():
    unguarded = [
        f"{method} {path}"
        for method, path, route in _http_routes()
        if not _resolves_auth(route.dependant)
        and (method, path) not in PUBLIC_ROUTES
    ]
    assert not unguarded, (
        "These routes have no auth dependency and are not on the public "
        "allowlist. Add the dependency, or add an entry to PUBLIC_ROUTES with "
        "a reason:\n  " + "\n  ".join(sorted(unguarded))
    )


def test_the_public_allowlist_has_no_stale_entries():
    """A guarded or deleted route must not stay on the allowlist, or the next
    reviewer will trust an entry that no longer describes anything."""
    registered = {(method, path) for method, path, _ in _http_routes()}
    stale = [
        f"{method} {path}"
        for (method, path) in PUBLIC_ROUTES
        if (method, path) not in registered
    ]
    assert not stale, "PUBLIC_ROUTES entries for routes that no longer exist: " + ", ".join(stale)


def test_websocket_routes_are_accounted_for():
    """WebSocket auth happens in the handler, so the only protection against
    a new unauthenticated socket is this list."""
    ws_paths = {
        route.path for route in app.routes if isinstance(route, APIWebSocketRoute)
    }
    assert ws_paths == WEBSOCKET_ROUTES_SELF_AUTHENTICATING, (
        "WebSocket routes changed. Each one must call authenticate_token() on "
        f"connect; update this list deliberately. Registered: {sorted(ws_paths)}"
    )


def test_websocket_handlers_actually_authenticate():
    """Cheap source check, so the list above cannot become a rubber stamp."""
    import inspect

    from app.routers import ws_chat, ws_notifications

    for module in (ws_chat, ws_notifications):
        source = inspect.getsource(module)
        assert "authenticate_token(" in source, f"{module.__name__} does not authenticate"
        assert "code=1008" in source, f"{module.__name__} does not reject with 1008"
