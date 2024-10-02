const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const Sequelize = require('sequelize');
const User = require('./models/User');
const { setUserCode, clearUserCode } = require('./helpers/homeAssistant');

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
  await User.sync();
})();

// Admin page: List users and suggest next slot
app.get('/admin', async (req, res) => {
  const users = await User.findAll({ attributes: ['id', 'name', 'email', 'ethereum_address', 'pin_code_slot', 'nfc_key_address'] });
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
    const { name, pin_code, pin_code_slot, nfc_key_address, email, ethereum_address } = req.body;
  
    try {
      if (pin_code_slot >= 250) {
        throw new Error('Pin Code Slot must be less than 250.');
      }
  
      if (pin_code && !/^\d{4,10}$/.test(pin_code)) {
        throw new Error('Pin Code must be a number between 4 and 10 digits.');
      }
  
      if (pin_code) {
        await setUserCode(pin_code_slot, pin_code);
      }
  
      await User.create({
        name,
        pin_code: pin_code || null,
        pin_code_slot,
        nfc_key_address: nfc_key_address && nfc_key_address.trim() !== "" ? nfc_key_address : null,
        email: email || null,  // Save email if provided
        ethereum_address: ethereum_address || null  // Save Ethereum address if provided
      });
  
      res.redirect('/admin');
    } catch (error) {
      if (error.name === 'SequelizeValidationError') {
        const validationErrors = error.errors.map(e => e.message).join(', ');
        res.status(400).send('Error: ' + validationErrors);
      } else {
        console.error('Failed to add user:', error);
        res.status(500).send('Error adding user.');
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
  

// Handle the reset pin form submission
app.post('/edit', async (req, res) => {
    const { pin_code_slot, pin_code, nfc_key_address, email, ethereum_address } = req.body;
  
    try {
      if (pin_code_slot >= 250) {
        throw new Error('Pin Code Slot must be less than 250.');
      }
  
      if (pin_code && !/^\d{4,10}$/.test(pin_code)) {
        throw new Error('Pin Code must be a number between 4 and 10 digits.');
      }
  
      if (pin_code) {
        await setUserCode(pin_code_slot, pin_code);
      }
  
      const user = await User.findOne({ where: { pin_code_slot } });
  
      user.pin_code = pin_code || null;
      user.nfc_key_address = nfc_key_address && nfc_key_address.trim() !== "" ? nfc_key_address : null;
      user.email = email || null;
      user.ethereum_address = ethereum_address || null;
      await user.save();
  
      res.redirect('/admin');
    } catch (error) {
      if (error.name === 'SequelizeValidationError') {
        const validationErrors = error.errors.map(e => e.message).join(', ');
        res.status(400).send('Error: ' + validationErrors);
      } else {
        console.error('Error editing user:', error);
        res.status(500).send('Error editing user.');
      }
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

// TODO: add an API route that allows for the lookup of a user by their NFC key address and returns their user ID if found

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
