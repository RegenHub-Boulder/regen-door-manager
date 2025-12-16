const cron = require('node-cron');
const { DayCode } = require('./models');
const { clearUserCode } = require('./helpers/homeAssistant');
const { Op } = require('sequelize');

/**
 * Expire all day codes that have passed their expiration time.
 * Clears them from Home Assistant and marks them as inactive.
 */
async function expireOldCodes() {
  console.log('[Scheduler] Running code expiration check...');

  try {
    const now = new Date();

    // Find all active codes that have expired
    const expiredCodes = await DayCode.findAll({
      where: {
        is_active: true,
        expires_at: {
          [Op.lte]: now
        }
      }
    });

    if (expiredCodes.length === 0) {
      console.log('[Scheduler] No expired codes found.');
      return { expired: 0, errors: 0 };
    }

    console.log(`[Scheduler] Found ${expiredCodes.length} expired code(s) to revoke.`);

    let errorCount = 0;

    for (const code of expiredCodes) {
      try {
        // Clear from Home Assistant
        await clearUserCode(code.pin_slot);

        // Mark as inactive
        code.is_active = false;
        code.revoked_at = now;
        await code.save();

        console.log(`[Scheduler] Expired code ID ${code.id} (slot ${code.pin_slot})`);
      } catch (error) {
        console.error(`[Scheduler] Failed to expire code ID ${code.id}:`, error.message);
        errorCount++;
      }
    }

    console.log(`[Scheduler] Expiration complete. Expired: ${expiredCodes.length - errorCount}, Errors: ${errorCount}`);
    return { expired: expiredCodes.length - errorCount, errors: errorCount };
  } catch (error) {
    console.error('[Scheduler] Error during expiration check:', error);
    throw error;
  }
}

/**
 * Start the scheduler to run at 3 AM daily in the configured timezone.
 */
function startScheduler() {
  const timezone = process.env.TIMEZONE || 'America/Denver';

  // Run at 3:00 AM every day in the specified timezone
  const job = cron.schedule('0 3 * * *', async () => {
    console.log(`[Scheduler] Running scheduled expiration at 3 AM (${timezone})`);
    await expireOldCodes();
  }, {
    timezone: timezone
  });

  console.log(`[Scheduler] Started. Will expire codes at 3 AM ${timezone} daily.`);

  // Also run every 5 minutes to catch any codes that might have been missed
  // (e.g., if server was down at 3 AM)
  cron.schedule('*/5 * * * *', async () => {
    // Silent check - only log if there are actually expired codes
    try {
      const now = new Date();
      const expiredCount = await DayCode.count({
        where: {
          is_active: true,
          expires_at: {
            [Op.lte]: now
          }
        }
      });

      if (expiredCount > 0) {
        console.log(`[Scheduler] Cleanup check found ${expiredCount} expired code(s)`);
        await expireOldCodes();
      }
    } catch (error) {
      console.error('[Scheduler] Error during cleanup check:', error.message);
    }
  }, {
    timezone: timezone
  });

  return job;
}

module.exports = {
  startScheduler,
  expireOldCodes
};
