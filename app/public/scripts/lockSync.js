/**
 * Lock Sync Client Module
 * Handles UI for lock synchronization operations
 */
const LockSync = (function() {
  let overlay = null;
  let isSyncing = false;

  // Operation display names
  const operationNames = {
    push: 'Push All Codes',
    clear: 'Clear All Slots',
    resync: 'Full Resync'
  };

  // Operation confirmation messages
  const confirmMessages = {
    push: 'This will push all active codes from the database to the door locks.\n\nThis may take several minutes. Continue?',
    clear: 'This will CLEAR ALL 249 SLOTS on the door locks.\n\nThis is a destructive operation. All codes will be removed from the locks.\n\nAre you sure you want to continue?',
    resync: 'This will perform a FULL RESYNC:\n1. Clear all 249 slots on the locks\n2. Push all active codes from the database\n\nThis is the nuclear option and will take several minutes.\n\nAre you absolutely sure?'
  };

  /**
   * Initialize the module - create overlay element
   */
  function init() {
    // Create overlay HTML
    overlay = document.createElement('div');
    overlay.id = 'sync-overlay';
    overlay.className = 'sync-overlay';
    overlay.innerHTML = `
      <div class="sync-modal">
        <h2 id="sync-title">Lock Sync</h2>
        <div class="sync-status" id="sync-status">Initializing...</div>
        <div class="sync-progress-container">
          <div class="sync-progress-bar" id="sync-progress-bar"></div>
        </div>
        <div class="sync-progress-text" id="sync-progress-text">0 / 0</div>
        <div class="sync-results" id="sync-results" style="display: none;">
          <div class="sync-results-summary" id="sync-results-summary"></div>
          <div class="sync-results-errors" id="sync-results-errors"></div>
        </div>
        <button class="btn btn-submit sync-close-btn" id="sync-close-btn" style="display: none;">Close</button>
      </div>
    `;
    document.body.appendChild(overlay);

    // Close button handler
    document.getElementById('sync-close-btn').addEventListener('click', hideOverlay);

    // Warn before navigating away during sync
    window.addEventListener('beforeunload', function(e) {
      if (isSyncing) {
        e.preventDefault();
        e.returnValue = 'A sync operation is in progress. Are you sure you want to leave?';
        return e.returnValue;
      }
    });
  }

  /**
   * Show the overlay
   */
  function showOverlay(operation) {
    const title = operationNames[operation] || 'Lock Sync';
    document.getElementById('sync-title').textContent = title;
    document.getElementById('sync-status').textContent = 'Starting...';
    document.getElementById('sync-progress-bar').style.width = '0%';
    document.getElementById('sync-progress-text').textContent = '0 / 0';
    document.getElementById('sync-results').style.display = 'none';
    document.getElementById('sync-close-btn').style.display = 'none';
    overlay.style.display = 'flex';
  }

  /**
   * Hide the overlay
   */
  function hideOverlay() {
    overlay.style.display = 'none';
  }

  /**
   * Update progress display
   */
  function updateProgress(progress) {
    const percent = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
    document.getElementById('sync-status').textContent = progress.message;
    document.getElementById('sync-progress-bar').style.width = percent + '%';
    document.getElementById('sync-progress-text').textContent = `${progress.current} / ${progress.total}`;
  }

  /**
   * Show completion results
   */
  function showResults(results) {
    const resultsDiv = document.getElementById('sync-results');
    const summaryDiv = document.getElementById('sync-results-summary');
    const errorsDiv = document.getElementById('sync-results-errors');
    const statusDiv = document.getElementById('sync-status');

    statusDiv.textContent = 'Complete!';

    let summaryHtml = `<p><strong>Success:</strong> ${results.success}</p>`;
    summaryHtml += `<p><strong>Failed:</strong> ${results.failed}</p>`;

    if (results.phases) {
      summaryHtml += `<p><small>Clear: ${results.phases.clear.success} ok, ${results.phases.clear.failed} failed</small></p>`;
      summaryHtml += `<p><small>Push: ${results.phases.push.success} ok, ${results.phases.push.failed} failed</small></p>`;
    }

    summaryDiv.innerHTML = summaryHtml;

    if (results.errors && results.errors.length > 0) {
      let errorsHtml = '<p><strong>Errors:</strong></p><ul>';
      const maxErrors = 10;
      const displayErrors = results.errors.slice(0, maxErrors);

      for (const error of displayErrors) {
        if (error.name) {
          errorsHtml += `<li>${error.name} (slot ${error.slot}): ${error.error}</li>`;
        } else {
          errorsHtml += `<li>Slot ${error.slot}: ${error.error}</li>`;
        }
      }

      if (results.errors.length > maxErrors) {
        errorsHtml += `<li>...and ${results.errors.length - maxErrors} more</li>`;
      }

      errorsHtml += '</ul>';
      errorsDiv.innerHTML = errorsHtml;
    } else {
      errorsDiv.innerHTML = '';
    }

    resultsDiv.style.display = 'block';
    document.getElementById('sync-close-btn').style.display = 'block';
  }

  /**
   * Show error
   */
  function showError(error) {
    document.getElementById('sync-status').textContent = 'Error: ' + error;
    document.getElementById('sync-results').style.display = 'none';
    document.getElementById('sync-close-btn').style.display = 'block';
  }

  /**
   * Start a sync operation
   */
  function startSync(operation) {
    // Validate operation
    if (!operationNames[operation]) {
      alert('Unknown operation: ' + operation);
      return;
    }

    // Confirm with user
    if (!confirm(confirmMessages[operation])) {
      return;
    }

    // Show overlay
    showOverlay(operation);
    isSyncing = true;

    // Create EventSource for SSE
    // Using fetch with POST since EventSource only supports GET
    fetch(`/api/sync/${operation}`, {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream'
      }
    }).then(response => {
      if (!response.ok) {
        return response.json().then(err => {
          throw new Error(err.error || 'Sync failed');
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      function processStream() {
        return reader.read().then(({ done, value }) => {
          if (done) {
            isSyncing = false;
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete events in buffer
          const lines = buffer.split('\n');
          buffer = '';

          let eventType = null;
          let eventData = null;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('event: ')) {
              eventType = line.substring(7);
            } else if (line.startsWith('data: ')) {
              eventData = line.substring(6);

              // Process the event
              if (eventType && eventData) {
                try {
                  const data = JSON.parse(eventData);
                  handleEvent(eventType, data);
                } catch (e) {
                  console.error('Error parsing SSE data:', e);
                }
              }

              eventType = null;
              eventData = null;
            } else if (line === '') {
              // Empty line - end of event
            } else {
              // Incomplete data, add back to buffer
              buffer = lines.slice(i).join('\n');
              break;
            }
          }

          return processStream();
        });
      }

      return processStream();
    }).catch(error => {
      isSyncing = false;
      showError(error.message);
    });
  }

  /**
   * Handle SSE events
   */
  function handleEvent(eventType, data) {
    switch (eventType) {
      case 'start':
        updateProgress({ current: 0, total: 0, message: 'Starting...' });
        break;
      case 'progress':
        updateProgress(data);
        break;
      case 'complete':
        isSyncing = false;
        updateProgress({ current: data.success + data.failed, total: data.success + data.failed, message: 'Complete!' });
        showResults(data);
        break;
      case 'error':
        isSyncing = false;
        showError(data.error);
        break;
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API
  return {
    startSync: startSync
  };
})();
