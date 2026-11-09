"""TLS trust for outbound requests.

Some government hosts send an incomplete or wrong certificate chain. pakistancode.gov.pk
serves "GoGetSSL RSA DV SSL CA 2" where its leaf was issued by "GoGetSSL RSA DV CA", so a
strict client can't build a path to a root (#147). Browsers repair this through the AIA URL;
httpx and urllib don't.

The fix is to *add* the missing intermediate (``certs/extra-intermediates.pem``) next to
certifi's roots. The chain must still end at a trusted root, so nothing is weakened.
Verification is never turned off here.
"""

from __future__ import annotations

import ssl
from functools import lru_cache
from pathlib import Path

import certifi

EXTRA_INTERMEDIATES = Path(__file__).resolve().parent.parent / "certs" / "extra-intermediates.pem"


@lru_cache(maxsize=1)
def ssl_context() -> ssl.SSLContext:
    """certifi's roots plus the bundled intermediates. Hostname checks and verification stay on."""
    context = ssl.create_default_context(cafile=certifi.where())
    context.load_verify_locations(cafile=str(EXTRA_INTERMEDIATES))
    return context
