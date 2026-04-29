"""Anthropic API のリバースプロキシ。
rate-limit ヘッダを観測したいので、SDK を直結せず自プロセスを経由させる。
"""
from fastapi import APIRouter, Request
from fastapi.responses import Response

import http_client
from config import ANTHROPIC_API_BASE
from state import update_shared_from_headers

router = APIRouter()


@router.api_route(
    "/proxy/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def anthropic_proxy(path: str, request: Request):
    target_url = f"{ANTHROPIC_API_BASE}/{path}"
    if request.query_params:
        target_url += f"?{request.query_params}"

    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length")
    }

    client = http_client.get()
    resp = await client.request(
        method=request.method,
        url=target_url,
        headers=headers,
        content=body,
    )

    update_shared_from_headers(resp.headers)

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
