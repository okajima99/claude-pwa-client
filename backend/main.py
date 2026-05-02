"""FastAPI app のエントリポイント。
ロギング初期化 → ルータ登録 → 静的ファイル配信、を組み立てるだけ。
ビジネスロジックは下記の責務別モジュールに分かれている:

- config.py        設定 / 定数
- state.py         プロセス共有状態
- http_client.py   共通 httpx クライアント
- sdk_runner.py    Claude Agent SDK 駆動
- chat_routes.py   チャット送受信エンドポイント
- files_routes.py  ファイル系エンドポイント
- proxy_routes.py  Anthropic プロキシ
- push.py          Web Push 配信 + エンドポイント
"""
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# --- ロギング初期化 (各モジュール import より前) ---
ERROR_LOG_PATH = Path(__file__).parent.parent / "logs" / "backend.error.log"
logging.basicConfig(
    filename=str(ERROR_LOG_PATH),
    level=logging.ERROR,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# --- アプリ内モジュール ---
import http_client  # noqa: E402
from config import UPLOADS_TMP  # noqa: E402
from sdk_runner import disconnect_client, idle_disconnect_loop  # noqa: E402
from session_logging import prune_all_existing  # noqa: E402
from state import sessions_meta, stream_states  # noqa: E402

import chat_routes  # noqa: E402
import files_routes  # noqa: E402
import proxy_routes  # noqa: E402
import push  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 起動: 共有 httpx クライアント初期化 + 古い tmp ファイル / 大きすぎるエラーログを掃除
    await http_client.init()

    # アイドル GC: 一定時間発話のないセッションの SDK client を自動 disconnect する
    import asyncio as _asyncio
    idle_gc_task = _asyncio.create_task(idle_disconnect_loop())

    cutoff = time.time() - 24 * 3600
    if UPLOADS_TMP.exists():
        for f in UPLOADS_TMP.iterdir():
            if f.is_file() and f.stat().st_mtime < cutoff:
                try:
                    f.unlink(missing_ok=True)
                except Exception:
                    pass
    if ERROR_LOG_PATH.exists() and ERROR_LOG_PATH.stat().st_size > 10 * 1024 * 1024:
        try:
            ERROR_LOG_PATH.write_text("")
        except Exception:
            pass

    # per-tab ログ: 既存セッションぶんの掃除を起動時に 1 回走らせる
    # (セッション終了で都度 prune する設計だが、 取りこぼし対策として保険で実行)
    try:
        prune_all_existing(list(sessions_meta.keys()))
    except Exception:
        logger.exception("prune_all_existing failed")

    yield

    # 終了: アイドル GC 停止 → SDK クライアントを全て切断 → httpx を閉じる
    idle_gc_task.cancel()
    try:
        await idle_gc_task
    except (Exception, BaseException):
        pass
    for session_id in list(stream_states.keys()):
        await disconnect_client(session_id)
    await http_client.aclose()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_routes.router)
app.include_router(files_routes.router)
app.include_router(proxy_routes.router)
app.include_router(push.router)


# --- 静的ファイル配信 (Vite ビルド成果物) ---
FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


class CacheControlledStaticFiles(StaticFiles):
    """index.html / manifest.json / sw.js は no-cache、ハッシュ付き assets は immutable で長期キャッシュ。

    iOS Safari (PWA) はデフォルトで Cache-Control 無しレスポンスを長時間キャッシュするため、
    index.html が古いままになり Vite の新しいハッシュ付き assets ファイルを参照できなくなる。
    エントリポイント (= index.html / manifest.json / sw.js) だけ毎回鮮度確認させ、
    /assets/ 配下はファイル名にハッシュが入っているので永久キャッシュして問題ない。
    """

    NO_CACHE_PATHS = {"index.html", "manifest.json", "sw.js"}
    IMMUTABLE_PREFIX = "assets/"

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        normalized = path.lstrip("/")
        if normalized in self.NO_CACHE_PATHS or normalized in ("", "."):
            response.headers["Cache-Control"] = "no-cache"
        elif normalized.startswith(self.IMMUTABLE_PREFIX):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if FRONTEND_DIST.exists():
    app.mount(
        "/",
        CacheControlledStaticFiles(directory=str(FRONTEND_DIST), html=True),
        name="frontend",
    )
