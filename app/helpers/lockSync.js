const { User, DayCode } = require('../models');
const { setUserCode, clearUserCode } = require('./homeAssistant');

// In-memory sync state (mutex)
const syncState = {
  isRunning: false,
  operation: null,
  startedAt: null,
  current: 0,
  total: 0,
  message: '',
  lastFailedItems: [] // Track failed items for retry
};

// Delay helper for rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limit delay between operations (ms)
const RATE_LIMIT_DELAY = 1000;

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds between retries

/**
 * Execute an operation with automatic retries
 */
async function withRetry(operation, operationName) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        console.log(`[LockSync] ${operationName} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}ms...`);
        await delay(RETRY_DELAY);
      }
    }
  }
  throw lastError;
}

/**
 * Middleware to block lock-modifying routes during sync
 */
function blockDuringSync(req, res, next) {
  if (syncState.isRunning) {
    return res.status(423).json({
      error: 'Lock sync in progress',
      operation: syncState.operation,
      message: 'Please wait for the sync operation to complete before making changes.'
    });
  }
  next();
}

/**
 * Get current sync status
 */
function getSyncStatus() {
  return { ...syncState };
}

/**
 * Push all active codes from DB to locks
 */
async function pushAllCodes(onProgress) {
  const results = { success: 0, failed: 0, errors: [] };

  // Get all full members with pin codes
  const users = await User.findAll({
    where: {
      member_type: 'full',
      pin_code: { [require('sequelize').Op.not]: null },
      pin_code_slot: { [require('sequelize').Op.not]: null }
    }
  });

  // Get all active day codes
  const dayCodes = await DayCode.findAll({
    where: { is_active: true },
    include: [{ model: User, as: 'user', attributes: ['name'] }]
  });

  const total = users.length + dayCodes.length;
  let current = 0;

  onProgress({ current: 0, total, message: `Starting push of ${total} codes...` });

  // Push user codes
  for (const user of users) {
    current++;
    onProgress({
      current,
      total,
      message: `Pushing ${user.name} (slot ${user.pin_code_slot})...`
    });

    try {
      await withRetry(
        () => setUserCode(user.pin_code_slot, user.pin_code),
        `Push ${user.name} (slot ${user.pin_code_slot})`
      );
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        type: 'user',
        name: user.name,
        slot: user.pin_code_slot,
        error: error.message
      });
    }

    await delay(RATE_LIMIT_DELAY);
  }

  // Push day codes
  for (const code of dayCodes) {
    current++;
    const userName = code.user ? code.user.name : 'Unknown';
    onProgress({
      current,
      total,
      message: `Pushing day code for ${userName} (slot ${code.pin_slot})...`
    });

    try {
      await withRetry(
        () => setUserCode(code.pin_slot, code.code),
        `Push day code for ${userName} (slot ${code.pin_slot})`
      );
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        type: 'daycode',
        name: userName,
        slot: code.pin_slot,
        error: error.message
      });
    }

    await delay(RATE_LIMIT_DELAY);
  }

  return results;
}

/**
 * Clear all slots 1-249 on locks
 */
async function clearAllSlots(onProgress) {
  const results = { success: 0, failed: 0, errors: [] };
  const total = 249;

  onProgress({ current: 0, total, message: 'Starting clear of all 249 slots...' });

  for (let slot = 1; slot <= 249; slot++) {
    onProgress({
      current: slot,
      total,
      message: `Clearing slot ${slot}...`
    });

    try {
      await withRetry(
        () => clearUserCode(slot),
        `Clear slot ${slot}`
      );
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        type: 'slot',
        slot,
        error: error.message
      });
    }

    await delay(RATE_LIMIT_DELAY);
  }

  return results;
}

/**
 * Full resync: clear all slots, then push all codes
 */
async function fullResync(onProgress) {
  const totalClear = 249;

  // Get counts for progress tracking
  const users = await User.findAll({
    where: {
      member_type: 'full',
      pin_code: { [require('sequelize').Op.not]: null },
      pin_code_slot: { [require('sequelize').Op.not]: null }
    }
  });
  const dayCodes = await DayCode.findAll({ where: { is_active: true } });
  const totalPush = users.length + dayCodes.length;
  const grandTotal = totalClear + totalPush;

  const results = {
    clear: { success: 0, failed: 0, errors: [] },
    push: { success: 0, failed: 0, errors: [] }
  };

  // Phase 1: Clear all slots
  onProgress({ current: 0, total: grandTotal, message: 'Phase 1: Clearing all slots...' });

  for (let slot = 1; slot <= 249; slot++) {
    onProgress({
      current: slot,
      total: grandTotal,
      message: `Phase 1: Clearing slot ${slot}...`
    });

    try {
      await withRetry(
        () => clearUserCode(slot),
        `Clear slot ${slot}`
      );
      results.clear.success++;
    } catch (error) {
      results.clear.failed++;
      results.clear.errors.push({ slot, error: error.message });
    }

    await delay(RATE_LIMIT_DELAY);
  }

  // Phase 2: Push all codes
  let current = totalClear;
  onProgress({ current, total: grandTotal, message: 'Phase 2: Pushing all codes...' });

  // Push user codes
  for (const user of users) {
    current++;
    onProgress({
      current,
      total: grandTotal,
      message: `Phase 2: Pushing ${user.name} (slot ${user.pin_code_slot})...`
    });

    try {
      await withRetry(
        () => setUserCode(user.pin_code_slot, user.pin_code),
        `Push ${user.name} (slot ${user.pin_code_slot})`
      );
      results.push.success++;
    } catch (error) {
      results.push.failed++;
      results.push.errors.push({
        type: 'user',
        name: user.name,
        slot: user.pin_code_slot,
        error: error.message
      });
    }

    await delay(RATE_LIMIT_DELAY);
  }

  // Re-fetch day codes with user info
  const dayCodesWithUser = await DayCode.findAll({
    where: { is_active: true },
    include: [{ model: User, as: 'user', attributes: ['name'] }]
  });

  // Push day codes
  for (const code of dayCodesWithUser) {
    current++;
    const userName = code.user ? code.user.name : 'Unknown';
    onProgress({
      current,
      total: grandTotal,
      message: `Phase 2: Pushing day code for ${userName} (slot ${code.pin_slot})...`
    });

    try {
      await withRetry(
        () => setUserCode(code.pin_slot, code.code),
        `Push day code for ${userName} (slot ${code.pin_slot})`
      );
      results.push.success++;
    } catch (error) {
      results.push.failed++;
      results.push.errors.push({
        type: 'daycode',
        name: userName,
        slot: code.pin_slot,
        error: error.message
      });
    }

    await delay(RATE_LIMIT_DELAY);
  }

  // Flatten results for consistent response format
  return {
    success: results.clear.success + results.push.success,
    failed: results.clear.failed + results.push.failed,
    errors: [...results.clear.errors, ...results.push.errors],
    phases: results
  };
}

/**
 * Run a sync operation with mutex protection
 */
async function runSync(operation, onProgress, onComplete) {
  // Check if already running
  if (syncState.isRunning) {
    throw new Error('A sync operation is already in progress');
  }

  // Acquire lock
  syncState.isRunning = true;
  syncState.operation = operation;
  syncState.startedAt = new Date();
  syncState.current = 0;
  syncState.total = 0;
  syncState.message = 'Starting...';

  // Progress wrapper that updates syncState
  const progressWrapper = (progress) => {
    syncState.current = progress.current;
    syncState.total = progress.total;
    syncState.message = progress.message;
    if (onProgress) onProgress(progress);
  };

  try {
    let results;

    switch (operation) {
      case 'push':
        results = await pushAllCodes(progressWrapper);
        break;
      case 'clear':
        results = await clearAllSlots(progressWrapper);
        break;
      case 'resync':
        results = await fullResync(progressWrapper);
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    // Store failed items for potential retry
    syncState.lastFailedItems = results.errors || [];

    if (onComplete) onComplete(null, results);
    return results;
  } catch (error) {
    if (onComplete) onComplete(error, null);
    throw error;
  } finally {
    // Release lock (but keep lastFailedItems)
    syncState.isRunning = false;
    syncState.operation = null;
    syncState.startedAt = null;
    syncState.current = 0;
    syncState.total = 0;
    syncState.message = '';
  }
}

/**
 * Retry only the previously failed items
 */
async function retryFailed(onProgress) {
  const failedItems = syncState.lastFailedItems;

  if (!failedItems || failedItems.length === 0) {
    return { success: 0, failed: 0, errors: [], message: 'No failed items to retry' };
  }

  const results = { success: 0, failed: 0, errors: [] };
  const total = failedItems.length;

  onProgress({ current: 0, total, message: `Retrying ${total} failed items...` });

  for (let i = 0; i < failedItems.length; i++) {
    const item = failedItems[i];
    const current = i + 1;

    if (item.type === 'slot') {
      // Clear slot retry
      onProgress({
        current,
        total,
        message: `Retrying clear slot ${item.slot}...`
      });

      try {
        await withRetry(
          () => clearUserCode(item.slot),
          `Retry clear slot ${item.slot}`
        );
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          type: 'slot',
          slot: item.slot,
          error: error.message
        });
      }
    } else if (item.type === 'user' || item.type === 'daycode') {
      // Push code retry - need to fetch current data
      onProgress({
        current,
        total,
        message: `Retrying push ${item.name} (slot ${item.slot})...`
      });

      try {
        // Fetch fresh data based on type
        let code;
        if (item.type === 'user') {
          const user = await User.findOne({ where: { pin_code_slot: item.slot } });
          if (user && user.pin_code) {
            code = user.pin_code;
          }
        } else {
          const dayCode = await DayCode.findOne({
            where: { pin_slot: item.slot, is_active: true }
          });
          if (dayCode) {
            code = dayCode.code;
          }
        }

        if (code) {
          await withRetry(
            () => setUserCode(item.slot, code),
            `Retry push ${item.name} (slot ${item.slot})`
          );
          results.success++;
        } else {
          results.failed++;
          results.errors.push({
            ...item,
            error: 'Code no longer exists in database'
          });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          ...item,
          error: error.message
        });
      }
    }

    await delay(RATE_LIMIT_DELAY);
  }

  // Update lastFailedItems with any new failures
  syncState.lastFailedItems = results.errors;

  return results;
}

module.exports = {
  syncState,
  blockDuringSync,
  getSyncStatus,
  pushAllCodes,
  clearAllSlots,
  fullResync,
  runSync,
  retryFailed
};
