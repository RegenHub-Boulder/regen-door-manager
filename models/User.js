const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST,
  dialect: process.env.DB_DIALECT
});

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  pin_code_slot: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: {
      isLessThan250(value) {
        if (value >= 250) {
          throw new Error('Pin Code Slot must be less than 250');
        }
      }
    }
  },
  nfc_key_address: {
    type: DataTypes.STRING,
    allowNull: true,  // Allow null for blank values
    validate: {
      isUniqueIfNotEmpty(value) {
        if (value && value.trim() !== "") {
          return User.findOne({ where: { nfc_key_address: value } })
            .then(user => {
              if (user) {
                throw new Error('This NFC Key Address is already in use.');
              }
            });
        }
      }
    }
  },
  pin_code: {
    type: DataTypes.STRING,
    allowNull: true,  // Pin code is now optional
    validate: {
      isValidPin(value) {
        if (value && (!/^\d{4,10}$/.test(value))) {
          throw new Error('Pin Code must be a number between 4 and 10 digits.');
        }
      }
    }
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: {
      isEmail: true
    }
  },
  ethereum_address: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: {
      isValidEthereumAddress(value) {
        if (value && !/^0x[a-fA-F0-9]{40}$/.test(value)) {
          throw new Error('Invalid Ethereum Address.');
        }
      }
    }
  }
}, {
  timestamps: true
});

module.exports = User;
