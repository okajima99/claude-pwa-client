"""Claude Agent SDK を駆動して SSE wire イベントを buffer に積む層。

run_sdk_background が中心。各メッセージ種別ごとの状態更新と
ターン完了時の Web Push 発火もここで行う。
"""
import asyncio
import json
import logging
import time
from typing import Any

from anyio import WouldBlock

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
from claude_agent_sdk._internal.message_parser import parse_message
from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny

from config import AGENTS, CLAUDE_PATH
from push import broadcast_push, notification_title_for
from session_logging import session_log
from state import (
    agent_status,
    compute_ctx_pct,
    flags,
    last_assistant_text,
    reset_activity,
    save_sessions,
    sessions,
    shared_status,
    stream_states,
    update_agent_from_result,
)

logger = logging.getLogger(__name__)


# --- SDK メッセージ → CLI stream-json 互換 dict ---
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
    return {"type": "unknown", "raw": str(block)}


def serialize_sdk_message(msg: Any) -> dict | None:
    """SDK Message → フロント互換 JSON dict (CLI stream-json 形式)。"""
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


# --- can_use_tool ハンドラ ---
def make_permission_handler(session_id: str):
    async def handler(tool_name: str, input_data: dict, context: Any):
        if tool_name != "AskUserQuestion":
            return PermissionResultAllow(updated_input=input_data)

        state = stream_states[session_id]
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
            return PermissionResultDeny(message="ユーザー応答待ちがキャンセルされました。", interrupt=True)

        state.pending_question = None
        state.pending_question_tool_id = None
        return PermissionResultDeny(message=f"ユーザーの回答: {answer}", interrupt=False)

    return handler


# --- SDK クライアントの生成/接続 ---
async def ensure_client(session_id: str) -> ClaudeSDKClient:
    state = stream_states[session_id]
    if state.client is not None:
        return state.client

    agent_id = state.agent_id
    cfg = AGENTS[agent_id]
    env = {
        "ANTHROPIC_BASE_URL": "http://localhost:8000/proxy",
        "CLAUDE_CODE_EFFORT_LEVEL": "medium",
    }
    options = ClaudeAgentOptions(
        cwd=cfg["cwd"],
        resume=sessions.get(session_id),
        setting_sources=["user", "project", "local"],
        can_use_tool=make_permission_handler(session_id),
        allowed_tools=[],  # 空 = 全許可（can_use_tool は AskUserQuestion だけ介入）
        permission_mode="bypassPermissions",
        env=env,
        cli_path=CLAUDE_PATH,
    )
    client = ClaudeSDKClient(options=options)
    await client.connect()
    state.client = client
    state.client_session_id = sessions.get(session_id)
    return client


async def disconnect_client(session_id: str) -> None:
    state = stream_states.get(session_id)
    if state is None:
        return
    if state.client is not None:
        try:
            await state.client.disconnect()
        except Exception:
            logger.exception("disconnect failed for session=%s", session_id)
        state.client = None
        state.client_session_id = None


# --- アイドル GC ---
# 直近のターン完了から IDLE_DISCONNECT_SEC 経過した SDK client を disconnect する。
# claude API の prompt cache が 5 分 TTL なので、 同期間で切るのが妥当 (cache 切れた
# client を保持してもメモリだけ食って効果は無い)。 buffer も同時にクリアして
# F の問題 (再接続不要なバッファ残留) も解消する。
IDLE_DISCONNECT_SEC = 5 * 60
IDLE_GC_INTERVAL_SEC = 60


async def idle_disconnect_loop():
    """N 秒間隔で全セッションを巡回し、 アイドル時間が閾値超のものを disconnect する。"""
    while True:
        try:
            await asyncio.sleep(IDLE_GC_INTERVAL_SEC)
            now = time.time()
            for session_id, state in list(stream_states.items()):
                if state.client is None:
                    continue
                # 進行中ターン or pending question があればスキップ
                if not state.complete:
                    continue
                if state.pending_question is not None and not state.pending_question.done():
                    continue
                # last_activity_at == 0.0 はまだ発話してないセッション (= 立ち上げ済みだが
                # ターン未経験) → GC 対象にしない方が安全
                if state.last_activity_at <= 0:
                    continue
                idle = now - state.last_activity_at
                if idle < IDLE_DISCONNECT_SEC:
                    continue
                session_log(
                    session_id,
                    f"[idle-gc] disconnecting idle={idle:.0f}s",
                )
                await disconnect_client(session_id)
                # 再接続用 buffer もここで捨てる (アイドル状態なので誰も replay しに来ない)
                state.buffer = []
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("idle_disconnect_loop iteration failed")


# --- バックグラウンドで SDK ストリームを読む ---
async def run_sdk_background(session_id: str, content: list, user_request_id: str | None = None):
    state = stream_states[session_id]
    # アイドル GC が「進行中ターンを誤って disconnect」 しないよう、 開始時に活動時刻を更新
    state.last_activity_at = time.time()
    # ターンの所有者を識別する request_id。ユーザー起点ターンには user_request_id を、
    # 自発ターン (CronCreate / ScheduleWakeup でキューされたもの) には毎回別の
    # proactive_xxx を付与する。
    # SDK は ユーザー POST と同じ receive_response 内に、キュー済みの自発ターンを
    # 先または後に混ぜて流すことがある。各 UserMessage の content を ユーザーの
    # 入力 text と照合して所有者を切り替える。
    import uuid as _uuid

    def _extract_user_text(content_obj) -> str:
        """user content (list of blocks or str) から text 部分を抽出して結合。"""
        if isinstance(content_obj, str):
            return content_obj.strip()
        if not isinstance(content_obj, list):
            return ""
        parts = []
        for b in content_obj:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
            elif isinstance(b, TextBlock):
                parts.append(b.text)
        return "\n".join(parts).strip()

    user_input_text = _extract_user_text(content)

    current_request_id = f"proactive_{_uuid.uuid4().hex[:8]}"
    user_turn_done = False
    session_log(
        session_id,
        f"[run_sdk] === START user_request_id={user_request_id} user_text={user_input_text[:80]!r} ===",
    )
    try:
        client = await ensure_client(session_id)

        # ---- 過去ターン応答の非ブロッキング drain ----
        # SDK の _message_receive に wakeup / Monitor 由来の応答が溜まっている可能性がある
        # (ユーザー POST より前に runtime がそれらのターンを処理して buffer に積んでいる場合)。
        # query 送信前に取り出して proactive_id でタグ付けし、wire に流す。
        # 受信は receive_nowait で時間待ちなし、buffer 空になったら即抜ける。
        drain_stream = client._query._message_receive
        drained_count = 0
        proactive_id_drain = f"proactive_{_uuid.uuid4().hex[:8]}"
        while True:
            try:
                data = drain_stream.receive_nowait()
            except WouldBlock:
                break
            if not isinstance(data, dict):
                continue
            t = data.get("type")
            if t in ("end", "error"):
                continue
            drained_count += 1
            msg = parse_message(data)
            if msg is None:
                continue
            wire = serialize_sdk_message(msg)
            if wire is None:
                continue
            # ResultMessage 検出で proactive_id を更新 (turn 境界)
            wire["request_id"] = proactive_id_drain
            state.buffer.append("data: " + json.dumps(wire, ensure_ascii=False) + "\n\n")
            session_log(
                session_id,
                f"[drain] type={wire.get('type')} request_id={proactive_id_drain}",
            )
            if isinstance(msg, ResultMessage):
                proactive_id_drain = f"proactive_{_uuid.uuid4().hex[:8]}"
        session_log(session_id, f"[drain] total={drained_count} before query")

        # drain 後の最初のターン = ユーザーのターン。user_request_id でタグする。
        if user_request_id:
            current_request_id = user_request_id

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
            wire = serialize_sdk_message(msg)
            is_subagent = False

            # --- メッセージ単位の詳細ログ ---
            if isinstance(msg, AssistantMessage):
                _text_preview = "".join(b.text for b in msg.content if isinstance(b, TextBlock))[:80]
                _tools = [b.name for b in msg.content if isinstance(b, ToolUseBlock)]
                session_log(
                    session_id,
                    f"[msg] AssistantMessage stop_reason={msg.stop_reason} parent_tool={msg.parent_tool_use_id} text={_text_preview!r} tools={_tools}",
                )
            elif isinstance(msg, ResultMessage):
                session_log(
                    session_id,
                    f"[msg] ResultMessage subtype={msg.subtype} is_error={msg.is_error} claude_session={msg.session_id} num_turns={msg.num_turns} stop_reason={msg.stop_reason}",
                )
            elif isinstance(msg, UserMessage):
                _text = _extract_user_text(msg.content)[:80]
                _has_tr = isinstance(msg.content, list) and any(isinstance(b, ToolResultBlock) for b in msg.content)
                session_log(
                    session_id,
                    f"[msg] UserMessage parent_tool={msg.parent_tool_use_id} tool_result={_has_tr} text={_text!r}",
                )
            elif isinstance(msg, SystemMessage):
                session_log(session_id, f"[msg] SystemMessage subtype={msg.subtype}")

            # --- ステータス更新（送出前に済ます） ---
            if isinstance(msg, AssistantMessage):
                is_subagent = msg.parent_tool_use_id is not None
                # サブエージェントは親とは別コンテキストで走るので ctx_pct を汚染させない
                if msg.usage and not is_subagent:
                    last_assistant_usage = msg.usage
                    ctx_window = agent_status[session_id].get("ctx_window") or 1_000_000
                    agent_status[session_id]["ctx_pct"] = compute_ctx_pct(msg.usage, ctx_window)
                if not is_subagent:
                    for block in msg.content:
                        if isinstance(block, ToolUseBlock):
                            agent_status[session_id]["current_tool"] = {
                                "name": block.name,
                                "id": block.id,
                                "started_at": time.time(),
                            }
                            if block.name == "TodoWrite":
                                todos = block.input.get("todos")
                                if todos is not None:
                                    agent_status[session_id]["todos"] = todos
                            elif block.name == "ExitPlanMode":
                                agent_status[session_id]["plan_mode"] = False
                    # ターン完了通知のために assistant text を蓄積する。
                    # 各 AssistantMessage は完結した発話単位 (tool_use を挟むと
                    # 1 ターン内に複数飛んでくる) なので、最後の text を保持して
                    # 「仕上げの返信」を通知 body にする。
                    text_parts = [b.text for b in msg.content if isinstance(b, TextBlock)]
                    if text_parts:
                        last_assistant_text[session_id] = "\n".join(text_parts)

            elif isinstance(msg, UserMessage):
                is_subagent = msg.parent_tool_use_id is not None
                if not is_subagent and isinstance(msg.content, list):
                    for block in msg.content:
                        if isinstance(block, ToolResultBlock):
                            cur = agent_status[session_id].get("current_tool")
                            if cur and cur.get("id") == block.tool_use_id:
                                agent_status[session_id]["current_tool"] = None

            elif isinstance(msg, SystemMessage):
                sub = msg.subtype
                if sub == "init":
                    perm = msg.data.get("permissionMode")
                    agent_status[session_id]["plan_mode"] = (perm == "plan")
                elif sub == "task_started":
                    agent_status[session_id]["subagent"] = {
                        "description": msg.data.get("description", "") or getattr(msg, "description", ""),
                        "last_tool": "",
                        "task_id": msg.data.get("task_id", "") or getattr(msg, "task_id", ""),
                    }
                elif sub == "task_progress":
                    cur = agent_status[session_id].get("subagent")
                    task_id = msg.data.get("task_id", "") or getattr(msg, "task_id", "")
                    if cur and cur.get("task_id") == task_id:
                        last_tool = msg.data.get("last_tool_name") or getattr(msg, "last_tool_name", None)
                        if last_tool:
                            cur["last_tool"] = last_tool
                elif sub == "task_notification":
                    cur = agent_status[session_id].get("subagent")
                    task_id = msg.data.get("task_id", "") or getattr(msg, "task_id", "")
                    if cur and cur.get("task_id") == task_id:
                        agent_status[session_id]["subagent"] = None

            elif isinstance(msg, ResultMessage):
                if msg.session_id:
                    sessions[session_id] = msg.session_id
                    save_sessions()
                    state.client_session_id = msg.session_id
                update_agent_from_result(session_id, msg.model_usage, last_assistant_usage)

                # ターン完了通知: PWA をフォアで見ていない時のみ Web Push で届ける。
                # 直前ターンの assistant text を冒頭 140 文字に切って body に。
                turn_text = last_assistant_text.get(session_id, "").strip()
                if turn_text and not flags["user_visible"]:
                    body = turn_text if len(turn_text) <= 140 else (turn_text[:140] + "…")
                    asyncio.create_task(broadcast_push(body, notification_title_for(session_id)))

            elif isinstance(msg, RateLimitEvent):
                info = msg.rate_limit_info
                if info.resets_at:
                    if info.rate_limit_type and "five_hour" in info.rate_limit_type:
                        shared_status["five_hour_resets_at"] = info.resets_at
                    elif info.rate_limit_type and "seven_day" in info.rate_limit_type:
                        shared_status["seven_day_resets_at"] = info.resets_at

            # --- SSE バッファへ積む (request_id 付与) ---
            if wire is not None:
                wire["request_id"] = current_request_id
                state.buffer.append("data: " + json.dumps(wire, ensure_ascii=False) + "\n\n")
                # 検証ログ: メッセージ種別 + request_id を 1 行で残す
                _suffix = " (user-turn-end)" if (isinstance(msg, ResultMessage) and current_request_id == user_request_id) else ""
                session_log(
                    session_id,
                    f"[wire] type={wire.get('type')} request_id={current_request_id}{_suffix}",
                )

            # ResultMessage 通過後はターン終了。次に来るメッセージは別ターン (自発)
            # として扱うため、いったん proactive_id に切り替えて待機する。
            # (続く UserMessage の content 照合で再度切り替わる)
            if isinstance(msg, ResultMessage):
                if current_request_id == user_request_id:
                    user_turn_done = True
                current_request_id = f"proactive_{_uuid.uuid4().hex[:8]}"

    except asyncio.CancelledError:
        session_log(session_id, f"[run_sdk] CANCELLED user_request_id={user_request_id}")
        raise
    except Exception:
        logger.exception("Error in run_sdk_background for session=%s", session_id)
        session_log(session_id, f"[run_sdk] EXCEPTION user_request_id={user_request_id}")
    finally:
        session_log(
            session_id,
            f"[run_sdk] === END user_request_id={user_request_id} user_turn_done={user_turn_done} ===",
        )
        state.complete = True
        # ターン完了時刻を活動時刻として記録 (アイドル GC の起点)
        state.last_activity_at = time.time()
        reset_activity(session_id)
        # ターン中に蓄積した assistant text を必ずクリアする。
        # 例外 / interrupt / stop で ResultMessage を経由しなかった場合に
        # 古い text が次ターンの通知 body に混入するのを防ぐ。
        last_assistant_text[session_id] = ""
        # 回答待ちが残っていたらキャンセル
        if state.pending_question is not None and not state.pending_question.done():
            state.pending_question.cancel()
