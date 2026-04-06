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
    
    // CRITICAL FIX: Auto-click play button to bypass autoplay block
    const href = params.get('href');
    if (href && href.includes('sooplive.co.kr')) {
      console.log('[modern-ui] Broadcast detected - attempting auto-play to start playback');
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: parseInt(tabId) },
          func: () => {
            console.log('[Auto-Play] Attempting to start video playback...');
            
            // Strategy 1: Call .play() directly on video element (bypasses click requirement)
            const video = document.querySelector('video');
            if (video) {
              console.log('[Auto-Play] Found video element, calling play()...');
              
              // Try to unmute first (user might want audio)
              video.muted = false;
              video.volume = 1.0;
              
              // Call play() and handle the promise
              const playPromise = video.play();
              if (playPromise !== undefined) {
                playPromise.then(() => {
                  console.log('[Auto-Play] ✓ Video playing successfully (unmuted)');
                  return { success: true, method: 'video-play-unmuted' };
                }).catch(error => {
                  console.log('[Auto-Play] Unmuted play failed:', error.message);
                  console.log('[Auto-Play] Trying muted playback...');
                  
                  // If unmuted fails, try muted (more likely to be allowed)
                  video.muted = true;
                  video.play().then(() => {
                    console.log('[Auto-Play] ✓ Video playing successfully (muted)');
                  }).catch(err => {
                    console.error('[Auto-Play] ✗ Muted play also failed:', err.message);
                  });
                });
              }
              
              // Return immediately (don't wait for promise)
              return { success: true, method: 'video-play-direct' };
            }
            
            // Strategy 2: Click the player container as fallback
            const playerDiv = document.querySelector('#afreecatv_player');
            if (playerDiv) {
              console.log('[Auto-Play] No video element, clicking player div...');
              playerDiv.click();
              return { success: true, method: 'player-div-click' };
            }
            
            // Strategy 3: Look for stop screen overlay
            const stopScreen = document.querySelector('#stop_screen');
            if (stopScreen && stopScreen.offsetParent !== null) {
              console.log('[Auto-Play] Clicking stop screen overlay...');
              stopScreen.click();
              return { success: true, method: 'stop-screen-click' };
            }
            
            // Strategy 4: Find any play button by class or text
            const playButtons = document.querySelectorAll('button, a, div[role="button"]');
            for (const btn of playButtons) {
              const text = btn.textContent?.toLowerCase() || '';
              const classes = btn.className?.toLowerCase() || '';
              if (text.includes('play') || classes.includes('play') || 
                  text.includes('재생') || classes.includes('btn_play')) {
                console.log('[Auto-Play] Found play button:', btn);
                btn.click();
                return { success: true, method: 'play-button-click' };
              }
            }
            
            console.log('[Auto-Play] No playback method found');
            return { success: false, error: 'no-element-found' };
          }
        });
        
        const playResult = result[0]?.result;
        if (playResult?.success) {
          console.log(`[modern-ui] ✓ Auto-play successful (method: ${playResult.method})`);
          showNotification('▶️ Auto-started video playback', 'success');
        } else {
          console.warn('[modern-ui] Auto-play failed:', playResult?.error);
          showNotification('⚠️ Could not auto-start playback - streams may not load', 'warning');
        }
      } catch (e) {
        console.error('[modern-ui] Error during Auto-play:', e);
        
        if (e.message && e.message.includes('No tab with id')) {
          console.error('[modern-ui] Tab not found! The tab may have been closed or the tab ID is incorrect.');
          console.error('[modern-ui] Expected tab ID:', tabId);
          showNotification('⚠️ Tab not found - cannot auto-start playback. Please click play manually.', 'error');
        } else {
          console.error('[modern-ui] Unexpected error:', e.message);
          showNotification('⚠️ Auto-play failed - you may need to click play manually', 'warning');
        }
      }
      
      // Give extra time for streaming to start streams after playback starts
      console.log('[modern-ui] Waiting extra 3 seconds after auto-play for streams to appear...');
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
  
  // CRITICAL FIX: Always use first m3u8 as fallback for auto-record
  // The WRU system already verified the stream exists, so trust it
  if (!bestStream) {
    console.log('[modern-ui] No confirmed live stream, using first m3u8 (trusted from WRU detection)...');
    for (const [index, data] of streamData) {
      if (data.ext === 'm3u8') {
        bestStream = data;
        console.log('[modern-ui] ✓ Using m3u8 stream for auto-record:', data.name || data.url.substring(0, 50));
        break;
      }
    }
  }
  
  if (!bestStream) {
    console.error('[modern-ui] CRITICAL: No m3u8 stream found in streamData!');
    console.error('[modern-ui] This should not happen if WRU detected streams');
    showNotification('Auto-record failed: No m3u8 stream available', 'error');
    return;
  }
  
  // AUTO-RECORD: Delegate all directory handling to LiveMonitor.start().
  // LiveMonitor.requestDirectoryAccess() is the single source of truth —
  // it handles permission checks, reauth banners, and OPFS fallback correctly.
  // Passing null fileHandle tells start() to create the file itself after
  // resolving directory access (including showing the reauth banner if needed).
  const baseName = (bestStream.name || 'recording').replace(/[\\/:*?"<>|]/g, '_');

  console.log('[modern-ui] Starting auto-record for:', bestStream.name);
  console.log('[modern-ui] Parameters: url:', bestStream.url.substring(0, 80));
  console.log('[modern-ui] Parameters: baseName:', baseName);

  try {
    const monitor = new window.LiveMonitor(bestStream.url, baseName, 'ts');
    console.log('[modern-ui] LiveMonitor created, starting recording...');

    // Pass null fileHandle — LiveMonitor will resolve directory access,
    // show the reauth banner if needed, and create the file itself.
    await monitor.start([], null);

    console.log('[modern-ui] ✓✓✓ Auto-record started successfully ✓✓✓');

  } catch (e) {
    console.error('[modern-ui] ✗✗✗ Auto-record FAILED ✗✗✗');
    console.error('[modern-ui] Error:', e.message);
    console.error('[modern-ui] bestStream:', bestStream);
    showNotification(`Auto-record failed: ${e.message}`, 'error');
  }
}

// ===========================================
// UI INJECTION
// ===========================================
