const TelegramBot = require('node-telegram-bot-api');
const { User, DayPass, DayCode } = require('../models');
const { setUserCode, clearUserCode } = require('../helpers/homeAssistant');
const {
  findNextAvailableDayPassSlot,
  generateRandomCode,
  calculateDayPassExpiration,
  calculateExpiration
} = require('../helpers/slotManager');
const { Op } = require('sequelize');

let bot = null;

// Track pending multi-step actions (replaces old pendingCodeChanges)
// Key: chatId, Value: { type, step, data, timestamp }
const pendingActions = new Map();

const ITEMS_PER_PAGE = 10;

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
 * Format an expiration date for display
 */
function formatExpiration(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: process.env.TIMEZONE || 'America/Denver',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Cancel any pending action for a chat and notify
 */
function cancelPending(chatId) {
  if (pendingActions.has(chatId)) {
    pendingActions.delete(chatId);
    return true;
  }
  return false;
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

  // Register command handlers
  bot.onText(/\/start/, handleStart);
  bot.onText(/\/mycode/, handleMyCode);
  bot.onText(/\/newcode(?:\s+(.+))?/, handleNewCode);
  bot.onText(/\/daypass/, handleDayPass);
  bot.onText(/\/help/, handleHelp);
  bot.onText(/\/quickcode(?:\s+(.+))?/, handleQuickCode);
  bot.onText(/\/codes/, handleCodes);
  bot.onText(/\/admin/, handleAdmin);

  // Handle callback queries (inline keyboard buttons)
  bot.on('callback_query', handleCallbackQuery);

  // Handle text messages for multi-step flows
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
 * Find an admin by their Telegram username
 */
async function findAdminByTelegram(username) {
  const user = await findUserByTelegram(username);
  return user && user.is_admin ? user : null;
}

// ============================================
// Existing Member Commands
// ============================================

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
    message += `/daypass - Generate a day pass code for a guest\n`;
    message += `/help - Show help`;
  } else {
    message += `You are a Day Pass Member.\n\n`;
    message += `Available commands:\n`;
    message += `/daypass - Request a door code for today\n`;
    message += `/help - Show help`;
  }

  if (user.is_admin) {
    message += `\n\nAdmin commands:\n`;
    message += `/quickcode - Create a quick door code\n`;
    message += `/codes - View/revoke active codes\n`;
    message += `/admin - Member & admin management`;
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
    message += `- The ability to change your code whenever you want\n`;
    message += `- The ability to generate day pass codes for guests\n\n`;
    message += `Commands:\n`;
    message += `/mycode - View your current door code\n`;
    message += `/newcode - Set a new door code interactively\n`;
    message += `/newcode 1234 - Set code directly (4-6 digits)\n`;
    message += `/newcode random - Generate a random code\n`;
    message += `/daypass - Generate a day pass code for a guest\n`;
  } else {
    message += `As a Day Pass Member, you have:\n`;
    message += `- A set number of day passes\n`;
    message += `- Each pass gives you a door code valid until 3 AM\n\n`;
    message += `Commands:\n`;
    message += `/daypass - Request a door code for today\n`;
  }

  if (user.is_admin) {
    message += `\nAdmin Commands:\n`;
    message += `/quickcode - Create a temporary door code\n`;
    message += `/quickcode <label> - Create code with a label (e.g. "yoga class")\n`;
    message += `/codes - List all active temporary codes\n`;
    message += `/admin - Member & admin management menu\n`;
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
 */
async function handleNewCode(msg, match) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;
  const codeArg = match?.[1]?.trim();

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

  if (!user.pin_code_slot) {
    return bot.sendMessage(chatId,
      `You don't have a door slot assigned yet.\n` +
      `Please contact an admin to set up your account.`
    );
  }

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

  // Interactive mode
  cancelPending(chatId);
  pendingActions.set(chatId, {
    type: 'newcode',
    step: 'awaiting_code',
    data: { userId: user.id },
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
 * /daypass - Request a day pass code (day pass members use a pass, full members generate a guest code)
 */
async function handleDayPass(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  await reactWithEyes(msg);

  const user = await findUserByTelegram(username);

  if (!user) {
    return bot.sendMessage(chatId, `You're not registered. Please contact an admin.`);
  }

  const isFullMember = user.member_type === 'full';

  // For day pass members, check for existing active code
  if (!isFullMember) {
    const existingCode = await DayCode.findOne({
      where: {
        user_id: user.id,
        is_active: true,
        expires_at: { [Op.gt]: new Date() }
      }
    });

    if (existingCode) {
      return bot.sendMessage(chatId,
        `You already have an active code for today!\n\n` +
        `🔑 *${existingCode.code}*\n\n` +
        `Valid until: ${formatExpiration(existingCode.expires_at)}\n\n` +
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
      order: [['expires_at', 'ASC']]
    });

    if (!dayPass || !dayPass.hasRemainingUses()) {
      return bot.sendMessage(chatId,
        `You don't have any day passes remaining.\n\n` +
        `Please contact an admin to purchase more passes.`
      );
    }

    // Day pass member flow: consume a pass and generate code
    const slot = await findNextAvailableDayPassSlot();
    if (!slot) {
      return bot.sendMessage(chatId,
        `Sorry, all door code slots are currently in use.\n` +
        `Please try again later or contact an admin.`
      );
    }

    const code = generateRandomCode();
    const expiresAt = calculateDayPassExpiration();

    try {
      await setUserCode(slot, code);

      await DayCode.create({
        day_pass_id: dayPass.id,
        user_id: user.id,
        code: code,
        pin_slot: slot,
        issued_at: new Date(),
        expires_at: expiresAt,
        is_active: true
      });

      dayPass.used_count += 1;
      await dayPass.save();

      const remainingUses = dayPass.allowed_uses - dayPass.used_count;

      return bot.sendMessage(chatId,
        `Here's your door code for today!\n\n` +
        `🔑 *${code}*\n\n` +
        `Valid until: ${formatExpiration(expiresAt)}\n\n` +
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

  // Full member flow: generate a guest code (expires at 3 AM, no day pass consumed)
  const slot = await findNextAvailableDayPassSlot();
  if (!slot) {
    return bot.sendMessage(chatId,
      `Sorry, all door code slots are currently in use.\n` +
      `Please try again later or contact an admin.`
    );
  }

  const code = generateRandomCode();
  const expiresAt = calculateDayPassExpiration();

  try {
    await setUserCode(slot, code);

    await DayCode.create({
      day_pass_id: null,
      user_id: user.id,
      label: `Guest code by ${user.name}`,
      code: code,
      pin_slot: slot,
      issued_at: new Date(),
      expires_at: expiresAt,
      is_active: true
    });

    return bot.sendMessage(chatId,
      `Here's a guest door code!\n\n` +
      `🔑 *${code}*\n\n` +
      `Valid until: ${formatExpiration(expiresAt)}\n\n` +
      `Share this code with your guest.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[Telegram] Failed to create guest code:', error);
    return bot.sendMessage(chatId,
      `Sorry, there was an error generating the code.\n` +
      `Please try again or contact an admin.`
    );
  }
}

// ============================================
// Admin Commands
// ============================================

/**
 * /quickcode [label] - Admin creates a quick anonymous door code
 */
async function handleQuickCode(msg, match) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;
  const label = match?.[1]?.trim() || null;

  await reactWithEyes(msg);

  const admin = await findAdminByTelegram(username);
  if (!admin) {
    return bot.sendMessage(chatId, `This command is for admins only.`);
  }

  // Store label for use after expiration selection
  cancelPending(chatId);
  pendingActions.set(chatId, {
    type: 'quickcode',
    step: 'awaiting_expiration',
    data: { label },
    timestamp: Date.now()
  });

  return bot.sendMessage(chatId,
    `Create a quick door code${label ? ` for "${label}"` : ''}.\n\nChoose when it should expire:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '6 PM', callback_data: 'expire_6pm' },
            { text: '9 PM', callback_data: 'expire_9pm' },
            { text: '3 AM', callback_data: 'expire_3am' }
          ],
          [
            { text: 'Custom Time', callback_data: 'expire_custom' }
          ]
        ]
      }
    }
  );
}

/**
 * Generate and push a quick code with the given expiration
 */
async function createQuickCode(chatId, expiresAt, label) {
  const slot = await findNextAvailableDayPassSlot();

  if (!slot) {
    return bot.sendMessage(chatId,
      `All door code slots are full. Use /codes to see active codes and revoke unused ones.`
    );
  }

  const code = generateRandomCode();

  try {
    await setUserCode(slot, code);

    await DayCode.create({
      day_pass_id: null,
      user_id: null,
      label: label,
      code: code,
      pin_slot: slot,
      issued_at: new Date(),
      expires_at: expiresAt,
      is_active: true
    });

    let message = `Quick code created!\n\n` +
      `🔑 *${code}*\n\n` +
      `Expires: ${formatExpiration(expiresAt)}`;

    if (label) {
      message += `\nLabel: ${label}`;
    }

    return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[Telegram] Failed to create quick code:', error);
    const errMsg = error.errors ? error.errors.map(e => e.message).join(', ') : error.message;
    return bot.sendMessage(chatId,
      `Sorry, there was an error creating the code.\n${errMsg}\nPlease try again.`
    );
  }
}

/**
 * /codes - Admin lists all active temporary codes
 */
async function handleCodes(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  await reactWithEyes(msg);

  const admin = await findAdminByTelegram(username);
  if (!admin) {
    return bot.sendMessage(chatId, `This command is for admins only.`);
  }

  await sendCodesList(chatId, 0);
}

/**
 * Send paginated list of active codes
 */
async function sendCodesList(chatId, offset) {
  const totalCount = await DayCode.count({ where: { is_active: true } });

  if (totalCount === 0) {
    return bot.sendMessage(chatId, `No active temporary codes.`);
  }

  const codes = await DayCode.findAll({
    where: { is_active: true },
    include: [{ model: User, as: 'user', attributes: ['name', 'telegram_username'], required: false }],
    order: [['expires_at', 'ASC']],
    limit: ITEMS_PER_PAGE,
    offset: offset
  });

  let message = `Active Codes (${totalCount}):\n\n`;

  const buttons = [];
  codes.forEach((c, i) => {
    const num = offset + i + 1;
    let desc = c.label ? `"${c.label}"` : (c.user ? (c.user.telegram_username || c.user.name) : '(anonymous)');
    message += `${num}. ${c.code} — ${desc} — expires ${formatExpiration(c.expires_at)}\n`;
    buttons.push([{ text: `Revoke ${c.code}`, callback_data: `revoke_${c.id}` }]);
  });

  // Pagination buttons
  const navButtons = [];
  if (offset > 0) {
    navButtons.push({ text: '< Prev', callback_data: `page_codes_${offset - ITEMS_PER_PAGE}` });
  }
  if (offset + ITEMS_PER_PAGE < totalCount) {
    navButtons.push({ text: 'Next >', callback_data: `page_codes_${offset + ITEMS_PER_PAGE}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  return bot.sendMessage(chatId, message, {
    reply_markup: { inline_keyboard: buttons }
  });
}

/**
 * /admin - Admin management menu
 */
async function handleAdmin(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  await reactWithEyes(msg);

  const admin = await findAdminByTelegram(username);
  if (!admin) {
    return bot.sendMessage(chatId, `This command is for admins only.`);
  }

  cancelPending(chatId);

  return bot.sendMessage(chatId, `Admin Management:`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Add Member', callback_data: 'admin_addmember' },
          { text: 'Add Day Passes', callback_data: 'admin_addpasses' }
        ],
        [
          { text: 'Add Admin', callback_data: 'admin_addadmin' },
          { text: 'Remove Admin', callback_data: 'admin_removeadmin' }
        ],
        [
          { text: 'List Members', callback_data: 'admin_listmembers' }
        ]
      ]
    }
  });
}

// ============================================
// Callback Query Handler
// ============================================

async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    // Ignore if already answered
  }

  // Verify admin for all callbacks
  const username = query.from?.username;
  const admin = await findAdminByTelegram(username);
  if (!admin) {
    return bot.sendMessage(chatId, `This action is for admins only.`);
  }

  // Route based on callback data prefix
  if (data.startsWith('expire_')) {
    return handleExpirationCallback(chatId, data);
  }
  if (data.startsWith('revoke_')) {
    return handleRevokeCallback(chatId, data);
  }
  if (data.startsWith('page_codes_')) {
    return handleCodesPageCallback(chatId, data);
  }
  if (data.startsWith('page_members_')) {
    return handleMembersPageCallback(chatId, data);
  }
  if (data.startsWith('admin_')) {
    return handleAdminMenuCallback(chatId, data, admin);
  }
  if (data.startsWith('membertype_')) {
    return handleMemberTypeCallback(chatId, data);
  }
  if (data.startsWith('confirm_removeadmin_')) {
    return handleRemoveAdminConfirm(chatId, data);
  }
}

/**
 * Handle expiration preset selection for /quickcode
 */
async function handleExpirationCallback(chatId, data) {
  const pending = pendingActions.get(chatId);
  if (!pending || pending.type !== 'quickcode') return;

  const preset = data.replace('expire_', '');

  if (preset === 'custom') {
    pending.step = 'awaiting_custom_time';
    pending.timestamp = Date.now();
    pendingActions.set(chatId, pending);
    return bot.sendMessage(chatId,
      `Enter expiration time (e.g. "8:30pm", "tomorrow 2pm", "14:00"):\n\n` +
      `Type "cancel" to abort.`
    );
  }

  const expiresAt = calculateExpiration(preset);
  const label = pending.data.label;
  pendingActions.delete(chatId);

  return createQuickCode(chatId, expiresAt, label);
}

/**
 * Handle code revocation from /codes
 */
async function handleRevokeCallback(chatId, data) {
  const codeId = parseInt(data.replace('revoke_', ''));

  try {
    const code = await DayCode.findByPk(codeId);
    if (!code || !code.is_active) {
      return bot.sendMessage(chatId, `Code not found or already revoked.`);
    }

    await clearUserCode(code.pin_slot);
    code.is_active = false;
    code.revoked_at = new Date();
    await code.save();

    return bot.sendMessage(chatId, `Code ${code.code} has been revoked.`);
  } catch (error) {
    console.error('[Telegram] Failed to revoke code:', error);
    return bot.sendMessage(chatId, `Error revoking code. Please try again.`);
  }
}

/**
 * Handle codes list pagination
 */
async function handleCodesPageCallback(chatId, data) {
  const offset = parseInt(data.replace('page_codes_', ''));
  return sendCodesList(chatId, offset);
}

/**
 * Handle members list pagination
 */
async function handleMembersPageCallback(chatId, data) {
  const offset = parseInt(data.replace('page_members_', ''));
  return sendMembersList(chatId, offset);
}

/**
 * Handle admin menu button presses
 */
async function handleAdminMenuCallback(chatId, data, admin) {
  cancelPending(chatId);

  switch (data) {
    case 'admin_addmember':
      pendingActions.set(chatId, {
        type: 'addmember',
        step: 'awaiting_type',
        data: {},
        timestamp: Date.now()
      });
      return bot.sendMessage(chatId, `What type of member?`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Full Member', callback_data: 'membertype_full' },
              { text: 'Day Pass Member', callback_data: 'membertype_daypass' }
            ]
          ]
        }
      });

    case 'admin_addpasses':
      pendingActions.set(chatId, {
        type: 'addpasses',
        step: 'awaiting_username',
        data: {},
        timestamp: Date.now()
      });
      return bot.sendMessage(chatId,
        `Enter the member's Telegram username (e.g. @username):\n\nType "cancel" to abort.`
      );

    case 'admin_addadmin':
      pendingActions.set(chatId, {
        type: 'addadmin',
        step: 'awaiting_username',
        data: {},
        timestamp: Date.now()
      });
      return bot.sendMessage(chatId,
        `Enter the Telegram username of the new admin (e.g. @username):\n\nType "cancel" to abort.`
      );

    case 'admin_removeadmin': {
      const admins = await User.findAll({ where: { is_admin: true } });
      if (admins.length <= 1) {
        return bot.sendMessage(chatId, `Cannot remove the last admin.`);
      }
      const buttons = admins.map(a => ([{
        text: `${a.name} (${a.telegram_username || 'no telegram'})`,
        callback_data: `confirm_removeadmin_${a.id}`
      }]));
      return bot.sendMessage(chatId, `Select admin to remove:`, {
        reply_markup: { inline_keyboard: buttons }
      });
    }

    case 'admin_listmembers':
      return sendMembersList(chatId, 0);
  }
}

/**
 * Handle member type selection in Add Member flow
 */
async function handleMemberTypeCallback(chatId, data) {
  const pending = pendingActions.get(chatId);
  if (!pending || pending.type !== 'addmember') return;

  const memberType = data.replace('membertype_', '');
  pending.data.memberType = memberType;
  pending.step = 'awaiting_name';
  pending.timestamp = Date.now();
  pendingActions.set(chatId, pending);

  return bot.sendMessage(chatId,
    `Enter the member's name:\n\nType "cancel" to abort.`
  );
}

/**
 * Handle admin removal confirmation
 */
async function handleRemoveAdminConfirm(chatId, data) {
  const userId = parseInt(data.replace('confirm_removeadmin_', ''));

  try {
    // Re-check admin count to prevent race condition
    const adminCount = await User.count({ where: { is_admin: true } });
    if (adminCount <= 1) {
      return bot.sendMessage(chatId, `Cannot remove the last admin.`);
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return bot.sendMessage(chatId, `User not found.`);
    }

    user.is_admin = false;
    await user.save();

    return bot.sendMessage(chatId,
      `${user.name} (${user.telegram_username || 'no telegram'}) is no longer an admin.`
    );
  } catch (error) {
    console.error('[Telegram] Failed to remove admin:', error);
    return bot.sendMessage(chatId, `Error removing admin. Please try again.`);
  }
}

/**
 * Send paginated list of members
 */
async function sendMembersList(chatId, offset) {
  const totalCount = await User.count();

  if (totalCount === 0) {
    return bot.sendMessage(chatId, `No members found.`);
  }

  const users = await User.findAll({
    order: [['name', 'ASC']],
    limit: ITEMS_PER_PAGE,
    offset: offset
  });

  let message = `Members (${totalCount}):\n\n`;

  users.forEach((u, i) => {
    const num = offset + i + 1;
    const type = u.member_type === 'full' ? 'Full' : 'Day Pass';
    const tg = u.telegram_username || '';
    const adminTag = u.is_admin ? ' [Admin]' : '';
    message += `${num}. ${u.name} — ${type} ${tg}${adminTag}\n`;
  });

  const navButtons = [];
  if (offset > 0) {
    navButtons.push({ text: '< Prev', callback_data: `page_members_${offset - ITEMS_PER_PAGE}` });
  }
  if (offset + ITEMS_PER_PAGE < totalCount) {
    navButtons.push({ text: 'Next >', callback_data: `page_members_${offset + ITEMS_PER_PAGE}` });
  }

  const opts = navButtons.length > 0
    ? { reply_markup: { inline_keyboard: [navButtons] } }
    : {};

  return bot.sendMessage(chatId, message, opts);
}

// ============================================
// Message Handler for Multi-Step Flows
// ============================================

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // Skip commands
  if (text?.startsWith('/')) return;

  const pending = pendingActions.get(chatId);
  if (!pending) return;

  await reactWithEyes(msg);

  // Check timeout (5 minutes)
  if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
    pendingActions.delete(chatId);
    return bot.sendMessage(chatId, `Action timed out. Please start again.`);
  }

  // Handle cancel for all flows
  if (text?.toLowerCase() === 'cancel') {
    pendingActions.delete(chatId);
    return bot.sendMessage(chatId, `Action cancelled.`);
  }

  // Route to appropriate flow handler
  switch (pending.type) {
    case 'newcode':
      return handleNewCodeFlow(chatId, text, pending);
    case 'quickcode':
      return handleQuickCodeFlow(chatId, text, pending);
    case 'addmember':
      return handleAddMemberFlow(chatId, text, pending);
    case 'addpasses':
      return handleAddPassesFlow(chatId, text, pending);
    case 'addadmin':
      return handleAddAdminFlow(chatId, text, pending);
  }
}

/**
 * Handle /newcode interactive flow
 */
async function handleNewCodeFlow(chatId, text, pending) {
  const user = await User.findByPk(pending.data.userId);
  if (!user) {
    pendingActions.delete(chatId);
    return bot.sendMessage(chatId, `Error: User not found.`);
  }

  let newCode;

  if (text?.toLowerCase() === 'random') {
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
    await setUserCode(user.pin_code_slot, newCode);
    user.pin_code = newCode;
    await user.save();
    pendingActions.delete(chatId);

    return bot.sendMessage(chatId,
      `Your door code has been updated!\n\n` +
      `🔑 *${newCode}*\n\n` +
      `This code is now active on the door.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[Telegram] Failed to update code:', error);
    pendingActions.delete(chatId);
    return bot.sendMessage(chatId,
      `Sorry, there was an error updating your code.\n` +
      `Please try again or contact an admin.`
    );
  }
}

/**
 * Handle /quickcode custom time flow
 */
async function handleQuickCodeFlow(chatId, text, pending) {
  if (pending.step !== 'awaiting_custom_time') return;

  const expiresAt = calculateExpiration(text);
  if (!expiresAt) {
    return bot.sendMessage(chatId,
      `Couldn't parse that time. Try formats like:\n` +
      `"8:30pm", "9pm", "tomorrow 2pm", "14:00"\n\n` +
      `Type "cancel" to abort.`
    );
  }

  // Sanity check: expiration should be in the future
  if (expiresAt <= new Date()) {
    return bot.sendMessage(chatId,
      `That time is in the past. Please enter a future time.\n\n` +
      `Type "cancel" to abort.`
    );
  }

  const label = pending.data.label;
  pendingActions.delete(chatId);

  return createQuickCode(chatId, expiresAt, label);
}

/**
 * Handle Add Member multi-step flow
 */
async function handleAddMemberFlow(chatId, text, pending) {
  switch (pending.step) {
    case 'awaiting_name':
      pending.data.name = text;
      pending.step = 'awaiting_telegram';
      pending.timestamp = Date.now();
      pendingActions.set(chatId, pending);
      return bot.sendMessage(chatId,
        `Enter Telegram username (e.g. @username), or "skip":`
      );

    case 'awaiting_telegram': {
      if (text.toLowerCase() !== 'skip') {
        const tg = text.startsWith('@') ? text : `@${text}`;
        if (!/^@[a-zA-Z0-9_]{5,32}$/.test(tg)) {
          return bot.sendMessage(chatId,
            `Invalid format. Must be @username (5-32 chars). Try again or "skip":`
          );
        }
        // Check for duplicate
        const existing = await User.findOne({ where: { telegram_username: tg } });
        if (existing) {
          return bot.sendMessage(chatId,
            `That Telegram username is already registered to ${existing.name}. Try another or "skip":`
          );
        }
        pending.data.telegram = tg;
      }

      if (pending.data.memberType === 'full') {
        pending.step = 'awaiting_pincode';
        pending.timestamp = Date.now();
        pendingActions.set(chatId, pending);
        return bot.sendMessage(chatId,
          `Enter a 4-6 digit pin code, or "random":`
        );
      } else {
        pending.step = 'awaiting_passes';
        pending.timestamp = Date.now();
        pendingActions.set(chatId, pending);
        return bot.sendMessage(chatId,
          `How many day passes? (default: 10):`
        );
      }
    }

    case 'awaiting_pincode': {
      let pinCode;
      if (text.toLowerCase() === 'random') {
        pinCode = String(Math.floor(100000 + Math.random() * 900000));
      } else if (/^\d{4,6}$/.test(text)) {
        pinCode = text;
      } else {
        return bot.sendMessage(chatId,
          `Invalid. Enter 4-6 digits or "random":`
        );
      }
      pending.data.pinCode = pinCode;

      // Find next available slot
      const { User: UserModel } = require('../models');
      const latestUser = await UserModel.findOne({
        order: [['pin_code_slot', 'DESC']],
        where: { pin_code_slot: { [Op.not]: null } }
      });
      const nextSlot = latestUser ? latestUser.pin_code_slot + 1 : 1;
      pending.data.pinSlot = nextSlot;

      // Create the member
      return createMemberFromPending(chatId, pending);
    }

    case 'awaiting_passes': {
      const passes = parseInt(text) || 10;
      pending.data.passes = passes;
      return createMemberFromPending(chatId, pending);
    }
  }
}

/**
 * Create a member from collected pending data
 */
async function createMemberFromPending(chatId, pending) {
  const d = pending.data;
  const isFull = d.memberType === 'full';

  try {
    const userData = {
      name: d.name,
      member_type: d.memberType,
      telegram_username: d.telegram || null,
      pin_code: isFull ? d.pinCode : null,
      pin_code_slot: isFull ? d.pinSlot : null
    };

    // Push code to lock before creating user
    if (isFull && d.pinCode && d.pinSlot) {
      await setUserCode(d.pinSlot, d.pinCode);
    }

    const user = await User.create(userData);

    // Create day passes if day pass member
    if (!isFull && d.passes && d.passes > 0) {
      await DayPass.create({
        user_id: user.id,
        allowed_uses: d.passes,
        used_count: 0
      });
    }

    pendingActions.delete(chatId);

    let message = `Member created!\n\n`;
    message += `Name: ${user.name}\n`;
    message += `Type: ${isFull ? 'Full Member' : 'Day Pass Member'}\n`;
    if (d.telegram) message += `Telegram: ${d.telegram}\n`;
    if (isFull) {
      message += `Slot: ${d.pinSlot}\n`;
      message += `Code: ${d.pinCode}\n`;
    } else {
      message += `Day Passes: ${d.passes || 10}\n`;
    }

    return bot.sendMessage(chatId, message);
  } catch (error) {
    console.error('[Telegram] Failed to create member:', error);
    pendingActions.delete(chatId);
    const errMsg = error.errors ? error.errors.map(e => e.message).join(', ') : error.message;
    return bot.sendMessage(chatId, `Error creating member: ${errMsg}`);
  }
}

/**
 * Handle Add Day Passes flow
 */
async function handleAddPassesFlow(chatId, text, pending) {
  switch (pending.step) {
    case 'awaiting_username': {
      const tg = text.startsWith('@') ? text : `@${text}`;
      const user = await User.findOne({ where: { telegram_username: tg } });

      if (!user) {
        return bot.sendMessage(chatId,
          `User with username ${tg} not found. Try again or "cancel":`
        );
      }

      pending.data.userId = user.id;
      pending.data.userName = user.name;
      pending.step = 'awaiting_count';
      pending.timestamp = Date.now();
      pendingActions.set(chatId, pending);

      return bot.sendMessage(chatId,
        `Found: ${user.name} (${tg})\n\nHow many day passes to add?`
      );
    }

    case 'awaiting_count': {
      const count = parseInt(text);
      if (!count || count < 1) {
        return bot.sendMessage(chatId, `Please enter a number (1 or more):`);
      }

      try {
        await DayPass.create({
          user_id: pending.data.userId,
          allowed_uses: count,
          used_count: 0
        });

        pendingActions.delete(chatId);
        return bot.sendMessage(chatId,
          `Added ${count} day pass${count > 1 ? 'es' : ''} to ${pending.data.userName}.`
        );
      } catch (error) {
        console.error('[Telegram] Failed to add passes:', error);
        pendingActions.delete(chatId);
        return bot.sendMessage(chatId, `Error adding passes. Please try again.`);
      }
    }
  }
}

/**
 * Handle Add Admin flow
 */
async function handleAddAdminFlow(chatId, text, pending) {
  const tg = text.startsWith('@') ? text : `@${text}`;
  const user = await User.findOne({ where: { telegram_username: tg } });

  if (!user) {
    return bot.sendMessage(chatId,
      `User with username ${tg} not found. They must be a registered member first.\n\nTry again or "cancel":`
    );
  }

  if (user.is_admin) {
    pendingActions.delete(chatId);
    return bot.sendMessage(chatId, `${user.name} is already an admin.`);
  }

  try {
    user.is_admin = true;
    await user.save();

    pendingActions.delete(chatId);
    return bot.sendMessage(chatId,
      `${user.name} (${tg}) is now an admin.`
    );
  } catch (error) {
    console.error('[Telegram] Failed to add admin:', error);
    pendingActions.delete(chatId);
    return bot.sendMessage(chatId, `Error adding admin. Please try again.`);
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
