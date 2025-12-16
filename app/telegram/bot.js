const TelegramBot = require('node-telegram-bot-api');
const { User, DayPass, DayCode } = require('../models');
const { setUserCode, clearUserCode } = require('../helpers/homeAssistant');
const {
  findNextAvailableDayPassSlot,
  generateRandomCode,
  calculateDayPassExpiration
} = require('../helpers/slotManager');
const { Op } = require('sequelize');

let bot = null;

// Track users who are in the middle of setting a new code
const pendingCodeChanges = new Map();

/**
 * React to a message with eyes emoji to show we saw it
 */
async function reactWithEyes(msg) {
  try {
    await bot.setMessageReaction(msg.chat.id, msg.message_id, {
      reaction: [{ type: 'emoji', emoji: '👀' }]
    });
  } catch (error) {
    // Silently fail - reactions may not be supported in all chats
    console.log('[Telegram] Could not set reaction:', error.message);
  }
}

/**
 * Initialize and start the Telegram bot
 */
function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set, bot disabled.');
    return null;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log('[Telegram] Bot started and polling for messages...');

  // Register command handlers with regex to capture arguments
  bot.onText(/\/start/, handleStart);
  bot.onText(/\/mycode/, handleMyCode);
  bot.onText(/\/newcode(?:\s+(.+))?/, handleNewCode);
  bot.onText(/\/daypass/, handleDayPass);
  bot.onText(/\/help/, handleHelp);

  // Handle text messages for code input
  bot.on('message', handleMessage);

  // Handle errors
  bot.on('polling_error', (error) => {
    console.error('[Telegram] Polling error:', error.message);
  });

  return bot;
}

/**
 * Find a user by their Telegram username
 */
async function findUserByTelegram(username) {
  if (!username) return null;

  const telegramHandle = username.startsWith('@') ? username : `@${username}`;

  return User.findOne({
    where: { telegram_username: telegramHandle }
  });
}

/**
 * /start - Welcome message with available commands
 */
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  await reactWithEyes(msg);

  const user = await findUserByTelegram(username);

  if (!user) {
    return bot.sendMessage(chatId,
      `Welcome to the RegenHub Door Manager!\n\n` +
      `Your Telegram username (@${username || 'unknown'}) is not registered in our system.\n\n` +
      `Please contact an admin to get set up.`
    );
  }

  const isFullMember = user.member_type === 'full';

  let message = `Welcome back, ${user.name}!\n\n`;

  if (isFullMember) {
    message += `You are a Full Member.\n\n`;
    message += `Available commands:\n`;
    message += `/mycode - View your current door code\n`;
    message += `/newcode - Set a new door code\n`;
    message += `/help - Show this help message`;
  } else {
    message += `You are a Day Pass Member.\n\n`;
    message += `Available commands:\n`;
    message += `/daypass - Request a door code for today\n`;
    message += `/help - Show this help message`;
  }

  return bot.sendMessage(chatId, message);
}

/**
 * /help - Show help based on member type
 */
async function handleHelp(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  await reactWithEyes(msg);

  const user = await findUserByTelegram(username);

  if (!user) {
    return bot.sendMessage(chatId,
      `You're not registered in our system.\n` +
      `Please contact an admin to get set up.`
    );
  }

  const isFullMember = user.member_type === 'full';

  let message = `RegenHub Door Manager Help\n\n`;

  if (isFullMember) {
    message += `As a Full Member, you have:\n`;
    message += `- A permanent door code that works anytime\n`;
    message += `- The ability to change your code whenever you want\n\n`;
    message += `Commands:\n`;
    message += `/mycode - View your current door code\n`;
    message += `/newcode - Set a new door code interactively\n`;
    message += `/newcode 1234 - Set code directly (4-6 digits)\n`;
    message += `/newcode random - Generate a random code\n`;
  } else {
    message += `As a Day Pass Member, you have:\n`;
    message += `- A set number of day passes\n`;
    message += `- Each pass gives you a door code valid until 3 AM\n\n`;
    message += `Commands:\n`;
    message += `/daypass - Request a door code for today\n`;
  }

  return bot.sendMessage(chatId, message);
}

/**
 * /mycode - Full members view their current code
 */
async function handleMyCode(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  await reactWithEyes(msg);

  const user = await findUserByTelegram(username);

  if (!user) {
    return bot.sendMessage(chatId, `You're not registered. Please contact an admin.`);
  }

  if (user.member_type !== 'full') {
    return bot.sendMessage(chatId,
      `This command is for Full Members only.\n` +
      `Use /daypass to get a temporary code.`
    );
  }

  if (!user.pin_code) {
    return bot.sendMessage(chatId,
      `You don't have a door code set yet.\n` +
      `Use /newcode to set one.`
    );
  }

  return bot.sendMessage(chatId,
    `Your current door code is:\n\n` +
    `🔑 *${user.pin_code}*\n\n` +
    `Slot: ${user.pin_code_slot}`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * /newcode - Full members set a new code
 * Supports: /newcode, /newcode 1234, /newcode random
 */
async function handleNewCode(msg, match) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;
  const codeArg = match?.[1]?.trim(); // Captured argument from regex

  // React with eyes to show we saw the message
  await reactWithEyes(msg);

  const user = await findUserByTelegram(username);

  if (!user) {
    return bot.sendMessage(chatId, `You're not registered. Please contact an admin.`);
  }

  if (user.member_type !== 'full') {
    return bot.sendMessage(chatId,
      `This command is for Full Members only.\n` +
      `Use /daypass to get a temporary code.`
    );
  }

  // Check if user has a slot assigned
  if (!user.pin_code_slot) {
    return bot.sendMessage(chatId,
      `You don't have a door slot assigned yet.\n` +
      `Please contact an admin to set up your account.`
    );
  }

  // If a code was provided as argument, process it directly
  if (codeArg) {
    let newCode;

    if (codeArg.toLowerCase() === 'random') {
      newCode = String(Math.floor(100000 + Math.random() * 900000));
    } else if (/^\d{4,6}$/.test(codeArg)) {
      newCode = codeArg;
    } else {
      return bot.sendMessage(chatId,
        `Invalid code format.\n\n` +
        `Use: /newcode 1234 (4-6 digits)\n` +
        `Or: /newcode random`
      );
    }

    try {
      await setUserCode(user.pin_code_slot, newCode);
      user.pin_code = newCode;
      await user.save();

      return bot.sendMessage(chatId,
        `Your door code has been updated!\n\n` +
        `🔑 *${newCode}*\n\n` +
        `This code is now active on the door.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('[Telegram] Failed to update code:', error);
      return bot.sendMessage(chatId,
        `Sorry, there was an error updating your code.\n` +
        `Please try again or contact an admin.`
      );
    }
  }

  // No argument provided - enter interactive mode
  pendingCodeChanges.set(chatId, {
    userId: user.id,
    timestamp: Date.now()
  });

  return bot.sendMessage(chatId,
    `Let's set your new door code!\n\n` +
    `Send me a 4-6 digit code, or type "random"\n\n` +
    `Tip: You can also use /newcode 1234 directly.\n\n` +
    `Type "cancel" to abort.`
  );
}

/**
 * /daypass - Day pass members request a code
 */
async function handleDayPass(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  await reactWithEyes(msg);

  const user = await findUserByTelegram(username);

  if (!user) {
    return bot.sendMessage(chatId, `You're not registered. Please contact an admin.`);
  }

  if (user.member_type !== 'daypass') {
    return bot.sendMessage(chatId,
      `This command is for Day Pass Members.\n` +
      `As a Full Member, use /mycode to see your permanent code.`
    );
  }

  // Check if user already has an active code for today
  const existingCode = await DayCode.findOne({
    where: {
      user_id: user.id,
      is_active: true,
      expires_at: {
        [Op.gt]: new Date()
      }
    }
  });

  if (existingCode) {
    const expiresAt = new Date(existingCode.expires_at);
    const expiresStr = expiresAt.toLocaleString('en-US', {
      timeZone: process.env.TIMEZONE || 'America/Denver',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    return bot.sendMessage(chatId,
      `You already have an active code for today!\n\n` +
      `🔑 *${existingCode.code}*\n\n` +
      `Valid until: ${expiresStr}\n\n` +
      `Enter this code on the door keypad to unlock.`,
      { parse_mode: 'Markdown' }
    );
  }

  // Find a valid day pass
  const dayPass = await DayPass.findOne({
    where: {
      user_id: user.id,
      [Op.or]: [
        { expires_at: null },
        { expires_at: { [Op.gt]: new Date() } }
      ]
    },
    order: [['expires_at', 'ASC']] // Use passes that expire soonest first
  });

  if (!dayPass || !dayPass.hasRemainingUses()) {
    return bot.sendMessage(chatId,
      `You don't have any day passes remaining.\n\n` +
      `Please contact an admin to purchase more passes.`
    );
  }

  // Find available slot
  const slot = await findNextAvailableDayPassSlot();

  if (!slot) {
    return bot.sendMessage(chatId,
      `Sorry, all door code slots are currently in use.\n` +
      `Please try again later or contact an admin.`
    );
  }

  // Generate code and expiration
  const code = generateRandomCode();
  const expiresAt = calculateDayPassExpiration();

  try {
    // Set code on the door lock via Home Assistant
    await setUserCode(slot, code);

    // Create the day code record
    const dayCode = await DayCode.create({
      day_pass_id: dayPass.id,
      user_id: user.id,
      code: code,
      pin_slot: slot,
      issued_at: new Date(),
      expires_at: expiresAt,
      is_active: true
    });

    // Increment used count
    dayPass.used_count += 1;
    await dayPass.save();

    const remainingUses = dayPass.allowed_uses - dayPass.used_count;
    const expiresStr = expiresAt.toLocaleString('en-US', {
      timeZone: process.env.TIMEZONE || 'America/Denver',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    return bot.sendMessage(chatId,
      `Here's your door code for today!\n\n` +
      `🔑 *${code}*\n\n` +
      `Valid until: ${expiresStr}\n\n` +
      `Day passes remaining: ${remainingUses}\n\n` +
      `Enter this code on the door keypad to unlock.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[Telegram] Failed to create day code:', error);
    return bot.sendMessage(chatId,
      `Sorry, there was an error generating your code.\n` +
      `Please try again or contact an admin.`
    );
  }
}

/**
 * Handle general messages (for code input during /newcode flow)
 */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // Skip if it's a command
  if (text?.startsWith('/')) return;

  // Check if this user is in the middle of setting a new code
  const pending = pendingCodeChanges.get(chatId);
  if (!pending) return;

  // React with eyes to show we saw the message
  await reactWithEyes(msg);

  // Clean up old pending requests (older than 5 minutes)
  if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
    pendingCodeChanges.delete(chatId);
    return;
  }

  // Handle cancel
  if (text?.toLowerCase() === 'cancel') {
    pendingCodeChanges.delete(chatId);
    return bot.sendMessage(chatId, `Code change cancelled.`);
  }

  // Get the user
  const user = await User.findByPk(pending.userId);
  if (!user) {
    pendingCodeChanges.delete(chatId);
    return bot.sendMessage(chatId, `Error: User not found.`);
  }

  let newCode;

  if (text?.toLowerCase() === 'random') {
    // Generate random 6-digit code
    newCode = String(Math.floor(100000 + Math.random() * 900000));
  } else if (/^\d{4,6}$/.test(text)) {
    newCode = text;
  } else {
    return bot.sendMessage(chatId,
      `Invalid input. Please send:\n` +
      `- A 4-6 digit code, OR\n` +
      `- "random" to auto-generate, OR\n` +
      `- "cancel" to abort`
    );
  }

  try {
    // Update the door lock via Home Assistant
    await setUserCode(user.pin_code_slot, newCode);

    // Update the user record
    user.pin_code = newCode;
    await user.save();

    pendingCodeChanges.delete(chatId);

    return bot.sendMessage(chatId,
      `Your door code has been updated!\n\n` +
      `🔑 *${newCode}*\n\n` +
      `This code is now active on the door.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[Telegram] Failed to update code:', error);
    pendingCodeChanges.delete(chatId);
    return bot.sendMessage(chatId,
      `Sorry, there was an error updating your code.\n` +
      `Please try again or contact an admin.`
    );
  }
}

/**
 * Stop the bot
 */
function stopBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
    console.log('[Telegram] Bot stopped.');
  }
}

module.exports = {
  startBot,
  stopBot,
  findUserByTelegram
};
