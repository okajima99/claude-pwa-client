"""Claude Agent SDK を駆動して SSE wire イベントを buffer に積む層。

run_sdk_background が中心。各メッセージ種別ごとの状態更新と
ターン完了時の Web Push 発火もここで行う。
"""
import asyncio
import json
import logging
import time
from typing import Any

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

from config import AGENTS, CLAUDE_PATH
from push import broadcast_push, notification_title_for
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
def make_permission_handler(agent: str):
    async def handler(tool_name: str, input_data: dict, context: Any):
        if tool_name != "AskUserQuestion":
            return PermissionResultAllow(updated_input=input_data)

        state = stream_states[agent]
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
async def ensure_client(agent: str) -> ClaudeSDKClient:
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
        can_use_tool=make_permission_handler(agent),
        allowed_tools=[],  # 空 = 全許可（can_use_tool は AskUserQuestion だけ介入）
        permission_mode="bypassPermissions",
        env=env,
        cli_path=CLAUDE_PATH,
    )
    client = ClaudeSDKClient(options=options)
    await client.connect()
    state.client = client
    state.client_session_id = sessions[agent]
    return client


async def disconnect_client(agent: str) -> None:
    state = stream_states[agent]
    if state.client is not None:
        try:
            await state.client.disconnect()
        except Exception:
            logger.exception("disconnect failed for agent=%s", agent)
        state.client = None
        state.client_session_id = None


# --- バックグラウンドで SDK ストリームを読む ---
async def run_sdk_background(agent: str, content: list):
    state = stream_states[agent]
    try:
        client = await ensure_client(agent)

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

            # --- ステータス更新（送出前に済ます） ---
            if isinstance(msg, AssistantMessage):
                is_subagent = msg.parent_tool_use_id is not None
                # サブエージェントは親とは別コンテキストで走るので ctx_pct を汚染させない
                if msg.usage and not is_subagent:
                    last_assistant_usage = msg.usage
                    ctx_window = agent_status[agent].get("ctx_window") or 1_000_000
                    agent_status[agent]["ctx_pct"] = compute_ctx_pct(msg.usage, ctx_window)
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
                    # ターン完了通知のために assistant text を蓄積する。
                    # 各 AssistantMessage は完結した発話単位 (tool_use を挟むと
                    # 1 ターン内に複数飛んでくる) なので、最後の text を保持して
                    # 「仕上げの返信」を通知 body にする。
                    text_parts = [b.text for b in msg.content if isinstance(b, TextBlock)]
                    if text_parts:
                        last_assistant_text[agent] = "\n".join(text_parts)

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
                    save_sessions()
                    state.client_session_id = msg.session_id
                update_agent_from_result(agent, msg.model_usage, last_assistant_usage)

                # ターン完了通知: PWA をフォアで見ていない時のみ Web Push で届ける。
                # 直前ターンの assistant text を冒頭 140 文字に切って body に。
                turn_text = last_assistant_text.get(agent, "").strip()
                if turn_text and not flags["user_visible"]:
                    body = turn_text if len(turn_text) <= 140 else (turn_text[:140] + "…")
                    asyncio.create_task(broadcast_push(body, notification_title_for(agent)))

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
        logger.exception("Error in run_sdk_background for agent=%s", agent)
    finally:
        state.complete = True
        reset_activity(agent)
        # ターン中に蓄積した assistant text を必ずクリアする。
        # 例外 / interrupt / stop で ResultMessage を経由しなかった場合に
        # 古い text が次ターンの通知 body に混入するのを防ぐ。
        last_assistant_text[agent] = ""
        # 回答待ちが残っていたらキャンセル
        if state.pending_question is not None and not state.pending_question.done():
            state.pending_question.cancel()
