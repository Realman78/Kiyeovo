import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { IceTestStatus } from '../../types';

export type IceServerTestState = {
  status: IceTestStatus | 'testing';
  detail?: string;
  testedAt: number | null;
  requestId: string;
};

type IceSetupState = {
  testResults: Record<string, IceServerTestState>;
  activeTestAllRequestId: string | null;
};

const initialState: IceSetupState = {
  testResults: {},
  activeTestAllRequestId: null,
};

const iceSetupSlice = createSlice({
  name: 'iceSetup',
  initialState,
  reducers: {
    startIceServerTest: (
      state,
      action: PayloadAction<{ serverId: string; requestId: string }>,
    ) => {
      const { serverId, requestId } = action.payload;
      state.testResults[serverId] = {
        status: 'testing',
        testedAt: null,
        requestId,
      };
    },
    completeIceServerTest: (
      state,
      action: PayloadAction<{
        serverId: string;
        requestId: string;
        status: IceTestStatus;
        detail?: string;
        testedAt: number;
      }>,
    ) => {
      const {
        serverId,
        requestId,
        status,
        detail,
        testedAt,
      } = action.payload;
      if (state.testResults[serverId]?.requestId !== requestId) {
        return;
      }
      state.testResults[serverId] = {
        status,
        detail,
        testedAt,
        requestId,
      };
    },
    clearIceServerTest: (state, action: PayloadAction<{ serverId: string }>) => {
      delete state.testResults[action.payload.serverId];
    },
    startIceServerTestAll: (state, action: PayloadAction<{ requestId: string }>) => {
      state.activeTestAllRequestId = action.payload.requestId;
    },
    completeIceServerTestAll: (state, action: PayloadAction<{ requestId: string }>) => {
      if (state.activeTestAllRequestId === action.payload.requestId) {
        state.activeTestAllRequestId = null;
      }
    },
  },
});

export const {
  startIceServerTest,
  completeIceServerTest,
  clearIceServerTest,
  startIceServerTestAll,
  completeIceServerTestAll,
} = iceSetupSlice.actions;

export default iceSetupSlice.reducer;
