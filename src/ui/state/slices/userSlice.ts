import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// Slice for your own user
export interface User {
  peerId: string;
  connected: boolean | null;
  registered: boolean;
  username?: string;
  torEnabled: boolean;
  registrationInProgress: boolean;
  pendingRegisterUsername?: string;
}

const initialState: User = {
  peerId: '',
  connected: null,
  registered: false,
  username: '',
  torEnabled: false,
  registrationInProgress: false,
  pendingRegisterUsername: '',
};

const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setPeerId: (state, action: PayloadAction<string>) => {
      state.peerId = action.payload;
    },
    setUsername: (state, action: PayloadAction<string>) => {
      state.username = action.payload;
    },
    setConnected: (state, action: PayloadAction<boolean | null>) => {
      state.connected = action.payload;
    },
    setRegistered: (state, action: PayloadAction<boolean>) => {
      state.registered = action.payload;
      if (action.payload) {
        state.registrationInProgress = false;
        state.pendingRegisterUsername = '';
      }
    },
    setTorEnabled: (state, action: PayloadAction<boolean>) => {
      state.torEnabled = action.payload;
    },
    setRegistrationInProgress: (
      state,
      action: PayloadAction<{ inProgress: boolean; pendingUsername?: string }>
    ) => {
      state.registrationInProgress = action.payload.inProgress;
      state.pendingRegisterUsername = action.payload.pendingUsername || '';
    },
  },
});

export const {
  setPeerId,
  setUsername,
  setConnected,
  setRegistered,
  setTorEnabled,
  setRegistrationInProgress,
} = userSlice.actions;

export default userSlice.reducer;
