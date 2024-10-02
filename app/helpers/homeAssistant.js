const axios = require('axios');

// Function to set user code in Home Assistant
async function setUserCode(slot, code) {
  const url = `${process.env.HA_URL}/script/set_user_code`;
  const token = process.env.HA_TOKEN;
  
  const data = {
    entity_id: 'script.set_user_code',  // Replace with the actual lock entity_id
    slot: slot,
    lock_code: code
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error setting user code in Home Assistant:', error);
    throw error;
  }
}

// Function to clear user code in Home Assistant
async function clearUserCode(slot) {
  const url = `${process.env.HA_URL}/script/clear_user_code`;
  const token = process.env.HA_TOKEN;

  const data = {
    entity_id: 'script.clear_user_code',  // Replace with actual lock entity_id
    slot: slot
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error clearing user code in Home Assistant:', error);
    throw error;
  }
}

module.exports = {
  setUserCode,
  clearUserCode
};
