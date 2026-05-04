/**
 * liveDownload UI - Recording Badge
 * Floating badge overlay showing live recording status and controls.
 */
'use strict';

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

