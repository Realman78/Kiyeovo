export interface PasswordRequest {
    prompt: string;
    isNewPassword?: boolean;
    recoveryPhrase?: string;
    prefilledPassword?: string;
    errorMessage?: string;
    cooldownSeconds?: number; // Remaining cooldown time in seconds
    cooldownUntil?: number; // Absolute unix ms timestamp when cooldown ends
    showRecoveryOption?: boolean; // Show recovery phrase option after failed attempt
    keychainAvailable?: boolean; // Whether OS keychain is available
  }

export type MessageSentStatus = 'online' | 'offline' | null;

export type CallDirection = 'incoming' | 'outgoing';
export type CallLifecycleState = 'idle' | 'ringing_out' | 'ringing_in' | 'connecting' | 'active' | 'ended';
export type CallMediaType = 'audio' | 'video';

export type IncomingCallSignal = {
  type: 'CALL_OFFER';
  callId: string;
  fromPeerId: string;
  toPeerId: string;
  timestamp: number;
  signature: string;
  offerSdp: string;
  mediaType: CallMediaType;
};

export type CallSignal = {
  type: 'CALL_ANSWER' | 'CALL_ICE' | 'CALL_REJECT' | 'CALL_END' | 'CALL_BUSY';
  callId: string;
  fromPeerId: string;
  toPeerId: string;
  timestamp: number;
  signature: string;
  answerSdp?: string;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
  reason?: 'rejected' | 'timeout' | 'offline' | 'policy' | 'hangup' | 'disconnect' | 'failed' | 'busy';
};

export interface CallIncomingEvent {
  signal: IncomingCallSignal;
  receivedAt: number;
}

export interface CallSignalReceivedEvent {
  signal: CallSignal;
  receivedAt: number;
}

export interface CallStateChangedEvent {
  callId: string;
  peerId: string;
  state: CallLifecycleState;
  direction: CallDirection;
  mediaType?: CallMediaType;
  reason?: string;
  timestamp: number;
}

export interface CallErrorEvent {
  error: string;
  peerId?: string;
  callId?: string;
  code?: string;
  timestamp: number;
}
