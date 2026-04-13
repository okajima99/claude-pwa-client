import json
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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
# キー: agent名 ("agent_a" / "agent_b"), 値: session_id または None
sessions: dict[str, str | None] = {name: None for name in AGENTS}


# --- リクエスト/レスポンス型定義 ---
class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    result: str
    session_id: str


class StatusResponse(BaseModel):
    model: str
    five_hour_pct: float
    seven_day_pct: float
    context_pct: float
    five_hour_resets_at: int
    seven_day_resets_at: int


# --- エンドポイント ---

@app.post("/chat/{agent}", response_model=ChatResponse)
def chat(agent: str, req: ChatRequest):
    """メッセージを送信してエージェントの返答を返す"""
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    cwd = AGENTS[agent]["cwd"]
    session_id = sessions[agent]

    # claudeコマンドの組み立て
    cmd = ["claude"]
    if session_id:
        cmd += ["--resume", session_id]
    cmd += ["-p", req.message, "--output-format", "json"]

    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)

    data = json.loads(result.stdout)
    sessions[agent] = data["session_id"]

    return ChatResponse(result=data["result"], session_id=data["session_id"])


@app.post("/session/{agent}/end")
def end_session(agent: str):
    """セッションを終了してsession_idをリセットする"""
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent}' not found")

    sessions[agent] = None
    return {"status": "ok", "agent": agent}


@app.get("/status", response_model=StatusResponse)
def get_status():
    """rate-limits.jsonlから最新のusage情報を返す"""
    log_path = Path(RATE_LIMITS_LOG)
    if not log_path.exists():
        raise HTTPException(status_code=503, detail="rate-limits log not found")

    # 最終行を取得
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
        model=data["model"],
        five_hour_pct=data["five_hour_pct"],
        seven_day_pct=data["seven_day_pct"],
        context_pct=data["context_pct"],
        five_hour_resets_at=data["five_hour_resets_at"],
        seven_day_resets_at=data["seven_day_resets_at"],
    )
