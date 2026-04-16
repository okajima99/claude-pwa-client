import asyncio
import base64
import json
import mimetypes
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

HOME = Path.home()
UPLOADS_TMP = HOME / "cpc" / "uploads" / "tmp"

# --- 設定読み込み ---
CONFIG_PATH = Path(__file__).parent / "config.json"
with open(CONFIG_PATH) as f:
    config = json.load(f)

AGENTS = config["agents"]
ANTHROPIC_API_BASE = "https://api.anthropic.com"

SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# --- アプリ初期化 ---
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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

# --- ストリーム状態（エージェントごと）---
@dataclass
class StreamState:
    buffer: list[str] = field(default_factory=list)
    buffer_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    task: asyncio.Task | None = None
    complete: bool = True  # 初期状態は「完了済み（次のメッセージを受け付ける）」

stream_states: dict[str, StreamState] = {name: StreamState() for name in AGENTS}

# --- 実行中プロセス管理 ---
running_procs: dict[str, asyncio.subprocess.Process | None] = {}

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
    name: {"ctx_pct": 0, "model": cfg.get("model", "")}
    for name, cfg in AGENTS.items()
}


def _update_shared_from_headers(headers) -> None:
    def _get(key):
        if isinstance(headers, httpx.Headers):
            return headers.get(key)
        return headers.get(key)

    five_h = _get("anthropic-ratelimit-unified-5h-utilization")
    seven_d = _get("anthropic-ratelimit-unified-7d-utilization")
    five_h_reset = _get("anthropic-ratelimit-unified-5h-resets-at")
    seven_d_reset = _get("anthropic-ratelimit-unified-7d-resets-at")

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


def _update_agent_from_result(agent: str, result_event: dict, last_assistant_usage: dict = {}) -> None:
    model_usage = result_event.get("modelUsage", {})
    if not model_usage:
        return
    model_key = next(iter(model_usage), None)
    if not model_key:
        return
    agent_status[agent]["model"] = _format_model_name(model_key)
    result_usage = model_usage[model_key]
    ctx_window = result_usage.get("contextWindow", 200000)

    # resultイベントのmodelUsageは全イテレーション累積値なので使わない
    # 最後のassistantイベントのcacheRead（単一API呼び出し分）をctx%の基準にする
    # ターミナルのstatusLineと同じ挙動: cacheRead / contextWindow
    cache_read = last_assistant_usage.get("cache_read_input_tokens", 0)
    if cache_read > 0 and ctx_window > 0:
        agent_status[agent]["ctx_pct"] = min(round(cache_read / ctx_window * 100), 100)
    elif ctx_window > 0:
        # assistantイベントがない場合はresultから近似
        cache_read_result = result_usage.get("cacheReadInputTokens", 0)
        agent_status[agent]["ctx_pct"] = min(round(cache_read_result / ctx_window * 100), 100)


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


# --- バックグラウンドでclaude実行 ---
async def _run_claude_background(agent: str, cmd: list, input_msg: str, env: dict):
    state = stream_states[agent]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=AGENTS[agent]["cwd"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        running_procs[agent] = proc

        proc.stdin.write(input_msg.encode())
        await proc.stdin.drain()
        proc.stdin.close()

        last_assistant_usage: dict = {}

        async for raw_line in proc.stdout:
            line = raw_line.decode().strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                etype = event.get("type")
                # assistantイベントのusageを毎回更新（最後の1回分 = 単一API呼び出し分）
                if etype == "assistant":
                    usage = event.get("message", {}).get("usage")
                    if usage:
                        last_assistant_usage = usage
                if etype == "result" and event.get("session_id"):
                    sessions[agent] = event["session_id"]
                    _save_sessions()
                    _update_agent_from_result(agent, event, last_assistant_usage)
                elif etype == "rate_limit_event":
                    info = event.get("rate_limit_info", {})
                    resets_at = info.get("resetsAt")
                    if resets_at:
                        limit_type = info.get("rateLimitType", "")
                        if "five_hour" in limit_type:
                            shared_status["five_hour_resets_at"] = resets_at
                        elif "seven_day" in limit_type:
                            shared_status["seven_day_resets_at"] = resets_at
            except json.JSONDecodeError:
                pass
            # バッファに追加（クライアントが切断していても継続）
            state.buffer.append(f"data: {line}\n\n")

        await proc.wait()
    except Exception:
        pass
    finally:
        running_procs[agent] = None
        state.complete = True


# --- 起動時クリーンアップ ---
@app.on_event("startup")
async def startup_cleanup():
    # 24時間以上前のtmpファイルを削除（再起動時に孤立したファイルを回収）
    cutoff = time.time() - 24 * 3600
    if UPLOADS_TMP.exists():
        for f in UPLOADS_TMP.iterdir():
            if f.is_file() and f.stat().st_mtime < cutoff:
                try:
                    f.unlink(missing_ok=True)
                except Exception:
                    pass
    # エラーログが10MB超えたら空にする
    log_path = Path(__file__).parent.parent / "logs" / "backend.error.log"
    if log_path.exists() and log_path.stat().st_size > 10 * 1024 * 1024:
        try:
            log_path.write_text("")
        except Exception:
            pass


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

    # 前の会話が完了済み → 新しいメッセージとして処理
    if state.complete:
        saved_files = await save_to_tmp(files, agent)
        session_id = sessions[agent]

        cmd = [config.get("claude_path", "claude")]
        if session_id:
            cmd += ["--resume", session_id]
        cmd += [
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "-p",
            "--dangerously-skip-permissions",
        ]

        content = build_content(message, saved_files)
        input_msg = json.dumps({
            "type": "user",
            "message": {"role": "user", "content": content},
        }) + "\n"

        env = os.environ.copy()
        env["ANTHROPIC_BASE_URL"] = "http://localhost:8000/proxy"

        # バッファをリセットして新しいバックグラウンドタスク開始
        state.buffer = []
        state.buffer_id = str(uuid.uuid4())
        state.complete = False
        state.task = asyncio.create_task(
            _run_claude_background(agent, cmd, input_msg, env)
        )

    # バッファからクライアントにSSE送信（切断・再接続どちらでも先頭から）
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


@app.post("/chat/{agent}/stop")
async def chat_stop(agent: str):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    proc = running_procs.get(agent)
    if proc:
        try:
            proc.terminate()
        except Exception:
            pass
        running_procs[agent] = None

    state = stream_states[agent]
    if state.task and not state.task.done():
        state.task.cancel()
    state.complete = True

    return {"status": "stopped"}


@app.post("/session/{agent}/end")
def end_session(agent: str):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")
    sessions[agent] = None
    _save_sessions()
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
    return {
        "model": a["model"],
        "ctx_pct": a["ctx_pct"],
        "five_hour_pct": shared_status["five_hour_pct"],
        "seven_day_pct": shared_status["seven_day_pct"],
        "five_hour_resets_at": shared_status["five_hour_resets_at"],
        "seven_day_resets_at": shared_status["seven_day_resets_at"],
        "streaming": not stream_states[agent].complete,
        "buffer_length": len(stream_states[agent].buffer),
        "buffer_id": stream_states[agent].buffer_id,
    }


@app.get("/chat/{agent}/reconnect")
async def reconnect_stream(agent: str, from_pos: int = Query(default=0, alias="from")):
    """バックグラウンドで処理中のストリームに再接続する。from=N で既読位置以降だけ送信"""
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    state = stream_states[agent]
    if state.complete and from_pos >= len(state.buffer):
        return Response(status_code=204)  # 完了済み かつ 未送信データなし

    async def generate():
        sent = max(0, from_pos)  # クライアントが既に受け取った位置から再開
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


# --- Anthropic リバースプロキシ ---
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

    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.request(
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


def _resolve_safe(path_str: str) -> Path:
    resolved = Path(path_str.replace("~", str(HOME))).resolve()
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


# フロントエンド静的ファイル配信（APIルートの後に配置）
FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
