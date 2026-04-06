/**
 * Settings Panel Management
 * Handles UI, storage, and directory permissions for liveDownload
 */

(function() {
  'use strict';

  // Settings keys
  const SETTINGS_KEYS = {
    ROOT_DIRECTORY: 'liveDownload_rootDirectory',
    BATCH_SIZE: 'liveDownload_batchSize',
    AUTO_CONCAT: 'liveDownload_autoConcat',
    LIVE_THREADS: 'liveDownload_liveThreads',
    MAX_MANIFEST_ERRORS: 'liveDownload_maxManifestErrors',
    RESILIENT_MODE: 'liveDownload_resilientMode',
    RECOVERY_POLL_INTERVAL: 'liveDownload_recoveryPollInterval',
    MAX_ERRORS_BEFORE_RECOVERY: 'liveDownload_maxErrorsBeforeRecovery',
    TRANSLATE_TITLES: 'liveDownload_translateTitles',
    FILENAME: 'filename',
    THREADS: 'threads',
    ERROR_TOLERANCE: 'error-tolerance',
    DEFAULT_FORMAT: 'default-format',
    QUALITY: 'quality',
    AUTO_CLOSE: 'autoclose',
    MIME_WATCH: 'mime-watch',
    ONLINE_RESOLVE_NAME: 'online-resolve-name',  // kept for storage compat, not shown in UI
    // Wait for Start settings
    WAIT_CHECK_INTERVAL: 'waitForStart_checkInterval',
    WAIT_INITIAL_WAIT: 'waitForStart_initialWait',
    WAIT_MAX_TABS: 'waitForStart_maxTabs',
    WAIT_MONITOR_TIMEOUT: 'waitForStart_monitorTimeout',  // How long to wait per URL before closing window
    POLLING_SUSPENDED: 'waitForStart_pollingSuspended'  // User can suspend/resume polling
  };

  // Default values
  const DEFAULTS = {
    [SETTINGS_KEYS.BATCH_SIZE]: 20,
    [SETTINGS_KEYS.AUTO_CONCAT]: true,
    [SETTINGS_KEYS.LIVE_THREADS]: 1,
    [SETTINGS_KEYS.MAX_MANIFEST_ERRORS]: 10,
    [SETTINGS_KEYS.RESILIENT_MODE]: true,  // ON by default
    [SETTINGS_KEYS.RECOVERY_POLL_INTERVAL]: 5,  // 5 minutes
    [SETTINGS_KEYS.MAX_ERRORS_BEFORE_RECOVERY]: 100,  // ~5 min of errors
    [SETTINGS_KEYS.TRANSLATE_TITLES]: false,  // OFF by default
    [SETTINGS_KEYS.FILENAME]: '【[q:.nick|textContent|Unknown]】[title]',
    [SETTINGS_KEYS.THREADS]: 3,
    [SETTINGS_KEYS.ERROR_TOLERANCE]: 30,
    [SETTINGS_KEYS.DEFAULT_FORMAT]: 'ts',
    [SETTINGS_KEYS.QUALITY]: 'highest',
    [SETTINGS_KEYS.AUTO_CLOSE]: false,
    [SETTINGS_KEYS.MIME_WATCH]: false,
    [SETTINGS_KEYS.ONLINE_RESOLVE_NAME]: true,
    // Wait for Start defaults
    [SETTINGS_KEYS.WAIT_CHECK_INTERVAL]: 15,   // minutes
    [SETTINGS_KEYS.WAIT_INITIAL_WAIT]: 10,     // seconds
    [SETTINGS_KEYS.WAIT_MAX_TABS]: 10,
    [SETTINGS_KEYS.WAIT_MONITOR_TIMEOUT]: 90,   // seconds - how long to wait per URL
    [SETTINGS_KEYS.POLLING_SUSPENDED]: false    // Polling active by default
  };

  let currentSettings = {};
  let rootDirectoryHandle = null;
  
  // IndexedDB for storing directory handle (can't use chrome.storage for handles)
  const DB_NAME = 'liveDownload';
  const DB_VERSION = 1;
  const STORE_NAME = 'handles';
  
  async function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }
  
  async function saveDirectoryHandle(handle) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(handle, 'rootDirectory');
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      console.log('[Settings] Directory handle saved to IndexedDB');
    } catch (e) {
      console.error('[Settings] Failed to save directory handle:', e);
    }
  }
  
  async function loadDirectoryHandle() {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get('rootDirectory');
      
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      console.error('[Settings] Failed to load directory handle:', e);
      return null;
    }
  }

  /**
   * Initialize settings panel
   */
  function init() {
    // Find or create gear icon
    setupGearIcon();
    
    // Setup event listeners
    setupEventListeners();
    
    // Load current settings
    loadSettings();
  }

  /**
   * Setup gear icon in footer
   */
  function setupGearIcon() {
    // Use existing #options gear icon from original plugin
    const gearIcon = document.getElementById('options');
    if (!gearIcon) {
      console.warn('[Settings] #options gear icon not found');
      return;
    }
    
    // Remove any existing click handlers and set up ours
    gearIcon.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSettings();
    };
    
    console.log('[Settings] Hooked into existing gear icon');
  }

  /**
   * Setup all event listeners
   */
  function setupEventListeners() {
    // Gear icon click is handled in setupGearIcon()
    
    // Overlay click (close)
    document.getElementById('settings-overlay')?.addEventListener('click', closeSettings);
    
    // Cancel button
    document.getElementById('settings-cancel')?.addEventListener('click', closeSettings);
    
    // Save button
    document.getElementById('settings-save')?.addEventListener('click', saveSettings);
    
    // Choose directory button
    document.getElementById('choose-root-directory')?.addEventListener('click', chooseDirectory);
    
    // Batch size slider
    const batchSlider = document.getElementById('batch-size');
    const batchValue = document.getElementById('batch-size-value');
    if (batchSlider && batchValue) {
      batchSlider.addEventListener('input', (e) => {
        batchValue.textContent = e.target.value;
      });
    }
  }

  /**
   * Load settings from storage
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(Object.values(SETTINGS_KEYS));
      currentSettings = { ...DEFAULTS, ...stored };
      
      // Load directory handle from IndexedDB
      const handle = await loadDirectoryHandle();
      if (handle) {
        // Just store the handle - permission will be checked/requested when actually used
        // (requestPermission requires user activation, which we don't have on page load)
        rootDirectoryHandle = handle;
        console.log('[Settings] Loaded directory handle from IndexedDB');
      }
      
      updateUI();
    } catch (e) {
      console.error('[Settings] Error loading settings:', e);
    }
  }

  /**
   * Update UI with current settings
   */
  function updateUI() {
    // Root directory
    const dirDisplay = document.getElementById('root-directory-display');
    if (dirDisplay) {
      const isPolyfilled = window.showDirectoryPicker?._polyfilled;
      
      if (isPolyfilled) {
        // Browser doesn't support native file system access
        dirDisplay.textContent = 'Downloads (browser default)';
        dirDisplay.classList.remove('empty');
      } else if (rootDirectoryHandle) {
        dirDisplay.textContent = rootDirectoryHandle.name || 'Selected';
        dirDisplay.classList.remove('empty');
      } else {
        dirDisplay.textContent = 'Not selected';
        dirDisplay.classList.add('empty');
      }
    }
    
    // Filename format
    const filename = document.getElementById('settings-filename');
    if (filename) filename.value = currentSettings[SETTINGS_KEYS.FILENAME];
    
    // Batch size
    const batchSlider = document.getElementById('batch-size');
    const batchValue = document.getElementById('batch-size-value');
    if (batchSlider && batchValue) {
      batchSlider.value = currentSettings[SETTINGS_KEYS.BATCH_SIZE];
      batchValue.textContent = currentSettings[SETTINGS_KEYS.BATCH_SIZE];
    }
    
    // Live threads
    const liveThreads = document.getElementById('live-threads');
    if (liveThreads) liveThreads.value = currentSettings[SETTINGS_KEYS.LIVE_THREADS];
    
    // Max manifest errors
    const maxManifestErrors = document.getElementById('max-manifest-errors');
    if (maxManifestErrors) maxManifestErrors.value = currentSettings[SETTINGS_KEYS.MAX_MANIFEST_ERRORS];
    
    // Resilient mode
    const resilientMode = document.getElementById('resilient-mode');
    if (resilientMode) resilientMode.checked = currentSettings[SETTINGS_KEYS.RESILIENT_MODE];
    
    // Recovery poll interval
    const recoveryPollInterval = document.getElementById('recovery-poll-interval');
    if (recoveryPollInterval) recoveryPollInterval.value = currentSettings[SETTINGS_KEYS.RECOVERY_POLL_INTERVAL];
    
    // Max errors before recovery
    const maxErrorsBeforeRecovery = document.getElementById('max-errors-before-recovery');
    if (maxErrorsBeforeRecovery) maxErrorsBeforeRecovery.value = currentSettings[SETTINGS_KEYS.MAX_ERRORS_BEFORE_RECOVERY];
    
    // Translate titles
    const translateTitles = document.getElementById('translate-titles');
    if (translateTitles) translateTitles.checked = currentSettings[SETTINGS_KEYS.TRANSLATE_TITLES];
    
    // Checkboxes
    const autoConcat = document.getElementById('auto-concat');
    if (autoConcat) autoConcat.checked = currentSettings[SETTINGS_KEYS.AUTO_CONCAT];
    
    const autoClose = document.getElementById('settings-autoclose');
    if (autoClose) autoClose.checked = currentSettings[SETTINGS_KEYS.AUTO_CLOSE];
    
    const mimeWatch = document.getElementById('settings-mime-watch');
    if (mimeWatch) mimeWatch.checked = currentSettings[SETTINGS_KEYS.MIME_WATCH];
    
    
    // Numbers
    const threads = document.getElementById('settings-threads');
    if (threads) threads.value = currentSettings[SETTINGS_KEYS.THREADS];
    
    const errorTolerance = document.getElementById('settings-error-tolerance');
    if (errorTolerance) errorTolerance.value = currentSettings[SETTINGS_KEYS.ERROR_TOLERANCE];
    
    // IMPORTANT: Sync to original element that helper.js reads for file picker — always TS
    const originalFormat = document.getElementById('default-format');
    if (originalFormat) originalFormat.value = 'ts';
    
    const quality = document.getElementById('settings-quality');
    if (quality) quality.value = currentSettings[SETTINGS_KEYS.QUALITY];
    
    // Wait for Start settings
    const waitCheckInterval = document.getElementById('wait-check-interval');
    if (waitCheckInterval) waitCheckInterval.value = currentSettings[SETTINGS_KEYS.WAIT_CHECK_INTERVAL];
    
    const waitInitialWait = document.getElementById('wait-initial-wait');
    if (waitInitialWait) waitInitialWait.value = currentSettings[SETTINGS_KEYS.WAIT_INITIAL_WAIT];
    
    const waitMaxTabs = document.getElementById('wait-max-tabs');
    if (waitMaxTabs) waitMaxTabs.value = currentSettings[SETTINGS_KEYS.WAIT_MAX_TABS];
    
    const waitMonitorTimeout = document.getElementById('wait-monitor-timeout');
    if (waitMonitorTimeout) waitMonitorTimeout.value = currentSettings[SETTINGS_KEYS.WAIT_MONITOR_TIMEOUT];
  }

  /**
   * Open settings panel
   */
  function openSettings() {
    const overlay = document.getElementById('settings-overlay');
    const panel = document.getElementById('settings-panel');
    
    if (overlay) overlay.classList.add('visible');
    if (panel) {
      // Small delay for animation
      setTimeout(() => panel.classList.add('visible'), 10);
    }
  }

  /**
   * Close settings panel
   */
  function closeSettings() {
    const overlay = document.getElementById('settings-overlay');
    const panel = document.getElementById('settings-panel');
    
    if (panel) panel.classList.remove('visible');
    
    // Wait for animation
    setTimeout(() => {
      if (overlay) overlay.classList.remove('visible');
    }, 300);
  }

  /**
   * Choose root directory
   */
  async function chooseDirectory() {
    try {
      // Check if native File System Access API is available
      const isPolyfilled = window.showDirectoryPicker?._polyfilled;
      
      if (isPolyfilled) {
        // Polyfill is active - directory picker won't work as expected
        alert('Your browser does not support the File System Access API.\n\n' +
              'Recordings will be saved to your browser\'s default Downloads folder.\n\n' +
              'For best experience, use Chrome or Edge.');
        
        // Update display to show fallback
        const dirDisplay = document.getElementById('root-directory-display');
        if (dirDisplay) {
          dirDisplay.textContent = 'Downloads (browser default)';
          dirDisplay.classList.remove('empty');
        }
        return;
      }
      
      const dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'downloads'
      });
      
      rootDirectoryHandle = dirHandle;
      
      // Update display
      const dirDisplay = document.getElementById('root-directory-display');
      if (dirDisplay) {
        dirDisplay.textContent = dirHandle.name || 'Selected';
        dirDisplay.classList.remove('empty');
      }
      
      console.log('[Settings] Directory selected:', dirHandle.name);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[Settings] Error selecting directory:', e);
        alert('Failed to select directory: ' + e.message);
      }
    }
  }

  /**
   * Save settings
   */
  async function saveSettings() {
    try {
      // Gather values from UI
      const newSettings = {
        [SETTINGS_KEYS.FILENAME]: document.getElementById('settings-filename')?.value || '[title]',
        [SETTINGS_KEYS.BATCH_SIZE]: parseInt(document.getElementById('batch-size')?.value || 50),
        [SETTINGS_KEYS.AUTO_CONCAT]: document.getElementById('auto-concat')?.checked || false,
        [SETTINGS_KEYS.LIVE_THREADS]: parseInt(document.getElementById('live-threads')?.value || 1),
        [SETTINGS_KEYS.MAX_MANIFEST_ERRORS]: parseInt(document.getElementById('max-manifest-errors')?.value || 10),
        [SETTINGS_KEYS.RESILIENT_MODE]: document.getElementById('resilient-mode')?.checked ?? true,
        [SETTINGS_KEYS.RECOVERY_POLL_INTERVAL]: parseInt(document.getElementById('recovery-poll-interval')?.value || 5),
        [SETTINGS_KEYS.MAX_ERRORS_BEFORE_RECOVERY]: parseInt(document.getElementById('max-errors-before-recovery')?.value || 100),
        [SETTINGS_KEYS.TRANSLATE_TITLES]: document.getElementById('translate-titles')?.checked || false,
        [SETTINGS_KEYS.THREADS]: parseInt(document.getElementById('settings-threads')?.value || 3),
        [SETTINGS_KEYS.ERROR_TOLERANCE]: parseInt(document.getElementById('settings-error-tolerance')?.value || 30),
        [SETTINGS_KEYS.DEFAULT_FORMAT]: 'ts',
        [SETTINGS_KEYS.QUALITY]: document.getElementById('settings-quality')?.value || 'highest',
        [SETTINGS_KEYS.AUTO_CLOSE]: document.getElementById('settings-autoclose')?.checked || false,
        [SETTINGS_KEYS.MIME_WATCH]: document.getElementById('settings-mime-watch')?.checked || false,
        // Wait for Start settings
        [SETTINGS_KEYS.WAIT_CHECK_INTERVAL]: parseInt(document.getElementById('wait-check-interval')?.value || 15),
        [SETTINGS_KEYS.WAIT_INITIAL_WAIT]: parseInt(document.getElementById('wait-initial-wait')?.value || 10),
        [SETTINGS_KEYS.WAIT_MAX_TABS]: parseInt(document.getElementById('wait-max-tabs')?.value || 10),
        [SETTINGS_KEYS.WAIT_MONITOR_TIMEOUT]: parseInt(document.getElementById('wait-monitor-timeout')?.value || 45)
      };
      
      // Save directory handle to IndexedDB (can't serialize to chrome.storage)
      if (rootDirectoryHandle) {
        await saveDirectoryHandle(rootDirectoryHandle);
      }
      
      // Save other settings to chrome.storage
      await chrome.storage.local.set(newSettings);
      
      currentSettings = newSettings;
      
      // Notify service worker of settings change (for polling interval update)
      chrome.runtime.sendMessage({
        method: 'settings-updated',
        checkInterval: newSettings[SETTINGS_KEYS.WAIT_CHECK_INTERVAL]
      });
      
      console.log('[Settings] Settings saved successfully');
      
      // Close panel
      closeSettings();
      
      // Show confirmation
      const saveBtn = document.getElementById('settings-save');
      if (saveBtn) {
        const originalText = saveBtn.textContent;
        saveBtn.textContent = '✓ Saved!';
        setTimeout(() => {
          saveBtn.textContent = originalText;
        }, 2000);
      }
    } catch (e) {
      console.error('[Settings] Error saving settings:', e);
      alert('Failed to save settings: ' + e.message);
    }
  }

  /**
   * Get current settings (for use by other modules)
   */
  window.getSettings = function() {
    return currentSettings;
  };

  /**
   * Get root directory handle (for use by live-integration.js)
   */
  window.getRootDirectory = function() {
    return rootDirectoryHandle;
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
