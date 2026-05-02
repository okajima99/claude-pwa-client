"""チャット送受信・状態問い合わせ系のエンドポイント群。

セッション (UI 上の 1 タブ = 1 議題) を一意キー session_id で扱う。

含まれるルート:
- POST /chat/{session_id}/stream      新規ターン開始 + SSE 配信
- POST /chat/{session_id}/answer      AskUserQuestion への回答
- POST /chat/{session_id}/stop        ターン中断
- GET  /chat/{session_id}/reconnect   バッファ再生
- POST /sessions/{session_id}/end     claude session_id だけクリア (UI セッションは残す)
- GET  /status/{session_id}           ステータス取得
- GET  /sessions                      セッション一覧
- POST /sessions                      新規セッション作成 (body: {agent_id, title?})
- PATCH /sessions/{session_id}        title 変更 (body: {title})
- DELETE /sessions/{session_id}       セッション削除
- GET  /agents                        agent 種別一覧 (作成時の選択肢)
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
from session_logging import (
    delete_session_log,
    mark_session_end,
    prune_session_log,
    session_log,
)
from state import (
    agent_status,
    register_session,
    rename_session,
    reset_activity,
    save_sessions,
    session_tmp_files,
    sessions,
    sessions_meta,
    shared_status,
    stream_states,
    unregister_session,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# --- ファイル一時保存 / コンテンツ組み立て ---
async def save_to_tmp(files: List[UploadFile], session_id: str) -> List[dict]:
    UPLOADS_TMP.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        if not f.size:
            continue
        ext = Path(f.filename or "file").suffix or ""
        dest = UPLOADS_TMP / f"{uuid.uuid4().hex}{ext}"
        data = await f.read()
        dest.write_bytes(data)
        session_tmp_files.setdefault(session_id, []).append(dest)
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


# --- セッション CRUD ---
@router.get("/sessions")
def list_sessions():
    return [m.to_dict() for m in sessions_meta.values()]


@router.post("/sessions")
def create_session(payload: dict = Body(...)):
    agent_id = payload.get("agent_id")
    title = payload.get("title")
    if not agent_id or agent_id not in AGENTS:
        raise HTTPException(status_code=400, detail="agent_id が無効です")
    meta = register_session(agent_id, title)
    return meta.to_dict()


@router.patch("/sessions/{session_id}")
def patch_session(session_id: str, payload: dict = Body(...)):
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        raise HTTPException(status_code=400, detail="title は必須 (空不可)")
    rename_session(session_id, title.strip())
    return sessions_meta[session_id].to_dict()


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    # SDK client を切断してから state を破棄
    await disconnect_client(session_id)
    # 残タスクがあればキャンセル
    state = stream_states.get(session_id)
    if state and state.task and not state.task.done():
        state.task.cancel()
        try:
            await state.task
        except Exception:
            pass
    # 一時ファイルをクリーンアップ
    for p in session_tmp_files.pop(session_id, []):
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    # per-tab ログを丸ごと削除
    delete_session_log(session_id)
    unregister_session(session_id)
    return {"status": "ok", "session_id": session_id}


# --- エンドポイント ---
@router.post("/chat/{session_id}/stream")
async def chat_stream(
    session_id: str,
    message: str = Form(...),
    files: List[UploadFile] = File(default=[]),
):
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")

    state = stream_states[session_id]

    # 新ターン開始: 直前のタスクが残っていれば完全にキャンセル・待機する
    # （割り込まれた tool_use は orphan として記録し、下で tool_result を合成して閉じる）
    if not state.complete and state.task and not state.task.done():
        try:
            if state.client is not None:
                await state.client.interrupt()
        except Exception:
            logger.exception("interrupt failed during new-stream for session=%s", session_id)
        cur = agent_status[session_id].get("current_tool")
        if cur and cur.get("id"):
            state.orphaned_tool_use_id = cur["id"]
        agent_status[session_id]["current_tool"] = None
        state.task.cancel()
        try:
            await state.task
        except Exception:
            pass

    if state.complete or state.task is None or state.task.done():
        saved_files = await save_to_tmp(files, session_id)
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

        # user_request_id: この POST 起点ターンを識別する ID。
        # SDK が同じ receive_response で自発ターン (CronCreate/ScheduleWakeup 由来) の
        # ResultMessage を追加で吐くケースがある。ID で送信ボタン解放を ユーザーターンの
        # ResultMessage 1 個に限定し、自発の Result でロックが外れないようにする。
        user_request_id = uuid.uuid4().hex[:12]
        state.user_request_id = user_request_id
        session_log(
            session_id,
            f"[POST /chat/stream] user_request_id={user_request_id} text={message[:80]!r} files={len(saved_files)}",
        )

        state.buffer = []
        state.buffer_id = str(uuid.uuid4())
        # SSE 先頭で request_id をフロントに通知
        import json as _json
        state.buffer.append(
            "data: " + _json.dumps({"type": "request_id", "request_id": user_request_id}) + "\n\n"
        )
        state.complete = False
        state.task = asyncio.create_task(run_sdk_background(session_id, content, user_request_id))

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


@router.post("/chat/{session_id}/answer")
async def chat_answer(session_id: str, payload: dict = Body(...)):
    """AskUserQuestion への回答を受け取って can_use_tool ハンドラに返す"""
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    state = stream_states[session_id]
    if state.pending_question is None or state.pending_question.done():
        raise HTTPException(status_code=409, detail="回答待ちの質問がありません")

    answer = payload.get("answer", "")
    if not isinstance(answer, str):
        raise HTTPException(status_code=400, detail="answer は文字列である必要があります")

    state.pending_question.set_result(answer)
    return {"status": "ok", "tool_use_id": state.pending_question_tool_id}


@router.post("/chat/{session_id}/stop")
async def chat_stop(session_id: str):
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")

    state = stream_states[session_id]
    if state.client is not None:
        try:
            await state.client.interrupt()
        except Exception:
            logger.exception("interrupt failed for session=%s", session_id)

    if state.task and not state.task.done():
        # SDK の interrupt で receive_response が終了するはずだが、念のためキャンセルもトリガー
        state.task.cancel()

    if state.pending_question is not None and not state.pending_question.done():
        state.pending_question.cancel()

    # 実行中だった tool_use を孤児として記録（次ターン先頭で tool_result を合成して閉じる）
    cur = agent_status[session_id].get("current_tool")
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
    await disconnect_client(session_id)

    state.complete = True
    reset_activity(session_id)

    return {"status": "stopped"}


@router.post("/sessions/{session_id}/end")
async def end_session(session_id: str):
    """claude 側の会話 context だけリセット (UI セッションは残す)。
    旧 /session/{agent}/end の置換。 セッションそのものを消すには DELETE /sessions/{id}。
    """
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    # SDK クライアントを切断（再接続で新セッションになる）
    await disconnect_client(session_id)
    sessions[session_id] = None
    save_sessions()
    agent_status[session_id]["todos"] = None
    agent_status[session_id]["plan_mode"] = False
    reset_activity(session_id)
    for p in session_tmp_files.pop(session_id, []):
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    # per-tab ログにセッション終了マーカーを書いて、 古いセッション分を prune
    mark_session_end(session_id)
    prune_session_log(session_id)
    return {"status": "ok", "session_id": session_id}


@router.get("/status/{session_id}")
def get_status(session_id: str):
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    a = agent_status[session_id]
    state = stream_states[session_id]
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


@router.get("/chat/{session_id}/reconnect")
async def reconnect_stream(session_id: str, from_pos: int = Query(default=0, alias="from")):
    if session_id not in sessions_meta:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")

    state = stream_states[session_id]
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
    """セッション作成時の選択肢として agent 種別一覧を返す。"""
    return [
        {"id": name, "display_name": cfg.get("display_name", name.upper())}
        for name, cfg in AGENTS.items()
    ]
