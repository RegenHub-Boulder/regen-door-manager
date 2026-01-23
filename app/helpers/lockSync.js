const { User, DayCode } = require('../models');
const { setUserCode, clearUserCode } = require('./homeAssistant');

// In-memory sync state (mutex)
const syncState = {
  isRunning: false,
  operation: null,
  startedAt: null,
  current: 0,
  total: 0,
  message: ''
};

// Delay helper for rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limit delay between operations (ms)
const RATE_LIMIT_DELAY = 500;

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
      await setUserCode(user.pin_code_slot, user.pin_code);
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
      await setUserCode(code.pin_slot, code.code);
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
      await clearUserCode(slot);
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
      await clearUserCode(slot);
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
      await setUserCode(user.pin_code_slot, user.pin_code);
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
      await setUserCode(code.pin_slot, code.code);
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

    if (onComplete) onComplete(null, results);
    return results;
  } catch (error) {
    if (onComplete) onComplete(error, null);
    throw error;
  } finally {
    // Release lock
    syncState.isRunning = false;
    syncState.operation = null;
    syncState.startedAt = null;
    syncState.current = 0;
    syncState.total = 0;
    syncState.message = '';
  }
}

module.exports = {
  syncState,
  blockDuringSync,
  getSyncStatus,
  pushAllCodes,
  clearAllSlots,
  fullResync,
  runSync
};
