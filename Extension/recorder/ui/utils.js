/**
 * liveDownload UI - Shared Data Model & Utilities
 * These globals are accessible to all ui/ scripts loaded in the same page.
 */
'use strict';

// ===========================================
// SHARED DATA MODEL - single source of truth
// ===========================================

// ===========================================
const streamData = new Map(); // index -> {url, meta, entry, node, isLive, selected}
let streamIndex = 0;          // monotonic counter — key for streamData entries

// ===========================================
// UTILITIES
// ===========================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Periodically update header counts

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

