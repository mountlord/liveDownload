/**
 * liveDownload - Shared Autoplay Injection
 *
 * Single source of truth for platform-specific autoplay bypass.
 * Loaded by both service worker (importScripts) and recorder page (<script>).
 *
 * Callers:
 *   polling-manager.js  — during WRU monitoring (with timed retries)
 *   live-integration.js — during recovery polling
 *   autorecord.js       — during auto-record startup
 */

'use strict';

/**
 * Inject autoplay into a tab by dispatching real pointer/mouse/click events
 * to the most likely player element. Tries platform-specific selectors first
 * (SOOP/AfreecaTV), then generic play-button heuristics, then raw video.play().
 *
 * @param {number} tabId  — Chrome tab ID to inject into
 * @returns {Promise<string|null>}  — method that worked, or null on failure
 */
async function injectAutoplay(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function fireClick(el) {
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type =>
            el.dispatchEvent(new MouseEvent(type, {
              bubbles: true, cancelable: true, view: window,
              clientX: el.getBoundingClientRect().left + el.offsetWidth  / 2,
              clientY: el.getBoundingClientRect().top  + el.offsetHeight / 2
            }))
          );
        }

        // Strategy 1: SOOP/AfreecaTV stop-screen overlay
        const stopScreen = document.querySelector('#stop_screen');
        if (stopScreen?.offsetParent) { fireClick(stopScreen); return 'stop-screen'; }

        // Strategy 2: SOOP/AfreecaTV player container
        const playerDiv = document.querySelector('#afreecatv_player');
        if (playerDiv) { fireClick(playerDiv); return 'player-div'; }

        // Strategy 3: Generic play button (class, aria-label, text content)
        for (const el of document.querySelectorAll('button, [role="button"], a, div')) {
          if (!el.offsetParent) continue;
          const t  = el.textContent?.trim().toLowerCase() || '';
          const c  = el.className?.toLowerCase() || '';
          const ar = el.getAttribute('aria-label')?.toLowerCase() || '';
          if (c.includes('btn_play') || c.includes('play-btn') || c.includes('play_btn') ||
              ar.includes('play') || t === 'play' || t === '재생') {
            fireClick(el);
            return 'play-button:' + (el.className || el.id || t);
          }
        }

        // Strategy 4: Video element — click + play() with muted fallback
        const video = document.querySelector('video');
        if (video) {
          fireClick(video);
          if (video.paused) {
            video.muted = false;
            const p = video.play();
            if (p) p.catch(() => { video.muted = true; video.play().catch(() => {}); });
          }
          return 'video-click';
        }

        // Strategy 5: Body click (last resort)
        if (document.body) { fireClick(document.body); return 'body-click'; }

        return null;
      }
    });
    return result?.[0]?.result || null;
  } catch {
    return null;
  }
}
