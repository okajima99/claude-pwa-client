"""チャット送受信・状態問い合わせ系のエンドポイント群。

含まれるルート:
- POST /chat/{agent}/stream      新規ターン開始 + SSE 配信
- POST /chat/{agent}/answer      AskUserQuestion への回答
- POST /chat/{agent}/stop        ターン中断
- GET  /chat/{agent}/reconnect   バッファ再生
- POST /session/{agent}/end      セッションリセット
- GET  /status/{agent}           ステータス取得
- GET  /agents                   エージェント一覧
"""
import asyncio
import base64
import logging
import mimetypes
import uuid
from pathlib import Path
from typing import List

from fastapi import APIRouter, Body, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse

from config import AGENTS, SUPPORTED_IMAGE_TYPES, UPLOADS_TMP
from sdk_runner import disconnect_client, run_sdk_background
from state import (
    agent_status,
    reset_activity,
    save_sessions,
    session_tmp_files,
    sessions,
    shared_status,
    stream_states,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# --- ファイル一時保存 / コンテンツ組み立て ---
async def save_to_tmp(files: List[UploadFile], agent: str) -> List[dict]:
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


def build_content(message: str, saved_files: List[dict]) -> list:
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


# --- エンドポイント ---
@router.post("/chat/{agent}/stream")
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
        state.task = asyncio.create_task(run_sdk_background(agent, content))

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


@router.post("/chat/{agent}/answer")
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


@router.post("/chat/{agent}/stop")
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
        # SDK の interrupt で receive_response が終了するはずだが、念のためキャンセルもトリガー
        state.task.cancel()

    if state.pending_question is not None and not state.pending_question.done():
        state.pending_question.cancel()

    # 実行中だった tool_use を孤児として記録（次ターン先頭で tool_result を合成して閉じる）
    cur = agent_status[agent].get("current_tool")
    if cur and cur.get("id"):
        state.orphaned_tool_use_id = cur["id"]

    # ここでタスクが完全に終わるまで await する。await しないと、stop のすぐ後に
    # 次ターンが来た際に古いタスクの finally と新ターンの初期化が race する。
    if state.task and not state.task.done():
        try:
            await state.task
        except Exception:
            pass

    # interrupt 後の SDK client は内部状態が壊れている可能性があり、再利用すると
    # 次ターンの ResultMessage が is_error=true で帰ってきて「⚠ エラーで停止」
    # チップが出たり、以降のターンで挙動がおかしくなる。明示的に disconnect して
    # 新 send で ensure_client が新しい client を建て直すようにする。
    await disconnect_client(agent)

    state.complete = True
    reset_activity(agent)

    return {"status": "stopped"}


@router.post("/session/{agent}/end")
async def end_session(agent: str):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")
    # SDK クライアントを切断（再接続で新セッションになる）
    await disconnect_client(agent)
    sessions[agent] = None
    save_sessions()
    agent_status[agent]["todos"] = None
    agent_status[agent]["plan_mode"] = False
    reset_activity(agent)
    for p in session_tmp_files.pop(agent, []):
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    return {"status": "ok", "agent": agent}


@router.get("/status/{agent}")
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


@router.get("/chat/{agent}/reconnect")
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


@router.get("/agents")
def list_agents():
    return [
        {"id": name, "display_name": cfg.get("display_name", name.upper())}
        for name, cfg in AGENTS.items()
    ]
