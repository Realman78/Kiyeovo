import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface PendingFile {
  fileId: string;
  filename: string;
  size: number;
  senderId: string;
  senderUsername: string;
  chatId: number;
  timestamp: number;
  expiresAt: number;
}

interface PendingFilesState {
  files: PendingFile[];
}

const initialState: PendingFilesState = {
  files: [],
};

const pendingFilesSlice = createSlice({
  name: 'pendingFiles',
  initialState,
  reducers: {
    addPendingFile: (state, action: PayloadAction<PendingFile>) => {
      // Check if file already exists (prevent duplicates)
      const exists = state.files.some(f => f.fileId === action.payload.fileId);
      if (!exists) {
        state.files.push(action.payload);
      }
    },
    removePendingFile: (state, action: PayloadAction<string>) => {
      state.files = state.files.filter(f => f.fileId !== action.payload);
    },
    setPendingFiles: (state, action: PayloadAction<PendingFile[]>) => {
      state.files = action.payload;
    },
    clearPendingFiles: (state) => {
      state.files = [];
    },
  },
});

export const {
  addPendingFile,
  removePendingFile,
  setPendingFiles,
  clearPendingFiles
} = pendingFilesSlice.actions;

export default pendingFilesSlice.reducer;
