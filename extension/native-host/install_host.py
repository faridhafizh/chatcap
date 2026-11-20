"""Install or remove the Chatcap native messaging host for Chrome and Edge.

Usage:
    python install_host.py <extension-id> [--python PATH] [--skip-deps]
    python install_host.py --uninstall

The extension ID is the 32-letter id shown on chrome://extensions (and
edge://extensions) after loading the unpacked ``extension/`` folder.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HOST = "com.chatcap.host"
HOST_DIR = Path(__file__).resolve().parent
HOST_SCRIPT = HOST_DIR / "chatcap_host.py"
REPO_ROOT = HOST_DIR.parent.parent
ID_RE = re.compile(r"^[a-p]{32}$")


def build_manifest(extension_id: str, python_exe: str | Path, host_script: str | Path = HOST_SCRIPT) -> dict:
    """Build the native messaging manifest (exact origin, no wildcards)."""
    if not ID_RE.fullmatch(extension_id):
        raise ValueError("extension id must be 32 lowercase letters a-p")
    return {
        "name": HOST,
        "description": "Chatcap native messaging host (Python backend)",
        "path": str(python_exe),
        "args": [str(host_script)],
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def manifest_path() -> Path:
    """Stable location for the manifest on each OS."""
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Chatcap"
    else:
        base = Path.home() / ".config" / "chatcap"
    return base / f"{HOST}.json"


def browser_host_dirs() -> list[Path]:
    """Per-browser NativeMessagingHosts folders on macOS/Linux (Windows uses registry)."""
    home = Path.home()
    if sys.platform == "darwin":
        roots = [home / "Library/Application Support/Google/Chrome",
                 home / "Library/Application Support/Microsoft Edge"]
    else:
        roots = [home / ".config/google-chrome", home / ".config/microsoft-edge"]
    return [root / "NativeMessagingHosts" for root in roots]


def _host_python(python: Path) -> Path:
    """Prefer pythonw.exe on Windows so no console window flashes."""
    if os.name == "nt":
        pythonw = python.parent / "pythonw.exe"
        if pythonw.exists():
            return pythonw
    return python


def _install_deps(python: Path) -> None:
    subprocess.check_call([str(python), "-m", "pip", "install", "-e", str(REPO_ROOT)])


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Native messaging manifests must be UTF-8 without a BOM.
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def install(extension_id: str, python: str | None = None, skip_deps: bool = False) -> Path:
    python = Path(python).expanduser().resolve() if python else Path(sys.executable)
    if not python.exists():
        raise FileNotFoundError(f"Python executable not found: {python}")

    if not skip_deps:
        print(f"Installing chatcap from {REPO_ROOT} (this needs internet the first time)…")
        _install_deps(Path(sys.executable))

    payload = build_manifest(extension_id, _host_python(python))
    target = manifest_path()
    _write_json(target, payload)

    if os.name == "nt":
        import winreg

        for subkey in (
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\Microsoft\Edge\NativeMessagingHosts",
        ):
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, subkey) as key:
                winreg.SetValueEx(key, HOST, 0, winreg.REG_SZ, str(target))
            print(f"Registered: HKCU\\{subkey}\\{HOST}")
    else:
        for directory in browser_host_dirs():
            directory.mkdir(parents=True, exist_ok=True)
            _write_json(directory / f"{HOST}.json", payload)
            print(f"Installed: {directory / (HOST + '.json')}")

    print(f"\nChatcap host installed for chrome-extension://{extension_id}/")
    print(f"Manifest: {target}")
    print("Reload the extension in chrome://extensions / edge://extensions and open a YouTube tab.")
    return target


def uninstall() -> None:
    if os.name == "nt":
        import winreg

        for subkey in (
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\Microsoft\Edge\NativeMessagingHosts",
        ):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey, 0, winreg.KEY_WRITE) as key:
                    winreg.DeleteValue(key, HOST)
            except FileNotFoundError:
                pass
            print(f"Removed: HKCU\\{subkey}\\{HOST}")
    else:
        for directory in browser_host_dirs():
            path = directory / f"{HOST}.json"
            if path.exists():
                path.unlink()
            print(f"Removed: {path}")
    path = manifest_path()
    if path.exists():
        path.unlink()
    print("Chatcap host uninstalled.")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Install/remove the Chatcap native messaging host")
    parser.add_argument("extension_id", nargs="?", help="32-letter extension id")
    parser.add_argument("--python", help="Python interpreter to launch the host with")
    parser.add_argument("--skip-deps", action="store_true", help="Do not run pip install -e .")
    parser.add_argument("--uninstall", action="store_true", help="Remove host registration")
    args = parser.parse_args(argv)

    try:
        if args.uninstall:
            uninstall()
        elif not args.extension_id:
            parser.error("extension id is required (or use --uninstall)")
        else:
            install(args.extension_id, args.python, args.skip_deps)
    except (ValueError, FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
