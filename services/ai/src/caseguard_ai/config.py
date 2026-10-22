"""Settings, read from the environment, then services/ai/.env, then the repo-root .env."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVICE_DIR = Path(__file__).resolve().parents[2]
# In the repo: services/ai -> repo root. In the container (/app) there is no repo root.
_REPO_ROOT = _SERVICE_DIR.parents[1] if len(_SERVICE_DIR.parents) > 1 else _SERVICE_DIR


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Later files win, and real environment variables beat both.
        env_file=(_REPO_ROOT / ".env", _SERVICE_DIR / ".env"),
        extra="ignore",
    )

    ai_service_token: SecretStr
    ai_database_url: str = "postgresql://caseguard_ai@localhost:5432/caseguard"
    log_level: str = "INFO"

    # Model gateway (ADR-0005): any OpenAI-compatible endpoint, one per role.
    # Presets for each provider are listed in .env.example.
    llm_generation_base_url: str = ""
    llm_generation_model: str = ""
    llm_generation_api_key: SecretStr = SecretStr("")
    llm_judge_base_url: str = ""
    llm_judge_model: str = ""
    llm_judge_api_key: SecretStr = SecretStr("")

    @property
    def psycopg_dsn(self) -> str:
        """AI_DATABASE_URL may use the SQLAlchemy form (postgresql+psycopg://); psycopg wants plain."""
        return self.ai_database_url.replace("postgresql+psycopg://", "postgresql://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # required fields come from the environment
