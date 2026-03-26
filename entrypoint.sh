#!/bin/bash
set -e

# Check if groups are already registered
if node -e "
  const Database = require('better-sqlite3');
  try {
    const db = new Database('store/messages.db');
    const count = db.prepare('SELECT COUNT(*) as c FROM registered_groups').get().c;
    process.exit(count > 0 ? 0 : 1);
  } catch(e) {
    process.exit(1);
  }
" 2>/dev/null; then
  echo "Groups already registered, starting NanoClaw..."
else
  echo "No groups registered, auto-registering from environment..."
  if [ -n "$TELEGRAM_MAIN_CHAT_ID" ]; then
    node -e "
      const { initDatabase, setRegisteredGroup } = require('./dist/db.js');
      const path = require('path');
      const fs = require('fs');
      initDatabase();
      const folder = 'main';
      const groupDir = path.join('groups', folder);
      fs.mkdirSync(groupDir, { recursive: true });
      setRegisteredGroup('tg:' + process.env.TELEGRAM_MAIN_CHAT_ID, {
        name: process.env.TELEGRAM_MAIN_CHAT_NAME || 'main',
        folder: folder,
        trigger: '@' + (process.env.ASSISTANT_NAME || 'Vi'),
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: true,
      });
      console.log('Registered Telegram chat: tg:' + process.env.TELEGRAM_MAIN_CHAT_ID);
    "
  else
    echo "WARNING: TELEGRAM_MAIN_CHAT_ID not set, skipping registration"
  fi
fi

exec node dist/index.js
