import asyncio
import base64
import json
import logging
import mimetypes
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List

import httpx
from contextlib import asynccontextmanager
from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

try:
    from pywebpush import WebPushException, webpush
    _HAS_WEBPUSH = True
except ImportError:
    _HAS_WEBPUSH = False

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    RateLimitEvent,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny

HOME = Path.home()
ERROR_LOG_PATH = Path(__file__).parent.parent / "logs" / "backend.error.log"

logging.basicConfig(
    filename=str(ERROR_LOG_PATH),
    level=logging.ERROR,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# --- 設定読み込み ---
CONFIG_PATH = Path(__file__).parent / "config.json"
with open(CONFIG_PATH) as f:
    config = json.load(f)

AGENTS = config["agents"]
# uploads_tmp は config.json で上書き可能。デフォルトは ~/.claude-pwa-client/uploads/tmp
UPLOADS_TMP = Path(config.get("uploads_tmp", str(HOME / ".claude-pwa-client" / "uploads" / "tmp"))).expanduser()
ANTHROPIC_API_BASE = "https://api.anthropic.com"

SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# --- httpx クライアント（プロキシ用） ---
http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app):
    global http_client
    http_client = httpx.AsyncClient(timeout=300)

    # 起動時クリーンアップ: 24時間以上前のtmpファイルを削除
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

    yield

    # SDK クライアントを全て切断
    for agent in list(stream_states.keys()):
        state = stream_states[agent]
        if state.client is not None:
            try:
                await state.client.disconnect()
            except Exception:
                logger.exception("disconnect failed for agent=%s", agent)
            state.client = None

    await http_client.aclose()
    http_client = None


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Web Push (VAPID + subscriptions) ---
VAPID_PATH = Path(__file__).parent / "vapid.json"
SUBSCRIPTIONS_PATH = Path(__file__).parent / "subscriptions.json"


def _load_vapid() -> dict | None:
    if not VAPID_PATH.exists():
        return None
    try:
        return json.loads(VAPID_PATH.read_text())
    except Exception:
        logger.exception("Failed to parse vapid.json")
        return None


def _load_subscriptions() -> list[dict]:
    if not SUBSCRIPTIONS_PATH.exists():
        return []
    try:
        data = json.loads(SUBSCRIPTIONS_PATH.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_subscriptions() -> None:
    SUBSCRIPTIONS_PATH.write_text(json.dumps(subscriptions, indent=2))


vapid_config: dict | None = _load_vapid()
subscriptions: list[dict] = _load_subscriptions()
# VAPID claim の sub (連絡先) は config.json で上書き可。デフォルトは汎用 mailto
VAPID_SUB = config.get("vapid_sub", "mailto:admin@example.com")
# OS 通知のタイトル (バナー / ロック画面に出る見出し)
NOTIFICATION_TITLE = config.get("notification_title", "Notification")


# --- セッション管理 ---
SESSIONS_PATH = Path(__file__).parent / "sessions.json"


def _load_sessions() -> dict[str, str | None]:
    if SESSIONS_PATH.exists():
        try:
            data = json.loads(SESSIONS_PATH.read_text())
            return {name: data.get(name) for name in AGENTS}
        except Exception:
            pass
    return {name: None for name in AGENTS}


def _save_sessions() -> None:
    SESSIONS_PATH.write_text(json.dumps(sessions))


sessions: dict[str, str | None] = _load_sessions()


# --- ストリーム状態（エージェントごと） ---
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

# --- セッションごとの一時ファイル管理 ---
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
        "ctx_window": 1_000_000,   # Max プラン + Opus 前提。ResultMessage で上書き更新
        "model": cfg.get("model", ""),
        "plan_mode": False,
        "current_tool": None,   # {"name": str, "id": str, "started_at": float}
        "todos": None,          # list[{content, activeForm, status}]
        "subagent": None,       # {"description": str, "last_tool": str, "task_id": str}
    }
    for name, cfg in AGENTS.items()
}


def _reset_activity(agent: str) -> None:
    agent_status[agent]["current_tool"] = None
    agent_status[agent]["subagent"] = None


def _update_shared_from_headers(headers) -> None:
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
            from datetime import datetime
            dt = datetime.fromisoformat(five_h_reset.replace("Z", "+00:00"))
            shared_status["five_hour_resets_at"] = int(dt.timestamp())
        except Exception:
            pass
    if seven_d_reset is not None:
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(seven_d_reset.replace("Z", "+00:00"))
            shared_status["seven_day_resets_at"] = int(dt.timestamp())
        except Exception:
            pass


def _compute_ctx_pct(usage: dict, ctx_window: int = 1_000_000) -> int:
    if not usage or ctx_window <= 0:
        return 0
    total = (
        usage.get("input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
    )
    return min(round(total / ctx_window * 100), 100)


def _update_agent_from_result(agent: str, model_usage: dict | None, last_assistant_usage: dict | None) -> None:
    if not model_usage:
        return
    model_key = next(iter(model_usage), None)
    if not model_key:
        return
    agent_status[agent]["model"] = _format_model_name(model_key)
    ctx_window = model_usage[model_key].get("contextWindow") or agent_status[agent].get("ctx_window") or 1_000_000
    agent_status[agent]["ctx_window"] = ctx_window
    if last_assistant_usage:
        agent_status[agent]["ctx_pct"] = _compute_ctx_pct(last_assistant_usage, ctx_window)


def _format_model_name(key: str) -> str:
    key = key.replace("claude-", "")
    parts = key.split("-")
    if len(parts) >= 3:
        name = parts[0].capitalize()
        version = ".".join(parts[1:])
        return f"{name} {version}"
    return key.capitalize()


# --- ファイル一時保存 ---
async def save_to_tmp(files: list[UploadFile], agent: str) -> list[dict]:
    UPLOADS_TMP.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        if not f.size:
            continue
        ext = Path(f.filename or "file").suffix or ""
        dest = UPLOADS_TMP / f"{uuid.uuid4().hex}{ext}"
        data = await f.read()
        dest.write_bytes(data)
        session_tmp_files.setdefault(agent, []).append(dest)
        saved.append({
            "name": f.filename or dest.name,
            "path": str(dest),
            "mime": f.content_type or mimetypes.guess_type(f.filename or "")[0] or "",
        })
    return saved


def build_content(message: str, saved_files: list[dict]) -> list:
    content = []
    for sf in saved_files:
        mime = sf["mime"]
        path_obj = Path(sf["path"])
        if mime in SUPPORTED_IMAGE_TYPES:
            b64 = base64.b64encode(path_obj.read_bytes()).decode()
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": mime, "data": b64},
            })
            content.append({"type": "text", "text": f"[添付画像のパス: {sf['path']}]"})
        else:
            try:
                text_content = path_obj.read_text(errors="replace")
                content.append({
                    "type": "text",
                    "text": f"[添付ファイル: {sf['path']} ({sf['name']})]\n```\n{text_content}\n```",
                })
            except Exception:
                pass
    if message:
        content.append({"type": "text", "text": message})
    return content


# --- SDK メッセージ → CLI stream-json 互換 dict に変換 ---
def _block_to_dict(block: Any) -> dict:
    if isinstance(block, TextBlock):
        return {"type": "text", "text": block.text}
    if isinstance(block, ThinkingBlock):
        return {"type": "thinking", "thinking": block.thinking, "signature": block.signature}
    if isinstance(block, ToolUseBlock):
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    if isinstance(block, ToolResultBlock):
        return {
            "type": "tool_result",
            "tool_use_id": block.tool_use_id,
            "content": block.content,
            "is_error": block.is_error,
        }
    # 未知ブロックはそのまま
    return {"type": "unknown", "raw": str(block)}


def _serialize_sdk_message(msg: Any) -> dict | None:
    """SDK Message → フロント互換 JSON dict（CLI stream-json 形式）"""
    if isinstance(msg, AssistantMessage):
        return {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [_block_to_dict(b) for b in msg.content],
                "usage": msg.usage,
                "model": msg.model,
                "id": msg.message_id,
                "stop_reason": msg.stop_reason,
            },
            "parent_tool_use_id": msg.parent_tool_use_id,
            "session_id": msg.session_id,
            "uuid": msg.uuid,
        }
    if isinstance(msg, UserMessage):
        content = msg.content
        if isinstance(content, list):
            content = [_block_to_dict(b) for b in content]
        return {
            "type": "user",
            "message": {"role": "user", "content": content},
            "parent_tool_use_id": msg.parent_tool_use_id,
            "uuid": msg.uuid,
        }
    if isinstance(msg, ResultMessage):
        return {
            "type": "result",
            "subtype": msg.subtype,
            "session_id": msg.session_id,
            "num_turns": msg.num_turns,
            "duration_ms": msg.duration_ms,
            "duration_api_ms": msg.duration_api_ms,
            "is_error": msg.is_error,
            "total_cost_usd": msg.total_cost_usd,
            "usage": msg.usage,
            "modelUsage": msg.model_usage,  # 既存フロント/backend は camelCase
            "result": msg.result,
            "stop_reason": msg.stop_reason,
            "uuid": msg.uuid,
        }
    if isinstance(msg, SystemMessage):
        # TaskStartedMessage / TaskProgressMessage / TaskNotificationMessage は
        # SystemMessage のサブクラス。data dict を展開して top-level に出す。
        wire: dict = {"type": "system", "subtype": msg.subtype}
        if isinstance(msg.data, dict):
            for k, v in msg.data.items():
                if k not in wire:
                    wire[k] = v
        return wire
    if isinstance(msg, RateLimitEvent):
        info = msg.rate_limit_info
        rl_dict = {
            "status": info.status,
            "resetsAt": info.resets_at,
            "rateLimitType": info.rate_limit_type,
            "utilization": info.utilization,
        }
        if info.raw:
            for k, v in info.raw.items():
                rl_dict.setdefault(k, v)
        return {
            "type": "rate_limit_event",
            "rate_limit_info": rl_dict,
            "session_id": msg.session_id,
            "uuid": msg.uuid,
        }
    return None


# --- Web Push 配信 ---
async def _broadcast_push(message: str) -> None:
    """登録済みの全 Web Push サブスクリプションに通知を送る。

    アプリ起動中は SSE で proactive_notification が届くが、
    アプリ完全終了 / ロック画面の時は OS 通知として届けるためにこちらが必要。
    """
    if not _HAS_WEBPUSH or not vapid_config or not subscriptions:
        return

    private_pem = vapid_config.get("private_pem")
    if not private_pem:
        return

    payload = json.dumps({"title": NOTIFICATION_TITLE, "body": message or ""}, ensure_ascii=False)
    dead: list[dict] = []

    def _send_one(sub: dict) -> None:
        try:
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=private_pem,
                vapid_claims={"sub": VAPID_SUB},
                ttl=60,
            )
        except WebPushException as e:
            # 410 Gone / 404 → サブスクリプションが端末で破棄された、削除候補
            resp = getattr(e, "response", None)
            status = getattr(resp, "status_code", None)
            if status in (404, 410):
                dead.append(sub)
            else:
                logger.warning("webpush failed (status=%s): %s", status, e)
        except Exception:
            logger.exception("webpush send error")

    # pywebpush は同期 API なので thread pool に逃がす
    await asyncio.gather(*(asyncio.to_thread(_send_one, s) for s in list(subscriptions)))

    if dead:
        for d in dead:
            try:
                subscriptions.remove(d)
            except ValueError:
                pass
        _save_subscriptions()


# --- can_use_tool ハンドラ（エージェントごとにクロージャ） ---
def _make_permission_handler(agent: str):
    async def handler(tool_name: str, input_data: dict, context: Any):
        if tool_name != "AskUserQuestion":
            return PermissionResultAllow(updated_input=input_data)

        state = stream_states[agent]
        # 既存 Future が生きていたらキャンセル（通常は起きない）
        if state.pending_question is not None and not state.pending_question.done():
            state.pending_question.cancel()

        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()
        state.pending_question = future
        tool_use_id = getattr(context, "tool_use_id", None)
        state.pending_question_tool_id = tool_use_id

        # SSE にも明示的な ask_user_question イベントを積む（フロントが tool_use から
        # 検出するパスと並走。互換のため同じ情報を別タイプでも通知）
        state.buffer.append(
            "data: " + json.dumps({
                "type": "ask_user_question",
                "tool_use_id": tool_use_id,
                "input": input_data,
            }) + "\n\n"
        )

        try:
            answer = await future
        except asyncio.CancelledError:
            state.pending_question = None
            state.pending_question_tool_id = None
            return PermissionResultDeny(
                message="ユーザー応答待ちがキャンセルされました。",
                interrupt=True,
            )

        state.pending_question = None
        state.pending_question_tool_id = None
        return PermissionResultDeny(
            message=f"ユーザーの回答: {answer}",
            interrupt=False,
        )

    return handler


# --- SDK クライアントの生成/接続 ---
async def _ensure_client(agent: str) -> ClaudeSDKClient:
    state = stream_states[agent]
    if state.client is not None:
        return state.client

    cfg = AGENTS[agent]
    env = {
        "ANTHROPIC_BASE_URL": "http://localhost:8000/proxy",
        "CLAUDE_CODE_EFFORT_LEVEL": "medium",
    }
    options = ClaudeAgentOptions(
        cwd=cfg["cwd"],
        resume=sessions[agent],
        setting_sources=["user", "project", "local"],
        can_use_tool=_make_permission_handler(agent),
        allowed_tools=[],  # 空 = 全許可（can_use_tool は AskUserQuestion だけ介入）
        permission_mode="bypassPermissions",
        env=env,
        cli_path=config.get("claude_path"),
    )
    client = ClaudeSDKClient(options=options)
    await client.connect()  # 空 stream で接続、以降 client.query() で送る
    state.client = client
    state.client_session_id = sessions[agent]
    return client


async def _disconnect_client(agent: str) -> None:
    state = stream_states[agent]
    if state.client is not None:
        try:
            await state.client.disconnect()
        except Exception:
            logger.exception("disconnect failed for agent=%s", agent)
        state.client = None
        state.client_session_id = None


# --- バックグラウンドで SDK ストリームを読む ---
async def _run_sdk_background(agent: str, content: list):
    state = stream_states[agent]
    try:
        client = await _ensure_client(agent)

        # 入力を送る（AsyncIterable で streaming mode を維持）
        async def _single_msg():
            yield {
                "type": "user",
                "message": {"role": "user", "content": content},
                "parent_tool_use_id": None,
                "session_id": "default",
            }

        await client.query(_single_msg())

        last_assistant_usage: dict = {}

        async for msg in client.receive_response():
            wire = _serialize_sdk_message(msg)
            is_subagent = False

            # --- ステータス更新（送出前に済ます） ---
            if isinstance(msg, AssistantMessage):
                is_subagent = msg.parent_tool_use_id is not None
                # サブエージェントは親とは別コンテキストで走るので ctx_pct を汚染させない
                if msg.usage and not is_subagent:
                    last_assistant_usage = msg.usage
                    ctx_window = agent_status[agent].get("ctx_window") or 1_000_000
                    agent_status[agent]["ctx_pct"] = _compute_ctx_pct(msg.usage, ctx_window)
                if not is_subagent:
                    for block in msg.content:
                        if isinstance(block, ToolUseBlock):
                            agent_status[agent]["current_tool"] = {
                                "name": block.name,
                                "id": block.id,
                                "started_at": time.time(),
                            }
                            if block.name == "TodoWrite":
                                todos = block.input.get("todos")
                                if todos is not None:
                                    agent_status[agent]["todos"] = todos
                            elif block.name == "ExitPlanMode":
                                agent_status[agent]["plan_mode"] = False
                            elif block.name == "PushNotification":
                                # 自発通知 (アイドル中・長尺タスク中の「気づき」通知) は通常返信の
                                # bubble フローから外し、専用 system イベントとして扱う。
                                # 同じバブルに混ざると次の返信が 1 ターン遅れて見える事象を防ぐ。
                                notif_msg = ""
                                if isinstance(block.input, dict):
                                    notif_msg = str(block.input.get("message", "") or "")
                                state.buffer.append(
                                    "data: " + json.dumps({
                                        "type": "proactive_notification",
                                        "message": notif_msg,
                                        "ts": time.time(),
                                        "tool_use_id": block.id,
                                    }, ensure_ascii=False) + "\n\n"
                                )
                                # アプリ閉じてる時のために Web Push でも配信
                                asyncio.create_task(_broadcast_push(notif_msg))

            elif isinstance(msg, UserMessage):
                is_subagent = msg.parent_tool_use_id is not None
                if not is_subagent and isinstance(msg.content, list):
                    for block in msg.content:
                        if isinstance(block, ToolResultBlock):
                            cur = agent_status[agent].get("current_tool")
                            if cur and cur.get("id") == block.tool_use_id:
                                agent_status[agent]["current_tool"] = None

            elif isinstance(msg, SystemMessage):
                sub = msg.subtype
                if sub == "init":
                    perm = msg.data.get("permissionMode")
                    agent_status[agent]["plan_mode"] = (perm == "plan")
                elif sub == "task_started":
                    agent_status[agent]["subagent"] = {
                        "description": msg.data.get("description", "") or getattr(msg, "description", ""),
                        "last_tool": "",
                        "task_id": msg.data.get("task_id", "") or getattr(msg, "task_id", ""),
                    }
                elif sub == "task_progress":
                    cur = agent_status[agent].get("subagent")
                    task_id = msg.data.get("task_id", "") or getattr(msg, "task_id", "")
                    if cur and cur.get("task_id") == task_id:
                        last_tool = msg.data.get("last_tool_name") or getattr(msg, "last_tool_name", None)
                        if last_tool:
                            cur["last_tool"] = last_tool
                elif sub == "task_notification":
                    cur = agent_status[agent].get("subagent")
                    task_id = msg.data.get("task_id", "") or getattr(msg, "task_id", "")
                    if cur and cur.get("task_id") == task_id:
                        agent_status[agent]["subagent"] = None

            elif isinstance(msg, ResultMessage):
                if msg.session_id:
                    sessions[agent] = msg.session_id
                    _save_sessions()
                    state.client_session_id = msg.session_id
                _update_agent_from_result(agent, msg.model_usage, last_assistant_usage)

            elif isinstance(msg, RateLimitEvent):
                info = msg.rate_limit_info
                if info.resets_at:
                    if info.rate_limit_type and "five_hour" in info.rate_limit_type:
                        shared_status["five_hour_resets_at"] = info.resets_at
                    elif info.rate_limit_type and "seven_day" in info.rate_limit_type:
                        shared_status["seven_day_resets_at"] = info.resets_at

            # --- SSE バッファへ積む ---
            if wire is not None:
                state.buffer.append("data: " + json.dumps(wire, ensure_ascii=False) + "\n\n")

    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Error in _run_sdk_background for agent=%s", agent)
    finally:
        state.complete = True
        _reset_activity(agent)
        # 回答待ちが残っていたらキャンセル
        if state.pending_question is not None and not state.pending_question.done():
            state.pending_question.cancel()


# --- エンドポイント ---

@app.post("/chat/{agent}/stream")
async def chat_stream(
    agent: str,
    message: str = Form(...),
    files: List[UploadFile] = File(default=[]),
):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    state = stream_states[agent]

    # 新ターン開始: 直前のタスクが残っていれば完全にキャンセル・待機する
    # （割り込まれた tool_use は orphan として記録し、下で tool_result を合成して閉じる）
    if not state.complete and state.task and not state.task.done():
        try:
            if state.client is not None:
                await state.client.interrupt()
        except Exception:
            logger.exception("interrupt failed during new-stream for agent=%s", agent)
        cur = agent_status[agent].get("current_tool")
        if cur and cur.get("id"):
            state.orphaned_tool_use_id = cur["id"]
        agent_status[agent]["current_tool"] = None
        state.task.cancel()
        try:
            await state.task
        except Exception:
            pass

    if state.complete or state.task is None or state.task.done():
        saved_files = await save_to_tmp(files, agent)
        content = build_content(message, saved_files)

        # 孤児 tool_use が残っていれば synthetic tool_result を先頭に差し込んで履歴を閉じる
        # （これをしないと Anthropic API が "tool_use ids without tool_result" で 400 を返し、
        #  以降のターンの推論が空になって表示が 1 ターンずれる）
        if state.orphaned_tool_use_id:
            content = [
                {
                    "type": "tool_result",
                    "tool_use_id": state.orphaned_tool_use_id,
                    "content": "User cancelled the previous turn.",
                    "is_error": True,
                },
                *content,
            ]
            state.orphaned_tool_use_id = None

        state.buffer = []
        state.buffer_id = str(uuid.uuid4())
        state.complete = False
        state.task = asyncio.create_task(_run_sdk_background(agent, content))

    async def generate():
        sent = 0
        last_heartbeat = asyncio.get_event_loop().time()
        while True:
            while sent < len(state.buffer):
                yield state.buffer[sent]
                sent += 1
                last_heartbeat = asyncio.get_event_loop().time()
            if state.complete and sent >= len(state.buffer):
                break
            now = asyncio.get_event_loop().time()
            if now - last_heartbeat >= 15:
                yield ": ping\n\n"
                last_heartbeat = now
            await asyncio.sleep(0.05)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat/{agent}/answer")
async def chat_answer(agent: str, payload: dict = Body(...)):
    """AskUserQuestion への回答を受け取って can_use_tool ハンドラに返す"""
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")
    state = stream_states[agent]
    if state.pending_question is None or state.pending_question.done():
        raise HTTPException(status_code=409, detail="回答待ちの質問がありません")

    answer = payload.get("answer", "")
    if not isinstance(answer, str):
        raise HTTPException(status_code=400, detail="answer は文字列である必要があります")

    state.pending_question.set_result(answer)
    return {"status": "ok", "tool_use_id": state.pending_question_tool_id}


@app.post("/chat/{agent}/stop")
async def chat_stop(agent: str):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    state = stream_states[agent]
    if state.client is not None:
        try:
            await state.client.interrupt()
        except Exception:
            logger.exception("interrupt failed for agent=%s", agent)

    if state.task and not state.task.done():
        # SDK の interrupt で receive_response が終了するはずだが、
        # 念のためタスクのキャンセルもトリガー
        state.task.cancel()

    if state.pending_question is not None and not state.pending_question.done():
        state.pending_question.cancel()

    # 実行中だった tool_use を孤児として記録（次ターン先頭で tool_result を合成して閉じる）
    cur = agent_status[agent].get("current_tool")
    if cur and cur.get("id"):
        state.orphaned_tool_use_id = cur["id"]

    # ここでタスクが完全に終わるまで await する。await しないと、stop のすぐ後に
    # 新 stream が来たときに前タスクがまだ SDK client を握っていて新タスクと衝突する。
    # asyncio.CancelledError は BaseException 派生なので Exception では捕まらない。
    # gather(return_exceptions=True) で CancelledError ごと握りつぶす。
    if state.task and not state.task.done():
        await asyncio.gather(state.task, return_exceptions=True)

    # interrupt 後の SDK client は内部状態が壊れている可能性があり、再利用すると
    # 次ターンの ResultMessage が is_error=true で帰ってきて「⚠ エラーで停止」
    # チップが出たり、以降のターンで挙動がおかしくなる。明示的に disconnect して
    # 新 send で _ensure_client が新しい client を建て直すようにする。
    await _disconnect_client(agent)

    state.complete = True
    _reset_activity(agent)

    return {"status": "stopped"}


@app.post("/session/{agent}/end")
async def end_session(agent: str):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")
    # SDK クライアントを切断（再接続で新セッションになる）
    await _disconnect_client(agent)
    sessions[agent] = None
    _save_sessions()
    agent_status[agent]["todos"] = None
    agent_status[agent]["plan_mode"] = False
    _reset_activity(agent)
    for p in session_tmp_files.pop(agent, []):
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    return {"status": "ok", "agent": agent}


@app.get("/status/{agent}")
def get_status(agent: str):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")
    a = agent_status[agent]
    state = stream_states[agent]
    return {
        "model": a["model"],
        "ctx_pct": a["ctx_pct"],
        "plan_mode": a["plan_mode"],
        "current_tool": a["current_tool"],
        "todos": a["todos"],
        "subagent": a["subagent"],
        "five_hour_pct": shared_status["five_hour_pct"],
        "seven_day_pct": shared_status["seven_day_pct"],
        "five_hour_resets_at": shared_status["five_hour_resets_at"],
        "seven_day_resets_at": shared_status["seven_day_resets_at"],
        "streaming": not state.complete,
        "buffer_length": len(state.buffer),
        "buffer_id": state.buffer_id,
        "pending_question_tool_id": state.pending_question_tool_id,
    }


@app.get("/chat/{agent}/reconnect")
async def reconnect_stream(agent: str, from_pos: int = Query(default=0, alias="from")):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    state = stream_states[agent]
    if state.complete and from_pos >= len(state.buffer):
        return Response(status_code=204)

    async def generate():
        sent = max(0, from_pos)
        last_heartbeat = asyncio.get_event_loop().time()
        while True:
            while sent < len(state.buffer):
                yield state.buffer[sent]
                sent += 1
                last_heartbeat = asyncio.get_event_loop().time()
            if state.complete and sent >= len(state.buffer):
                break
            now = asyncio.get_event_loop().time()
            if now - last_heartbeat >= 15:
                yield ": ping\n\n"
                last_heartbeat = now
            await asyncio.sleep(0.05)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Anthropic リバースプロキシ（rate limit ヘッダ取得のため温存） ---
@app.api_route("/proxy/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def anthropic_proxy(path: str, request: Request):
    target_url = f"{ANTHROPIC_API_BASE}/{path}"
    if request.query_params:
        target_url += f"?{request.query_params}"

    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length")
    }

    resp = await http_client.request(
        method=request.method,
        url=target_url,
        headers=headers,
        content=body,
    )

    _update_shared_from_headers(resp.headers)

    skip_headers = {"transfer-encoding", "connection", "keep-alive", "content-encoding"}
    response_headers = {
        k: v for k, v in resp.headers.items()
        if k.lower() not in skip_headers
    }

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=response_headers,
    )


# --- Web Push エンドポイント ---
@app.get("/push/vapid-public-key")
def get_vapid_public_key():
    if not vapid_config or not vapid_config.get("public_key"):
        raise HTTPException(status_code=503, detail="VAPID not configured. Run gen_vapid.py.")
    return {"public_key": vapid_config["public_key"]}


def _sub_key(sub: dict) -> str | None:
    """サブスクリプションのユニーク識別子 (endpoint URL)。"""
    if not isinstance(sub, dict):
        return None
    return sub.get("endpoint")


@app.post("/push/subscribe")
def push_subscribe(subscription: dict = Body(...)):
    key = _sub_key(subscription)
    if not key:
        raise HTTPException(status_code=400, detail="Invalid subscription (missing endpoint)")
    # endpoint で重複排除
    for i, s in enumerate(subscriptions):
        if _sub_key(s) == key:
            subscriptions[i] = subscription
            break
    else:
        subscriptions.append(subscription)
    _save_subscriptions()
    return {"ok": True, "count": len(subscriptions)}


@app.post("/push/unsubscribe")
def push_unsubscribe(subscription: dict = Body(...)):
    key = _sub_key(subscription)
    if not key:
        raise HTTPException(status_code=400, detail="Invalid subscription (missing endpoint)")
    before = len(subscriptions)
    subscriptions[:] = [s for s in subscriptions if _sub_key(s) != key]
    if len(subscriptions) != before:
        _save_subscriptions()
    return {"ok": True, "count": len(subscriptions)}


def _resolve_safe(path_str: str) -> Path:
    resolved = Path(path_str).expanduser().resolve()
    if not str(resolved).startswith(str(HOME)):
        raise HTTPException(status_code=403, detail="Access denied")
    return resolved


FILE_SIZE_LIMIT = 1 * 1024 * 1024  # 1MB

@app.get("/file")
def get_file(path: str = Query(...)):
    resolved = _resolve_safe(path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Not a file")
    if resolved.stat().st_size > FILE_SIZE_LIMIT:
        raise HTTPException(status_code=413, detail=f"ファイルが大きすぎます（上限 1MB）")
    try:
        content = resolved.read_text(errors="replace")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"path": str(resolved), "content": content}


@app.put("/file")
def put_file(path: str = Body(...), content: str = Body(...)):
    resolved = _resolve_safe(path)
    if resolved.exists() and not resolved.is_file():
        raise HTTPException(status_code=400, detail="Not a file")
    try:
        resolved.write_text(content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@app.get("/files/tree")
def get_tree(path: str = Query(default="~")):
    resolved = _resolve_safe(path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Directory not found")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")
    entries = []
    try:
        for entry in sorted(resolved.iterdir(), key=lambda e: (e.is_file(), e.name.lower())):
            entries.append({
                "name": entry.name,
                "path": str(entry),
                "is_dir": entry.is_dir(),
            })
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"path": str(resolved), "entries": entries}


@app.get("/agents")
def list_agents():
    return [
        {"id": name, "display_name": cfg.get("display_name", name.upper())}
        for name, cfg in AGENTS.items()
    ]


FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


class CacheControlledStaticFiles(StaticFiles):
    """index.html / manifest.json は no-cache、ハッシュ付き assets は immutable で長期キャッシュ。

    iOS Safari (PWA) はデフォルトで Cache-Control 無しレスポンスを長時間キャッシュするため、
    index.html が古いままになり Vite の新しいハッシュ付き assets ファイルを参照できなくなる。
    エントリポイント (= index.html / manifest.json) だけ毎回鮮度確認させ、
    /assets/ 配下はファイル名にハッシュが入っているので永久キャッシュして問題ない。
    """

    NO_CACHE_PATHS = {"index.html", "manifest.json", "sw.js"}
    IMMUTABLE_PREFIX = "assets/"

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        # path はマウントポイント以降の相対パス。ルート ("/") の場合は "." が来るので
        # html=True で展開された後の実ファイル名で判定するため、後段でも振り分ける
        normalized = path.lstrip("/")
        if normalized in self.NO_CACHE_PATHS or normalized in ("", "."):
            response.headers["Cache-Control"] = "no-cache"
        elif normalized.startswith(self.IMMUTABLE_PREFIX):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if FRONTEND_DIST.exists():
    app.mount("/", CacheControlledStaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
