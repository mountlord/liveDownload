/**
 * liveDownload UI - Status Bar
 * Header status counts, dropdown for waiting/recording lists, status actions.
 */
'use strict';

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
