"""Accounts, roles and signed session tokens for RapidAid.

Roles:
  dispatcher -> command centre (demo admin login)
  user       -> normal requester portal (any registered email)
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from typing import Optional

TOKEN_SECRET = os.getenv("RAPIDAID_TOKEN_SECRET", "local-demo-change-this-secret")
TOKEN_TTL_SECONDS = 8 * 60 * 60


def _csv_env(name: str, default: str) -> set:
    return {v.strip().lower() for v in os.getenv(name, default).split(",") if v.strip()}


# Demo dispatcher login: any of these ids with any of these passwords.
# Defaults: admin / admin123  (and admin123 / admin).  Override in .env.
DISPATCHER_IDS = _csv_env("DEMO_DISPATCHER_IDS", "admin,admin123")
DISPATCHER_PASSWORDS = {v.strip() for v in os.getenv("DEMO_DISPATCHER_PASSWORDS", "admin123,admin").split(",") if v.strip()}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _sign(encoded: str) -> str:
    return _b64(hmac.new(TOKEN_SECRET.encode(), encoded.encode(), hashlib.sha256).digest())


def issue_token(sub: str, role: str, name: str = "") -> str:
    payload = json.dumps({"sub": sub, "role": role, "name": name, "exp": int(time.time()) + TOKEN_TTL_SECONDS}, separators=(",", ":")).encode()
    encoded = _b64(payload)
    return encoded + "." + _sign(encoded)


def read_token(token: str) -> Optional[dict]:
    try:
        encoded, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, _sign(encoded)):
            return None
        data = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if data.get("exp", 0) < time.time():
            return None
        return data
    except Exception:
        return None


def is_demo_dispatcher(identifier: str, password: str) -> bool:
    ok_id = identifier.strip().lower() in DISPATCHER_IDS
    ok_pw = any(hmac.compare_digest(password, p) for p in DISPATCHER_PASSWORDS)
    return ok_id and ok_pw


class UserStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at REAL NOT NULL)"
            )

    @staticmethod
    def _hash(password: str, salt: str) -> str:
        return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()

    def create(self, name: str, email: str, password: str) -> bool:
        salt = secrets.token_hex(16)
        try:
            with sqlite3.connect(self.db_path) as db:
                db.execute(
                    "INSERT INTO users(email,name,salt,pw_hash,created_at) VALUES(?,?,?,?,?)",
                    (email, name, salt, self._hash(password, salt), time.time()),
                )
            return True
        except sqlite3.IntegrityError:
            return False

    def verify(self, email: str, password: str) -> Optional[str]:
        """Returns the user's display name if the credentials are valid."""
        with sqlite3.connect(self.db_path) as db:
            row = db.execute("SELECT name, salt, pw_hash FROM users WHERE email=?", (email,)).fetchone()
        if not row:
            return None
        return row[0] if hmac.compare_digest(self._hash(password, row[1]), row[2]) else None