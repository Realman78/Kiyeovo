import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { CallDirection, CallLifecycleState, CallMediaType, ScreenShareLifecycleState } from '../../types';

export interface IncomingCall {
  callId: string;
  peerId: string;
  peerName: string;
  offerSdp: string;
  mediaType: CallMediaType;
  receivedAt: number;
}

export interface ActiveCall {
  callId: string;
  peerId: string;
  peerName: string;
  direction: CallDirection;
  mediaType: CallMediaType;
  state: Exclude<CallLifecycleState, 'idle' | 'ended'>;
  startedAt: number;
  reason?: string;
}

interface CallState {
  incomingCall: IncomingCall | null;
  activeCall: ActiveCall | null;
  screenShare: {
    callId: string | null;
    peerId: string | null;
    localState: ScreenShareLifecycleState;
    remoteSharing: boolean;
  };
  lastError: string | null;
}

const initialState: CallState = {
  incomingCall: null,
  activeCall: null,
  screenShare: {
    callId: null,
    peerId: null,
    localState: 'idle',
    remoteSharing: false,
  },
  lastError: null,
};

function resetScreenShareState(state: CallState): void {
  state.screenShare = {
    callId: null,
    peerId: null,
    localState: 'idle',
    remoteSharing: false,
  };
}

const callSlice = createSlice({
  name: 'call',
  initialState,
  reducers: {
    setIncomingCall: (state, action: PayloadAction<IncomingCall>) => {
      state.incomingCall = action.payload;
      if (
        !state.activeCall
        || state.activeCall.callId !== action.payload.callId
        || state.activeCall.peerId !== action.payload.peerId
      ) {
        resetScreenShareState(state);
        state.activeCall = {
          callId: action.payload.callId,
          peerId: action.payload.peerId,
          peerName: action.payload.peerName,
          direction: 'incoming',
          mediaType: action.payload.mediaType,
          state: 'ringing_in',
          startedAt: action.payload.receivedAt,
        };
      }
      state.lastError = null;
    },
    clearIncomingCall: (state) => {
      state.incomingCall = null;
    },
    applyCoreCallState: (
      state,
      action: PayloadAction<{
        callId: string;
        peerId: string;
        peerName: string;
        direction: CallDirection;
        mediaType?: CallMediaType;
        state: CallLifecycleState;
        reason?: string;
        timestamp: number;
      }>
    ) => {
      const payload = action.payload;
      if (payload.state === 'idle' || payload.state === 'ended') {
        if (
          state.activeCall
          && state.activeCall.callId === payload.callId
          && state.activeCall.peerId === payload.peerId
        ) {
          state.activeCall = null;
          resetScreenShareState(state);
        }
        if (
          state.incomingCall
          && state.incomingCall.callId === payload.callId
          && state.incomingCall.peerId === payload.peerId
        ) {
          state.incomingCall = null;
        }
        return;
      }

      if (
        !state.activeCall
        || state.activeCall.callId !== payload.callId
        || state.activeCall.peerId !== payload.peerId
      ) {
        resetScreenShareState(state);
        state.activeCall = {
          callId: payload.callId,
          peerId: payload.peerId,
          peerName: payload.peerName,
          direction: payload.direction,
          mediaType: payload.mediaType ?? 'audio',
          state: payload.state,
          startedAt: payload.timestamp,
          reason: payload.reason,
        };
      } else {
        state.activeCall.state = payload.state;
        state.activeCall.direction = payload.direction;
        state.activeCall.mediaType = payload.mediaType ?? state.activeCall.mediaType;
        state.activeCall.peerName = payload.peerName;
        state.activeCall.reason = payload.reason;
      }

      if (
        payload.state !== 'ringing_in'
        && state.incomingCall
        && state.incomingCall.callId === payload.callId
        && state.incomingCall.peerId === payload.peerId
      ) {
        state.incomingCall = null;
      }
    },
    applyLocalCallState: (
      state,
      action: PayloadAction<{
        callId: string;
        peerId: string;
        state: 'connecting' | 'active' | 'ended';
        reason?: string;
      }>
    ) => {
      const payload = action.payload;
      if (payload.state === 'ended') {
        if (
          state.activeCall
          && state.activeCall.callId === payload.callId
          && state.activeCall.peerId === payload.peerId
        ) {
          state.activeCall = null;
          resetScreenShareState(state);
        }
        if (
          state.incomingCall
          && state.incomingCall.callId === payload.callId
          && state.incomingCall.peerId === payload.peerId
        ) {
          state.incomingCall = null;
        }
        return;
      }

      if (
        state.activeCall
        && state.activeCall.callId === payload.callId
        && state.activeCall.peerId === payload.peerId
      ) {
        state.activeCall.state = payload.state;
        state.activeCall.reason = payload.reason;
      }
    },
    setCallError: (state, action: PayloadAction<string>) => {
      state.lastError = action.payload;
    },
    clearCallError: (state) => {
      state.lastError = null;
    },
    setCallPeerName: (state, action: PayloadAction<{ peerId: string; peerName: string }>) => {
      const { peerId, peerName } = action.payload;
      if (state.activeCall?.peerId === peerId) {
        state.activeCall.peerName = peerName;
      }
      if (state.incomingCall?.peerId === peerId) {
        state.incomingCall.peerName = peerName;
      }
    },
    applyScreenShareState: (
      state,
      action: PayloadAction<{
        callId: string;
        peerId: string;
        localState: ScreenShareLifecycleState;
        remoteSharing: boolean;
      }>
    ) => {
      const payload = action.payload;
      if (
        !state.activeCall
        || state.activeCall.callId !== payload.callId
        || state.activeCall.peerId !== payload.peerId
      ) {
        if (payload.localState === 'idle' && !payload.remoteSharing) {
          resetScreenShareState(state);
        }
        return;
      }

      state.screenShare = {
        callId: payload.callId,
        peerId: payload.peerId,
        localState: payload.localState,
        remoteSharing: payload.remoteSharing,
      };

      if (payload.localState === 'idle' && !payload.remoteSharing) {
        resetScreenShareState(state);
      }
    },
    resetCallState: (state) => {
      state.incomingCall = null;
      state.activeCall = null;
      resetScreenShareState(state);
      state.lastError = null;
    },
  },
});

export const {
  setIncomingCall,
  clearIncomingCall,
  applyCoreCallState,
  applyLocalCallState,
  setCallError,
  clearCallError,
  setCallPeerName,
  applyScreenShareState,
  resetCallState,
} = callSlice.actions;

export default callSlice.reducer;
