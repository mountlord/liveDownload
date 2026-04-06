/**
 * liveDownload UI - App Entry Point
 * init() wires everything together; injectModernUI() builds the DOM skeleton.
 * This file must be loaded LAST in index.html.
 */
'use strict';

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
      <button class="header-icon-btn header-help-btn" id="header-help-btn" title="Help">
        <span class="icon-wrapper">
          <span class="icon">❓</span>
        </span>
      </button>
      <button class="header-icon-btn header-donate-btn" id="header-donate-btn" title="Donate to Save the Children">
        <span class="icon-wrapper">
          <span class="icon">❤️</span>
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
          <div class="empty-state-logo"></div>
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
  // Help button — open local help page in new window
  document.getElementById('header-help-btn').addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('recorder/help.html'),
      type: 'popup',
      width: 900,
      height: 700
    });
  });

  // Donate button — open Save the Children donation page
  document.getElementById('header-donate-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.savethechildren.org/savekids' });
  });

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

// Refresh status counts every 30 seconds
setInterval(updateHeaderStatusCounts, 30000);
