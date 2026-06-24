import Sequelize from 'sequelize';

export const db = {};

// Default to SQLite. On a host like Render, point SQLITE_PATH at a mounted
// persistent disk (e.g. /var/data/wssync.sqlite) so the DB survives restarts.
const dialect = process.env.DB_DIALECT || 'sqlite';
const storage = process.env.SQLITE_PATH || 'wssync.sqlite';

const sequelize = new Sequelize('wssync', 'wssync', 'wssync', {
  dialect,
  host: 'localhost',
  storage,
  logging: false,
  define: {
    freezeTableName: true
  }
});

const rooms = sequelize.define('rooms', {
  uuid: {
    type: Sequelize.UUID,
    defaultValue: Sequelize.UUIDV4,
    allowNull: false
  },
  state: {
    type: Sequelize.TEXT('long'),
    allowNull: true
  }
}, {
  hooks: {
    beforeCount(options) {
      options.raw = true;
    }
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;
db.rooms = rooms;

sequelize.sync();