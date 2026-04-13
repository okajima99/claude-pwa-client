import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

HOME = Path.home()

# --- 設定読み込み ---
CONFIG_PATH = Path(__file__).parent / "config.json"
with open(CONFIG_PATH) as f:
    config = json.load(f)

AGENTS = config["agents"]
RATE_LIMITS_LOG = config["rate_limits_log"]

# --- アプリ初期化 ---
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- セッション管理（メモリ上） ---
sessions: dict[str, str | None] = {name: None for name in AGENTS}

# --- 実行中プロセス管理（停止ボタン用） ---
running_procs: dict[str, asyncio.subprocess.Process | None] = {}


# --- リクエスト/レスポンス型定義 ---
class ChatRequest(BaseModel):
    message: str


class StatusResponse(BaseModel):
    model: str
    five_hour_pct: float
    seven_day_pct: float
    context_pct: float
    five_hour_resets_at: int
    seven_day_resets_at: int


# --- エンドポイント ---

@app.post("/chat/{agent}/stream")
async def chat_stream(agent: str, req: ChatRequest):
    """メッセージを送信してエージェントの出力をSSEでストリーミングする"""
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    cwd = AGENTS[agent]["cwd"]
    session_id = sessions[agent]

    cmd = [config.get("claude_path", "claude")]
    if session_id:
        cmd += ["--resume", session_id]
    cmd += ["-p", req.message, "--output-format", "stream-json", "--verbose"]

    async def generate():
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        running_procs[agent] = proc

        try:
            async for raw_line in proc.stdout:
                line = raw_line.decode().strip()
                if not line:
                    continue
                # session_idをresultイベントから保存
                try:
                    event = json.loads(line)
                    if event.get("type") == "result" and event.get("session_id"):
                        sessions[agent] = event["session_id"]
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
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/chat/{agent}/stop")
async def chat_stop(agent: str):
    """実行中のサブプロセスをkillする"""
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
    """セッションを終了してsession_idをリセットする"""
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    sessions[agent] = None
    return {"status": "ok", "agent": agent}


@app.get("/status/{agent}", response_model=StatusResponse)
def get_status(agent: str):
    """rate-limits.jsonlから最新のusage情報とエージェントのモデルを返す"""
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    log_path = Path(RATE_LIMITS_LOG)
    if not log_path.exists():
        raise HTTPException(status_code=503, detail="rate-limits log not found")

    last_line = None
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if line:
                last_line = line

    if not last_line:
        raise HTTPException(status_code=503, detail="rate-limits log is empty")

    data = json.loads(last_line)
    return StatusResponse(
        model=AGENTS[agent].get("model", data["model"]),
        five_hour_pct=data["five_hour_pct"],
        seven_day_pct=data["seven_day_pct"],
        context_pct=data["context_pct"],
        five_hour_resets_at=data["five_hour_resets_at"],
        seven_day_resets_at=data["seven_day_resets_at"],
    )


def _resolve_safe(path_str: str) -> Path:
    """パスを解決してHOME配下かチェック。違う場合は403を返す"""
    resolved = Path(path_str.replace("~", str(HOME))).resolve()
    if not str(resolved).startswith(str(HOME)):
        raise HTTPException(status_code=403, detail="Access denied")
    return resolved


@app.get("/file")
def get_file(path: str = Query(...)):
    """ファイル内容をテキストで返す（HOME配下のみ）"""
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
    """ディレクトリ一覧を返す（HOME配下のみ）"""
    resolved = _resolve_safe(path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Directory not found")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    entries = []
    try:
        for entry in sorted(resolved.iterdir(), key=lambda e: (e.is_file(), e.name.lower())):
            if entry.name.startswith('.'):
                continue
            entries.append({
                "name": entry.name,
                "path": str(entry),
                "is_dir": entry.is_dir(),
            })
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"path": str(resolved), "entries": entries}
