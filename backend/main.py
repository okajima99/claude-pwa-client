import asyncio
import base64
import json
import mimetypes
import uuid
from pathlib import Path
from typing import List

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

HOME = Path.home()
UPLOADS_TMP = HOME / "cpc" / "uploads" / "tmp"

# --- 設定読み込み ---
CONFIG_PATH = Path(__file__).parent / "config.json"
with open(CONFIG_PATH) as f:
    config = json.load(f)

AGENTS = config["agents"]
RATE_LIMITS_LOG = config["rate_limits_log"]

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

# --- 実行中プロセス管理 ---
running_procs: dict[str, asyncio.subprocess.Process | None] = {}

# --- セッションごとの一時ファイル管理 ---
session_tmp_files: dict[str, list[Path]] = {}


# --- ファイル一時保存 ---
async def save_to_tmp(files: list[UploadFile], agent: str) -> list[dict]:
    """アップロードされたファイルをtmpディレクトリに保存してパス情報を返す"""
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


# --- コンテンツブロック組み立て ---
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
            # Claudeがパスを参照できるよう通知
            content.append({
                "type": "text",
                "text": f"[添付画像のパス: {sf['path']}]",
            })
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

@app.post("/chat/{agent}/stream")
async def chat_stream(
    agent: str,
    message: str = Form(...),
    files: List[UploadFile] = File(default=[]),
):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    cwd = AGENTS[agent]["cwd"]
    session_id = sessions[agent]

    # ファイルをtmpに保存
    saved_files = await save_to_tmp(files, agent)

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

    async def generate():
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        running_procs[agent] = proc

        proc.stdin.write(input_msg.encode())
        await proc.stdin.drain()
        proc.stdin.close()

        try:
            async for raw_line in proc.stdout:
                line = raw_line.decode().strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    if event.get("type") == "result" and event.get("session_id"):
                        sessions[agent] = event["session_id"]
                        _save_sessions()
                except json.JSONDecodeError:
                    pass
                yield f"data: {line}\n\n"
        finally:
            running_procs[agent] = None
            try:
                await proc.wait()
            except Exception:
                pass

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

    return {"status": "stopped"}


@app.post("/session/{agent}/end")
def end_session(agent: str):
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    sessions[agent] = None
    _save_sessions()

    # セッションのtmpファイルを削除
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

    log_path = Path(RATE_LIMITS_LOG)
    if not log_path.exists():
        raise HTTPException(status_code=503, detail="rate-limits log not found")

    agent_model = AGENTS[agent].get("model", "").lower()  # "sonnet" or "opus"
    last_line = None
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if agent_model in entry.get("model", "").lower():
                    last_line = line
            except json.JSONDecodeError:
                pass

    if not last_line:
        raise HTTPException(status_code=503, detail="rate-limits log is empty")

    data = json.loads(last_line)
    return {
        "model": AGENTS[agent].get("model", data["model"]),
        "five_hour_pct": data["five_hour_pct"],
        "seven_day_pct": data["seven_day_pct"],
        "context_pct": data["context_pct"],
        "five_hour_resets_at": data["five_hour_resets_at"],
        "seven_day_resets_at": data["seven_day_resets_at"],
    }


def _resolve_safe(path_str: str) -> Path:
    resolved = Path(path_str.replace("~", str(HOME))).resolve()
    if not str(resolved).startswith(str(HOME)):
        raise HTTPException(status_code=403, detail="Access denied")
    return resolved


@app.get("/file")
def get_file(path: str = Query(...)):
    resolved = _resolve_safe(path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Not a file")
    try:
        content = resolved.read_text(errors="replace")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"path": str(resolved), "content": content}


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
            if entry.name.startswith("."):
                continue
            entries.append({
                "name": entry.name,
                "path": str(entry),
                "is_dir": entry.is_dir(),
            })
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"path": str(resolved), "entries": entries}
