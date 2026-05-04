/**
 * Modern UI Renderer for liveDownload
 * Transforms old template-based UI into modern table-based UI
 * 
 * This version maintains its own data model and handles batch downloads
 * directly, avoiding the user gesture chain issues with delegating to
 * hidden UI elements.
 */

(function() {
  'use strict';

  // ===========================================
  // OUR DATA MODEL - Single source of truth
  // ===========================================
  const streamData = new Map(); // index -> {url, meta, entry, node, isLive, selected}
  let streamIndex = 0;

  // ===========================================
  // INITIALIZATION
  // ===========================================
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    // Update window title with version
    try {
      const manifest = chrome.runtime.getManifest();
      document.title = `liveDownload v${manifest.version}`;
      console.log('[modern-ui] Window title set to:', document.title);
    } catch (e) {
      console.error('[modern-ui] Failed to set title:', e);
      document.title = 'liveDownload';
    }
    
    // Inject modern UI structure
    injectModernUI();
    
    // Override the original entry rendering
    interceptEntryCreation();
    
    // Setup recording badge
    setupRecordingBadge();
    
    // Setup Wait for Start functionality
    setupWaitForStart();
    
    // Setup WRU Editor
    setupWRUEditor();
    
    // Setup stream filter
    setupStreamFilter();
    
    // Check for auto-record flag (set by Wait for Start trigger)
    checkAutoRecord();
  }
  
  // ===========================================
  // STREAM FILTER
  // ===========================================
  
  function setupStreamFilter() {
    // Wait for DOM to be ready
    setTimeout(() => {
      const filterCheckbox = document.getElementById('filter-playlists-only');
      if (filterCheckbox) {
        filterCheckbox.addEventListener('change', () => {
          renderStreamsTable();
        });
      }
    }, 100);
  }
  
  // ===========================================
  // WAIT FOR START - Auto-record functionality
  // ===========================================
  
  let waitingStatusInterval = null;
  
  // ===========================================
  // STATUS DROPDOWN - Global status view
  // ===========================================
  
  async function updateHeaderStatusCounts() {
    console.log('[modern-ui] updateHeaderStatusCounts called');
    try {
      // Get all waiting tabs
      const waitingResponse = await chrome.runtime.sendMessage({
        method: 'waitForStart-getAll'
      });
      console.log('[modern-ui] waitForStart-getAll response:', waitingResponse);
      
      // Get all recording windows
      const recordingResponse = await chrome.runtime.sendMessage({
        method: 'recording-getAll'
      });
      console.log('[modern-ui] recording-getAll response:', recordingResponse);
      
      const waitingCount = waitingResponse?.count || 0;
      const recordingCount = recordingResponse?.count || 0;
      
      console.log('[modern-ui] Counts - waiting:', waitingCount, 'recording:', recordingCount);
      
      // Update badges
      const waitingBadge = document.getElementById('waiting-count');
      const recordingBadge = document.getElementById('recording-count');
      
      if (waitingBadge) {
        waitingBadge.textContent = waitingCount > 0 ? waitingCount : '';
        waitingBadge.style.display = waitingCount > 0 ? 'flex' : 'none';
      } else {
        console.warn('[modern-ui] waiting-count element not found');
      }
      
      if (recordingBadge) {
        recordingBadge.textContent = recordingCount > 0 ? recordingCount : '';
        recordingBadge.style.display = recordingCount > 0 ? 'flex' : 'none';
      } else {
        console.warn('[modern-ui] recording-count element not found');
      }
    } catch (e) {
      console.error('[modern-ui] Error updating status counts:', e);
    }
  }
  
  async function openStatusDropdown() {
    // Fetch current status
    const waitingResponse = await chrome.runtime.sendMessage({
      method: 'waitForStart-getAll'
    });
    
    const recordingResponse = await chrome.runtime.sendMessage({
      method: 'recording-getAll'
    });
    
    const waitingTabs = waitingResponse?.tabs || [];
    const recordingTabs = recordingResponse?.tabs || [];
    
    // If nothing to show, do nothing
    if (waitingTabs.length === 0 && recordingTabs.length === 0) {
      return;
    }
    
    // Build dropdown content
    const content = document.getElementById('status-dropdown-content');
    if (!content) return;
    
    let html = '';
    
    // Recording items first
    for (const item of recordingTabs) {
      html += `
        <div class="status-item recording">
          <div class="status-item-icon">🔴</div>
          <div class="status-item-info">
            <div class="status-item-name">${escapeHtml(item.title || 'Unknown')}</div>
            <div class="status-item-detail">${item.duration || '0:00'} | ${item.segments || 0} segments</div>
          </div>
          <button class="status-item-action" data-action="view" data-window-id="${item.windowId}">View</button>
        </div>
      `;
    }
    
    // Waiting items
    for (const item of waitingTabs) {
      const remaining = Math.max(0, (item.nextCheck || 0) - Date.now());
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      
      html += `
        <div class="status-item waiting">
          <div class="status-item-icon">⏳</div>
          <div class="status-item-info">
            <div class="status-item-name">${escapeHtml(item.title || item.pageUrl || 'Unknown')}</div>
            <div class="status-item-detail">Next check: ${timeStr}</div>
          </div>
          <button class="status-item-action cancel" data-action="cancel" data-tab-id="${item.tabId}">Cancel</button>
        </div>
      `;
    }
    
    content.innerHTML = html || '<div class="status-empty">No active items</div>';
    
    // Add event listeners to action buttons
    content.querySelectorAll('.status-item-action').forEach(btn => {
      btn.addEventListener('click', handleStatusAction);
    });
    
    // Show dropdown
    const dropdown = document.getElementById('status-dropdown');
    if (dropdown) {
      dropdown.classList.add('visible');
    }
  }
  
  function closeStatusDropdown() {
    const dropdown = document.getElementById('status-dropdown');
    if (dropdown) {
      dropdown.classList.remove('visible');
    }
  }
  
  async function handleStatusAction(e) {
    const action = e.target.dataset.action;
    
    if (action === 'cancel') {
      const tabId = parseInt(e.target.dataset.tabId);
      await chrome.runtime.sendMessage({
        method: 'waitForStart-stop',
        tabId
      });
      // Refresh dropdown and counts
      updateHeaderStatusCounts();
      openStatusDropdown();
    } else if (action === 'view') {
      const windowId = parseInt(e.target.dataset.windowId);
      chrome.windows.update(windowId, { focused: true });
      closeStatusDropdown();
    }
  }
  
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  
  // Periodically update header counts
  setInterval(updateHeaderStatusCounts, 30000); // Every 30 seconds
  
  // ===========================================
  // WAIT FOR START - Button handlers
  // ===========================================
  
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
  // ===========================================
  
  function setupWRUEditor() {
    // Toggle accordion
    const header = document.getElementById('wru-accordion-header');
    const content = document.getElementById('wru-accordion-content');
    
    if (header && content) {
      header.addEventListener('click', () => {
        const isExpanded = content.style.display !== 'none';
        content.style.display = isExpanded ? 'none' : 'block';
        header.classList.toggle('expanded', !isExpanded);
        
        // Load list when expanding
        if (!isExpanded) {
          loadWRUList();
        }
      });
    }
    
    // Add URL button
    const addBtn = document.getElementById('wru-add-btn');
    const urlInput = document.getElementById('wru-url-input');
    
    if (addBtn && urlInput) {
      addBtn.addEventListener('click', () => addWRU(urlInput.value));
      urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          addWRU(urlInput.value);
        }
      });
    }
    
    // Export button
    const exportBtn = document.getElementById('wru-export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportWRUList);
    }
    
    // Import button
    const importInput = document.getElementById('wru-import-input');
    if (importInput) {
      importInput.addEventListener('change', importWRUList);
    }
    
    // Poll Now button
    const pollNowBtn = document.getElementById('wru-poll-now-btn');
    if (pollNowBtn) {
      pollNowBtn.addEventListener('click', triggerPollNow);
    }
    
    // Suspend/Resume buttons
    const suspendBtn = document.getElementById('wru-suspend-btn');
    const resumeBtn = document.getElementById('wru-resume-btn');
    if (suspendBtn && resumeBtn) {
      suspendBtn.addEventListener('click', () => togglePolling(true));
      resumeBtn.addEventListener('click', () => togglePolling(false));
      // Initialize button state
      updateSuspendResumeButtons();
    }
    
    // Load initial count
    updateWRUCount();
  }
  
  async function togglePolling(suspend) {
    try {
      await chrome.storage.local.set({ 'waitForStart_pollingSuspended': suspend });
      await updateSuspendResumeButtons();
      
      if (suspend) {
        showNotification('⏸️ Polling suspended - no automatic checks until resumed', 'info');
      } else {
        showNotification('▶️ Polling resumed - automatic checks enabled', 'success');
      }
    } catch (e) {
      console.error('[WRU] Toggle polling error:', e);
      showNotification('Failed to ' + (suspend ? 'suspend' : 'resume') + ' polling', 'error');
    }
  }
  
  async function updateSuspendResumeButtons() {
    try {
      const result = await chrome.storage.local.get('waitForStart_pollingSuspended');
      const suspended = result['waitForStart_pollingSuspended'] || false;
      
      const suspendBtn = document.getElementById('wru-suspend-btn');
      const resumeBtn = document.getElementById('wru-resume-btn');
      
      if (suspendBtn && resumeBtn) {
        suspendBtn.style.display = suspended ? 'none' : '';
        resumeBtn.style.display = suspended ? '' : 'none';
      }
    } catch (e) {
      console.error('[WRU] Update suspend/resume buttons error:', e);
    }
  }
  
  async function exportWRUList() {
    try {
      const response = await chrome.runtime.sendMessage({
        method: 'wru-getAll'
      });
      
      const urls = response?.urls || [];
      
      if (urls.length === 0) {
        showNotification('No URLs to export', 'info');
        return;
      }
      
      // Create export data (just URLs and titles, not runtime state)
      const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        urls: urls.map(item => ({
          url: item.url,
          title: item.title
        }))
      };
      
      // Download as JSON file
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wru-list-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showNotification(`Exported ${urls.length} URLs`, 'success');
    } catch (e) {
      console.error('[WRU] Export error:', e);
      showNotification('Export failed', 'error');
    }
  }
  
  async function importWRUList(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      if (!data.urls || !Array.isArray(data.urls)) {
        showNotification('Invalid file format', 'error');
        return;
      }
      
      let imported = 0;
      let skipped = 0;
      
      // Add all URLs to storage first (skipPoll: true to avoid triggering poll for each)
      for (const item of data.urls) {
        if (!item.url) continue;
        
        const response = await chrome.runtime.sendMessage({
          method: 'wru-add',
          url: item.url,
          title: item.title,  // Preserve custom title from import
          skipPoll: true  // Don't trigger poll for each URL
        });
        
        if (response?.success) {
          imported++;
        } else {
          skipped++;
        }
      }
      
      // Now trigger ONE sequential poll to process all imported URLs
      if (imported > 0) {
        showNotification(`Added ${imported} URLs to storage, starting sequential poll...`, 'info');
        await chrome.runtime.sendMessage({
          method: 'wru-pollNow'
        });
      }
      
      loadWRUList();
      updateWRUCount();
      updateHeaderStatusCounts();
      
      showNotification(`Imported ${imported} URLs (${skipped} skipped)`, 'success');
    } catch (e) {
      console.error('[WRU] Import error:', e);
      showNotification('Import failed: ' + e.message, 'error');
    }
    
    // Reset input so same file can be imported again
    e.target.value = '';
  }
  
  async function triggerPollNow() {
    const btn = document.getElementById('wru-poll-now-btn');
    if (!btn) return;
    
    try {
      // Disable button and show loading state
      btn.disabled = true;
      btn.textContent = '🔄 Polling...';
      
      showNotification('⏳ Triggering polling cycle...', 'info');
      
      // Send message to trigger polling
      const response = await chrome.runtime.sendMessage({
        method: 'wru-pollNow'
      });
      
      if (response?.success) {
        showNotification(`✅ Poll complete - monitoring ${response.tabCount || 0} tabs`, 'success');
      } else {
        showNotification('⚠️ Polling triggered, check service worker console for details', 'warning');
      }
    } catch (e) {
      console.error('[WRU] Poll Now error:', e);
      showNotification('Poll failed: ' + e.message, 'error');
    } finally {
      // Re-enable button
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔄 Poll Now';
        }
      }, 2000); // 2 second delay to prevent spam clicking
    }
  }
  
  async function updateWRUCount() {
    try {
      const response = await chrome.runtime.sendMessage({
        method: 'wru-getAll'
      });
      
      // Only count active (non-inactive) URLs
      const activeCount = response?.urls?.filter(item => !item.inactive)?.length || 0;
      const countEl = document.getElementById('wru-count');
      if (countEl) {
        countEl.textContent = activeCount;
      }
    } catch (e) {
      console.warn('[WRU] Error getting count:', e);
    }
  }
  
  async function loadWRUList() {
    const listEl = document.getElementById('wru-list');
    const warningEl = document.getElementById('wru-limit-warning');
    const maxLimitEl = document.getElementById('wru-max-limit');
    
    if (!listEl) return;
    
    try {
      const response = await chrome.runtime.sendMessage({
        method: 'wru-getAll'
      });
      
      const urls = response?.urls || [];
      const maxTabs = response?.maxTabs || 10;
      
      if (maxLimitEl) maxLimitEl.textContent = maxTabs;
      
      if (urls.length === 0) {
        listEl.innerHTML = '<div class="wru-empty">No URLs in wait list. Add a URL above or click "Wait for Broadcast" on a stream page.</div>';
        if (warningEl) warningEl.style.display = 'none';
        return;
      }
      
      // Separate into active (not inactive) and inactive lists
      const activeUrls = urls.filter(item => !item.inactive);
      const inactiveUrls = urls.filter(item => item.inactive);
      
      // Show warning if at limit
      if (warningEl) {
        warningEl.style.display = activeUrls.length >= maxTabs ? 'block' : 'none';
      }
      
      let html = '';
      
      // Active section
      html += `<div class="wru-section-header active">
        <span>🟢 Active (Waiting)</span>
        <span class="wru-section-count">${activeUrls.length}/${maxTabs}</span>
      </div>`;
      
      if (activeUrls.length === 0) {
        html += '<div class="wru-empty">No active URLs</div>';
      } else {
        for (const item of activeUrls) {
          const statusIcon = '👁️';
          const itemClass = '';
          const networkNotice = '';
          
          html += `
            <div class="wru-item ${itemClass}" data-url="${escapeHtml(item.url)}">
              <span class="wru-item-status">${statusIcon}</span>
              <div class="wru-item-info">
                <div class="wru-item-title">${escapeHtml(item.title || 'Unknown')}${networkNotice}</div>
                <div class="wru-item-url">${escapeHtml(item.url)}</div>
              </div>
              <div class="wru-item-actions">
                <button class="wru-item-btn copy" 
                        data-action="copy" 
                        data-url="${escapeHtml(item.url)}"
                        title="Copy URL">
                  📋
                </button>
                <button class="wru-item-btn deactivate" 
                        data-action="deactivate" 
                        data-url="${escapeHtml(item.url)}"
                        title="Move to inactive list">
                  ⏸️ Deactivate
                </button>
                <button class="wru-item-btn delete" 
                        data-action="delete" 
                        data-url="${escapeHtml(item.url)}"
                        title="Remove from list">
                  🗑️
                </button>
              </div>
            </div>
          `;
        }
      }
      
      // Inactive section (only show if there are inactive URLs)
      if (inactiveUrls.length > 0) {
        html += `<div class="wru-section-header inactive">
          <span>⏸️ Inactive</span>
          <span class="wru-section-count">${inactiveUrls.length}</span>
        </div>`;
        
        for (const item of inactiveUrls) {
          html += `
            <div class="wru-item inactive" data-url="${escapeHtml(item.url)}">
              <span class="wru-item-status">⏸️</span>
              <div class="wru-item-info">
                <div class="wru-item-title">${escapeHtml(item.title || 'Unknown')}</div>
                <div class="wru-item-url">${escapeHtml(item.url)}</div>
              </div>
              <div class="wru-item-actions">
                <button class="wru-item-btn copy" 
                        data-action="copy" 
                        data-url="${escapeHtml(item.url)}"
                        title="Copy URL">
                  📋
                </button>
                <button class="wru-item-btn activate" 
                        data-action="activate" 
                        data-url="${escapeHtml(item.url)}"
                        title="Move to active list">
                  ▶️ Activate
                </button>
                <button class="wru-item-btn delete" 
                        data-action="delete" 
                        data-url="${escapeHtml(item.url)}"
                        title="Remove from list">
                  🗑️
                </button>
              </div>
            </div>
          `;
        }
      }
      
      listEl.innerHTML = html;
      
      // Attach event listeners
      listEl.querySelectorAll('.wru-item-btn').forEach(btn => {
        btn.addEventListener('click', handleWRUAction);
      });
      
      // Update count (show only active count)
      const countEl = document.getElementById('wru-count');
      if (countEl) countEl.textContent = activeUrls.length;
      
    } catch (e) {
      console.error('[WRU] Error loading list:', e);
      listEl.innerHTML = '<div class="wru-empty">Error loading list</div>';
    }
  }
  
  async function addWRU(url) {
    if (!url || !url.trim()) {
      showNotification('Please enter a URL', 'error');
      return;
    }
    
    // Basic URL validation
    try {
      new URL(url);
    } catch (e) {
      showNotification('Invalid URL format', 'error');
      return;
    }
    
    try {
      const response = await chrome.runtime.sendMessage({
        method: 'wru-add',
        url: url.trim(),
        userInitiated: true  // Flag: user clicked "+ Add" button
      });
      
      if (response?.success) {
        showNotification('URL added to wait list', 'success');
        const urlInput = document.getElementById('wru-url-input');
        if (urlInput) urlInput.value = '';
        loadWRUList();
        updateHeaderStatusCounts();
      } else {
        showNotification(response?.error || 'Failed to add URL', 'error');
      }
    } catch (e) {
      console.error('[WRU] Error adding URL:', e);
      showNotification('Error adding URL', 'error');
    }
  }
  
  async function handleWRUAction(e) {
    const action = e.target.dataset.action;
    const url = e.target.dataset.url;
    
    if (!action || !url) return;
    
    try {
      let response;
      
      switch (action) {
        case 'deactivate':
          response = await chrome.runtime.sendMessage({
            method: 'wru-deactivate',
            url
          });
          if (response?.success) {
            showNotification('URL moved to inactive list', 'success');
          } else {
            showNotification(response?.error || 'Failed to deactivate', 'error');
          }
          break;
          
        case 'activate':
          response = await chrome.runtime.sendMessage({
            method: 'wru-activate',
            url
          });
          if (response?.success) {
            showNotification('URL activated and waiting for broadcast', 'success');
          } else if (response?.error === 'max_tabs_reached') {
            showNotification(`Active list full (max ${response.maxTabs}). Deactivate one first.`, 'error');
          } else {
            showNotification(response?.error || 'Failed to activate', 'error');
          }
          break;
          
        case 'delete':
          response = await chrome.runtime.sendMessage({
            method: 'wru-delete',
            url
          });
          if (response?.success) {
            showNotification('URL removed', 'success');
          }
          break;
          
        case 'copy':
          try {
            await navigator.clipboard.writeText(url);
            showNotification('URL copied to clipboard', 'success');
          } catch (e) {
            console.error('[WRU] Copy failed:', e);
            showNotification('Failed to copy URL', 'error');
          }
          return; // Don't refresh list for copy action
      }
      
      // Refresh list
      loadWRUList();
      updateHeaderStatusCounts();
      
    } catch (e) {
      console.error('[WRU] Error handling action:', e);
      showNotification('Error: ' + e.message, 'error');
    }
  }

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
            console.log(`[modern-ui] ✓ auto-play successful (method: ${playResult.method})`);
            showNotification('▶️ Auto-started video playback', 'success');
          } else {
            console.warn('[modern-ui] auto-play failed:', playResult?.error);
            showNotification('⚠️ Could not auto-start playback - streams may not load', 'warning');
          }
        } catch (e) {
          console.error('[modern-ui] Error during auto-play:', e);
          
          if (e.message && e.message.includes('No tab with id')) {
            console.error('[modern-ui] tab not found! The tab may have been closed or the tab ID is incorrect.');
            console.error('[modern-ui] Expected tab ID:', tabId);
            showNotification('⚠️ Tab not found - cannot auto-start playback. Please click play manually.', 'error');
          } else {
            console.error('[modern-ui] Unexpected error:', e.message);
            showNotification('⚠️ Auto-play failed - you may need to click play manually', 'warning');
          }
        }
        
        // Give extra time for streaming to start after playback starts
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
    
    // AUTO-RECORD: Start recording directly without file picker.
    // File creation is deferred to live-integration.js start() so translation
    // and correct filename generation happen before the file is created.
    console.log('[modern-ui] Starting auto-record for:', bestStream.name);

    const isPolyfilled = window.showDirectoryPicker?._polyfilled;
    const baseName = (bestStream.name || 'recording').replace(/[\\/:*?"<>|]/g, '_');
    let rootDir = null;
    let usingOPFS = false;

    // Resolve directory — don't create the file yet
    if (!isPolyfilled) {
      rootDir = window.getRootDirectory?.();
      if (rootDir) {
        try {
          const permission = await rootDir.queryPermission({ mode: 'readwrite' });
          if (permission === 'granted') {
            window._liveDownloadDirectory = rootDir;
          } else if (permission === 'prompt') {
            console.warn('[modern-ui] Directory permission requires re-grant. Falling back to OPFS.');
            rootDir = null;
          } else {
            console.warn('[modern-ui] Directory permission denied');
            rootDir = null;
          }
        } catch (e) {
          console.warn('[modern-ui] Directory permission check failed:', e);
          rootDir = null;
        }
      }
    }

    if (!rootDir) {
      usingOPFS = true;
      try {
        const opfsRoot = await navigator.storage.getDirectory();
        window._liveDownloadDirectory = opfsRoot;
      } catch (e) {
        console.error('[modern-ui] OPFS fallback failed:', e);
        showNotification('Auto-record failed: Could not access storage', 'error');
        return;
      }
    }

    try {
      // Create LiveMonitor — file will be created inside start() with correct translated name
      const monitor = new window.LiveMonitor(bestStream.url, baseName, 'ts');

      if (usingOPFS) {
        monitor.usingOPFS = true;
        monitor.directoryName = 'Downloads';
      } else {
        monitor.directoryName = rootDir?.name || 'Downloads';
      }

      console.log('[modern-ui] LiveMonitor created, starting recording...');
      console.log('[modern-ui] Parameters: url:', bestStream.url.substring(0, 80));
      console.log('[modern-ui] Parameters: baseName:', baseName);

      await monitor.start([], null);
      
      if (usingOPFS) {
        showNotification('🔴 Auto-recording started! (will save to Downloads on completion)', 'success');
      } else {
        showNotification('🔴 Auto-recording started!', 'success');
      }
      console.log('[modern-ui] ✓✓✓ Auto-record started successfully ✓✓✓');
      
    } catch (e) {
      console.error('[modern-ui] ✗✗✗ Auto-record FAILED ✗✗✗');
      console.error('[modern-ui] Error:', e);
      console.error('[modern-ui] Error message:', e.message);
      console.error('[modern-ui] Error stack:', e.stack);
      console.error('[modern-ui] bestStream:', bestStream);
      console.error('[modern-ui] fileHandle:', fileHandle);
      showNotification(`Auto-record failed: ${e.message}`, 'error');
    }
  }

  // ===========================================
  // UI INJECTION
  // ===========================================

  function injectModernUI() {
    // Get version for display
    let version = '';
    try {
      version = chrome.runtime.getManifest().version;
    } catch (e) {
      console.warn('[modern-ui] Could not get version');
    }
    
    // Create header
    const header = document.createElement('div');
    header.className = 'app-header';
    header.innerHTML = `
      <h1>liveDownload <span class="version-tag">v${version}</span></h1>
      <div class="header-icons">
        <button class="header-icon-btn" id="status-waiting-btn" title="Waiting for Broadcast">
          <span class="icon-wrapper">
            <span class="icon">⏳</span>
            <span class="icon-badge" id="waiting-count"></span>
          </span>
        </button>
        <button class="header-icon-btn" id="status-recording-btn" title="Currently Recording">
          <span class="icon-wrapper">
            <span class="icon">🔴</span>
            <span class="icon-badge" id="recording-count"></span>
          </span>
        </button>
        <button class="header-icon-btn" id="modern-settings-btn" title="Settings">
          <span class="icon-wrapper">
            <span class="icon">⚙️</span>
          </span>
        </button>
      </div>
    `;
    
    // Create status dropdown
    const statusDropdown = document.createElement('div');
    statusDropdown.className = 'status-dropdown';
    statusDropdown.id = 'status-dropdown';
    statusDropdown.innerHTML = `
      <div class="status-dropdown-header">
        <span>Status</span>
        <button class="status-dropdown-close" id="status-dropdown-close">✕</button>
      </div>
      <div class="status-dropdown-content" id="status-dropdown-content">
        <div class="status-empty">No active items</div>
      </div>
    `;
    
    // Create main container
    const container = document.createElement('div');
    container.className = 'app-container';
    container.innerHTML = `
      <!-- WRU Editor Accordion - Top of page -->
      <div class="section-card wru-editor-section" id="wru-editor-section">
        <div class="accordion-header" id="wru-accordion-header">
          <h2>⏳ Wait for Recording URLs</h2>
          <span class="accordion-count" id="wru-count">0</span>
          <span class="accordion-toggle" id="wru-toggle">▼</span>
        </div>
        <div class="accordion-content" id="wru-accordion-content" style="display: none;">
          <!-- Add URL form -->
          <div class="wru-add-form">
            <input type="url" id="wru-url-input" placeholder="Enter stream page URL..." class="wru-input">
            <button id="wru-add-btn" class="wru-add-btn" title="Add URL to wait list">+ Add</button>
          </div>
          <!-- URL list -->
          <div class="wru-list" id="wru-list">
            <div class="wru-empty">No URLs in wait list</div>
          </div>
          <!-- Export/Import buttons -->
          <div class="wru-actions">
            <button id="wru-export-btn" class="wru-action-btn" title="Export list to file">📤 Export</button>
            <label class="wru-action-btn" title="Import list from file">
              📥 Import
              <input type="file" id="wru-import-input" accept=".json" style="display: none;">
            </label>
            <button id="wru-poll-now-btn" class="wru-action-btn wru-poll-now-btn" title="Trigger polling cycle now (checks all active URLs)">🔄 Poll Now</button>
            <button id="wru-suspend-btn" class="wru-action-btn" title="Suspend polling - no automatic checks until resumed">⏸️ Suspend</button>
            <button id="wru-resume-btn" class="wru-action-btn" style="display: none;" title="Resume automatic polling">▶️ Resume</button>
          </div>
          <!-- Limit warning -->
          <div class="wru-limit-warning" id="wru-limit-warning" style="display: none;">
            Maximum URLs reached (limit: <span id="wru-max-limit">10</span>)
          </div>
        </div>
      </div>

      <!-- Streams Section -->
      <div class="section-card" id="streams-section">
        <div class="section-header">
          <h2>Available Streams</h2>
          <div class="stream-filter">
            <label class="filter-toggle" title="Show only playlists (M3U8/MPD) by default. Segments shown if no playlists exist.">
              <input type="checkbox" id="filter-playlists-only" checked>
              <span>Playlists Only</span>
            </label>
          </div>
        </div>
        <div id="streams-content">
          <div class="empty-state" id="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <h3>No streams detected</h3>
            <p>Waiting for media streams on this page...</p>
            <button class="wait-for-start-btn" id="wait-for-start-btn">
              ⏰ Wait for Broadcast
            </button>
          </div>
        </div>
      </div>

      <!-- Download Selected Button -->
      <div class="download-selected-container">
        <button class="download-selected-btn" id="download-selected-btn" disabled>
          Download Selected
        </button>
        <span class="selection-count" id="selection-count">0 selected</span>
      </div>

      <!-- Stream Information -->
      <div class="section-card" id="info-section">
        <div class="section-header">
          <h2>Stream Information</h2>
        </div>
        <table class="info-table">
          <tr>
            <td>Referrer</td>
            <td id="info-referrer">-</td>
          </tr>
          <tr>
            <td>Page Title</td>
            <td id="info-title">-</td>
          </tr>
          <tr>
            <td>Page Link</td>
            <td id="info-link">-</td>
          </tr>
        </table>
      </div>

      <!-- Waiting Badge - REMOVED: Using notification bubble instead -->
      <!-- The notification bubble shows for 8 seconds when Wait for Broadcast is clicked -->

      <!-- Recording Badge -->
      <div class="recording-badge" id="recording-badge">
        <div class="status">
          <span class="pulse"></span>
          RECORDING
        </div>
        <div class="stats" id="recording-stats">
          Segments: <span id="badge-segments">0</span><br>
          Batches: <span id="badge-batches">0</span><br>
          Duration: <span id="badge-duration">0:00:00</span>
        </div>
        <button class="stop-recording-btn" id="badge-stop-btn">⬛ Stop Recording</button>
      </div>
      
      <!-- Progress indicator for batch downloads -->
      <div class="batch-progress" id="batch-progress" style="display: none;">
        <div class="batch-progress-text" id="batch-progress-text">Downloading...</div>
        <div class="batch-progress-bar">
          <div class="batch-progress-fill" id="batch-progress-fill" style="width: 0%"></div>
        </div>
      </div>
    `;
    
    // Insert into page
    document.body.insertBefore(header, document.body.firstChild);
    document.body.insertBefore(statusDropdown, document.body.children[1]);
    document.body.insertBefore(container, document.body.children[2]);
    
    // Hook up settings button to existing gear icon handler
    document.getElementById('modern-settings-btn').addEventListener('click', () => {
      const settingsTrigger = document.getElementById('options');
      if (settingsTrigger) {
        settingsTrigger.click();
      }
    });
    
    // Hook up status buttons
    document.getElementById('status-waiting-btn').addEventListener('click', () => openStatusDropdown());
    document.getElementById('status-recording-btn').addEventListener('click', () => openStatusDropdown());
    document.getElementById('status-dropdown-close').addEventListener('click', () => closeStatusDropdown());
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('status-dropdown');
      const waitingBtn = document.getElementById('status-waiting-btn');
      const recordingBtn = document.getElementById('status-recording-btn');
      
      if (dropdown && dropdown.classList.contains('visible') &&
          !dropdown.contains(e.target) && 
          !waitingBtn.contains(e.target) && 
          !recordingBtn.contains(e.target)) {
        closeStatusDropdown();
      }
    });
    
    // Update header status counts
    updateHeaderStatusCounts();
    
    // Update page info
    updatePageInfo();
  }

  function updatePageInfo() {
    // Get info from footer elements
    const refererEl = document.getElementById('referer');
    const titleEl = document.getElementById('title');
    const pageEl = document.getElementById('page');
    
    if (refererEl) {
      document.getElementById('info-referrer').textContent = refererEl.textContent || '-';
    }
    if (titleEl) {
      document.getElementById('info-title').textContent = titleEl.textContent || '-';
    }
    if (pageEl) {
      document.getElementById('info-link').textContent = pageEl.textContent || '-';
    }
    
    // Watch for changes
    const observer = new MutationObserver(() => {
      if (refererEl) document.getElementById('info-referrer').textContent = refererEl.textContent || '-';
      if (titleEl) document.getElementById('info-title').textContent = titleEl.textContent || '-';
      if (pageEl) document.getElementById('info-link').textContent = pageEl.textContent || '-';
    });
    
    if (refererEl) observer.observe(refererEl, { childList: true, characterData: true, subtree: true });
    if (titleEl) observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    if (pageEl) observer.observe(pageEl, { childList: true, characterData: true, subtree: true });
  }

  // ===========================================
  // ENTRY INTERCEPTION - Capture data from original UI
  // ===========================================

  function interceptEntryCreation() {
    const hrefsContainer = document.getElementById('hrefs');
    if (!hrefsContainer) return;
    
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.classList.contains('entry')) {
            // Hide the old entry immediately
            node.style.display = 'none';
            
            // Extract and store data in OUR data model
            const data = extractAndStoreEntry(node);
            
            // Render modern table
            renderStreamsTable();
          }
        });
      });
    });
    
    observer.observe(hrefsContainer, { childList: true });
  }

  /**
   * Extract data from original entry node and store in our data model
   */
  function extractAndStoreEntry(entryNode) {
    const index = streamIndex++;
    
    // Get references to original elements
    const checkbox = entryNode.querySelector('[data-id="selected"]');
    const downloadBtn = entryNode.querySelector('input[type="submit"]');
    
    // USE the meta and entry objects that build.js attached to the node!
    // These have the correct filename info
    const meta = entryNode.meta || {
      name: entryNode.querySelector('[data-id="name"]')?.textContent || '',
      gname: entryNode.querySelector('[data-id="extracted-name"]')?.textContent || '',
      ext: entryNode.querySelector('[data-id="ext"]')?.textContent || '',
      index: 0
    };
    
    const entry = entryNode.entry || {
      url: entryNode.querySelector('[data-id="href"]')?.textContent || ''
    };
    
    // For display purposes, get text from DOM
    const sizeEl = entryNode.querySelector('[data-id="size"]');
    
    // Store in our data model
    const data = {
      index,
      url: entry.url,
      meta,  // Use the actual meta object from build.js
      entry, // Use the actual entry object from build.js
      node: entryNode,
      checkbox,
      downloadBtn,
      name: meta.gname || meta.name || '',
      extractedName: entryNode.querySelector('[data-id="extracted-name"]')?.textContent || '',
      ext: meta.ext || '',
      size: sizeEl?.textContent || '',
      href: entry.url,
      isLive: false,
      selected: false
    };
    
    streamData.set(index, data);
    
    console.log(`[modern-ui] Stored stream ${index}:`, meta.gname || meta.name || entry.url.substring(0, 50));
    
    return data;
  }

  // ===========================================
  // TABLE RENDERING
  // ===========================================

  async function renderStreamsTable() {
    const contentEl = document.getElementById('streams-content');
    if (!contentEl) return;
    
    if (streamData.size === 0) {
      contentEl.innerHTML = `
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <h3>No streams detected</h3>
          <p>Waiting for media streams on this page...</p>
        </div>
      `;
      return;
    }
    
    // Check for live streams
    for (const [index, data] of streamData) {
      if (data.ext === 'm3u8' && window.LiveMonitor) {
        try {
          data.isLive = await window.LiveMonitor.isLiveStream(data.url);
        } catch (e) {
          console.warn('[modern-ui] Live check failed:', e);
          data.isLive = false;
        }
      }
    }
    
    // Apply playlist filter
    const filterPlaylistsOnly = document.getElementById('filter-playlists-only')?.checked ?? true;
    const playlistExtensions = ['m3u8', 'mpd'];
    
    // Separate playlists and segments
    const playlists = [];
    const segments = [];
    
    for (const [index, data] of streamData) {
      if (playlistExtensions.includes(data.ext?.toLowerCase())) {
        playlists.push([index, data]);
      } else {
        segments.push([index, data]);
      }
    }
    
    // Determine what to display
    let displayStreams;
    let showingSegmentsFallback = false;
    
    if (filterPlaylistsOnly) {
      if (playlists.length > 0) {
        displayStreams = playlists;
      } else {
        // No playlists - show segments as fallback
        displayStreams = segments;
        showingSegmentsFallback = true;
      }
    } else {
      // Show all streams
      displayStreams = [...streamData.entries()];
    }
    
    // Build table HTML
    let tableHTML = '';
    
    if (showingSegmentsFallback && segments.length > 0) {
      tableHTML += `<div class="filter-notice">No playlists found. Showing ${segments.length} segment(s) instead.</div>`;
    } else if (filterPlaylistsOnly && playlists.length > 0 && segments.length > 0) {
      tableHTML += `<div class="filter-notice">${playlists.length} playlist(s) shown. ${segments.length} segment(s) hidden.</div>`;
    }
    
    tableHTML += `
      <table class="streams-table">
        <thead>
          <tr>
            <th><input type="checkbox" id="select-all-modern" title="Select all"></th>
            <th>Name</th>
            <th>Segment</th>
            <th>Format</th>
            <th>Size</th>
            <th>Link</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    for (const [index, data] of displayStreams) {
      const rowClass = data.isLive ? 'live-stream' : '';
      
      tableHTML += `
        <tr class="${rowClass}" data-index="${index}">
          <td><input type="checkbox" class="stream-checkbox" data-index="${index}" ${data.selected ? 'checked' : ''}></td>
          <td><span class="stream-name">${escapeHtml(data.name)}</span></td>
          <td><span class="segment-type">${escapeHtml(data.extractedName)}</span></td>
          <td><span class="format-badge ${data.ext}">${escapeHtml(data.ext)}</span></td>
          <td><span class="stream-size">${escapeHtml(data.size)}</span></td>
          <td>
            <span class="stream-link" title="${escapeHtml(data.href)}">${escapeHtml(truncate(data.href, 30))}</span>
            <button class="copy-url-btn" data-url="${escapeHtml(data.url)}" title="Copy URL">📋</button>
          </td>
          <td>
            <button class="action-btn ${data.isLive ? 'record' : 'download'}" data-index="${index}">
              ${data.isLive ? '🔴 Record' : 'Download'}
            </button>
          </td>
        </tr>
      `;
    }
    
    tableHTML += `
        </tbody>
      </table>
    `;
    
    contentEl.innerHTML = tableHTML;
    
    // Hook up events
    setupTableEvents();
  }

  // ===========================================
  // EVENT HANDLERS
  // ===========================================

  function setupTableEvents() {
    // Select all checkbox
    const selectAll = document.getElementById('select-all-modern');
    if (selectAll) {
      selectAll.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        
        document.querySelectorAll('.stream-checkbox').forEach(cb => {
          cb.checked = isChecked;
          const index = parseInt(cb.dataset.index);
          const data = streamData.get(index);
          if (data) {
            data.selected = isChecked;
          }
        });
        
        updateSelectionCount();
      });
    }
    
    // Individual checkboxes
    document.querySelectorAll('.stream-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const index = parseInt(e.target.dataset.index);
        const data = streamData.get(index);
        if (data) {
          data.selected = e.target.checked;
        }
        updateSelectionCount();
      });
    });
    
    // Action buttons (individual download/record)
    document.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        const data = streamData.get(index);
        if (data && data.downloadBtn) {
          // For individual downloads, use original button (preserves user gesture)
          data.downloadBtn.click();
        }
      });
    });
    
    // Copy URL buttons
    document.querySelectorAll('.copy-url-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const url = e.target.dataset.url;
        if (url) {
          try {
            await navigator.clipboard.writeText(url);
            const originalText = e.target.textContent;
            e.target.textContent = '✓';
            setTimeout(() => {
              e.target.textContent = originalText;
            }, 1500);
          } catch (err) {
            console.error('[modern-ui] Copy failed:', err);
            showNotification('Failed to copy URL', 'error');
          }
        }
      });
    });
    
    // Download Selected button - OUR OWN IMPLEMENTATION
    const downloadSelectedBtn = document.getElementById('download-selected-btn');
    if (downloadSelectedBtn) {
      downloadSelectedBtn.addEventListener('click', handleBatchDownload);
    }
  }

  function updateSelectionCount() {
    const selectedCount = Array.from(streamData.values()).filter(d => d.selected).length;
    
    const countEl = document.getElementById('selection-count');
    const btnEl = document.getElementById('download-selected-btn');
    
    if (countEl) {
      countEl.textContent = `${selectedCount} selected`;
    }
    
    if (btnEl) {
      btnEl.disabled = selectedCount === 0;
    }
  }

  // ===========================================
  // BATCH DOWNLOAD - Our own implementation
  // ===========================================

  /**
   * Handle batch download - called directly from user click
   * This preserves the user gesture for showDirectoryPicker()
   */
  async function handleBatchDownload(e) {
    e.preventDefault();
    
    // Get selected streams
    const selected = Array.from(streamData.values()).filter(d => d.selected);
    
    if (selected.length === 0) {
      console.log('[modern-ui] No streams selected');
      return;
    }
    
    console.log(`[modern-ui] Batch download: ${selected.length} streams`);
    
    // IMPORTANT: Save current global directory setting so we don't overwrite it
    const savedGlobalDir = window._liveDownloadDirectory;
    
    try {
      // CRITICAL: Call showDirectoryPicker directly from user gesture
      const dir = await window.showDirectoryPicker({
        mode: 'readwrite'
      });
      
      console.log('[modern-ui] Directory selected:', dir.name);
      
      // Show progress UI
      showBatchProgress(0, selected.length);
      
      // Get existing filenames to handle duplicates
      const existingNames = {};
      for await (const file of dir.values()) {
        if (file.kind === 'file') {
          existingNames[file.name] = 0;
        }
      }
      
      // Generate unique filenames for all selected streams using helper.options
      const downloadQueue = [];
      for (const data of selected) {
        // Use helper.options() like the original code does - it knows how to generate proper names
        const options = helper.options({ meta: data.meta });
        let rawFilename = options.suggestedName || 'Untitled.ts';
        
        console.log(`[modern-ui] Raw filename from helper.options: "${rawFilename}"`);
        
        // SANITIZE the filename - remove invalid characters like / \ : * ? " < > |
        // Do this INLINE to ensure it happens
        let filename = rawFilename
          .replace(/[\/\\:*?"<>|]/g, '_')  // Replace forbidden chars with underscore
          .replace(/\s+/g, ' ')             // Collapse multiple spaces
          .trim();                          // Remove leading/trailing whitespace
        
        // Limit length
        if (filename.length > 200) {
          const ext = filename.lastIndexOf('.');
          if (ext > 0) {
            filename = filename.substring(0, 196) + filename.substring(ext);
          } else {
            filename = filename.substring(0, 200);
          }
        }
        
        console.log(`[modern-ui] Sanitized filename: "${filename}"`);

        // Ensure it has an extension
        if (!filename.includes('.')) {
          filename += '.ts';
        }
        
        // Handle duplicates
        if (filename in existingNames) {
          existingNames[filename]++;
          const ext = filename.lastIndexOf('.');
          if (ext > 0) {
            filename = filename.substring(0, ext) + ' - ' + existingNames[filename] + filename.substring(ext);
          } else {
            filename = filename + ' - ' + existingNames[filename];
          }
        } else {
          existingNames[filename] = 0;
        }
        existingNames[filename] = 0;
        
        downloadQueue.push({
          data,
          filename
        });
        
        console.log(`[modern-ui] Final queued filename: "${filename}"`);
      }
      
      // Download sequentially
      let completed = 0;
      for (const item of downloadQueue) {
        try {
          updateBatchProgress(completed, downloadQueue.length, item.filename);
          
          // Create file handle
          const fileHandle = await dir.getFileHandle(item.filename, { create: true });
          
          // Set the global aFile so the original code uses our file handle
          self.aFile = fileHandle;
          self.aFile.stat = {
            index: completed + 1,
            total: downloadQueue.length
          };
          
          // Click the original download button and wait for completion
          await downloadSingleStream(item.data, fileHandle);
          
          completed++;
          updateBatchProgress(completed, downloadQueue.length, item.filename);
          
          console.log(`[modern-ui] Completed ${completed}/${downloadQueue.length}: ${item.filename}`);
          
        } catch (err) {
          console.error(`[modern-ui] Failed to download ${item.filename}:`, err);
          // Continue with next file
          completed++;
        }
      }
      
      // Cleanup
      delete self.aFile;
      hideBatchProgress();
      
      showNotification(`Downloaded ${completed} of ${downloadQueue.length} files`, 'success');
      
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[modern-ui] User cancelled directory picker');
      } else {
        console.error('[modern-ui] Batch download error:', err);
        showNotification(`Download failed: ${err.message}`, 'error');
      }
      hideBatchProgress();
    } finally {
      // IMPORTANT: Restore the original global directory setting
      window._liveDownloadDirectory = savedGlobalDir;
    }
  }

  /**
   * Download a single stream using the original infrastructure
   */
  function downloadSingleStream(data, fileHandle) {
    return new Promise((resolve, reject) => {
      // Set up completion listener
      const onComplete = () => {
        events.after.delete(onComplete);
        resolve();
      };
      
      // Check if events.after exists (from original code)
      if (typeof events !== 'undefined' && events.after) {
        events.after.add(onComplete);
      }
      
      // Set global file handle for original code to use
      self.aFile = fileHandle;
      
      // Click original download button
      if (data.downloadBtn) {
        data.downloadBtn.click();
      } else {
        reject(new Error('No download button found'));
      }
      
      // Timeout after 5 minutes per file
      setTimeout(() => {
        if (typeof events !== 'undefined' && events.after) {
          events.after.delete(onComplete);
        }
        reject(new Error('Download timeout'));
      }, 300000);
    });
  }

  // ===========================================
  // PROGRESS UI
  // ===========================================

  function showBatchProgress(current, total) {
    const progressEl = document.getElementById('batch-progress');
    if (progressEl) {
      progressEl.style.display = 'block';
      updateBatchProgress(current, total, '');
    }
  }

  function updateBatchProgress(current, total, filename) {
    const textEl = document.getElementById('batch-progress-text');
    const fillEl = document.getElementById('batch-progress-fill');
    
    if (textEl) {
      textEl.textContent = `Downloading ${current + 1} of ${total}: ${filename}`;
    }
    
    if (fillEl) {
      const percent = total > 0 ? (current / total) * 100 : 0;
      fillEl.style.width = `${percent}%`;
    }
  }

  function hideBatchProgress() {
    const progressEl = document.getElementById('batch-progress');
    if (progressEl) {
      progressEl.style.display = 'none';
    }
  }

  function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.textContent = message;
    
    const colors = {
      success: '#10b981',
      error: '#ef4444',
      warning: '#f59e0b',
      info: '#3b82f6'
    };
    
    notification.style.cssText = `
      position: fixed;
      bottom: 80px;
      right: 20px;
      max-width: 400px;
      padding: 12px 16px;
      background: ${colors[type] || colors.info};
      color: white;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 10001;
    `;
    
    document.body.appendChild(notification);
    
    // Stay visible for 8 seconds (increased from 5)
    setTimeout(() => {
      notification.remove();
    }, 8000);
  }

  // ===========================================
  // RECORDING BADGE
  // ===========================================

  function setupRecordingBadge() {
    const liveControls = document.getElementById('live-controls');
    const recordingBadge = document.getElementById('recording-badge');
    const streamsSection = document.getElementById('streams-section');
    
    if (!liveControls || !recordingBadge) return;
    
    const observer = new MutationObserver(() => {
      if (liveControls.style.display !== 'none') {
        recordingBadge.classList.add('active');
        
        // Collapse streams section to give more space to WRU Editor
        if (streamsSection) {
          streamsSection.classList.add('recording-mode');
        }
        
        const segments = document.getElementById('live-segment-count')?.textContent || '0';
        const batches = document.getElementById('live-batch-count')?.textContent || '0';
        const duration = document.getElementById('live-duration')?.textContent || '0:00:00';
        
        document.getElementById('badge-segments').textContent = segments;
        document.getElementById('badge-batches').textContent = batches;
        document.getElementById('badge-duration').textContent = duration;
      } else {
        recordingBadge.classList.remove('active');
        
        // Expand streams section back
        if (streamsSection) {
          streamsSection.classList.remove('recording-mode');
        }
      }
    });
    
    observer.observe(liveControls, { attributes: true, attributeFilter: ['style'] });
    
    // Sync stats continuously
    setInterval(() => {
      if (recordingBadge.classList.contains('active')) {
        const segments = document.getElementById('live-segment-count')?.textContent || '0';
        const batches = document.getElementById('live-batch-count')?.textContent || '0';
        const duration = document.getElementById('live-duration')?.textContent || '0:00:00';
        
        document.getElementById('badge-segments').textContent = segments;
        document.getElementById('badge-batches').textContent = batches;
        document.getElementById('badge-duration').textContent = duration;
      }
    }, 1000);
    
    // Hook up stop button
    document.getElementById('badge-stop-btn').addEventListener('click', () => {
      document.getElementById('stop-recording')?.click();
    });
  }

  /**
   * Sanitize filename - remove/replace characters not allowed in filenames
   */
  function sanitizeFilename(filename) {
    if (!filename) return 'Untitled';
    
    // Replace characters not allowed in Windows/Mac/Linux filenames
    // Windows: \ / : * ? " < > |
    // Mac/Linux: / and null
    return filename
      .replace(/[\/\\:*?"<>|]/g, '_')  // Replace forbidden chars with underscore
      .replace(/\s+/g, ' ')             // Collapse multiple spaces
      .trim()                           // Remove leading/trailing whitespace
      .substring(0, 200);               // Limit length (some filesystems have limits)
  }

  // ===========================================
  // UTILITIES
  // ===========================================

  function truncate(str, len) {
    if (!str) return '';
    if (str.length <= len) return str;
    return str.substring(0, len) + '...';
  }

})();
