const { DayCode } = require('../models');
const { Op } = require('sequelize');

const MIN_SLOT = parseInt(process.env.DAY_PASS_SLOT_MIN) || 75;
const MAX_SLOT = parseInt(process.env.DAY_PASS_SLOT_MAX) || 99;

/**
 * Find the next available slot for a day pass code.
 * Searches for gaps in the active slot range (125-249 by default).
 * @returns {Promise<number|null>} Next available slot or null if all slots are in use
 */
async function findNextAvailableDayPassSlot() {
  // Get all active day codes with their slots
  const activeCodes = await DayCode.findAll({
    where: { is_active: true },
    attributes: ['pin_slot'],
    order: [['pin_slot', 'ASC']]
  });

  const usedSlots = new Set(activeCodes.map(code => code.pin_slot));

  // Find the first available slot in range
  for (let slot = MIN_SLOT; slot <= MAX_SLOT; slot++) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  // All slots are in use
  return null;
}

/**
 * Check if a specific slot is available
 * @param {number} slot - The slot number to check
 * @returns {Promise<boolean>} True if slot is available
 */
async function isSlotAvailable(slot) {
  if (slot < MIN_SLOT || slot > MAX_SLOT) {
    return false;
  }

  const existingCode = await DayCode.findOne({
    where: {
      pin_slot: slot,
      is_active: true
    }
  });

  return !existingCode;
}

/**
 * Get the count of available slots
 * @returns {Promise<number>} Number of available slots
 */
async function getAvailableSlotCount() {
  const activeCodes = await DayCode.count({
    where: { is_active: true }
  });

  const totalSlots = MAX_SLOT - MIN_SLOT + 1;
  return totalSlots - activeCodes;
}

/**
 * Generate a random 5-digit code
 * @returns {string} A 5-digit code as a string
 */
function generateRandomCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

/**
 * Calculate the expiration time (3 AM the next day in the configured timezone)
 * @returns {Date} The expiration date/time
 */
function calculateDayPassExpiration() {
  const timezone = process.env.TIMEZONE || 'America/Denver';

  // Get current time in the specified timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type)?.value;

  const currentHour = parseInt(getPart('hour'));

  // Create expiration date
  // If it's before 3 AM, expire at 3 AM today
  // If it's 3 AM or later, expire at 3 AM tomorrow
  const expiration = new Date(now);

  if (currentHour < 3) {
    // Set to 3 AM today
    expiration.setHours(3, 0, 0, 0);
  } else {
    // Set to 3 AM tomorrow
    expiration.setDate(expiration.getDate() + 1);
    expiration.setHours(3, 0, 0, 0);
  }

  // Convert back to UTC for storage (accounting for timezone offset)
  const tzOffset = getTimezoneOffset(timezone, expiration);
  expiration.setTime(expiration.getTime() + tzOffset * 60 * 1000);

  return expiration;
}

/**
 * Get timezone offset in minutes for a given timezone
 * @param {string} timezone - IANA timezone name
 * @param {Date} date - Date to check offset for
 * @returns {number} Offset in minutes
 */
function getTimezoneOffset(timezone, date) {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  return (utcDate - tzDate) / 60000;
}

/**
 * Calculate expiration time for a given preset or custom time
 * @param {string} preset - '6pm', '9pm', '3am', or a custom time string like '8:30pm'
 * @returns {Date} The expiration date/time in UTC
 */
function calculateExpiration(preset) {
  const timezone = process.env.TIMEZONE || 'America/Denver';
  const now = new Date();

  // Parse the target hour from preset
  let targetHour;
  let targetMinute = 0;

  switch (preset) {
    case '6pm':
      targetHour = 18;
      break;
    case '9pm':
      targetHour = 21;
      break;
    case '3am':
      targetHour = 3;
      break;
    default:
      // Try to parse custom time like "8:30pm", "2pm", "14:00", "tomorrow 3pm"
      const parsed = parseCustomTime(preset, timezone);
      if (parsed) return parsed;
      // Fall back to 3 AM if unparseable
      targetHour = 3;
      break;
  }

  // Get current time in the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type)?.value;
  const currentHour = parseInt(getPart('hour'));
  const currentMinute = parseInt(getPart('minute'));

  const expiration = new Date(now);

  // For 3am preset, always use next day (unless it's before 3am)
  if (targetHour === 3) {
    if (currentHour < 3) {
      expiration.setHours(3, 0, 0, 0);
    } else {
      expiration.setDate(expiration.getDate() + 1);
      expiration.setHours(3, 0, 0, 0);
    }
  } else {
    // For other presets: if current time is past target, use tomorrow
    if (currentHour > targetHour || (currentHour === targetHour && currentMinute >= targetMinute)) {
      expiration.setDate(expiration.getDate() + 1);
    }
    expiration.setHours(targetHour, targetMinute, 0, 0);
  }

  // Convert to UTC for storage
  const tzOffset = getTimezoneOffset(timezone, expiration);
  expiration.setTime(expiration.getTime() + tzOffset * 60 * 1000);

  return expiration;
}

/**
 * Parse a custom time string like "8:30pm", "2pm", "14:00", "tomorrow 3pm"
 * @param {string} timeStr - The time string to parse
 * @param {string} timezone - IANA timezone name
 * @returns {Date|null} Parsed date or null if unparseable
 */
function parseCustomTime(timeStr, timezone) {
  if (!timeStr) return null;

  const str = timeStr.toLowerCase().trim();
  let addDay = false;

  let timePart = str;
  if (str.startsWith('tomorrow')) {
    addDay = true;
    timePart = str.replace('tomorrow', '').trim();
  }

  // Match patterns: "8pm", "8:30pm", "8:30 pm", "14:00", "14"
  const match12 = timePart.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  const match24 = timePart.match(/^(\d{1,2})(?::(\d{2}))?$/);

  let hour, minute = 0;

  if (match12) {
    hour = parseInt(match12[1]);
    minute = match12[2] ? parseInt(match12[2]) : 0;
    const period = match12[3];
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
  } else if (match24) {
    hour = parseInt(match24[1]);
    minute = match24[2] ? parseInt(match24[2]) : 0;
  } else {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type)?.value;
  const currentHour = parseInt(getPart('hour'));
  const currentMinute = parseInt(getPart('minute'));

  const expiration = new Date(now);

  if (addDay) {
    expiration.setDate(expiration.getDate() + 1);
  } else if (currentHour > hour || (currentHour === hour && currentMinute >= minute)) {
    // Time has passed today, use tomorrow
    expiration.setDate(expiration.getDate() + 1);
  }

  expiration.setHours(hour, minute, 0, 0);

  const tzOffset = getTimezoneOffset(timezone, expiration);
  expiration.setTime(expiration.getTime() + tzOffset * 60 * 1000);

  return expiration;
}

module.exports = {
  findNextAvailableDayPassSlot,
  isSlotAvailable,
  getAvailableSlotCount,
  generateRandomCode,
  calculateDayPassExpiration,
  calculateExpiration,
  MIN_SLOT,
  MAX_SLOT
};
