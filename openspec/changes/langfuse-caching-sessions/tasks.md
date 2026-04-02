## 1. Database: conversations table and clearSession

- [x] 1.1 Add `conversations` table to `createSchema()` in `src/db.ts` — `(id TEXT PK, group_folder TEXT, session_id TEXT, started_at TEXT, ended_at TEXT)` with index on group_folder
- [x] 1.2 Add `clearSession(groupFolder)` function to `src/db.ts` — archives current session to conversations table (with ended_at = now), then deletes from sessions table. Returns `{ cleared: boolean }`. If no session exists, returns `{ cleared: false }`.
- [x] 1.3 Add `getConversations(groupFolder)` function to `src/db.ts` — returns all conversations for a group, ordered by started_at desc

## 2. Session reset in orchestrator

- [x] 2.1 Add `resetSession(chatJid)` function in `src/index.ts` — calls `clearSession()` from db, calls `queue.closeStdin(chatJid)` to kill active container, updates in-memory `sessions` object. Returns `{ cleared: boolean, message: string }`.
- [x] 2.2 Export `resetSession` so it can be called from channel handlers

## 3. Telegram commands

- [x] 3.1 Add `onSessionReset` callback to `TelegramChannelOpts` interface in `src/channels/telegram.ts`
- [x] 3.2 Add `/start` command handler that calls `onSessionReset(chatJid)` and replies with the result message. Must check `registeredGroups()` first — ignore if not registered.
- [x] 3.3 Add `/new` command handler (same logic as `/start`)
- [x] 3.4 Add `start` and `new` to `TELEGRAM_BOT_COMMANDS` set so they're not processed as regular messages

## 4. Wire up callbacks

- [x] 4.1 In `src/index.ts`, add `onSessionReset` to the `channelOpts` object, implemented using `resetSession()`

## 5. Track session start time

- [x] 5.1 When a new sessionId is first set in `wrappedOnOutput` (in `runAgent`), record the start time. Add `session_started_at` column to `sessions` table (migration pattern: ALTER TABLE with try/catch). Set it on INSERT only (not on UPDATE when sessionId doesn't change).

## 6. Build and verify

- [x] 6.1 Run `npm run build` to verify TypeScript compilation succeeds
