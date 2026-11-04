import contextlib
import json
import os
import tempfile


def save_json_atomic(messages: list[dict], path: str) -> None:
    """Write JSON via a temp file so a crash/quit can't leave a half-written file."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(messages, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
