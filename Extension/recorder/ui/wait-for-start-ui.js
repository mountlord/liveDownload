/**
 * liveDownload UI - Wait For Start
 * "Wait for Broadcast" button: adds current tab to WRU, shows waiting badge.
 */
'use strict';

function setupWaitForStart() {
  // Wait for Start button - now adds to WRU list
  const waitBtn = document.getElementById('wait-for-start-btn');
  if (waitBtn) {
    waitBtn.addEventListener('click', startWaitingViaWRU);
  }
  
  // Check if already waiting (in WRU list)
  checkWaitingStatus();
}

async function checkWaitingStatus() {
  const params = new URLSearchParams(window.location.search);
  const tabId = parseInt(params.get('tabId'));
  const pageUrl = params.get('href');
  
  if (!tabId || !pageUrl) return;
  
  try {
    // Check if this URL is in WRU list and active
    const response = await chrome.runtime.sendMessage({
      method: 'wru-getAll'
    });
    
    const entry = response?.urls?.find(item => item.url === pageUrl);
    if (entry && !entry.inactive) {
      // URL is in active list - hide the Wait for Broadcast button
      showWaitingBadge(null);
    }
  } catch (e) {
    console.warn('[modern-ui] Error checking waiting status:', e);
  }
}

async function startWaitingViaWRU() {
  const params = new URLSearchParams(window.location.search);
  const tabId = parseInt(params.get('tabId'));
  const pageUrl = params.get('href');
  const pageTitle = params.get('title') || 'Unknown';
  
  if (!tabId || !pageUrl) {
    showNotification('Cannot start waiting: no tab ID or URL', 'error');
    return;
  }
  
  // Check if root directory is configured - REQUIRED for auto-record
  const rootDir = window.getRootDirectory?.();
  if (!rootDir) {
    showNotification('Please set a Root Download Directory in Settings first. Auto-record requires a pre-configured save location.', 'error');
    // Open settings panel
    const settingsTrigger = document.getElementById('options');
    if (settingsTrigger) {
      setTimeout(() => settingsTrigger.click(), 500);
    }
    return;
  }
  
  // Verify directory permission
  try {
    const permission = await rootDir.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      showNotification('Directory permission lost. Please re-select the Root Download Directory in Settings.', 'error');
      const settingsTrigger = document.getElementById('options');
      if (settingsTrigger) {
        setTimeout(() => settingsTrigger.click(), 500);
      }
      return;
    }
  } catch (e) {
    showNotification('Directory no longer accessible. Please re-select in Settings.', 'error');
    return;
  }
  
  console.log('[modern-ui] Adding current page to WRU list:', pageUrl);
  
  try {
    // Add to WRU list with current tab (don't open new tab)
    const response = await chrome.runtime.sendMessage({
      method: 'wru-addCurrentTab',
      url: pageUrl,
      title: pageTitle,
      tabId: tabId
    });
    
    if (response && response.success) {
      showWaitingBadge(response.waitInfo);
      showNotification(`Added to wait list. Will check every ${response.waitInfo?.checkInterval || 15} minutes.`, 'success');
      // Refresh WRU list if accordion is open
      loadWRUList();
      updateWRUCount();
    } else if (response && response.error === 'max_tabs_reached') {
      showNotification(`Maximum waiting URLs (${response.maxTabs}) reached. Remove one first.`, 'error');
    } else if (response && response.error === 'URL already in list') {
      showNotification('This URL is already in the wait list', 'info');
    } else {
      showNotification(response?.error || 'Failed to add to wait list', 'error');
    }
  } catch (e) {
    console.error('[modern-ui] Error adding to WRU:', e);
    showNotification('Error: ' + e.message, 'error');
  }
}

function showWaitingBadge(info) {
  // Badge removed - just hide the Wait for Broadcast button
  const waitBtn = document.getElementById('wait-for-start-btn');
  if (waitBtn) {
    waitBtn.style.display = 'none';
  }
}

// startAdaptiveCountdown removed - waiting badge no longer used

function hideWaitingBadge() {
  // Badge removed - just show the Wait for Broadcast button again
  const waitBtn = document.getElementById('wait-for-start-btn');
  if (waitBtn) {
    waitBtn.style.display = 'block';
  }
  
  if (waitingStatusInterval) {
    clearInterval(waitingStatusInterval);
    waitingStatusInterval = null;
  }
}

async function refreshWaitingStats() {
  // Badge removed - this function now just checks if we should show/hide the button
  const params = new URLSearchParams(window.location.search);
  const tabId = parseInt(params.get('tabId'));
  
  if (!tabId) return;
  
  try {
    const response = await chrome.runtime.sendMessage({
      method: 'waitForStart-status',
      tabId
    });
    
    if (!response?.isWaiting) {
      // No longer waiting - show the button again
      hideWaitingBadge();
    }
  } catch (e) {
    // Service worker might be restarting, ignore
  }
}

// updateWaitingStats removed - waiting badge no longer used

// ===========================================
// WRU EDITOR - Wait for Recording URL Manager
