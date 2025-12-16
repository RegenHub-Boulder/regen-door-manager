const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const { Sequelize, User, DayPass, DayCode, syncDatabase } = require('./models');
const { setUserCode, clearUserCode } = require('./helpers/homeAssistant');
const { startBot } = require('./telegram/bot');
const { startScheduler, expireOldCodes } = require('./scheduler');
const { Op } = require('sequelize');

const app = express();
const PORT = 80;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Set view engine to EJS
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

// Basic Auth Middleware
const auth = (req, res, next) => {
    const user = basicAuth(req);
    const username = process.env.BASIC_AUTH_USER || 'admin';
    const password = process.env.BASIC_AUTH_PASS || 'password';
  
    if (!user || user.name !== username || user.pass !== password) {
      res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
      return res.status(401).send('Authentication required.');
    }
    next();
  };

// Apply Basic Auth middleware to all routes
app.use(auth);

// Sync database
(async () => {
  await syncDatabase();
})();

// Admin page: List users and suggest next slot
app.get('/admin', async (req, res) => {
  const users = await User.findAll({
    attributes: ['id', 'name', 'email', 'ethereum_address', 'pin_code_slot', 'pin_code', 'nfc_key_address', 'telegram_username', 'member_type'],
    include: [{
      model: DayPass,
      as: 'dayPasses',
      required: false
    }]
  });
  const nextSlot = await findNextAvailableSlot();
  res.render('admin', { users, nextSlot });
});

// Add new user page (slot value passed in the query)
app.get('/add', async (req, res) => {
    try {
      // Find the next available slot
      const nextSlot = await findNextAvailableSlot();
  
      // Render the add.ejs template with the next available slot
      res.render('add', { slot: nextSlot });
    } catch (error) {
      console.error('Error finding next available slot:', error);
      res.status(500).send('Error loading the add new user page.');
    }
  });

// Handle new user submission
app.post('/add', async (req, res) => {
    const { name, pin_code, pin_code_slot, nfc_key_address, email, ethereum_address, telegram_username, member_type, initial_passes } = req.body;

    try {
      const isFull = member_type === 'full';

      // Validate full member fields
      if (isFull) {
        if (pin_code_slot >= 250) {
          throw new Error('Pin Code Slot must be less than 250.');
        }

        if (pin_code && !/^\d{4,10}$/.test(pin_code)) {
          throw new Error('Pin Code must be a number between 4 and 10 digits.');
        }

        if (pin_code) {
          await setUserCode(pin_code_slot, pin_code);
        }
      }

      // Create the user
      const user = await User.create({
        name,
        member_type: member_type || 'full',
        telegram_username: telegram_username && telegram_username.trim() !== "" ? telegram_username : null,
        pin_code: isFull ? (pin_code || null) : null,
        pin_code_slot: isFull ? pin_code_slot : null,
        nfc_key_address: nfc_key_address && nfc_key_address.trim() !== "" ? nfc_key_address : null,
        email: email || null,
        ethereum_address: ethereum_address || null
      });

      // If day pass member, create initial passes
      if (!isFull && initial_passes && parseInt(initial_passes) > 0) {
        await DayPass.create({
          user_id: user.id,
          allowed_uses: parseInt(initial_passes),
          used_count: 0
        });
      }

      res.redirect('/admin');
    } catch (error) {
      if (error.name === 'SequelizeValidationError') {
        const validationErrors = error.errors.map(e => e.message).join(', ');
        res.status(400).send('Error: ' + validationErrors);
      } else {
        console.error('Failed to add user:', error);
        res.status(500).send('Error adding user: ' + error.message);
      }
    }
  });
  

app.post('/remove', async (req, res) => {
    const { id } = req.body; 
  
    try {
      const user = await User.findByPk(id);
  
      if (!user) {
        return res.status(404).send('User not found');
      }
  
      // If the user has a pin code slot, clear the user code in Home Assistant
      if (user.pin_code_slot) {
        await clearUserCode(user.pin_code_slot);  // Clear the user code
      }
  
      // Remove the user from the database
      await user.destroy();
  
      res.redirect('/admin');
    } catch (error) {
      console.error('Error removing user:', error);
      res.status(500).send('Error removing user');
    }
  });

app.post('/remove-pin', async (req, res) => {
    const { id } = req.body;  // Independent user ID
  
    try {
      const user = await User.findByPk(id);  // Find by independent ID
  
      if (!user) {
        return res.status(404).send('User not found');
      }

      await clearUserCode(user.pin_code_slot);

      // Clear the pin code and slot, but keep the user
      user.pin_code = null;
      await user.save();
  
      res.redirect('/admin');
    } catch (error) {
      console.error('Error removing pin code:', error);
      res.status(500).send('Error removing pin code');
    }
  });

app.post('/send-pin', async (req, res) => {
    const { slot } = req.body;
    console.log(`request body: ${JSON.stringify(req.body)}`);
    
    console.log('Slot received on server:', slot);  // Debugging log
  
    if (!slot) {
      return res.status(400).send('Slot value is missing or undefined.');
    }
  
    try {
      const user = await User.findOne({ where: { pin_code_slot: slot } });
      if (user) {
        await setUserCode(user.pin_code_slot, user.pin_code);  // Re-send the user code
        res.status(200).send('Pin sent successfully');
      } else {
        res.status(404).send('User not found');
      }
    } catch (error) {
      console.error('Error sending pin to door:', error);
      res.status(500).send('Error sending pin to door');
    }
  });
  
// Render the Reset Pin page
// Render the Edit Pin page (based on user ID, not pin_code_slot)
app.get('/edit', async (req, res) => {
    const { id } = req.query;  // Get the user ID from the query parameters
    
    try {
      const user = await User.findByPk(id);  // Look up user by primary key (ID)
      
      if (!user) {
        return res.status(404).send('User not found');
      }
      
      // Render the edit page with the user data
      res.render('edit', { user });
    } catch (error) {
      console.error('Error rendering edit user page:', error);
      res.status(500).send('Error loading edit user page.');
    }
  });
  

// Handle the edit user form submission
app.post('/edit', async (req, res) => {
    const { id, name, pin_code_slot, pin_code, nfc_key_address, email, ethereum_address, telegram_username, member_type } = req.body;

    try {
      const user = await User.findByPk(id);
      if (!user) {
        return res.status(404).send('User not found');
      }

      const isFull = member_type === 'full';
      const wasFullMember = user.member_type === 'full';

      // Validate full member fields
      if (isFull) {
        if (pin_code_slot >= 250) {
          throw new Error('Pin Code Slot must be less than 250.');
        }

        if (pin_code && !/^\d{4,10}$/.test(pin_code)) {
          throw new Error('Pin Code must be a number between 4 and 10 digits.');
        }

        if (pin_code) {
          await setUserCode(pin_code_slot, pin_code);
        }
      } else if (wasFullMember && user.pin_code_slot) {
        // User was full member but is now day pass - clear their old code
        await clearUserCode(user.pin_code_slot);
      }

      // Update user fields
      user.name = name;
      user.member_type = member_type;
      user.telegram_username = telegram_username && telegram_username.trim() !== "" ? telegram_username : null;
      user.email = email || null;
      user.ethereum_address = ethereum_address || null;

      if (isFull) {
        user.pin_code = pin_code || null;
        user.pin_code_slot = pin_code_slot;
        user.nfc_key_address = nfc_key_address && nfc_key_address.trim() !== "" ? nfc_key_address : null;
      } else {
        user.pin_code = null;
        user.pin_code_slot = null;
        user.nfc_key_address = null;
      }

      await user.save();

      res.redirect('/admin');
    } catch (error) {
      if (error.name === 'SequelizeValidationError') {
        const validationErrors = error.errors.map(e => e.message).join(', ');
        res.status(400).send('Error: ' + validationErrors);
      } else {
        console.error('Error editing user:', error);
        res.status(500).send('Error editing user: ' + error.message);
      }
    }
  });
  
// Day pass management page
app.get('/passes', async (req, res) => {
  const { userId } = req.query;

  try {
    const user = await User.findByPk(userId, {
      include: [{
        model: DayPass,
        as: 'dayPasses'
      }, {
        model: DayCode,
        as: 'dayCodes',
        where: { is_active: true },
        required: false
      }]
    });

    if (!user) {
      return res.status(404).send('User not found');
    }

    res.render('passes', { user });
  } catch (error) {
    console.error('Error loading passes page:', error);
    res.status(500).send('Error loading passes page.');
  }
});

// Add passes to user
app.post('/passes/add', async (req, res) => {
  const { user_id, allowed_uses, expires_at } = req.body;

  try {
    await DayPass.create({
      user_id: parseInt(user_id),
      allowed_uses: parseInt(allowed_uses) || 1,
      expires_at: expires_at || null
    });

    res.redirect(`/passes?userId=${user_id}`);
  } catch (error) {
    console.error('Error adding passes:', error);
    res.status(500).send('Error adding passes.');
  }
});

// Delete a day pass
app.post('/passes/delete', async (req, res) => {
  const { pass_id, user_id } = req.body;

  try {
    const pass = await DayPass.findByPk(pass_id);
    if (pass) {
      // Revoke any active codes from this pass
      const activeCodes = await DayCode.findAll({
        where: { day_pass_id: pass.id, is_active: true }
      });

      for (const code of activeCodes) {
        await clearUserCode(code.pin_slot);
        code.is_active = false;
        code.revoked_at = new Date();
        await code.save();
      }

      await pass.destroy();
    }

    res.redirect(`/passes?userId=${user_id}`);
  } catch (error) {
    console.error('Error deleting pass:', error);
    res.status(500).send('Error deleting pass.');
  }
});

// Revoke a day code
app.post('/passes/revoke-code', async (req, res) => {
  const { code_id, user_id } = req.body;

  try {
    const code = await DayCode.findByPk(code_id);
    if (code && code.is_active) {
      await clearUserCode(code.pin_slot);
      code.is_active = false;
      code.revoked_at = new Date();
      await code.save();
    }

    res.redirect(`/passes?userId=${user_id}`);
  } catch (error) {
    console.error('Error revoking code:', error);
    res.status(500).send('Error revoking code.');
  }
});

// Function to find next available slot
const findNextAvailableSlot = async () => {
    const latestUser = await User.findOne({
      order: [['pin_code_slot', 'DESC']],
      where: {
        pin_code_slot: {
          [Sequelize.Op.not]: null,  // Only users with a valid pin_code_slot
        }
      }
    });
  
    return latestUser ? latestUser.pin_code_slot + 1 : 1;  // Start from 1 if no users have a pin_code_slot
  };

// API route to lookup user by NFC key address
app.get('/api/user/nfc/:address', async (req, res) => {
  try {
    const user = await User.findOne({
      where: { nfc_key_address: req.params.address }
    });
    if (user) {
      res.json({ id: user.id, name: user.name });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// Day Pass API Routes
// ============================================

// Get all day passes for a user
app.get('/api/day-passes/:userId', async (req, res) => {
  try {
    const passes = await DayPass.findAll({
      where: { user_id: req.params.userId },
      order: [['createdAt', 'DESC']]
    });
    res.json(passes);
  } catch (error) {
    console.error('Error fetching day passes:', error);
    res.status(500).json({ error: 'Failed to fetch day passes' });
  }
});

// Create a new day pass for a user
app.post('/api/day-passes', async (req, res) => {
  try {
    const { user_id, allowed_uses, expires_at } = req.body;

    const user = await User.findByPk(user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const pass = await DayPass.create({
      user_id,
      allowed_uses: allowed_uses || 1,
      expires_at: expires_at || null
    });

    res.status(201).json(pass);
  } catch (error) {
    console.error('Error creating day pass:', error);
    res.status(500).json({ error: 'Failed to create day pass' });
  }
});

// Delete a day pass (also revokes any active codes from it)
app.delete('/api/day-passes/:id', async (req, res) => {
  try {
    const pass = await DayPass.findByPk(req.params.id);
    if (!pass) {
      return res.status(404).json({ error: 'Day pass not found' });
    }

    // Revoke any active codes from this pass
    const activeCodes = await DayCode.findAll({
      where: { day_pass_id: pass.id, is_active: true }
    });

    for (const code of activeCodes) {
      await clearUserCode(code.pin_slot);
      code.is_active = false;
      code.revoked_at = new Date();
      await code.save();
    }

    await pass.destroy();
    res.json({ success: true, revokedCodes: activeCodes.length });
  } catch (error) {
    console.error('Error deleting day pass:', error);
    res.status(500).json({ error: 'Failed to delete day pass' });
  }
});

// ============================================
// Day Code API Routes
// ============================================

// Get all active day codes
app.get('/api/day-codes', async (req, res) => {
  try {
    const codes = await DayCode.findAll({
      where: { is_active: true },
      include: [
        { model: User, as: 'user', attributes: ['id', 'name'] }
      ],
      order: [['issued_at', 'DESC']]
    });
    res.json(codes);
  } catch (error) {
    console.error('Error fetching day codes:', error);
    res.status(500).json({ error: 'Failed to fetch day codes' });
  }
});

// Manually trigger code expiration
app.post('/api/day-codes/expire', async (req, res) => {
  try {
    const result = await expireOldCodes();
    res.json(result);
  } catch (error) {
    console.error('Error expiring codes:', error);
    res.status(500).json({ error: 'Failed to expire codes' });
  }
});

// Revoke a specific day code
app.delete('/api/day-codes/:id', async (req, res) => {
  try {
    const code = await DayCode.findByPk(req.params.id);
    if (!code) {
      return res.status(404).json({ error: 'Day code not found' });
    }

    if (code.is_active) {
      await clearUserCode(code.pin_slot);
      code.is_active = false;
      code.revoked_at = new Date();
      await code.save();
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking day code:', error);
    res.status(500).json({ error: 'Failed to revoke day code' });
  }
});

// ============================================
// Server startup
// ============================================

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Start Telegram bot
  startBot();

  // Start scheduler for code expiration
  startScheduler();
});
