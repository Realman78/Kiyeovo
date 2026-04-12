import { type CategoryConfig, Categories } from "emoji-picker-react";

export const MAX_FILE_MESSAGE_SIZE = 1 * 1024 * 1024; // 1MB for JSON overhead
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max file size
export const FILE_ACCEPTANCE_TIMEOUT = 5 * 60 * 1000;
export const SHOW_TIMESTAMP_INTERVAL = 15 * 60 * 1000;
export const INITIAL_MESSAGES_LIMIT = 50;
export const LOAD_MORE_MESSAGES_LIMIT = 50;
export const REINVITE_COOLDOWN_MS = 2 * 60 * 1000;
export const INBOUND_INACTIVITY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

export const TOR_CONFIG = {
  DEFAULT_SOCKS_HOST: '127.0.0.1',
  DEFAULT_SOCKS_PORT: 9050,
  DEFAULT_CONNECTION_TIMEOUT: 30_000,
  DEFAULT_CIRCUIT_TIMEOUT: 60_000,
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_HEALTH_CHECK_INTERVAL: 60_000,
  DNS_RESOLUTION_TOR: 'tor',
  DNS_RESOLUTION_SYSTEM: 'system'
};

// Configuration defaults - must match core constants
export const CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES = 10;
export const KEY_EXCHANGE_RATE_LIMIT_DEFAULT = 10;
export const OFFLINE_MESSAGE_LIMIT = 50;
export const FILE_OFFER_RATE_LIMIT = 5;
export const MAX_PENDING_FILES_PER_PEER = 5;
export const MAX_PENDING_FILES_TOTAL = 10;
export const SILENT_REJECTION_THRESHOLD_GLOBAL = 20;
export const SILENT_REJECTION_THRESHOLD_PER_PEER = 5;
export const MAX_MESSAGE_CONTENT_LENGTH = 1024;
export const MAX_GROUP_MEMBERS = 10;

// String constants
export const UNEXPECTED_ERROR = 'Unexpected error occurred';

export const EMOJI_CATEGORIES: CategoryConfig[] = [
  { category: Categories.SMILEYS_PEOPLE, name: 'Smileys & People' },
  { category: Categories.ANIMALS_NATURE, name: 'Animals & Nature' },
  { category: Categories.FOOD_DRINK, name: 'Food & Drink' },
  { category: Categories.TRAVEL_PLACES, name: 'Travel & Places' },
  { category: Categories.ACTIVITIES, name: 'Activities' },
  { category: Categories.OBJECTS, name: 'Objects' },
  { category: Categories.SYMBOLS, name: 'Symbols' },
  { category: Categories.FLAGS, name: 'Flags' },
];
