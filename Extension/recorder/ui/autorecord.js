/**
 * liveDownload UI - Auto Record
 * Detects the autoRecord URL param and automatically starts recording
 * the best-quality live stream on page load.
 */
'use strict';

async function checkAutoRecord() {
  console.log('[modern-ui] ========== AUTO-RECORD CHECK ==========');
  console.log('[modern-ui] Current URL:', window.location.href);
  
  const params = new URLSearchParams(window.location.search);
  const autoRecord = params.get('autoRecord');
  const tabId = params.get('tabId');
  
  console.log('[modern-ui] URL params - autoRecord:', autoRecord, 'tabId:', tabId);
  console.log('[modern-ui] All params:', Object.fromEntries(params.entries()));
  
  if (autoRecord === 'true') {
    console.log('[modern-ui] *** AUTO-RECORD MODE ACTIVATED ***');
    
    // Show notification immediately
    showNotification('🔄 Auto-record started, waiting for streams to load...', 'info');
    
    // Inject autoplay into the source tab to start playback.
    // Uses the shared injectAutoplay() from autoplay.js — platform-agnostic.
    const sourceTabId = parseInt(tabId);
    if (sourceTabId) {
      console.log('[modern-ui] Attempting auto-play on source tab', sourceTabId);
      const method = await injectAutoplay(sourceTabId);
      if (method) {
        console.log(`[modern-ui] ✓ Auto-play successful: ${method}`);
      } else {
        console.warn('[modern-ui] Auto-play: no playable element found');
      }
      // Give extra time for streaming to start after playback starts
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Wait a bit for streams to load
    let settings;
    try {
      settings = await chrome.runtime.sendMessage({ method: 'waitForStart-getSettings' });
      console.log('[modern-ui] Got settings:', settings);
    } catch (e) {
      console.error('[modern-ui] Failed to get settings:', e);
      settings = { initialWait: 10 };
    }
    
    const initialWait = (settings?.initialWait || 10) * 1000;
    
    console.log(`[modern-ui] Will attempt auto-record in ${initialWait/1000} seconds`);
    console.log(`[modern-ui] Current streamData.size: ${streamData.size}`);
    
    // Start checking sooner but give more time overall
    setTimeout(() => {
      console.log('[modern-ui] Initial wait complete, starting triggerAutoRecord');
      console.log('[modern-ui] streamData.size at trigger:', streamData.size);
      triggerAutoRecord(0);
    }, initialWait);
  } else {
    console.log('[modern-ui] autoRecord param is not "true", skipping auto-record');
  }
}

async function triggerAutoRecord(attempt) {
  const MAX_ATTEMPTS = 150; // Try for up to 300 seconds (150 * 2s)
  
  console.log(`[modern-ui] ===== Auto-record attempt ${attempt + 1}/${MAX_ATTEMPTS} =====`);
  console.log(`[modern-ui] Current streamData size: ${streamData.size}`);
  console.log(`[modern-ui] window.LiveMonitor available: ${!!window.LiveMonitor}`);
  
  // List all streams we know about
  if (streamData.size > 0) {
    console.log('[modern-ui] Available streams:');
    for (const [idx, data] of streamData) {
      console.log(`  [${idx}] ${data.ext}: ${data.name || data.url?.substring(0, 80)}`);
    }
  }
  
  // Wait for streams to be detected
  if (streamData.size === 0) {
    if (attempt < MAX_ATTEMPTS) {
      if (attempt % 10 === 0) {
        console.log(`[modern-ui] No streams yet (attempt ${attempt + 1}), waiting 2s...`);
      }
      setTimeout(() => triggerAutoRecord(attempt + 1), 2000);
    } else {
      console.error('[modern-ui] Max attempts reached, no streams found');
      showNotification('Auto-record failed: No streams detected after 5 minutes', 'error');
    }
    return;
  }
  
  // CRITICAL FIX: Check if LiveMonitor is available
  if (!window.LiveMonitor) {
    console.error('[modern-ui] CRITICAL: window.LiveMonitor is not defined!');
    console.error('[modern-ui] This means live-integration.js failed to load or initialize');
    showNotification('Auto-record failed: LiveMonitor not available', 'error');
    return;
  }
  
  // Log all streams found
  console.log('[modern-ui] Streams found, searching for live stream...');
  
  // Find best stream to record (prefer m3u8 streams)
  let bestStream = null;
  let checkedStreams = 0;
  
  for (const [index, data] of streamData) {
    if (data.ext === 'm3u8') {
      console.log(`[modern-ui] Checking if stream ${index} is live...`);
      checkedStreams++;
      
      // Check if it's live
      try {
        const isLive = await window.LiveMonitor.isLiveStream(data.url);
        console.log(`[modern-ui] Stream ${index} isLive result: ${isLive} (type: ${typeof isLive})`);
        
        if (isLive === true) {
          bestStream = data;
          console.log('[modern-ui] ✓ Found confirmed live stream:', data.name || data.url.substring(0, 50));
          break;
        } else {
          console.log(`[modern-ui] Stream ${index} is NOT live or check returned: ${isLive}`);
        }
      } catch (e) {
        console.error(`[modern-ui] Error checking stream ${index}:`, e);
        console.error('[modern-ui] Error details:', e.message, e.stack);
      }
    }
  }
  
  console.log(`[modern-ui] Checked ${checkedStreams} m3u8 stream(s)`);
  
  if (!bestStream) {
    // No confirmed live stream. The page may have VOD replays but the broadcaster
    // is offline. Abort auto-record — the next WRU poll will check again.
    console.log('[modern-ui] No live stream confirmed — broadcaster may be offline (only VOD/replays detected)');
    showNotification('Auto-record: no live stream found, will retry at next poll', 'info');
    return;
  }
  
  // AUTO-RECORD: Route through the SAME pipeline as manual download.
  //
  // Instead of constructing LiveMonitor directly (which bypasses the form submit
  // handler, events.before/after, unload.js, and all plugins), we:
  //   1. Set self.aFile to a proxy object → skips the file picker dialog
  //   2. Click the hidden download button → triggers form#hrefs submit
  //   3. Submit handler → events.before → parse() → download() → LiveMonitor
  //
  // The proxy has _autoRecord:true so download() passes null to LiveMonitor.start(),
  // letting it create the file itself after directory resolution and title translation.
  const baseName = (bestStream.name || 'recording').replace(/[\\/:*?"<>|]/g, '_');

  console.log('[modern-ui] Auto-record: routing through unified pipeline');
  console.log('[modern-ui] baseName:', baseName);

  if (!bestStream.downloadBtn) {
    console.error('[modern-ui] No download button reference for stream — cannot route through pipeline');
    showNotification('Auto-record failed: stream entry not ready', 'error');
    return;
  }

  // Proxy object: has .name for filename extraction, .stat for events.after,
  // and ._autoRecord flag so download() passes null to LiveMonitor.start()
  self.aFile = { name: baseName + '.ts', _autoRecord: true, stat: { index: 1, total: 1 } };
  bestStream.downloadBtn.click();

  console.log('[modern-ui] ✓ Auto-record routed through form submit pipeline');
}

// ===========================================
// UI INJECTION
// ===========================================
