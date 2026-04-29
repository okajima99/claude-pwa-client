"""ホームディレクトリ配下のファイル閲覧・編集 / ディレクトリツリー取得。"""
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query

from config import FILE_SIZE_LIMIT, HOME

router = APIRouter()


def _resolve_safe(path_str: str) -> Path:
    resolved = Path(path_str).expanduser().resolve()
    if not str(resolved).startswith(str(HOME)):
        raise HTTPException(status_code=403, detail="Access denied")
    return resolved


@router.get("/file")
def get_file(path: str = Query(...)):
    resolved = _resolve_safe(path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Not a file")
    if resolved.stat().st_size > FILE_SIZE_LIMIT:
        raise HTTPException(status_code=413, detail="ファイルが大きすぎます（上限 1MB）")
    try:
        content = resolved.read_text(errors="replace")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"path": str(resolved), "content": content}


@router.put("/file")
def put_file(path: str = Body(...), content: str = Body(...)):
    resolved = _resolve_safe(path)
    if resolved.exists() and not resolved.is_file():
        raise HTTPException(status_code=400, detail="Not a file")
    try:
        resolved.write_text(content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@router.get("/files/tree")
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
