<div align="center">

# 💬 Chatcap

**Capture YouTube live chat and comments from your terminal — in real time, saved as clean JSON.**

[![Python](https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TUI](https://img.shields.io/badge/UI-Textual-8A2BE2)](https://github.com/Textualize/textual)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](pyproject.toml)

</div>

---

## Overview

**Chatcap** is a lightweight command-line tool with a live terminal UI for capturing YouTube **live chat** and **video comments**. Give it a video URL and it will:

- stream chat messages to a colorful, scrollable terminal view as they arrive,
- continuously write everything to a structured JSON file, and
- exit cleanly without ever leaving you with a corrupted output file.

It works with live streams, stream replays (VODs), and regular video comment sections, including replies.

## Features

- 🔴 **Live chat streaming** — messages appear in real time, with YouTube's suggested poll delay respected.
- ⏪ **Replay support** — automatically detects live vs. replay and walks the full chat history of ended streams.
- 💬 **Full comment scraping** — `--comment` mode fetches all top-level comments *and* replies via `yt-dlp`.
- 💎 **Rich message types** — Super Chats and memberships are detected and highlighted separately from plain text.
- 🖥️ **Interactive TUI** — built with [Textual](https://github.com/Textualize/textual) and [Rich](https://github.com/Textualize/rich): per-user colors, live status bar, and a rolling log.
- 💾 **Crash-safe saving** — JSON is written atomically (temp file + replace), throttled to about once per second, and force-saved on exit.
- ⏱️ **Stream-relative timestamps** — live messages are stamped with elapsed stream time (`H:MM:SS`) plus a `video_offset_ms` value.
- 🔁 **Resilient polling** — retries on transient errors, de-duplicates messages by ID, and refreshes continuation tokens when a live chat goes quiet.

## Requirements

- Python **3.10** or newer
- Dependencies (installed automatically): `textual`, `rich`, `yt-dlp`, `yt-chat-downloader`, `python-dateutil`

## Installation

```bash
git clone https://github.com/faridhafizh/chatcap.git
cd chatcap

# (recommended) create a virtual environment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install -e .
```

This installs the `chatcap` command.

## Usage

```bash
chatcap <VIDEO_URL> [--comment] [-o OUTPUT]
```

Equivalent ways to run it:

```bash
chatcap "https://www.youtube.com/watch?v=VIDEO_ID"
python -m chatcap "https://www.youtube.com/watch?v=VIDEO_ID"
python index.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

### Examples

```bash
# Capture a live stream's chat (saved to my_live_chat.json)
chatcap "https://www.youtube.com/watch?v=VIDEO_ID"

# Capture all comments and replies (saved to my_comments.json)
chatcap "https://www.youtube.com/watch?v=VIDEO_ID" --comment

# Choose your own output file
chatcap "https://www.youtube.com/watch?v=VIDEO_ID" -o stream_2026-11-02.json
```

### Command-line options

| Argument | Description | Default |
|---|---|---|
| `video_url` | YouTube video URL (required) | — |
| `--comment`, `--comments` | Scrape regular comments (including replies) instead of streaming live chat | off |
| `-o`, `--output` | Output JSON file path | `my_live_chat.json` / `my_comments.json` |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `q` or `Ctrl+C` | Quit (data is saved before exit) |
| `c` | Clear the on-screen log (messages keep being saved) |

## Output format

Chatcap writes a JSON array, one object per message. Full samples are available in the [`Example/`](Example) folder.

**Live chat** (`Example/Youtube-Live-Chats.json`)

```json
{
  "user_id": "UCtuK2Kk2Ndfg-gZEdUTxjoA",
  "user_display_name": "@swag_lord_2000",
  "user_handle": "@swag_lord_2000",
  "datetime": "2026-11-02T14:34:36.410265",
  "timestamp": "3:34:51",
  "comment": "clutch rescue from Kyoko actually",
  "message_type": "text",
  "badges": ["Member (1 year)"],
  "message_id": "ChwKGkNQeWp5N2ZWNkpjREZSZktMUUFkYktjRDFR",
  "purchase_amount": "",
  "video_offset_ms": "12891410"
}
```

**Comments** (`Example/Youtube-VOD-Comments.json`) include extra fields:

```json
{
  "message_type": "comment",
  "like_count": 13,
  "is_reply": true,
  "parent_id": "UgwxryhN972yKFfFzc54AaABAg",
  "is_pinned": false,
  "is_favorited": true,
  "author_is_uploader": false,
  "author_thumbnail": "https://..."
}
```

### Message types

| `message_type` | Meaning |
|---|---|
| `text` | Regular live chat message |
| `super_chat` | Paid Super Chat (see `purchase_amount`) |
| `membership` | Membership event or milestone |
| `comment` | Regular video comment (top-level or reply) |

## How it works

```
chatcap/
├── cli.py            # Argument parsing and entry point
├── app.py            # Textual TUI: status bar, log, key bindings, worker thread
├── streaming.py      # Live chat / replay polling loop (generator-based)
├── comments.py       # Comment scraper built on yt-dlp
├── downloader.py     # yt-chat-downloader subclass: Super Chat/membership detection, timestamp fixes
├── storage.py        # Atomic JSON writer
├── utils.py          # Deterministic per-user color palette
└── worker_control.py # Cooperative stop signal for the worker thread
```

- A background worker thread fetches data while the Textual UI renders it, so the interface stays responsive.
- Every message is appended to an in-memory list and flushed to disk through `save_json_atomic`.
- In comment mode, `yt-dlp`'s internal comment generator is wrapped so comments show up in the UI as they arrive instead of only at the very end.

## Project structure

```
chatcap/
├── Example/                    # Sample JSON output
│   ├── Youtube-Live-Chats.json
│   └── Youtube-VOD-Comments.json
├── chatcap/                    # Python package
├── index.py                    # Compatibility entry point
├── pyproject.toml              # Packaging and dependencies
├── LICENSE
└── README.md
```

## Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| `No live-chat continuation found` | The video has no live chat or replay chat. Try `--comment` instead. |
| `No comments found — they may be disabled` | The uploader disabled comments, or YouTube blocked the request. |
| Comment mode stops early | `yt-dlp` hit an error mid-way. Chatcap keeps what it collected; update with `pip install -U yt-dlp` and retry. |
| Extraction errors after a YouTube change | Update the scraping libraries: `pip install -U yt-dlp yt-chat-downloader`. |

## Disclaimer

Chatcap relies on unofficial scraping of public YouTube pages and may break if YouTube changes its internals. Use it responsibly and in line with [YouTube's Terms of Service](https://www.youtube.com/t/terms) and applicable privacy laws. Captured data contains public usernames and messages, so handle and share it with care.

## Contributing

Issues and pull requests are welcome. To get started:

```bash
git clone https://github.com/faridhafizh/chatcap.git
cd chatcap
pip install -e .
```

Please keep changes focused, and describe how you tested them in your pull request.

## License

Released under the [MIT License](LICENSE). © 2026 Muhammad Farid Hafizh.
