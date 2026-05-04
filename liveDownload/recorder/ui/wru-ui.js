/**
 * liveDownload UI - WRU Editor
 * Accordion panel: add/remove/toggle broadcaster URLs, export/import, poll now.
 */
'use strict';

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
      console.log('[WRU] ⏸️ Polling suspended by user');
      showNotification('⏸️ Polling suspended - no automatic checks until resumed', 'info');
    } else {
      console.log('[WRU] ▶️ Polling resumed by user');
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
        title: item.title,
        pollStart: item.pollStart || null,
        pollEnd: item.pollEnd || null
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
        title: item.title,
        skipPoll: true
      });
      
      if (response?.success) {
        imported++;
        // Apply poll window if present in import data
        if (item.pollStart && item.pollEnd) {
          await chrome.runtime.sendMessage({
            method: 'wru-update',
            originalUrl: item.url,
            url: item.url,
            title: item.title || item.url,
            pollStart: item.pollStart,
            pollEnd: item.pollEnd
          });
        }
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
        const pollWindow = (item.pollStart && item.pollEnd)
          ? `<span class="wru-poll-window">${item.pollStart} – ${item.pollEnd}</span>`
          : '';
        
        html += `
          <div class="wru-item" data-url="${escapeHtml(item.url)}">
            <span class="wru-item-status">${statusIcon}</span>
            <div class="wru-item-info">
              <div class="wru-item-title">${escapeHtml(item.title || 'Unknown')}${pollWindow}</div>
              <div class="wru-item-url">${escapeHtml(item.url)}</div>
            </div>
            <div class="wru-item-actions">
              <button class="wru-item-btn edit" 
                      data-action="edit" 
                      data-url="${escapeHtml(item.url)}"
                      title="Edit URL, title, poll window">
                ✏️
              </button>
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
        const pollWindow = (item.pollStart && item.pollEnd)
          ? `<span class="wru-poll-window">${item.pollStart} – ${item.pollEnd}</span>`
          : '';

        html += `
          <div class="wru-item inactive" data-url="${escapeHtml(item.url)}">
            <span class="wru-item-status">⏸️</span>
            <div class="wru-item-info">
              <div class="wru-item-title">${escapeHtml(item.title || 'Unknown')}${pollWindow}</div>
              <div class="wru-item-url">${escapeHtml(item.url)}</div>
            </div>
            <div class="wru-item-actions">
              <button class="wru-item-btn edit" 
                      data-action="edit" 
                      data-url="${escapeHtml(item.url)}"
                      title="Edit URL, title, poll window">
                ✏️
              </button>
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
        
      case 'edit':
        openWRUEditModal(url);
        return; // Don't refresh list — modal handles it
        
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

// ─── Edit Modal ──────────────────────────────────────────────────────────────

async function openWRUEditModal(url) {
  // Fetch current entry data
  let entry;
  try {
    const response = await chrome.runtime.sendMessage({ method: 'wru-getAll' });
    entry = response?.urls?.find(item => item.url === url);
  } catch (e) {
    showNotification('Could not load entry', 'error');
    return;
  }
  if (!entry) {
    showNotification('Entry not found', 'error');
    return;
  }

  // Remove any existing modal
  document.getElementById('wru-edit-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'wru-edit-modal';
  modal.className = 'wru-modal-overlay';
  modal.innerHTML = `
    <div class="wru-modal">
      <div class="wru-modal-header">Edit WRU Entry</div>
      <div class="wru-modal-body">
        <div class="wru-modal-field">
          <label>URL</label>
          <input type="text" id="wru-edit-url" value="${escapeHtml(entry.url)}" spellcheck="false">
        </div>
        <div class="wru-modal-field">
          <label>Title</label>
          <input type="text" id="wru-edit-title" value="${escapeHtml(entry.title || '')}">
        </div>
        <div class="wru-modal-field">
          <label>Poll Window (leave empty for always, overnight OK e.g. 20:00–07:00)</label>
          <div class="wru-time-row">
            <div class="wru-time-control">
              <span>Start</span>
              <div class="wru-time-spinner">
                <button class="wru-time-btn" data-target="wru-edit-start" data-dir="up">▲</button>
                <input type="text" id="wru-edit-start" value="${entry.pollStart || ''}" placeholder="HH:MM" maxlength="5" class="wru-time-input">
                <button class="wru-time-btn" data-target="wru-edit-start" data-dir="down">▼</button>
              </div>
            </div>
            <span class="wru-time-dash">–</span>
            <div class="wru-time-control">
              <span>End</span>
              <div class="wru-time-spinner">
                <button class="wru-time-btn" data-target="wru-edit-end" data-dir="up">▲</button>
                <input type="text" id="wru-edit-end" value="${entry.pollEnd || ''}" placeholder="HH:MM" maxlength="5" class="wru-time-input">
                <button class="wru-time-btn" data-target="wru-edit-end" data-dir="down">▼</button>
              </div>
            </div>
            <button class="wru-time-clear-btn" title="Clear poll window">✕</button>
          </div>
        </div>
      </div>
      <div class="wru-modal-footer">
        <button class="wru-modal-btn cancel" id="wru-edit-cancel">Cancel</button>
        <button class="wru-modal-btn save" id="wru-edit-save">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // ── Time spinner logic ──
  const pollInterval = 15; // minutes — matches polling interval resolution

  function parseHHMM(str) {
    const m = (str || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1]), min = parseInt(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  function formatHHMM(totalMin) {
    totalMin = ((totalMin % 1440) + 1440) % 1440; // wrap 0–1439
    return String(Math.floor(totalMin / 60)).padStart(2, '0') + ':' + String(totalMin % 60).padStart(2, '0');
  }

  modal.querySelectorAll('.wru-time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const dir = btn.dataset.dir === 'up' ? 1 : -1;
      let mins = parseHHMM(input.value);
      if (mins === null) {
        // Default: start at current time rounded to interval
        const now = new Date();
        mins = Math.round((now.getHours() * 60 + now.getMinutes()) / pollInterval) * pollInterval;
      }
      mins += dir * pollInterval;
      input.value = formatHHMM(mins);
    });
  });

  // Clear button
  modal.querySelector('.wru-time-clear-btn').addEventListener('click', () => {
    document.getElementById('wru-edit-start').value = '';
    document.getElementById('wru-edit-end').value = '';
  });

  // ── Save / Cancel ──
  document.getElementById('wru-edit-cancel').addEventListener('click', () => modal.remove());

  // Click overlay to cancel
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  document.getElementById('wru-edit-save').addEventListener('click', async () => {
    const newUrl   = document.getElementById('wru-edit-url').value.trim();
    const newTitle = document.getElementById('wru-edit-title').value.trim();
    const startVal = document.getElementById('wru-edit-start').value.trim();
    const endVal   = document.getElementById('wru-edit-end').value.trim();

    if (!newUrl) {
      showNotification('URL is required', 'error');
      return;
    }

    // Validate times if either is set
    let pollStart = null, pollEnd = null;
    if (startVal || endVal) {
      if (!startVal || !endVal) {
        showNotification('Both start and end times are required, or clear both', 'error');
        return;
      }
      if (parseHHMM(startVal) === null || parseHHMM(endVal) === null) {
        showNotification('Invalid time format — use HH:MM (24-hour)', 'error');
        return;
      }
      if (parseHHMM(startVal) === parseHHMM(endVal)) {
        showNotification('Start and end times cannot be the same', 'error');
        return;
      }
      pollStart = startVal;
      pollEnd   = endVal;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        method: 'wru-update',
        originalUrl: url,
        url: newUrl,
        title: newTitle || newUrl,
        pollStart,
        pollEnd
      });

      if (response?.success) {
        showNotification('Entry updated', 'success');
        modal.remove();
        loadWRUList();
        updateWRUCount();
      } else {
        showNotification(response?.error || 'Update failed', 'error');
      }
    } catch (e) {
      console.error('[WRU] Edit save error:', e);
      showNotification('Save failed: ' + e.message, 'error');
    }
  });
}
