# Changelog

All notable changes to liveDownload will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-12-29

### Added
- Modern blue gradient UI design
- Scrollable streams table with fixed header (500px max height)
- Gmail-style checkbox in table header for "select all"
- Floating recording badge showing real-time stats
- Non-blocking toast notifications for batch failures and completion
- Separate "Live Recording Threads" setting (default: 1)
- Root directory persistence via IndexedDB
- Smart master playlist detection
- Debug logging for stream type detection
- Settings panel with explicit Save/Cancel buttons
- Batch size slider (10-1000, default: 20)

### Changed
- Window opens at 1000x600 (optimized for content width)
- Batch size reduced from 50 to 20 (better for <1hr recordings)
- Stream table auto-detects LIVE vs VOD and shows appropriate button
- Master playlists now show "Download" instead of incorrectly showing "Record"
- Container width set to 100% (no max-width constraint)
- Minimal padding throughout UI (4px sides, 8px cells)
- Manifest updated to v3 (removed deprecated "scripts" array)

### Fixed
- Context menu duplicate ID errors (added removeAll before creating)
- Manifest v2/v3 compatibility warning removed
- Live stream detection now handles master playlists correctly
- Timestamp mangling prevented with single-threaded live recording
- Directory handle permission re-requests automatically when expired
- Recording badge properly syncs with live controls visibility

### Removed
- Uninstall URL tracking (no longer sends data to original extension site)
- Old UI elements (intro screen, toolbar, duplicate stream lists)
- Blocking alert() calls replaced with toast notifications
- "Select None/All", "Remove Duplicates", "Keep M3U8" buttons

## [0.1.9] - Development
- Added master playlist detection to prevent false LIVE detection

## [0.1.8] - Development
- Increased window width to 1600px
- Added detailed stream type detection logging

## [0.1.7] - Development
- Fixed manifest v3 warnings
- Removed deprecated background.scripts

## [0.1.6] - Development
- Added context menu cleanup

## [0.1.5] - Development
- Reduced UI margins

## [0.1.4] - Development
- Added scrollable table with fixed header

## [0.1.3] - Development
- Window size adjustments

## [0.1.2] - Development
- Typography improvements

## [0.1.1] - Development
- Hidden old UI elements

## [0.1.0] - Development
- Modern UI implementation
- Table-based layout

## [0.0.9] - Development
- Added separate live recording threads setting
- Improved segment failure handling

## [0.0.8] - Development
- Built comprehensive settings panel
- Implemented IndexedDB for directory storage

## [0.0.7] - Development
- Replaced blocking alerts with toast notifications
- Improved error handling

## [0.0.6] - Development
- MyGet patch for segment failures (later reverted)

## [0.0.1-0.0.5] - Initial Development
- Fork from Live Stream Downloader v3
- Basic batch recording implementation
- Live monitoring system
- Timeout handling

---

## Credits

Based on [Live Stream Downloader](https://github.com/chandler-stimson/live-stream-downloader) by Chandler Stimson.
