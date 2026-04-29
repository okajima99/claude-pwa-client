"""VAPID 鍵ペアを生成して backend/vapid.json に書き出す。

Web Push 機能を使うには 1 度だけこのスクリプトを実行する。
出力ファイルは gitignore 済み (公開リポでの鍵漏洩を防ぐため)。

使い方:
    python gen_vapid.py [--force]
"""
import argparse
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


VAPID_PATH = Path(__file__).parent / "vapid.json"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="既存の vapid.json を上書き")
    args = parser.parse_args()

    if VAPID_PATH.exists() and not args.force:
        print(f"{VAPID_PATH} は既に存在します。上書きするには --force を付けてください。")
        return

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    # PEM (private) — pywebpush に渡す
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")

    # 公開鍵を base64url エンコード (raw uncompressed point) — フロントの applicationServerKey 用
    public_raw = public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    public_b64 = b64url(public_raw)

    payload = {
        "private_pem": private_pem,
        "public_key": public_b64,
    }
    VAPID_PATH.write_text(json.dumps(payload, indent=2))
    VAPID_PATH.chmod(0o600)
    print(f"VAPID 鍵を生成しました: {VAPID_PATH}")
    print(f"public_key (フロント config に渡す): {public_b64}")


if __name__ == "__main__":
    main()
