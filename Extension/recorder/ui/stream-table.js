/**
 * liveDownload UI - Stream Table
 * Renders the detected streams as a filterable table; handles VOD batch downloads.
 */
'use strict';

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
      
      // Add timestamp to filename for uniqueness and traceability
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16); // MM-DD-YYYY format approx
      const ext = filename.lastIndexOf('.');
      if (ext > 0) {
        filename = filename.substring(0, ext) + '_' + timestamp + filename.substring(ext);
      } else {
        filename = filename + '_' + timestamp;
      }
      
      console.log(`[modern-ui] Filename with timestamp: "${filename}"`);
      
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
