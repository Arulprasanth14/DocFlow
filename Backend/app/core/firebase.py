"""
DocFlow Backend — Core: Firebase Admin SDK
Wraps firebase-admin for Firebase token verification.
Gracefully disabled when FIREBASE_PROJECT_ID is not configured (dev mode).
"""
from __future__ import annotations

import base64
import json
import logging
import os

logger = logging.getLogger(__name__)

_firebase_initialized = False
_firebase_app = None


def initialize_firebase() -> bool:
    """
    Initialize Firebase Admin SDK.
    Returns True if successful, False if disabled (no credentials).
    """
    global _firebase_initialized, _firebase_app
    if _firebase_initialized:
        return bool(_firebase_app)

    from app.config import settings

    if not settings.firebase_enabled:
        logger.warning(
            "Firebase Auth is DISABLED — FIREBASE_PROJECT_ID or FIREBASE_CREDENTIALS_JSON not set. "
            "Only email/password auth will work."
        )
        _firebase_initialized = True
        return False

    try:
        import firebase_admin
        from firebase_admin import credentials

        creds_value = settings.FIREBASE_CREDENTIALS_JSON

        if creds_value.endswith(".json") or os.path.exists(creds_value):
            # It's a file path
            cred = credentials.Certificate(creds_value)
        elif creds_value.strip().startswith("{"):
            # It's raw JSON string
            creds_dict = json.loads(creds_value)
            cred = credentials.Certificate(creds_dict)
        else:
            # It's base64-encoded JSON
            creds_dict = json.loads(base64.b64decode(creds_value))
            cred = credentials.Certificate(creds_dict)

        _firebase_app = firebase_admin.initialize_app(cred)
        _firebase_initialized = True
        logger.info(f"Firebase initialized for project: {settings.FIREBASE_PROJECT_ID}")
        return True

    except Exception as exc:
        logger.error(f"Firebase initialization failed: {exc}")
        _firebase_initialized = True
        return False


class FirebaseUnavailableError(Exception):
    """Firebase could not be reached / its public keys could not be fetched.

    Distinct from ValueError ("this token is bad"): the caller must answer
    503 (retry), NOT 401 — returning 401 would make the frontend sign the
    user out, and returning an unhandled error 500s, which the frontend
    interprets as "no account" and routes a returning user into the
    create-an-organization screen.
    """


def _verify_sync(id_token: str) -> dict:
    """Blocking verification. Runs in a worker thread (see caller)."""
    from firebase_admin import auth as firebase_auth
    from firebase_admin import exceptions as fb_exc

    from app.config import settings

    try:
        # Signature/expiry/audience check — needs Google's public certs
        # (cached by the SDK after the first fetch), no per-login round trip.
        decoded = firebase_auth.verify_id_token(
            id_token, check_revoked=False, clock_skew_seconds=60
        )
    except firebase_auth.ExpiredIdTokenError:
        raise ValueError("Firebase token has expired — please sign in again")
    except firebase_auth.RevokedIdTokenError:
        raise ValueError("Firebase token has been revoked")
    except firebase_auth.UserDisabledError:
        raise ValueError("Firebase user account is disabled")
    except firebase_auth.InvalidIdTokenError as exc:
        raise ValueError(f"Invalid Firebase token: {exc}")
    except firebase_auth.CertificateFetchError as exc:
        raise FirebaseUnavailableError(f"could not fetch Firebase public keys: {exc}")
    except ValueError:
        raise
    except Exception as exc:  # network / TLS / SDK errors — never a bare 500
        raise FirebaseUnavailableError(f"{type(exc).__name__}: {exc}")

    # Revocation check needs a live call to Google. The token is already
    # cryptographically verified above, so if only THIS step is unreachable
    # we log and proceed rather than lock every user out during a blip —
    # unless the deployment opts into strict mode.
    if getattr(settings, "FIREBASE_CHECK_REVOKED", True):
        try:
            firebase_auth.verify_id_token(
                id_token, check_revoked=True, clock_skew_seconds=60
            )
        except (firebase_auth.RevokedIdTokenError, firebase_auth.UserDisabledError):
            raise ValueError("Firebase session has been revoked or the account is disabled")
        except Exception as exc:
            if getattr(settings, "FIREBASE_REVOCATION_FAIL_CLOSED", False):
                raise FirebaseUnavailableError(f"revocation check failed: {exc}")
            logger.warning("firebase_revocation_check_skipped: %s: %s", type(exc).__name__, exc)

    return {
        "uid": decoded["uid"],
        "email": decoded.get("email", ""),
        "email_verified": decoded.get("email_verified", False),
        "name": decoded.get("name"),
        "picture": decoded.get("picture"),
        "sign_in_provider": decoded.get("firebase", {}).get("sign_in_provider"),
    }


async def verify_firebase_token(id_token: str) -> dict:
    """
    Verify a Firebase ID token and return the decoded claims.

    Raises:
        ValueError: the token is invalid/expired/revoked (-> 401).
        FirebaseUnavailableError: Firebase unreachable (-> 503, retryable).

    The SDK's verification does blocking network I/O, so it runs in a thread:
    calling it inline froze the whole event loop for every request.
    """
    import asyncio

    if not _firebase_app:
        raise FirebaseUnavailableError("Firebase is not configured on this server")
    return await asyncio.to_thread(_verify_sync, id_token)


async def revoke_firebase_sessions(firebase_uid: str, *, disable_user: bool = False) -> bool:
    """
    Revoke a Firebase identity's refresh tokens, optionally disabling it.

    Without this, locking a user out of DocFlow leaves the Firebase side able
    to mint fresh ID tokens for them, which is the credential /auth/firebase-
    login accepts.

    Best effort by design: returns True on success, False on any failure, and
    NEVER raises. The DocFlow-side change (flags + session revocation) is the
    authoritative one and must not be rolled back because an external provider
    was unreachable - the caller logs the False and moves on.
    """
    import asyncio

    if not _firebase_app or not firebase_uid:
        return False

    def _revoke() -> bool:
        from firebase_admin import auth as firebase_auth

        firebase_auth.revoke_refresh_tokens(firebase_uid)
        if disable_user:
            firebase_auth.update_user(firebase_uid, disabled=True)
        return True

    try:
        return await asyncio.to_thread(_revoke)
    except Exception as exc:  # noqa: BLE001 - provider failure must not propagate
        # stdlib logging in this module (not structlog): %-style, no kwargs.
        logger.warning(
            "firebase_session_revocation_failed: uid=%s disable=%s %s: %s",
            firebase_uid, disable_user, type(exc).__name__, exc,
        )
        return False


def create_firebase_user(email: str, password: str, name: str | None = None) -> str:
    """
    Create a Firebase account server-side with an admin-assigned password.

    Used when an org admin invites a brand-new employee: since there is no
    email-sending infrastructure for an "accept invite" link, the admin sets
    the employee's initial password directly and relays it to them out of
    band. This creates the underlying Firebase identity so the employee can
    then sign in through the normal email/password login flow unchanged.

    Returns the new Firebase UID. Raises ValueError on failure (duplicate
    email, Firebase not configured, weak password per Firebase's own rules).
    """
    if not _firebase_app:
        raise ValueError("Firebase is not configured on this server")

    from firebase_admin import auth as firebase_auth

    try:
        user_record = firebase_auth.create_user(
            email=email,
            password=password,
            display_name=name or None,
        )
        return user_record.uid
    except firebase_auth.EmailAlreadyExistsError as exc:
        raise ValueError("A Firebase account with this email already exists") from exc
    except Exception as exc:
        raise ValueError(f"Failed to create account: {exc}") from exc
