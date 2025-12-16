const { Sequelize, DataTypes } = require('sequelize');

// Initialize Sequelize
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST,
  dialect: process.env.DB_DIALECT || 'postgres',
  dialectOptions: {
    ssl: false
  },
  logging: false
});

// Define User model directly here (refactored from User.js for centralized management)
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
    allowNull: true,
    validate: {
      async isUniqueIfNotEmpty(value) {
        if (value && value.trim() !== "") {
          const existingUser = await User.findOne({
            where: { nfc_key_address: value, id: { [Sequelize.Op.ne]: this.id } }
          });
          if (existingUser) {
            throw new Error('This NFC Key Address is already in use.');
          }
        }
      }
    }
  },
  pin_code: {
    type: DataTypes.STRING,
    allowNull: true,
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
  },
  disabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  telegram_username: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    validate: {
      isValidTelegramUsername(value) {
        if (value && !/^@[a-zA-Z0-9_]{5,32}$/.test(value)) {
          throw new Error('Telegram username must start with @ and be 5-32 characters (letters, numbers, underscores).');
        }
      }
    }
  },
  member_type: {
    type: DataTypes.ENUM('full', 'daypass'),
    defaultValue: 'full',
    allowNull: false
  }
}, {
  timestamps: true
});

// Define DayPass model
const DayPass = sequelize.define('DayPass', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  allowed_uses: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: {
      min: 1
    }
  },
  used_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  timestamps: true
});

// DayPass instance methods
DayPass.prototype.hasRemainingUses = function() {
  return this.used_count < this.allowed_uses;
};

DayPass.prototype.isExpired = function() {
  if (!this.expires_at) return false;
  return new Date() > this.expires_at;
};

DayPass.prototype.isValid = function() {
  return this.hasRemainingUses() && !this.isExpired();
};

// Define DayCode model
const DayCode = sequelize.define('DayCode', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  day_pass_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  code: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isValidPin(value) {
        if (!/^\d{5,6}$/.test(value)) {
          throw new Error('Day code must be 5-6 digits.');
        }
      }
    }
  },
  pin_slot: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      isInRange(value) {
        const minSlot = parseInt(process.env.DAY_PASS_SLOT_MIN) || 125;
        const maxSlot = parseInt(process.env.DAY_PASS_SLOT_MAX) || 249;
        if (value < minSlot || value > maxSlot) {
          throw new Error(`Pin slot must be between ${minSlot} and ${maxSlot}.`);
        }
      }
    }
  },
  issued_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  revoked_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  }
}, {
  timestamps: true
});

// Define associations
User.hasMany(DayPass, { foreignKey: 'user_id', as: 'dayPasses' });
DayPass.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

DayPass.hasMany(DayCode, { foreignKey: 'day_pass_id', as: 'dayCodes' });
DayCode.belongsTo(DayPass, { foreignKey: 'day_pass_id', as: 'dayPass' });

User.hasMany(DayCode, { foreignKey: 'user_id', as: 'dayCodes' });
DayCode.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Sync all models
const syncDatabase = async () => {
  await sequelize.sync({ alter: true });
  console.log('Database synchronized');
};

module.exports = {
  sequelize,
  Sequelize,
  User,
  DayPass,
  DayCode,
  syncDatabase
};
