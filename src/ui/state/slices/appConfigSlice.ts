import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import type { AppConfig } from '../../../core/types';
import { errStr } from '../../../core/utils/general-error';
import {
  CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  KEY_EXCHANGE_RATE_LIMIT_DEFAULT,
  OFFLINE_MESSAGE_LIMIT,
  MAX_FILE_SIZE,
  FILE_OFFER_RATE_LIMIT,
  MAX_PENDING_FILES_PER_PEER,
  MAX_PENDING_FILES_TOTAL,
  SILENT_REJECTION_THRESHOLD_GLOBAL,
  SILENT_REJECTION_THRESHOLD_PER_PEER,
} from '../../constants';

export const DEFAULT_APP_CONFIG: AppConfig = {
  chatsToCheckForOfflineMessages: CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  keyExchangeRateLimit: KEY_EXCHANGE_RATE_LIMIT_DEFAULT,
  offlineMessageLimit: OFFLINE_MESSAGE_LIMIT,
  maxFileSize: MAX_FILE_SIZE,
  fileOfferRateLimit: FILE_OFFER_RATE_LIMIT,
  maxPendingFilesPerPeer: MAX_PENDING_FILES_PER_PEER,
  maxPendingFilesTotal: MAX_PENDING_FILES_TOTAL,
  silentRejectionThresholdGlobal: SILENT_REJECTION_THRESHOLD_GLOBAL,
  silentRejectionThresholdPerPeer: SILENT_REJECTION_THRESHOLD_PER_PEER,
};

interface AppConfigState {
  config: AppConfig;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  lastLoadedAt: number | null;
}

const initialState: AppConfigState = {
  config: DEFAULT_APP_CONFIG,
  loaded: false,
  loading: false,
  saving: false,
  error: null,
  lastLoadedAt: null,
};

export const fetchAppConfig = createAsyncThunk<AppConfig, void, { rejectValue: string }>(
  'appConfig/fetch',
  async (_, { rejectWithValue }) => {
    try {
      const result = await window.kiyeovoAPI.getAppConfig();
      if (!result.success || !result.config) {
        return rejectWithValue(result.error || 'Failed to fetch app configuration');
      }
      return result.config;
    } catch (error) {
      return rejectWithValue(errStr(error, 'Failed to fetch app configuration'));
    }
  },
);

export const saveAppConfig = createAsyncThunk<AppConfig, AppConfig, { rejectValue: string }>(
  'appConfig/save',
  async (nextConfig, { rejectWithValue }) => {
    try {
      const saveResult = await window.kiyeovoAPI.setAppConfig(nextConfig);
      if (!saveResult.success) {
        return rejectWithValue(saveResult.error || 'Failed to save app configuration');
      }

      // Re-read persisted values so UI reflects backend clamping/validation.
      const readResult = await window.kiyeovoAPI.getAppConfig();
      if (readResult.success && readResult.config) {
        return readResult.config;
      }
      return nextConfig;
    } catch (error) {
      return rejectWithValue(errStr(error, 'Failed to save app configuration'));
    }
  },
);

const appConfigSlice = createSlice({
  name: 'appConfig',
  initialState,
  reducers: {
    clearAppConfigError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchAppConfig.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchAppConfig.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.config = action.payload;
        state.lastLoadedAt = Date.now();
      })
      .addCase(fetchAppConfig.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || action.error.message || 'Failed to fetch app configuration';
      })
      .addCase(saveAppConfig.pending, (state) => {
        state.saving = true;
        state.error = null;
      })
      .addCase(saveAppConfig.fulfilled, (state, action) => {
        state.saving = false;
        state.loaded = true;
        state.config = action.payload;
        state.lastLoadedAt = Date.now();
      })
      .addCase(saveAppConfig.rejected, (state, action) => {
        state.saving = false;
        state.error = action.payload || action.error.message || 'Failed to save app configuration';
      });
  },
});

export const { clearAppConfigError } = appConfigSlice.actions;
export default appConfigSlice.reducer;
