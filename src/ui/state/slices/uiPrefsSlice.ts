import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type TimeFormat = '24h' | '12h';

const STORAGE_KEY = 'kiyeovo:timeFormat';

const readPersistedTimeFormat = (): TimeFormat => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '12h' ? '12h' : '24h';
  } catch {
    return '24h';
  }
};

interface UiPrefsState {
  timeFormat: TimeFormat;
}

const initialState: UiPrefsState = {
  timeFormat: readPersistedTimeFormat(),
};

const uiPrefsSlice = createSlice({
  name: 'uiPrefs',
  initialState,
  reducers: {
    setTimeFormat(state, action: PayloadAction<TimeFormat>) {
      state.timeFormat = action.payload;
      try {
        localStorage.setItem(STORAGE_KEY, action.payload);
      } catch {
        // Non-fatal: the preference simply won't persist across restarts.
      }
    },
  },
});

export const { setTimeFormat } = uiPrefsSlice.actions;
export default uiPrefsSlice.reducer;
