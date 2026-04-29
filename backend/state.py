"""プロセス内で共有する状態 (シングルプロセス FastAPI 前提)。

- ストリームごとの SDK 接続状態 (`stream_states`)
- ステータスキャッシュ (`agent_status`, `shared_status`)
- セッション ID の永続化 (`sessions` + `save_sessions`)
- ターン中の assistant text (`last_assistant_text`)
- 通知抑止用フラグ (`flags["user_visible"]`)

異なるモジュールから書き換えたい値は dict や dataclass にラップして
import 越しに mutate できる形にしている。
"""
import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from claude_agent_sdk import ClaudeSDKClient

from config import AGENTS

# --- セッション ID 永続化 ---
SESSIONS_PATH = Path(__file__).parent / "sessions.json"


def _load_sessions() -> dict[str, str | None]:
    if SESSIONS_PATH.exists():
        try:
            data = json.loads(SESSIONS_PATH.read_text())
            return {name: data.get(name) for name in AGENTS}
        except Exception:
            pass
    return {name: None for name in AGENTS}


def save_sessions() -> None:
    SESSIONS_PATH.write_text(json.dumps(sessions))


sessions: dict[str, str | None] = _load_sessions()


# --- ストリーム状態 ---
@dataclass
class StreamState:
    buffer: list[str] = field(default_factory=list)
    buffer_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    task: asyncio.Task | None = None
    complete: bool = True
    client: ClaudeSDKClient | None = None
    client_session_id: str | None = None
    pending_question: asyncio.Future | None = None
    pending_question_tool_id: str | None = None
    # /stop や新ターン割り込みで tool_use が宙ぶらりんになった場合の id。
    # 次の /stream で synthetic tool_result を先頭に入れて履歴を閉じる。
    orphaned_tool_use_id: str | None = None


stream_states: dict[str, StreamState] = {name: StreamState() for name in AGENTS}

# --- セッションごとの一時ファイル ---
session_tmp_files: dict[str, list[Path]] = {}

# --- ステータスキャッシュ ---
shared_status: dict = {
    "five_hour_pct": 0,
    "seven_day_pct": 0,
    "five_hour_resets_at": 0,
    "seven_day_resets_at": 0,
}

agent_status: dict[str, dict] = {
    name: {
        "ctx_pct": 0,
        "ctx_window": 1_000_000,
        "model": cfg.get("model", ""),
        "plan_mode": False,
        "current_tool": None,
        "todos": None,
        "subagent": None,
    }
    for name, cfg in AGENTS.items()
}

# --- ターン中 assistant text 蓄積 (通知 body 用) ---
last_assistant_text: dict[str, str] = {name: "" for name in AGENTS}

# --- グローバルフラグ (mutate 越し import 用に dict ラップ) ---
flags: dict = {"user_visible": False}


# --- 共通ヘルパ ---
def reset_activity(agent: str) -> None:
    agent_status[agent]["current_tool"] = None
    agent_status[agent]["subagent"] = None


def update_shared_from_headers(headers) -> None:
    """Anthropic API のレスポンスヘッダから rate-limit を吸い出して shared_status へ。"""
    five_h = headers.get("anthropic-ratelimit-unified-5h-utilization")
    seven_d = headers.get("anthropic-ratelimit-unified-7d-utilization")
    five_h_reset = headers.get("anthropic-ratelimit-unified-5h-resets-at")
    seven_d_reset = headers.get("anthropic-ratelimit-unified-7d-resets-at")

    if five_h is not None:
        try:
            shared_status["five_hour_pct"] = round(float(five_h) * 100)
        except ValueError:
            pass
    if seven_d is not None:
        try:
            shared_status["seven_day_pct"] = round(float(seven_d) * 100)
        except ValueError:
            pass
    if five_h_reset is not None:
        try:
            dt = datetime.fromisoformat(five_h_reset.replace("Z", "+00:00"))
            shared_status["five_hour_resets_at"] = int(dt.timestamp())
        except Exception:
            pass
    if seven_d_reset is not None:
        try:
            dt = datetime.fromisoformat(seven_d_reset.replace("Z", "+00:00"))
            shared_status["seven_day_resets_at"] = int(dt.timestamp())
        except Exception:
            pass


def compute_ctx_pct(usage: dict, ctx_window: int = 1_000_000) -> int:
    if not usage or ctx_window <= 0:
        return 0
    total = (
        usage.get("input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
    )
    return min(round(total / ctx_window * 100), 100)


def format_model_name(key: str) -> str:
    key = key.replace("claude-", "")
    parts = key.split("-")
    if len(parts) >= 3:
        name = parts[0].capitalize()
        version = ".".join(parts[1:])
        return f"{name} {version}"
    return key.capitalize()


def update_agent_from_result(agent: str, model_usage: dict | None, last_assistant_usage: dict | None) -> None:
    if not model_usage:
        return
    model_key = next(iter(model_usage), None)
    if not model_key:
        return
    agent_status[agent]["model"] = format_model_name(model_key)
    ctx_window = model_usage[model_key].get("contextWindow") or agent_status[agent].get("ctx_window") or 1_000_000
    agent_status[agent]["ctx_window"] = ctx_window
    if last_assistant_usage:
        agent_status[agent]["ctx_pct"] = compute_ctx_pct(last_assistant_usage, ctx_window)
