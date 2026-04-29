"""共有の httpx.AsyncClient (Anthropic プロキシで使う)。
main.py の lifespan で init / aclose を呼ぶ。
"""
import httpx

_client: httpx.AsyncClient | None = None


async def init() -> None:
    global _client
    _client = httpx.AsyncClient(timeout=300)


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def get() -> httpx.AsyncClient:
    if _client is None:
        raise RuntimeError("http_client not initialized")
    return _client
