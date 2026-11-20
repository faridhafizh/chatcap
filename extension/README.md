# Chatcap Browser Extension (Chrome / Edge)

Chatcap versi **Phase 2**: engine scraping, analytics, dan export berjalan **native di browser**
(JavaScript/TypeScript). **Python tidak dibutuhkan** untuk memakai extension ini.

```
Side Panel ──▶ Service Worker ──▶ Offscreen document (poller)
    ▲                │                    │
    │                └── relay ───────────┤ fetch youtubei/v1/*
    │                                     ▼
    └────── IndexedDB ◀────────── messages + session
                 │
                 └── analytics.js + exporters.js ──▶ chrome.downloads (JSON/CSV/MD/HTML)
```

Kenapa offscreen document? MV3 service worker dimatikan browser setelah idle ~30 detik,
sedangkan live chat butuh polling tiap 1–5 detik. Offscreen document adalah halaman
extension yang bisa tetap hidup dan menyimpan hasil ke IndexedDB, jadi capture tetap jalan
walau panel ditutup.

## Instalasi (tanpa Python)

1. Buka `chrome://extensions` atau `edge://extensions`.
2. Aktifkan **Developer mode**.
3. Klik **Load unpacked** → pilih folder `extension/` (berisi `manifest.json`).
4. Selesai. Klik ikon Chatcap di toolbar untuk membuka side panel.

> Folder `native-host/` masih ada sebagai **opsional Phase 1 fallback** (memakai backend
> Python CLI). Extension Phase 2 **tidak memanggilnya sama sekali** — permission
> `nativeMessaging` sudah dihapus dari manifest.

## Pemakaian

1. Buka video YouTube (live, replay, atau video biasa).
2. Klik **↻** di panel untuk mengisi URL + judul dari tab aktif.
3. Pilih mode **Live chat / replay** atau **Comments + replies**.
4. Isi filter keyword/user opsional (dipisah koma), lalu **Start capture** (`Ctrl/Cmd+Enter`).
5. Panel ditutup pun capture tetap berjalan; buka lagi untuk melihat progres.
6. **Stop** (`Esc`) atau tunggu stream selesai.
7. Pilih sesi di dropdown **Session**, lalu klik **JSON / CSV / MD / HTML** untuk download.
   File masuk ke folder `Downloads/chatcap/`.

Opsi (**Options** extension): prefix nama file dan auto-append video ID.

## Fitur yang di-port dari Python

| Python | Browser (Phase 2) |
|---|---|
| `streaming.py` (Innertube polling) | `src/core/innertube.js` + `src/background/capture.js` |
| `downloader.py` (renderer) | `src/core/parse.js` |
| `comments.py` (yt-dlp) | `youtubei/v1/next` + reply continuation |
| `storage.py` (atomic rewrite) | `src/storage/db.js` (IndexedDB, inkremental) |
| `analytics.py` (6 metrik) | `src/core/analytics.js` (termasuk stopword Indonesia) |
| `utils.py` (filter/warna) | `src/core/filter.js` |
| Markdown/HTML/CSV export | `src/core/exporters.js` |

Skema pesan **identik** dengan CLI — file di `Example/` tetap bisa dianalisis.

## Detail teknis

- API key & client version dibaca dari halaman watch (`INNERTUBE_API_KEY`,
  `INNERTUBE_CLIENT_VERSION`) via fetch dari extension context (host permission
  `https://www.youtube.com/*` mengabaikan CORS).
- YouTube menolak POST `youtubei/v1/*` dengan `Origin: chrome-extension://…`
  (HTTP 403 "Sorry..."). Rule statis `rules/youtube-origin.json` menulis ulang
  header `Origin` menjadi `https://www.youtube.com` untuk request POST ke
  `www.youtube.com/youtubei/`, sehingga tidak ada lagi 403 dari extension.
- Live chat: `youtubei/v1/live_chat/get_live_chat`, token lanjutan diambil dari
  `continuations[].invalidationContinuationData.continuation`, delay mengikuti
  `timeoutMs` (clamp 1–5 dtk). Replay pakai `live_chat/get_live_chat_replay`.
- Komentar: `youtubei/v1/next`. YouTube memakai skema baru `commentViewModel` +
  `frameworkUpdates.entityBatchUpdate` (bukan lagi `commentRenderer`), jadi kedua
  bentuk didukung. Capture otomatis pindah dari sort **Top** ke **Newest** agar
  mendapat seluruh komentar, mengikuti `continuationItemRenderer` untuk halaman
  berikutnya, dan membuka balasan via token di `replies.commentRepliesRenderer`.
  Halaman lanjutan balasan ("Show more replies") menaruh token di
  `button.buttonRenderer.command.continuationCommand`; token bersarang ini juga
  diikuti agar thread dengan puluhan balasan tidak berhenti di batch pertama.
- Deteksi tipe pesan: teks, Super Chat (`purchaseAmountText`), membership
  (`headerSubtext`/`headerPrimaryText`).
- Timestamp stream relatif (`H:MM:SS` + `video_offset_ms`) dihitung dari `startTimestamp`.
- Dedup by `message_id`, filter di jalur capture, flush ke IndexedDB tiap ~1 detik.
- Offscreen document dibuat saat mulai capture. Jika browser menolak pembuatan
  offscreen, capture otomatis berjalan di side panel (selama panel terbuka) dan
  pesan error lengkap ditampilkan — Start tidak lagi diblokir.


## Permission

| Permission | Alasan |
|---|---|
| `sidePanel` | UI utama |
| `activeTab`, `tabs` | baca URL tab YouTube aktif |
| `storage` | simpan konfigurasi & status |
| `downloads` | simpan file export |
| `offscreen` | poller tahan lama di MV3 |
| `declarativeNetRequestWithHostAccess`, rule `rules/youtube-origin.json` | ubah `Origin` request Innertube agar YouTube tidak menolak dengan 403 |
| `host_permissions: youtube.com` | fetch Innertube API |

## Limitasi

- Bergantung pada struktur internal YouTube; jika berubah, parser perlu di-update
  (sama seperti risiko `yt-dlp` di CLI).
- Live chat tidak punya `like_count` → metrik "most liked" hanya untuk mode komentar.
- Handoff config ke offscreen memakai port `chrome.runtime` (offscreen document hanya
  boleh memakai API `runtime`, bukan `chrome.storage`); `chrome.storage.local` dipakai
  panel untuk menyimpan pengaturan.
- Log di panel dibatasi 5.000 baris; semua pesan tetap tersimpan di IndexedDB.

## Test

```bash
# core engine + polling loop (Node, tanpa browser)
cd extension && npm test

# uji langsung ke YouTube (butuh internet)
node tools/smoke.mjs "https://www.youtube.com/watch?v=VIDEO_ID" comment
node tools/smoke.mjs "https://www.youtube.com/watch?v=VIDEO_ID" live
node tools/engine-smoke.mjs "https://www.youtube.com/watch?v=VIDEO_ID" comment
node tools/engine-smoke.mjs "https://www.youtube.com/watch?v=LIVE_ID" live 8

# manifest + host lama (Python)
python -m pytest tests -q
```

## Uninstall

Hapus extension dari `chrome://extensions` / `edge://extensions`. Data IndexedDB
bisa dihapus dari Chrome DevTools → Application → IndexedDB → `chatcap`.
