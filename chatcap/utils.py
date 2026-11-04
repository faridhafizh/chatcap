from typing import Callable

import hashlib


def make_filter(keywords: list[str] | None, users: list[str] | None) -> Callable[[dict], bool]:
    keywords = [k.lower() for k in (keywords or []) if k]
    users = [u.lower() for u in (users or []) if u]

    def predicate(msg: dict) -> bool:
        if not keywords and not users:
            return True
        comment = (msg.get("comment") or msg.get("message") or "").lower()
        name = (msg.get("user_display_name") or msg.get("author") or "").lower()
        uid = (msg.get("user_id") or "").lower()
        if keywords and any(k in comment for k in keywords):
            return True
        if users and any(u in name or u in uid for u in users):
            return True
        return False

    return predicate


PALETTE = [
    "bright_cyan", "bright_magenta", "bright_green", "bright_yellow",
    "bright_blue", "bright_red", "cyan", "magenta", "green", "yellow",
    "blue", "red",
]
PLAIN_TYPES = {"text", "comment", "chat", "textmessage"}


def user_color(name: str) -> str:
    """Deterministically pick a colour for a username."""
    h = int(hashlib.sha256(name.encode("utf-8")).hexdigest(), 16)
    return PALETTE[h % len(PALETTE)]
