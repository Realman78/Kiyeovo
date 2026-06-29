import { configureStore } from '@reduxjs/toolkit';
import chatReducer from './slices/chatSlice';
import userReducer from './slices/userSlice';
import appConfigReducer from './slices/appConfigSlice';
import callReducer from './slices/callSlice';
import setupNodesReducer from './slices/setupNodesSlice';
import iceSetupReducer from './slices/iceSetupSlice';
import uiPrefsReducer from './slices/uiPrefsSlice';

export const store = configureStore({
  reducer: {
    chat: chatReducer,
    user: userReducer,
    appConfig: appConfigReducer,
    call: callReducer,
    setupNodes: setupNodesReducer,
    iceSetup: iceSetupReducer,
    uiPrefs: uiPrefsReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
