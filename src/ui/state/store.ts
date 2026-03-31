import { configureStore } from '@reduxjs/toolkit';
import chatReducer from './slices/chatSlice';
import userReducer from './slices/userSlice';
import appConfigReducer from './slices/appConfigSlice';
import callReducer from './slices/callSlice';

export const store = configureStore({
  reducer: {
    chat: chatReducer,
    user: userReducer,
    appConfig: appConfigReducer,
    call: callReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
