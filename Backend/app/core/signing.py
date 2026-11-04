"""
DocFlow Backend — Core: Document Digital Signatures

Requirements report §6.4 ("Digital signatures and cryptographic integrity"):
  - Use a standard, reviewed digital-signature scheme, never a custom
    algorithm. We use RSA-PSS with SHA-256 (PSS/MGF1-SHA256,
    salt_length == digest_size) via the `cryptography` library — the same
    well-reviewed backend python-jose already depends on for this app's
    RS256 JWTs (see app/core/security.py).
  - A signature binds: approver identity, the exact document version (by
    content hash), the decision, the timestamp, and the workflow step.
  - Private keys are never stored in an application table and never sent to
    the frontend — they live only in this process, sourced from an env var
    (production) or generated in-memory for local development (never
    persisted). Mirrors the JWT_PRIVATE_KEY pattern in app/core/security.py.
  - Signatures and the data they cover must be independently verifiable
    later (tamper detection) using only the public key.

Canonicalization: the signed payload is a JSON object with sorted keys and
no insignificant whitespace (`json.dumps(..., sort_keys=True,
separators=(",", ":"))`), so the exact same payload always serializes to
the exact same bytes for both signing and verification.
"""
from __future__ import annotations

import base64
import hashlib
import json
from functools import lru_cache
from typing import Any

import structlog
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.config import settings

logger = structlog.get_logger(__name__)

ALGORITHM = "RSA-PSS-SHA256"


def _canonical_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def payload_hash(payload: dict[str, Any]) -> str:
    """SHA-256 hex digest of the canonicalized payload — stored alongside
    the signature so a verifier can confirm WHAT was signed without having
    to reconstruct it, and so any later tampering with the stored payload
    itself is independently detectable."""
    return hashlib.sha256(_canonical_bytes(payload)).hexdigest()


@lru_cache(maxsize=1)
def _load_or_generate_keypair() -> tuple[rsa.RSAPrivateKey, rsa.RSAPublicKey, bool]:
    """
    Returns (private_key, public_key, is_ephemeral_dev_key).

    Production MUST set DOCUMENT_SIGNING_PRIVATE_KEY (PEM, PKCS8, unencrypted
    at rest is acceptable only if the deployment's secret store already
    encrypts the env var at rest — settings.validate_production() enforces
    this is actually configured). Without it, a fresh RSA-2048 keypair is
    generated in-process for local development ONLY — it is never written
    to disk or the database, and it changes every process restart, so
    signatures created before a restart won't re-verify after one. That is
    an acceptable, clearly-logged dev-only limitation; production always
    configures a stable key.
    """
    pem = settings.DOCUMENT_SIGNING_PRIVATE_KEY
    if pem and "PLACEHOLDER" not in pem:
        private_key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
        if not isinstance(private_key, rsa.RSAPrivateKey):
            raise ValueError("DOCUMENT_SIGNING_PRIVATE_KEY must be an RSA key")
        return private_key, private_key.public_key(), False

    logger.warning(
        "document_signing_key_not_configured",
        detail=(
            "DOCUMENT_SIGNING_PRIVATE_KEY is not set — generating an ephemeral "
            "RSA-2048 keypair for this process only. Signatures will NOT "
            "verify after a restart. Set DOCUMENT_SIGNING_PRIVATE_KEY/"
            "DOCUMENT_SIGNING_PUBLIC_KEY (PEM) before deploying to production."
        ),
    )
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key(), True


def _pss_padding() -> padding.AsymmetricPadding:
    return padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH)


def key_id() -> str:
    """
    Stable identifier for the current public key — SHA-256 of its DER
    encoding, hex, truncated to 16 chars. Lets verification later confirm
    WHICH key a signature was made with (supports future key rotation
    without ambiguity about which public key to check against).
    """
    _, public_key, _ = _load_or_generate_keypair()
    der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return hashlib.sha256(der).hexdigest()[:16]


def public_key_pem() -> str:
    """The current public key, PEM-encoded — safe to expose (e.g. for an
    external auditor to independently verify a signature)."""
    _, public_key, _ = _load_or_generate_keypair()
    return public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")


def sign_payload(payload: dict[str, Any]) -> dict[str, str]:
    """
    Sign a canonicalized payload with RSA-PSS-SHA256.

    Returns a dict with everything needed to independently re-verify later:
    {signature, algorithm, key_id, payload_hash}. The caller persists this
    alongside the payload itself (see DigitalSignature model).
    """
    private_key, _, is_ephemeral = _load_or_generate_keypair()
    data = _canonical_bytes(payload)
    signature = private_key.sign(data, _pss_padding(), hashes.SHA256())
    return {
        "signature": base64.b64encode(signature).decode("ascii"),
        "algorithm": ALGORITHM,
        "key_id": key_id(),
        "payload_hash": hashlib.sha256(data).hexdigest(),
        "is_dev_ephemeral_key": is_ephemeral,
    }


def verify_signature(payload: dict[str, Any], signature_b64: str, expected_key_id: str) -> bool:
    """
    Verify a signature against the CURRENT process key. Returns False (not
    an exception) on any mismatch — tampering, wrong key, or corrupted
    signature all just mean "not valid" to the caller.
    """
    if expected_key_id != key_id():
        # Signed with a key this process doesn't hold — can't verify it
        # (expected after key rotation without a historical key registry;
        # treat conservatively as unverifiable rather than silently passing).
        return False
    _, public_key, _ = _load_or_generate_keypair()
    data = _canonical_bytes(payload)
    try:
        public_key.verify(base64.b64decode(signature_b64), data, _pss_padding(), hashes.SHA256())
        return True
    except (InvalidSignature, ValueError):
        return False
