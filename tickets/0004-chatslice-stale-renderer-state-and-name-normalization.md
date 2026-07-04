# Stale renderer-local chat state + un-normalized contact name

- **Area:** UI state (chatSlice) + Core identity
- **Severity:** Low
- **Source:** Test phase 5 & 6 review (`testing-findings.md`)
- **Status:** Open

## Summary

A cluster of small, related correctness gaps where local/renderer state is left stale or
un-normalized. None is a security issue; each can produce confusing UI or inconsistent
sort/display state. The phase 6 tests deliberately exercise the safe paths, so these are
documented but not currently asserted.

## Items

### 1. `addMessage` can regress preview metadata from duplicate or older messages
`src/ui/state/slices/chatSlice.ts:202-262`: duplicate messages are not inserted, and
out-of-order historical messages may be sorted into the message list, but the reducer
still unconditionally writes `chat.lastMessage` and `chat.lastMessageTimestamp` from
the incoming payload. A late offline/history arrival or duplicate payload can therefore
move the sidebar preview backward even when a newer message is already present.

**Fix:** update preview metadata only when the incoming message becomes the latest
settled message for that chat. Duplicates should not update preview metadata, and older
inserted messages should be stored without changing the chat preview. If in doubt,
recompute the preview from the chat's message list after insertion instead of trusting
the incoming payload.

### 2. `removeChat` does not clear `replyTargetByChatId` (and clears messages inconsistently)
`src/ui/state/slices/chatSlice.ts:314-322` filters out the chat and its sending
messages, but leaves `state.replyTargetByChatId[chatId]` in place. A stale reply target
survives until overwritten or cleared elsewhere — and could be reattached if a chat id is
reused.

Separately, `removeChat` does **not** filter `state.messages` by the removed chat id. It
clears `state.messages` (entirely) *only when the removed chat is the active one*
(`if (state.activeChat?.id === action.payload)`); if the removed chat is **not** active,
its loaded messages remain in `state.messages`. This is harmless only if `state.messages`
is by design just the active-chat window — but the reducer never documents that ownership,
and the sibling `clearMessages` reducer *does* filter by chatId, which suggests
`state.messages` can hold more than one chat. The reducer should either document that
`state.messages` is the active window or remove the deleted chat's messages consistently
(filter by chat id rather than all-or-nothing).

**Fix:** `delete state.replyTargetByChatId[action.payload];` inside `removeChat`, and
decide/normalize the `state.messages` ownership (document as active-window, or
`state.messages = state.messages.filter(m => m.chatId !== action.payload)`).

### 3. `removeMessagesByIds` leaves a stale `lastMessageTimestamp`
`src/ui/state/slices/chatSlice.ts:415-426`: when no preview remains, `lastMessage` is set
to `'SYSTEM: No messages yet'`, but `lastMessageTimestamp` is only updated when
`preview` is truthy (`if (preview)` guard). An emptied chat keeps its old timestamp and
thus its old position in the timestamp-sorted chat list.

**Fix:** in the `preview == null` branch, reset `lastMessageTimestamp` to a defined empty
value (e.g. `0` or the chat's `created_at`) consistent with how empty chats should sort.

### 4. Custom contact name is not trimmed/normalized
`src/core/identity/profile-manager.ts:155-163`: `localUsername = customName || profile.username`
is length-checked (2–64) but never trimmed. A name like `'  '` or `' x '` is stored as-is,
including leading/trailing whitespace, and a whitespace-only name can pass the length check.

**Fix:** trim (and reject empty-after-trim) before the length validation, in main/core so
the rule holds regardless of caller.

## Test coverage

Existing tests hit nearby safe paths but not these regressions: `chatSlice.test.ts`
covers the duplicate unread count but not duplicate/older preview regression, and covers
deletion with a remaining preview but not deletion down to empty; `profile-manager.test.ts`
covers successful and duplicate import but not custom-name trimming. Add cases:
- `addMessage` ignores duplicate payloads for preview metadata and does not let older
  inserted messages replace a newer sidebar preview.
- `removeChat` clears the reply target for the removed chat id.
- `removeChat` of a **non-active** chat does not leave that chat's messages in
  `state.messages` (or the active-window ownership is documented and asserted).
- `removeMessagesByIds` down to empty resets `lastMessageTimestamp`.
- Import with `customName = '  x  '` stores a trimmed name; whitespace-only is rejected.
