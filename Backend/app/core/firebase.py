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


async def verify_firebase_token(id_token: str) -> dict:
    """
    Verify a Firebase ID token and return the decoded claims.

    Returns:
        dict with: uid, email, email_verified, name, picture, ...

    Raises:
        ValueError: If token is invalid or Firebase is not initialized.
    """
    if not _firebase_app:
        raise ValueError("Firebase is not configured on this server")

    from firebase_admin import auth as firebase_auth

    try:
        decoded = firebase_auth.verify_id_token(id_token, check_revoked=True)
        return {
            "uid": decoded["uid"],
            "email": decoded.get("email", ""),
            "email_verified": decoded.get("email_verified", False),
            "name": decoded.get("name"),
            "picture": decoded.get("picture"),
            "sign_in_provider": decoded.get("firebase", {}).get("sign_in_provider"),
        }
    except firebase_auth.RevokedIdTokenError:
        raise ValueError("Firebase token has been revoked")
    except firebase_auth.UserDisabledError:
        raise ValueError("Firebase user account is disabled")
    except firebase_auth.InvalidIdTokenError as exc:
        raise ValueError(f"Invalid Firebase token: {exc}")
