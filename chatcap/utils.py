import hashlib


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
