"""プロセス内で共有する状態 (シングルプロセス FastAPI 前提)。

`session_id` (= UI 上の 1 セッション = 1 議題) を一意キーとして、 全状態を保持する。
セッションは作成時に `agent_id` (config.json AGENTS の key) を 1 つ持ち、
それによって cwd / 通知タイトル既定値などの定義を引く。 同じ agent_id を持つ
セッションは複数同時に存在できる (= 同じ作業ディレクトリで複数議題を並行で持てる)。

- セッション定義 (`sessions_meta`): 永続化、 session_meta.json
- ストリームごとの SDK 接続状態 (`stream_states`)
- ステータスキャッシュ (`agent_status`, `shared_status`)
- claude セッション ID の永続化 (`sessions` + `save_sessions`): session_id → claude session_id
- ターン中の assistant text (`last_assistant_text`)
- 通知抑止用フラグ (`flags["user_visible"]`)

異なるモジュールから書き換えたい値は dict や dataclass にラップして
import 越しに mutate できる形にしている。
"""
import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from claude_agent_sdk import ClaudeSDKClient

from config import AGENTS

# --- 永続化パス ---
SESSIONS_PATH = Path(__file__).parent / "sessions.json"
SESSION_META_PATH = Path(__file__).parent / "session_meta.json"


# --- セッション定義 (= UI 上の 1 タブ) ---
@dataclass
class SessionDef:
    id: str
    agent_id: str
    title: str
    created_at: int

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "agent_id": self.agent_id,
            "title": self.title,
            "created_at": self.created_at,
        }


def _default_title(agent_id: str, index: int) -> str:
    cfg = AGENTS.get(agent_id) or {}
    base = cfg.get("display_name") or agent_id.upper()
    return f"{base}-{index}"


def _new_session_id() -> str:
    return f"ses_{uuid.uuid4().hex[:12]}"


def _load_sessions_meta_and_claude_sessions() -> tuple[dict[str, SessionDef], dict[str, str | None]]:
    """session_meta.json + sessions.json をロード。 旧 sessions.json (agent_id キー) を
    検出した場合は agent ごと 1 セッションをマイグレーションして両ファイルを書き換える。
    """
    meta_raw: list[dict] | None = None
    sessions_raw: dict | None = None

    if SESSION_META_PATH.exists():
        try:
            meta_raw = json.loads(SESSION_META_PATH.read_text())
        except Exception:
            meta_raw = None
    if SESSIONS_PATH.exists():
        try:
            sessions_raw = json.loads(SESSIONS_PATH.read_text())
        except Exception:
            sessions_raw = None

    sessions_meta: dict[str, SessionDef] = {}
    claude_sessions: dict[str, str | None] = {}

    if meta_raw and isinstance(meta_raw, list):
        # 通常パス: session_meta.json に従う
        for entry in meta_raw:
            if not isinstance(entry, dict):
                continue
            sid = entry.get("id")
            aid = entry.get("agent_id")
            title = entry.get("title") or aid or "session"
            created = entry.get("created_at") or int(time.time())
            if not sid or aid not in AGENTS:
                continue
            sessions_meta[sid] = SessionDef(
                id=sid, agent_id=aid, title=title, created_at=int(created)
            )
        if isinstance(sessions_raw, dict):
            # 後方互換マップ: sessions.json が旧形式 (agent_id キー) のままだった場合、
            # session_meta の各 entry の agent_id をキーに引いて claude session_id を救出する。
            # 同 agent_id を持つ session_meta entry が 2 つ以上ある場合は最初の 1 つだけ拾う
            # (重複は事実上発生しない、 マイグレーション直後のみ意味を持つ)。
            legacy_consumed: set[str] = set()
            for sid, meta in sessions_meta.items():
                v = sessions_raw.get(sid)
                if isinstance(v, str):
                    claude_sessions[sid] = v
                    continue
                aid = meta.agent_id
                if aid in sessions_raw and aid not in legacy_consumed:
                    legacy_v = sessions_raw.get(aid)
                    if isinstance(legacy_v, str):
                        claude_sessions[sid] = legacy_v
                        legacy_consumed.add(aid)
                        continue
                claude_sessions[sid] = None
            # 救出が走ったら新形式で書き戻す (次回以降の loader は通常パスで済む)
            if legacy_consumed:
                _persist_sessions(claude_sessions)
        else:
            for sid in sessions_meta:
                claude_sessions[sid] = None
    else:
        # マイグレーション or 初期化: agent ごと 1 セッションを生成する
        legacy = sessions_raw if isinstance(sessions_raw, dict) else {}
        per_agent_idx: dict[str, int] = {}
        now = int(time.time())
        for agent_id in AGENTS:
            sid = _new_session_id()
            per_agent_idx[agent_id] = per_agent_idx.get(agent_id, 0) + 1
            sessions_meta[sid] = SessionDef(
                id=sid,
                agent_id=agent_id,
                title=_default_title(agent_id, per_agent_idx[agent_id]),
                created_at=now,
            )
            v = legacy.get(agent_id)
            claude_sessions[sid] = v if isinstance(v, str) else None
        # 永続化 (起動時 1 回のみ)
        _persist_meta(sessions_meta)
        _persist_sessions(claude_sessions)

    return sessions_meta, claude_sessions


def _persist_meta(meta: dict[str, SessionDef]) -> None:
    SESSION_META_PATH.write_text(
        json.dumps(
            [m.to_dict() for m in meta.values()],
            ensure_ascii=False,
            indent=2,
        )
    )


def _persist_sessions(claude_sessions: dict[str, str | None]) -> None:
    SESSIONS_PATH.write_text(json.dumps(claude_sessions, ensure_ascii=False))


def save_sessions_meta() -> None:
    _persist_meta(sessions_meta)


def save_sessions() -> None:
    _persist_sessions(sessions)


sessions_meta, sessions = _load_sessions_meta_and_claude_sessions()


# --- ストリーム状態 ---
@dataclass
class StreamState:
    agent_id: str = ""  # どの AGENTS 設定 (cwd / notification_title) を参照するか
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
    # 直近 POST が発行した user_request_id。wire イベントに付与してフロントが
    # 「ユーザー起点 ResultMessage」と「自発 ResultMessage」を区別できるようにする。
    user_request_id: str | None = None


def _make_agent_status(agent_id: str) -> dict:
    cfg = AGENTS.get(agent_id) or {}
    return {
        "ctx_pct": 0,
        "ctx_window": 1_000_000,
        "model": cfg.get("model", ""),
        "plan_mode": False,
        "current_tool": None,
        "todos": None,
        "subagent": None,
    }


stream_states: dict[str, StreamState] = {
    sid: StreamState(agent_id=meta.agent_id) for sid, meta in sessions_meta.items()
}

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
    sid: _make_agent_status(meta.agent_id) for sid, meta in sessions_meta.items()
}

# --- ターン中 assistant text 蓄積 (通知 body 用) ---
last_assistant_text: dict[str, str] = {sid: "" for sid in sessions_meta}

# --- グローバルフラグ (mutate 越し import 用に dict ラップ) ---
flags: dict = {"user_visible": False}


# --- セッション操作ヘルパ ---
def register_session(agent_id: str, title: str | None = None) -> SessionDef:
    """新規セッションを登録して全状態 dict を初期化する。 永続化まで行う。"""
    if agent_id not in AGENTS:
        raise ValueError(f"Unknown agent_id: {agent_id}")
    sid = _new_session_id()
    if not title:
        existing_count = sum(1 for m in sessions_meta.values() if m.agent_id == agent_id)
        title = _default_title(agent_id, existing_count + 1)
    meta = SessionDef(
        id=sid, agent_id=agent_id, title=title, created_at=int(time.time())
    )
    sessions_meta[sid] = meta
    stream_states[sid] = StreamState(agent_id=agent_id)
    agent_status[sid] = _make_agent_status(agent_id)
    last_assistant_text[sid] = ""
    sessions[sid] = None
    save_sessions_meta()
    save_sessions()
    return meta


def unregister_session(session_id: str) -> bool:
    """セッションを完全削除。 SDK client の disconnect は呼び出し側責任。"""
    if session_id not in sessions_meta:
        return False
    sessions_meta.pop(session_id, None)
    stream_states.pop(session_id, None)
    agent_status.pop(session_id, None)
    last_assistant_text.pop(session_id, None)
    sessions.pop(session_id, None)
    session_tmp_files.pop(session_id, None)
    save_sessions_meta()
    save_sessions()
    return True


def rename_session(session_id: str, title: str) -> bool:
    if session_id not in sessions_meta or not title:
        return False
    sessions_meta[session_id].title = title
    save_sessions_meta()
    return True


# --- 共通ヘルパ ---
def reset_activity(session_id: str) -> None:
    if session_id not in agent_status:
        return
    agent_status[session_id]["current_tool"] = None
    agent_status[session_id]["subagent"] = None


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


def update_agent_from_result(session_id: str, model_usage: dict | None, last_assistant_usage: dict | None) -> None:
    if not model_usage or session_id not in agent_status:
        return
    model_key = next(iter(model_usage), None)
    if not model_key:
        return
    agent_status[session_id]["model"] = format_model_name(model_key)
    ctx_window = (
        model_usage[model_key].get("contextWindow")
        or agent_status[session_id].get("ctx_window")
        or 1_000_000
    )
    agent_status[session_id]["ctx_window"] = ctx_window
    if last_assistant_usage:
        agent_status[session_id]["ctx_pct"] = compute_ctx_pct(last_assistant_usage, ctx_window)
