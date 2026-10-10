"""Internal /ai/v1 routes. The contract is packages/contracts/openapi/ai.v1.yaml."""

from fastapi import APIRouter, Depends

from caseguard_ai import __version__
from caseguard_ai.security import require_service_token

router = APIRouter(prefix="/ai/v1", dependencies=[Depends(require_service_token)])


@router.get("/info")
def info() -> dict[str, str]:
    """Authenticated smoke-test endpoint: proves the API → AI token wiring works."""
    return {"service": "caseguard-ai", "version": __version__}
