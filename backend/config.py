"""アプリ設定の読み込みと、複数モジュールから参照する定数。"""
import json
from pathlib import Path

HOME = Path.home()

CONFIG_PATH = Path(__file__).parent / "config.json"

with open(CONFIG_PATH) as f:
    config = json.load(f)

# --- agent 定義 ---
AGENTS: dict = config["agents"]

# --- ファイル系 ---
# uploads_tmp は config.json で上書き可能。
UPLOADS_TMP = Path(config.get("uploads_tmp", str(HOME / ".claude-pwa-client" / "uploads" / "tmp"))).expanduser()
SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
FILE_SIZE_LIMIT = 1 * 1024 * 1024  # 1MB

# --- Anthropic 直結 ---
ANTHROPIC_API_BASE = "https://api.anthropic.com"
CLAUDE_PATH = config.get("claude_path")

# --- Web Push 関連 ---
# VAPID claim の sub (連絡先)。デフォルトは汎用 mailto。
VAPID_SUB = config.get("vapid_sub", "mailto:admin@example.com")
# OS 通知のタイトル既定値。エージェント別は agents.<name>.notification_title で上書き。
NOTIFICATION_TITLE_DEFAULT = config.get("notification_title", "Notification")
