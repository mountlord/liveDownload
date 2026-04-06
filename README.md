# liveDownload

A Chrome extension for unattended live stream recording and VOD downloading from any HLS/DASH-based streaming platform that permits downloads.

---

## Features

- **Unattended live recording** — add broadcaster URLs to the Watch List and liveDownload polls them automatically. When a stream goes live, recording starts without any user interaction.
- **Resilient recording** — survives network interruptions, CDN hiccups, and broadcaster restarts. Recovery mode detects stream resumption and continues recording into a new file automatically.
- **VOD downloading** — download single or batch HLS/DASH VOD streams to a folder you choose.
- **Auto-translate titles** — optionally translates Korean/Japanese stream titles to English before saving (uses Google Translate, opt-in, off by default).
- **Rust/WASM segment fetcher** — the core segment fetch pipeline (retry logic, timeout management, error classification) runs as compiled Rust/WASM, not plain JavaScript.
- **RDP/headless server support** — designed to run on unattended media servers managed via Remote Desktop.

---

## Installation

1. Download the latest release zip from the [Releases](https://github.com/mountlord/livedownload/releases) page
2. Unzip to a local folder
3. Open Chrome and navigate to `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the `Extension` folder
6. The liveDownload icon appears in the toolbar

---

## Quick Start

### Manual recording
1. Navigate to a live stream page (e.g. `play.livebroadcast.com/broadcaster`)
2. Click the liveDownload icon — the recorder window opens
3. Detected streams appear under **Available Streams**
4. Select a stream and click **Download Selected**

### Auto-recording (unattended)
1. Click the liveDownload icon to open the recorder window
2. Expand the **Wait for Recording URLs** section
3. Paste broadcaster URLs and click **+ Add**
4. liveDownload polls each URL every 15 minutes (configurable). When a stream goes live, recording starts automatically.

---

## Setting a Recording Folder

By default, recordings go to your browser's Downloads folder. To save to a specific folder:

1. Click ⚙️ **Settings** in the header
2. Under **Root Download Directory**, click **Choose Folder**
3. Select your folder and click **Save Settings**

The folder selection survives browser restarts. A file called `liveFolder.TXT` is written to the folder when you save — this is normal and is used to maintain folder access across restarts.

---

## Wait for Recording URLs (WRU)

The WRU system is the heart of unattended recording.

| Button | Action |
|--------|--------|
| **+ Add** | Add a single broadcaster URL |
| **📤 Export** | Save the current list to a JSON file |
| **📥 Import** | Load a list from a JSON file |
| **🔄 Poll Now** | Immediately check all active URLs |
| **⏸️ Suspend** | Pause automatic polling |
| **▶️ Resume** | Resume automatic polling |

liveDownload skips URLs that are already recording — no duplicate recordings.

---

## Live Recording Dashboard

Once recording starts, the dashboard shows:

| Stat | Description |
|------|-------------|
| ⏱️ Duration | Elapsed recording time |
| 📦 Downloaded | Total data written to disk |
| 📁 Segments | Segments successfully downloaded |
| ⚠️ Fails | Failed / total segments and fail rate |
| 📋 Queue | Segments waiting to be downloaded |

### Recovery Mode

If the stream is interrupted (authentication expiry, broadcaster restart, network failure), liveDownload enters Recovery Mode:

- The current file is finalized and saved
- A background tab opens the broadcaster's page
- When the stream reappears, recording resumes into a new file automatically
- Recovery times out after 10 minutes if no stream is found

---

## VOD Downloads

For pre-recorded content, liveDownload detects m3u8/mpd playlist URLs on the page and lists them under **Available Streams**.

- **Single download** — select one stream and click **Download Selected**
- **Batch download** — select multiple streams, click **Download Selected**, choose a folder — each stream saves as a separate file

---

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| Root Download Directory | — | Folder where recordings are saved |
| Resilient Mode | ON | Keep recording through errors; never auto-stop |
| Max Manifest Errors | 10 | Stop after this many consecutive errors (Resilient Mode OFF only) |
| Recovery Poll Interval | 5 min | How often to check for stream restart during recovery |
| Errors Before Recovery | 100 | Consecutive errors (~5 min) before entering recovery |
| Auto-Translate Titles | OFF | Translate titles to English via Google Translate before saving |
| Check Interval | 15 min | How often WRU polls broadcaster URLs |
| Monitor Window Timeout | 45 s | How long to wait per URL before moving to the next |
| Auto Close When Done | OFF | Close the recorder window after download completes |
| Detect Streams in XHR | OFF | Intercept XHR responses for broader stream detection |

---

## Output Files

Live recordings are saved as `.ts` (MPEG-TS) files.

**Filename format:** `[Title]-[Mon]-[DD]-[YYYY]-[H]-[MM]-[SS][AM/PM].ts`

Example: `BroadcasterName-Apr-04-2026-10-33-05PM.ts`

Recovery files from the same session share the same base name with a new timestamp, making them easy to identify and concatenate.

### Converting to MP4

```bash
ffmpeg -i recording.ts -c copy output.mp4
```

> **Note:** ffmpeg may show "Packet corrupt" warnings when converting some recordings. This is cosmetic — the DTS values from recording's session clock are high but valid. Output quality is unaffected.

---

## What We Tested

| Platform | Live Recording | VOD Download |
|----------|---------------|--------------|
| SOOP (sooplive.com) | ✅ Full support | ✅ |
| Twitch | ⚠️ Tested, token expiry recovery pending | ✅ AES-128 + fMP4 |
| HLS (m3u8) | ✅ | ✅ |
| DASH (mpd) | ✅ | ✅ |

---

## Privacy

- **No telemetry.** liveDownload does not collect, transmit, or store any usage data.
- **No ads.** No advertising of any kind.
- **Google Translate** is used only if you enable Auto-Translate Titles in Settings (off by default). When enabled, stream titles are sent to Google Translate. This feature is off by default. Use at your own choosing. This is the only feature where you data leaves your environment.
- **Autoplay assistance.** To start stream playback on monitored pages, liveDownload injects mouse click events into the player area. This can be disabled in Settings.
- **Sound permission.** To ensure autoplay works on monitored sites, liveDownload sets Chrome's sound permission to "Allow" for those origins. This setting is applied only to URLs you have added to the Watch List.

---

## Permissions

| Permission | Why it's needed |
|-----------|----------------|
| `host_permissions: *://*/*` | Detect media streams on any page the user browses |
| `webRequest` | Intercept network responses to identify m3u8/mpd streams |
| `scripting` | Inject player-start clicks into monitored pages |
| `contentSettings` | Allow autoplay/sound on broadcaster pages |
| `system.display` | Position monitoring windows on-screen correctly (RDP support) |
| `storage` | Save settings and WRU list |
| `alarms` | Schedule polling at configured intervals |

---

## Architecture Notes

- **Service worker** (`worker.js`) — watches network responses, manages WRU polling, registers recording windows
- **Recorder window** (`recorder/`) — live recording engine, VOD downloader, settings UI
- **WASM module** (`wasm/`) — Rust-compiled segment fetch pipeline - you stream does not leave your environment
- **Live system** (`live/`) — polling manager, window manager, recording registry, WRU manager

---

## Acknowledgements

This project was inspired by:
Chandler Stimson's https://github.com/chandler-stimson/live-stream-downloader

---

## License

AGPL 3.0 — see [LICENSE](LICENSE) for details.

The Rust/WASM module (`livedownload_core`) is original work and distributed only in compiled binary form.

---

## Donate

If liveDownload has been useful to you, consider donating to [Save the Children](https://www.savethechildren.org/savekids).

*liveDownload is not affiliated with Save the Children. The donate button opens their official donation page.*
