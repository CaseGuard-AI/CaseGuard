"""Settings, read from the environment, then services/ai/.env, then the repo-root .env."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVICE_DIR = Path(__file__).resolve().parents[2]
# In the repo: services/ai -> repo root. In the container (/app) there is no repo root.
_REPO_ROOT = _SERVICE_DIR.parents[1] if len(_SERVICE_DIR.parents) > 1 else _SERVICE_DIR


_ENV = SettingsConfigDict(
    # Later files win, and real environment variables beat both.
    env_file=(_REPO_ROOT / ".env", _SERVICE_DIR / ".env"),
    extra="ignore",
)


def _sqlalchemy_url(url: str) -> str:
    """SQLAlchemy needs the psycopg (v3) driver named; a plain postgresql:// would pick psycopg2."""
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url.removeprefix("postgresql://")
    return url


class EmbeddingSettings(BaseSettings):
    """The in-process models (ADR-0008), pinned to a revision so every machine builds and queries
    the same corpus. corpus.corpus_meta records what a corpus was built with (#18)."""

    model_config = _ENV

    embedding_model: str = "BAAI/bge-m3"
    embedding_revision: str = "5617a9f61b028005a4858fdac845db406aefb181"
    embedding_device: str = ""  # empty = CUDA if torch has a GPU, else CPU
    embedding_batch_size: int = 16
    reranker_model: str = "BAAI/bge-reranker-v2-m3"
    reranker_revision: str = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
    # The citation support check (FR-TRUST-3, PRD §7.1 step 2): a multilingual NLI cross-encoder,
    # with the LLM judge only when it is inconclusive (trust/support.py).
    support_model: str = "MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7"
    support_revision: str = "b5113eb38ab63efdd7f280f8c144ea8b13f978ce"
    # TBD-13: defaults until they are calibrated on the development set (PRD §7.2, §11).
    support_pass_threshold: float = 0.7  # P(entailment) at or above this → pass
    support_fail_threshold: float = 0.7  # P(contradiction) at or above this → fail
    support_llm_fallback: bool = True  # ask the judge role when NLI is uncertain (if allowed)


class DatabaseSettings(BaseSettings):
    """Only the database URL, for tools that run without the service token (Alembic, loaders)."""

    model_config = _ENV

    ai_database_url: str = "postgresql://caseguard_ai@localhost:5432/caseguard"

    @property
    def sqlalchemy_url(self) -> str:
        return _sqlalchemy_url(self.ai_database_url)


class HubSettings(BaseSettings):
    """The private Hugging Face dataset that holds corpus dumps (#154). Never log the token."""

    model_config = _ENV

    hf_token: SecretStr = SecretStr("")  # empty: use the `hf auth login` token
    hf_corpus_repo: str = "caseguard/corpus"


class IngestSettings(EmbeddingSettings, DatabaseSettings):
    """For the ingestion jobs: the database and the embedding model, no service token."""


class Settings(EmbeddingSettings):
    model_config = _ENV

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
    # The ai.v1 ProviderId of each role's endpoint (nvidia-nim, gemini, groq, openrouter, openai,
    # anthropic, ollama). Empty = inferred from the base URL. A request may only use a provider
    # that the api lists in allowedProviders (SEC-11).
    llm_generation_provider: str = ""
    llm_judge_provider: str = ""
    # Local fallback, reachable under every allow-list that includes "ollama" (and the default).
    ollama_base_url: str = ""
    ollama_model: str = ""

    # FR-TRUST-6: a corpus source last retrieved longer ago than this is flagged "stale".
    # 180 days is the review window TBD-13 settled on (PRD §18).
    trust_stale_days: int = 180

    @property
    def sqlalchemy_url(self) -> str:
        return _sqlalchemy_url(self.ai_database_url)

    @property
    def psycopg_dsn(self) -> str:
        """AI_DATABASE_URL may use the SQLAlchemy form (postgresql+psycopg://); psycopg wants plain."""
        return self.ai_database_url.replace("postgresql+psycopg://", "postgresql://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # required fields come from the environment
