"""セッション (= UI 上の 1 タブ) ごとに分かれた append-only デバッグログ。

`logs/sessions/<session_id>.log` にセッション固有の wire / msg / drain 等の足跡を
書き出す。 「セッション終了」 ボタン押下時にマーカー行 (`=== SESSION END ... ===`) を
入れて区切りとし、 2 セッション前以前 (= 最新 2 セッション分より古い) を prune する。

呼び出し側は `session_log(sid, "...")` を logger.info 代わりに使うイメージ。
"""
import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)

LOG_ROOT = Path(__file__).parent.parent / "logs" / "sessions"
LOG_ROOT.mkdir(parents=True, exist_ok=True)

# 「セッション終了」 を区切る一意な行頭プリフィックス。 検索しやすく、 通常ログとぶつからない
SESSION_END_PREFIX = "=== SESSION END "
# 1 タブが「現在 + 1 個前」 の 2 セッションぶんまで保持する
KEEP_SESSIONS = 2


def _path_for(session_id: str) -> Path:
    # session_id は内部生成 (ses_xxxx) なのでパス事故は無いが保険として basename 化
    safe = session_id.replace("/", "_").replace("\\", "_")
    return LOG_ROOT / f"{safe}.log"


def session_log(session_id: str, line: str) -> None:
    """1 行追記。 line に改行文字は含まない前提 (内部で 1 行 = 1 イベント)。"""
    if not session_id:
        return
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with _path_for(session_id).open("a", encoding="utf-8") as f:
            f.write(f"{ts} {line}\n")
    except Exception:
        # ログ失敗で本処理を巻き込まない
        logger.exception("session_log write failed for session=%s", session_id)


def mark_session_end(session_id: str) -> None:
    """セッション終了の境界マーカーを 1 行入れる。 prune の区切りとして読まれる。"""
    if not session_id:
        return
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"{SESSION_END_PREFIX}{ts} ===\n"
    try:
        with _path_for(session_id).open("a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        logger.exception("mark_session_end failed for session=%s", session_id)


def prune_session_log(session_id: str, keep: int = KEEP_SESSIONS) -> None:
    """ファイル内のマーカー数を見て、 末尾 `keep` セッションぶんより古い行を捨てる。

    マーカーは「セッション終了」 1 個 = 1 個前のセッションが終わったことを示す。
    keep=2 なら「現在進行中のセッション + 直前に終了した 1 セッション」 が残る。
    つまり末尾から数えて `keep-1` 個目のマーカー以前は削除対象。
    """
    p = _path_for(session_id)
    if not p.exists():
        return
    try:
        lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
    except Exception:
        logger.exception("prune read failed for session=%s", session_id)
        return

    # 末尾から走査して keep-1 個目のマーカー位置を探す。
    # 例: keep=2 なら 1 個目のマーカー = 末尾側から数えて 1 個目 (= 最新の終了マーカー)。
    #   その「前」 を全部捨てたいわけではなく、 そこから「もう 1 個前のマーカー」 までを
    #   保持したい。 結局 N 個目のマーカー (N = 残したいセッション数) より前を捨てれば良い。
    threshold_index = -1  # ここより前を削除
    found = 0
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].startswith(SESSION_END_PREFIX):
            found += 1
            if found == keep:
                threshold_index = i
                break

    if threshold_index <= 0:
        # マーカーが keep 個未満 = まだ削るほど履歴が無い
        return

    new_content = "".join(lines[threshold_index + 1:])
    try:
        # 一時ファイルに書いてから差し替え (atomic)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(new_content, encoding="utf-8")
        tmp.replace(p)
    except Exception:
        logger.exception("prune write failed for session=%s", session_id)


def delete_session_log(session_id: str) -> None:
    """セッション削除時に丸ごと unlink。"""
    p = _path_for(session_id)
    try:
        p.unlink(missing_ok=True)
        # tmp が残ってる稀ケースも掃除
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.unlink(missing_ok=True)
    except Exception:
        logger.exception("delete_session_log failed for session=%s", session_id)


def prune_all_existing(session_ids: list[str]) -> None:
    """起動時の 1 回掃除: 現存する session_id すべてに対して prune を試行。"""
    for sid in session_ids:
        prune_session_log(sid)
