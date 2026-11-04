"""
DocFlow Backend — Core: TLS trust store.

Python's `ssl` module defaults to the bundled certifi roots, which do NOT
include a private/corporate root CA. On a network that terminates TLS with
its own root (corporate proxy, zscaler-style inspection, some CI sandboxes)
every outbound HTTPS call then fails with:

    CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate

even though the machine itself trusts that root — Windows/macOS keep it in
the OS certificate store, which Python ignores by default. This was
reproduced in this project's own environment: `pip` worked (it has its own
trust handling) while httpx calls to the Gemini API failed.

`truststore` makes Python use the OS certificate store, so the private root
is honoured exactly as the rest of the machine honours it. Verification stays
fully ON — this is the opposite of `verify=False`, which would accept any
certificate from anyone.

Called once at startup. Safe and effectively a no-op on machines whose OS
store matches the public roots.
"""
from __future__ import annotations

import structlog

logger = structlog.get_logger(__name__)

_injected = False


def ensure_os_trust_store() -> bool:
    """
    Route Python's TLS verification through the OS certificate store.

    Idempotent. Returns True if the OS store is in use, False if the
    `truststore` package isn't installed (in which case the default certifi
    bundle keeps being used — fine on a network without TLS interception).
    """
    global _injected
    if _injected:
        return True

    from app.config import settings

    if not getattr(settings, "SSL_USE_OS_TRUST_STORE", True):
        return False

    import sys
    # Python 3.12+ compatibility: truststore.inject_into_ssl() monkey-patches
    # ssl.SSLContext in a way that breaks Python 3.12's `options` setter
    # (ssl.py:562 super(SSLContext, SSLContext).options.__set__ enters infinite
    # recursion when botocore/boto3 creates its urllib3 SSL context).
    if sys.version_info >= (3, 12):
        logger.info(
            "os_trust_store_skipped_py312",
            detail="Skipping global truststore injection on Python 3.12+ to prevent botocore SSLContext recursion",
        )
        return False

    try:
        import truststore
    except ImportError:
        logger.info(
            "os_trust_store_unavailable",
            detail=(
                "truststore is not installed; using the bundled certifi roots. "
                "If outbound HTTPS fails with CERTIFICATE_VERIFY_FAILED behind a "
                "TLS-inspecting proxy, `pip install truststore` or set "
                "AI_CA_BUNDLE to your proxy's root CA."
            ),
        )
        return False

    truststore.inject_into_ssl()
    _injected = True
    logger.info("os_trust_store_enabled")
    return True
