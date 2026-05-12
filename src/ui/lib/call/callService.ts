import type {
  CallDirection,
  CallMediaType,
  CallSignal,
  CallStateChangedEvent,
  ScreenShareLifecycleState,
  ScreenShareStopReason,
} from '../../types';
import type { IceServerConfig } from '../../../core/types';
import { DEFAULT_WEBRTC_ICE_SERVERS } from '../../../core/network/default-infrastructure';
import { errStr } from '../../../core/utils/general-error';
import { SCREEN_SHARE_UNSUPPORTED_MESSAGE } from '../../constants';

type CurrentCall = {
  callId: string;
  peerId: string;
  direction: CallDirection;
  mediaType: CallMediaType;
};

const SCREEN_SHARE_MAX_BITRATE_BPS = 4_000_000;

export type CallServiceEvent =
  | {
    type: 'state';
    callId: string;
    peerId: string;
    state: 'connecting' | 'active' | 'ended';
    reason?: string;
  }
  | {
    type: 'error';
    message: string;
  }
  | {
    type: 'media';
    callId: string;
    peerId: string;
    mediaType: CallMediaType;
    localStream: MediaStream | null;
    remoteStream: MediaStream | null;
  }
  | {
    type: 'screen-share';
    callId: string;
    peerId: string;
    localState: ScreenShareLifecycleState;
    remoteSharing: boolean;
  };

class CallService {
  private static readonly RING_TIMEOUT_MS = 30_000;
  private peerConnection: RTCPeerConnection | null = null;
  private currentCall: CurrentCall | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private sharedVideoTransceiver: RTCRtpTransceiver | null = null;
  private sharedVideoSender: RTCRtpSender | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private localScreenShareState: ScreenShareLifecycleState = 'idle';
  private isRemoteScreenSharing = false;
  private localScreenShareAnnounced = false;
  private remoteScreenShareLastSignalTs: number | null = null;
  private muted = false;
  private deafened = false;
  private pendingRemoteIce: RTCIceCandidateInit[] = [];
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ringTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private sentDisconnectHangupCallId: string | null = null;
  private listeners = new Set<(event: CallServiceEvent) => void>();
  private iceServers: RTCIceServer[] = DEFAULT_WEBRTC_ICE_SERVERS.map((server) => ({ ...server }));

  subscribe(listener: (event: CallServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CallServiceEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  private emitMediaUpdate(context: CurrentCall | null = this.currentCall): void {
    if (!context) return;
    this.emit({
      type: 'media',
      callId: context.callId,
      peerId: context.peerId,
      mediaType: context.mediaType,
      localStream: this.getLocalDisplayStream(),
      remoteStream: this.remoteStream,
    });
  }

  private emitScreenShareUpdate(context: CurrentCall | null = this.currentCall): void {
    if (!context) return;
    this.emit({
      type: 'screen-share',
      callId: context.callId,
      peerId: context.peerId,
      localState: this.localScreenShareState,
      remoteSharing: this.isRemoteScreenSharing,
    });
  }

  private setLocalScreenShareState(
    state: ScreenShareLifecycleState,
    context: CurrentCall | null = this.currentCall,
  ): void {
    if (this.localScreenShareState === state) return;
    this.localScreenShareState = state;
    this.emitScreenShareUpdate(context);
  }

  private setRemoteScreenSharing(
    sharing: boolean,
    context: CurrentCall | null = this.currentCall,
  ): void {
    if (this.isRemoteScreenSharing === sharing) return;
    this.isRemoteScreenSharing = sharing;
    this.emitScreenShareUpdate(context);
  }

  private async sendScreenShareStartedSignal(context: CurrentCall): Promise<void> {
    const response = await window.kiyeovoAPI.sendCallSignal({
      type: 'CALL_SCREEN_SHARE_STARTED',
      callId: context.callId,
      toPeerId: context.peerId,
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to notify remote screen sharing started');
    }
  }

  private async sendScreenShareStoppedSignal(
    context: CurrentCall,
    reason: ScreenShareStopReason,
  ): Promise<void> {
    const response = await window.kiyeovoAPI.sendCallSignal({
      type: 'CALL_SCREEN_SHARE_STOPPED',
      callId: context.callId,
      toPeerId: context.peerId,
      reason,
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to notify remote screen sharing stopped');
    }
  }

  private announceScreenShareStoppedBestEffort(
    context: CurrentCall,
    reason: ScreenShareStopReason,
  ): void {
    if (!this.localScreenShareAnnounced) return;
    this.localScreenShareAnnounced = false;
    void this.sendScreenShareStoppedSignal(context, reason).catch((error: unknown) => {
      console.warn('[CallService] Failed to notify remote screen sharing stopped:', error);
    });
  }

  private getLocalDisplayStream(): MediaStream | null {
    return this.screenStream ?? this.localStream;
  }

  private getCameraTrack(): MediaStreamTrack | null {
    return this.localStream?.getVideoTracks()[0] ?? null;
  }

  private findSharedVideoTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | null {
    return pc.getTransceivers().find((transceiver) => (
      transceiver.receiver.track.kind === 'video' || transceiver.sender.track?.kind === 'video'
    )) ?? null;
  }

  private ensureSharedVideoTransceiver(pc: RTCPeerConnection): RTCRtpSender {
    const existingTransceiver = this.sharedVideoTransceiver ?? this.findSharedVideoTransceiver(pc);
    if (existingTransceiver) {
      existingTransceiver.direction = 'sendrecv';
      this.sharedVideoTransceiver = existingTransceiver;
      this.sharedVideoSender = existingTransceiver.sender;
    } else {
      const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
      this.sharedVideoTransceiver = transceiver;
      this.sharedVideoSender = transceiver.sender;
    }

    if (!this.sharedVideoSender) {
      throw new Error('Screen sharing video sender is not available');
    }

    return this.sharedVideoSender;
  }

  private async applyScreenShareSenderParameters(sender: RTCRtpSender): Promise<void> {
    try {
      const parameters = sender.getParameters() as RTCRtpSendParameters & {
        degradationPreference?: 'balanced' | 'maintain-framerate' | 'maintain-resolution';
      };
      if (parameters.encodings.length > 0) {
        parameters.encodings[0].maxBitrate = SCREEN_SHARE_MAX_BITRATE_BPS;
      }
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
    } catch (error: unknown) {
      console.warn('[CallService] Failed to tune screen share sender parameters:', error);
    }
  }

  private async resetSharedVideoSenderParameters(sender: RTCRtpSender): Promise<void> {
    try {
      const parameters = sender.getParameters() as RTCRtpSendParameters & {
        degradationPreference?: 'balanced' | 'maintain-framerate' | 'maintain-resolution';
      };
      if (parameters.encodings.length > 0) {
        delete parameters.encodings[0].maxBitrate;
      }
      parameters.degradationPreference = 'balanced';
      await sender.setParameters(parameters);
    } catch (error: unknown) {
      console.warn('[CallService] Failed to reset shared video sender parameters:', error);
    }
  }

  private async replaceSharedVideoTrack(
    track: MediaStreamTrack | null,
    content: 'camera' | 'screen' | 'none',
  ): Promise<void> {
    if (!this.sharedVideoSender && this.peerConnection) {
      this.ensureSharedVideoTransceiver(this.peerConnection);
    }

    if (!this.sharedVideoSender) {
      throw new Error('Screen sharing video sender is not available');
    }

    await this.sharedVideoSender.replaceTrack(track);
    if (track && content === 'screen') {
      await this.applyScreenShareSenderParameters(this.sharedVideoSender);
    } else {
      await this.resetSharedVideoSenderParameters(this.sharedVideoSender);
    }
  }

  private async restoreSharedVideoTrack(context: CurrentCall): Promise<void> {
    const cameraTrack = context.mediaType === 'video' ? this.getCameraTrack() : null;
    await this.replaceSharedVideoTrack(cameraTrack, cameraTrack ? 'camera' : 'none');
  }

  private toRtcIceServers(servers: IceServerConfig[]): RTCIceServer[] {
    return servers.map((server) => ({
      urls: server.url,
      username: server.username,
      credential: server.credential,
    }));
  }

  async refreshIceServers(): Promise<void> {
    try {
      const result = await window.kiyeovoAPI.getIceServers();
      if (!result.success) {
        console.warn('[CallService] Failed to load ICE servers:', result.error);
        return;
      }

      this.iceServers = this.toRtcIceServers(result.servers);
    } catch (error) {
      console.warn('[CallService] Failed to refresh ICE servers:', error);
    }
  }

  private getIceServers(): RTCIceServer[] {
    return this.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    }));
  }

  private createPeerConnection(context: CurrentCall): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(),
      iceTransportPolicy: 'all',
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void window.kiyeovoAPI.sendCallSignal({
        type: 'CALL_ICE',
        callId: context.callId,
        toPeerId: context.peerId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
        usernameFragment: event.candidate.usernameFragment ?? null,
      });
    };

    pc.ontrack = (event) => {
      if (event.streams.length === 0) {
        this.addRemoteTrack(event.track);
      } else {
        event.streams.forEach((stream) => {
          stream.getTracks().forEach((track) => {
            this.addRemoteTrack(track);
          });
        });
      }
      this.attachRemoteAudio();
      this.emitMediaUpdate(context);
    };

    pc.onconnectionstatechange = () => {
      if (this.currentCall?.callId !== context.callId) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        this.clearDisconnectTimer();
        this.emit({
          type: 'state',
          callId: context.callId,
          peerId: context.peerId,
          state: 'active',
        });
        return;
      }
      if (state === 'disconnected') {
        this.scheduleDisconnect(context);
        return;
      }
      if (state === 'failed' || state === 'closed') {
        this.clearDisconnectTimer();
        void this.endCallInternal(context, state === 'failed' ? 'failed' : 'disconnect', true);
      }
    };

    return pc;
  }

  private addRemoteTrack(track: MediaStreamTrack): boolean {
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }

    if (this.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
      return false;
    }

    this.remoteStream.addTrack(track);
    return true;
  }

  private syncRemoteVideoReceivers(context: CurrentCall | null = this.currentCall): void {
    if (!this.peerConnection) return;
    let addedTrack = false;

    this.peerConnection.getReceivers().forEach((receiver) => {
      const { track } = receiver;
      if (track.kind !== 'video' || track.readyState === 'ended') return;
      addedTrack = this.addRemoteTrack(track) || addedTrack;
    });

    if (!addedTrack) return;
    this.attachRemoteAudio();
    this.emitMediaUpdate(context);
  }

  private scheduleDisconnect(context: CurrentCall): void {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      void this.endCallInternal(context, 'disconnect', true);
    }, 5000);
  }

  private clearDisconnectTimer(): void {
    if (!this.disconnectTimer) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private scheduleOutgoingRingTimeout(context: CurrentCall): void {
    this.clearRingTimeout();
    this.ringTimeoutTimer = setTimeout(() => {
      if (!this.currentCall) return;
      if (this.currentCall.callId !== context.callId || this.currentCall.peerId !== context.peerId) return;
      void this.endCallInternal(context, 'timeout', true);
    }, CallService.RING_TIMEOUT_MS);
  }

  private clearRingTimeout(): void {
    if (!this.ringTimeoutTimer) return;
    clearTimeout(this.ringTimeoutTimer);
    this.ringTimeoutTimer = null;
  }

  private attachRemoteAudio(): void {
    if (!this.remoteStream) return;
    if (!this.remoteAudio) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      audio.style.display = 'none';
      document.body.appendChild(audio);
      this.remoteAudio = audio;
    }
    this.remoteAudio.muted = this.deafened;
    this.remoteAudio.srcObject = this.remoteStream;
    void this.remoteAudio.play().catch(() => {
      // Playback can fail due to browser policy before user gesture.
    });
  }

  private async getLocalStream(mediaType: CallMediaType): Promise<MediaStream> {
    if (this.localStream) {
      const hasVideoTrack = this.localStream.getVideoTracks().length > 0;
      if ((mediaType === 'video' && hasVideoTrack) || (mediaType === 'audio' && !hasVideoTrack)) {
        return this.localStream;
      }
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mediaType === 'video',
    });
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted;
    });
    this.localStream = stream;
    return stream;
  }

  private async addLocalTracks(pc: RTCPeerConnection, mediaType: CallMediaType): Promise<void> {
    const stream = await this.getLocalStream(mediaType);
    stream.getAudioTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });
    const videoSender = this.ensureSharedVideoTransceiver(pc);
    const cameraTrack = mediaType === 'video' ? this.getCameraTrack() : null;
    if (cameraTrack) {
      await videoSender.replaceTrack(cameraTrack);
    }
    this.emitMediaUpdate();
  }

  private async flushPendingRemoteIce(): Promise<void> {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    const queued = [...this.pendingRemoteIce];
    this.pendingRemoteIce = [];
    for (const candidate of queued) {
      await this.peerConnection.addIceCandidate(candidate);
    }
  }

  private async setRemoteAnswerSdp(answerSdp: string): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('No active peer connection for call answer');
    }
    await this.peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answerSdp,
    });
    await this.flushPendingRemoteIce();
    this.syncRemoteVideoReceivers();
  }

  private async addRemoteIce(signal: CallSignal): Promise<void> {
    if (signal.type !== 'CALL_ICE' || !signal.candidate) return;
    const candidate: RTCIceCandidateInit = {
      candidate: signal.candidate,
      sdpMid: signal.sdpMid ?? null,
      sdpMLineIndex: signal.sdpMLineIndex ?? null,
      usernameFragment: signal.usernameFragment ?? null,
    };
    if (!this.peerConnection) {
      this.pendingRemoteIce.push(candidate);
      return;
    }
    if (!this.peerConnection.remoteDescription) {
      this.pendingRemoteIce.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
  }

  private stopScreenCaptureTracks(): void {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.screenStream = null;
  }

  private resetScreenShare(context: CurrentCall | null = this.currentCall): void {
    const hadScreenShareState = this.localScreenShareState !== 'idle' || this.isRemoteScreenSharing;
    this.stopScreenCaptureTracks();
    this.localScreenShareState = 'idle';
    this.isRemoteScreenSharing = false;
    this.localScreenShareAnnounced = false;
    this.remoteScreenShareLastSignalTs = null;
    if (hadScreenShareState) {
      this.emitScreenShareUpdate(context);
    }
  }

  private stopStreams(context: CurrentCall | null = this.currentCall): void {
    this.resetScreenShare(context);
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => track.stop());
      this.remoteStream = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.muted = false;
      this.remoteAudio.srcObject = null;
    }
    this.muted = false;
    this.deafened = false;
  }

  private closePeerConnection(): void {
    if (!this.peerConnection) {
      this.pendingRemoteIce = [];
      return;
    }
    try {
      this.peerConnection.close();
    } catch {
      // Best-effort close.
    }
    this.peerConnection = null;
    this.sharedVideoTransceiver = null;
    this.sharedVideoSender = null;
    this.pendingRemoteIce = [];
  }

  private async endCallInternal(
    context: CurrentCall,
    reason: 'hangup' | 'disconnect' | 'failed' | 'rejected' | 'busy' | 'timeout',
    sendHangup: boolean,
  ): Promise<void> {
    const shouldNotifyCore = sendHangup
      && this.sentDisconnectHangupCallId !== context.callId;

    if (shouldNotifyCore) {
      this.sentDisconnectHangupCallId = context.callId;
    }

    this.announceScreenShareStoppedBestEffort(context, reason === 'failed' ? 'failed' : 'call-ended');
    this.clearDisconnectTimer();
    this.clearRingTimeout();
    this.closePeerConnection();
    this.stopStreams();
    this.emitMediaUpdate(context);
    this.currentCall = null;
    this.emit({
      type: 'state',
      callId: context.callId,
      peerId: context.peerId,
      state: 'ended',
      reason,
    });

    if (!shouldNotifyCore) {
      return;
    }

    // Peer-loss paths still need to notify the core so it clears its own
    // activeCall; the outbound signal will likely fail and that is expected.
    const hangupReason: 'hangup' | 'disconnect' | 'failed' =
      reason === 'disconnect' ? 'disconnect'
      : reason === 'failed' ? 'failed'
      : 'hangup';
    const isPeerLossPath = hangupReason === 'disconnect' || hangupReason === 'failed';
    try {
      const response = await window.kiyeovoAPI.hangupCall(context.peerId, context.callId, hangupReason);
      if (!response.success && !isPeerLossPath) {
        this.emit({ type: 'error', message: response.error || 'Failed to notify remote call end' });
      }
    } catch (error: unknown) {
      if (!isPeerLossPath) {
        const message = errStr(error, 'Failed to notify remote call end');
        this.emit({ type: 'error', message });
      }
    }
  }

  async startOutgoingCall(
    peerId: string,
    mediaType: CallMediaType = 'audio',
  ): Promise<{ success: boolean; callId?: string; error?: string }> {
    if (this.currentCall) {
      return { success: false, error: 'Another call is already in progress' };
    }

    const callId = crypto.randomUUID();
    const context: CurrentCall = {
      callId,
      peerId,
      direction: 'outgoing',
      mediaType,
    };

    try {
      await this.refreshIceServers();
      this.currentCall = context;
      this.sentDisconnectHangupCallId = null;
      this.peerConnection = this.createPeerConnection(context);
      await this.addLocalTracks(this.peerConnection, context.mediaType);
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      const offerSdp = this.peerConnection.localDescription?.sdp;
      if (!offerSdp) {
        throw new Error('Failed to create call offer');
      }

      const response = await window.kiyeovoAPI.startCall(peerId, callId, offerSdp, mediaType);
      if (!response.success) {
        throw new Error(response.error || 'Failed to start call');
      }
      this.scheduleOutgoingRingTimeout(context);
      return { success: true, callId };
    } catch (error: unknown) {
      const message = errStr(error, 'Failed to start call');
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.emitMediaUpdate(context);
      this.currentCall = null;
      return { success: false, error: message };
    }
  }

  async acceptIncomingCall(params: {
    callId: string;
    peerId: string;
    offerSdp: string;
    mediaType: CallMediaType;
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentCall && (this.currentCall.callId !== params.callId || this.currentCall.peerId !== params.peerId)) {
      return { success: false, error: 'Another call is already in progress' };
    }
    if (
      this.currentCall
      && this.currentCall.callId === params.callId
      && this.currentCall.peerId === params.peerId
      && this.peerConnection
    ) {
      return { success: false, error: 'Call accept already in progress' };
    }

    const context: CurrentCall = {
      callId: params.callId,
      peerId: params.peerId,
      direction: 'incoming',
      mediaType: params.mediaType,
    };

    try {
      await this.refreshIceServers();
      this.currentCall = context;
      this.sentDisconnectHangupCallId = null;
      this.peerConnection = this.createPeerConnection(context);

      await this.peerConnection.setRemoteDescription({
        type: 'offer',
        sdp: params.offerSdp,
      });
      await this.flushPendingRemoteIce();
      await this.addLocalTracks(this.peerConnection, context.mediaType);
      this.syncRemoteVideoReceivers(context);

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      const answerSdp = this.peerConnection.localDescription?.sdp;
      if (!answerSdp) {
        throw new Error('Failed to create call answer');
      }

      const response = await window.kiyeovoAPI.acceptCall(params.peerId, params.callId, answerSdp);
      if (!response.success) {
        throw new Error(response.error || 'Failed to accept call');
      }
      this.emit({
        type: 'state',
        callId: context.callId,
        peerId: context.peerId,
        state: 'connecting',
      });
      return { success: true };
    } catch (error: unknown) {
      const message = errStr(error, 'Failed to accept call');
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.emitMediaUpdate(context);
      this.currentCall = null;
      return { success: false, error: message };
    }
  }

  async rejectIncomingCall(
    peerId: string,
    callId: string,
    reason: 'rejected' | 'timeout' | 'offline' | 'policy' = 'rejected',
  ): Promise<{ success: boolean; error?: string }> {
    const response = await window.kiyeovoAPI.rejectCall(peerId, callId, reason);
    if (!response.success) {
      const message = response.error || 'Failed to reject call';
      return { success: false, error: message };
    }
    if (this.currentCall?.callId === callId && this.currentCall.peerId === peerId) {
      this.clearDisconnectTimer();
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.emitMediaUpdate(this.currentCall);
      this.currentCall = null;
    }
    this.emit({
      type: 'state',
      callId,
      peerId,
      state: 'ended',
      reason,
    });
    return { success: true };
  }

  async hangupCall(
    peerId: string,
    callId: string,
    reason: 'hangup' | 'disconnect' | 'failed' = 'hangup',
  ): Promise<{ success: boolean; error?: string }> {
    const matchesCurrentCall = this.currentCall?.callId === callId && this.currentCall.peerId === peerId;
    if (matchesCurrentCall && this.currentCall) {
      this.announceScreenShareStoppedBestEffort(this.currentCall, 'call-ended');
      this.clearDisconnectTimer();
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.emitMediaUpdate(this.currentCall);
      this.currentCall = null;
    }

    this.emit({
      type: 'state',
      callId,
      peerId,
      state: 'ended',
      reason,
    });

    let response: { success: boolean; error?: string | null };
    try {
      response = await window.kiyeovoAPI.hangupCall(peerId, callId, reason);
    } catch (error: unknown) {
      response = {
        success: false,
        error: errStr(error, 'Failed to hang up call'),
      };
    }

    if (!response.success) {
      const message = response.error ?? 'Failed to hang up call';
      return { success: false, error: message };
    }
    return { success: true };
  }

  getAudioControlState(): { muted: boolean; deafened: boolean } {
    return {
      muted: this.muted,
      deafened: this.deafened,
    };
  }

  getMediaStreams(): { localStream: MediaStream | null; remoteStream: MediaStream | null } {
    return {
      localStream: this.localStream,
      remoteStream: this.remoteStream,
    };
  }

  getScreenShareState(): { localState: ScreenShareLifecycleState; remoteSharing: boolean } {
    return {
      localState: this.localScreenShareState,
      remoteSharing: this.isRemoteScreenSharing,
    };
  }

  async startScreenShare(): Promise<{ success: boolean; error?: string; canceled?: boolean; unsupported?: boolean }> {
    const context = this.currentCall;
    if (!context) {
      return { success: false, error: 'No active call' };
    }

    if (this.peerConnection?.connectionState !== 'connected') {
      return { success: false, error: 'Screen sharing is available once the call is connected' };
    }

    const currentScreenShareState = this.getScreenShareState().localState;
    if (currentScreenShareState === 'starting' || currentScreenShareState === 'sharing') {
      return { success: true };
    }

    if (currentScreenShareState === 'stopping') {
      return { success: false, error: 'Screen sharing is still stopping' };
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      return { success: false, unsupported: true, error: SCREEN_SHARE_UNSUPPORTED_MESSAGE };
    }

    try {
      const support = await window.kiyeovoAPI.getScreenShareSupport();
      if (!support.success || !support.supported) {
        return {
          success: false,
          unsupported: true,
          error: support.message || support.error || SCREEN_SHARE_UNSUPPORTED_MESSAGE,
        };
      }
    } catch {
      return {
        success: false,
        unsupported: true,
        error: SCREEN_SHARE_UNSUPPORTED_MESSAGE,
      };
    }

    if (this.localScreenShareState === 'starting' || this.localScreenShareState === 'sharing') {
      return { success: true };
    }

    if (this.localScreenShareState === 'stopping') {
      return { success: false, error: 'Screen sharing is still stopping' };
    }

    const stillCurrentCallBeforePicker = this.currentCall?.callId === context.callId
      && this.currentCall.peerId === context.peerId
      && this.peerConnection?.connectionState === 'connected';
    if (!stillCurrentCallBeforePicker) {
      return { success: false, canceled: true, error: 'Call ended before screen sharing started' };
    }

    this.setLocalScreenShareState('starting', context);

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { max: 30 },
        },
        audio: false,
      });

      const latestScreenShareState = this.getScreenShareState().localState;
      const stillCurrentCall = this.currentCall?.callId === context.callId
        && this.currentCall.peerId === context.peerId
        && this.peerConnection?.connectionState === 'connected'
        && latestScreenShareState === 'starting';
      if (!stillCurrentCall) {
        stream.getTracks().forEach((track) => track.stop());
        return { success: false, canceled: true, error: 'Call ended before screen sharing started' };
      }

      const [screenTrack] = stream.getVideoTracks();
      if (!screenTrack) {
        throw new Error('No screen video track was selected');
      }

      screenTrack.contentHint = 'detail';
      screenTrack.onended = () => {
        void this.stopScreenShare('track-ended');
      };

      this.screenStream = stream;
      this.emitMediaUpdate(context);

      try {
        await this.replaceSharedVideoTrack(screenTrack, 'screen');
      } catch (replaceError: unknown) {
        this.stopScreenCaptureTracks();
        this.emitMediaUpdate(context);
        this.setLocalScreenShareState('idle', context);
        return {
          success: false,
          error: errStr(replaceError, 'Could not attach screen sharing to the call'),
        };
      }

      try {
        await this.sendScreenShareStartedSignal(context);
        this.localScreenShareAnnounced = true;
      } catch (signalError: unknown) {
        await this.restoreSharedVideoTrack(context).catch((restoreError: unknown) => {
          console.warn('[CallService] Failed to restore video sender after screen share signaling failed:', restoreError);
        });
        this.stopScreenCaptureTracks();
        this.emitMediaUpdate(context);
        this.setLocalScreenShareState('idle', context);
        return {
          success: false,
          error: errStr(signalError, 'Failed to notify remote screen sharing started'),
        };
      }

      const stillCurrentAfterSignal = this.currentCall?.callId === context.callId
        && this.currentCall.peerId === context.peerId
        && this.peerConnection?.connectionState === 'connected'
        && this.screenStream === stream
        && this.getScreenShareState().localState === 'starting';
      if (!stillCurrentAfterSignal) {
        try {
          await this.sendScreenShareStoppedSignal(context, 'call-ended');
        } catch {
          // The call is already changing state; cleanup below is the important part.
        }
        this.localScreenShareAnnounced = false;
        await this.restoreSharedVideoTrack(context).catch((restoreError: unknown) => {
          console.warn('[CallService] Failed to restore video sender after screen share race cleanup:', restoreError);
        });
        this.stopScreenCaptureTracks();
        this.emitMediaUpdate(context);
        this.setLocalScreenShareState('idle', context);
        return { success: false, canceled: true, error: 'Call ended before screen sharing started' };
      }

      this.setLocalScreenShareState('sharing', context);
      return { success: true };
    } catch (error: unknown) {
      stream?.getTracks().forEach((track) => track.stop());
      if (this.currentCall?.callId === context.callId && this.currentCall.peerId === context.peerId) {
        this.setLocalScreenShareState('idle', context);
      }

      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError')) {
        return { success: false, canceled: true, error: 'Screen sharing cancelled' };
      }

      return { success: false, error: errStr(error, 'Could not start screen sharing') };
    }
  }

  async stopScreenShare(reason: ScreenShareStopReason = 'manual'): Promise<{ success: boolean; error?: string }> {
    const context = this.currentCall;
    if (!context) {
      this.stopScreenCaptureTracks();
      this.localScreenShareState = 'idle';
      this.localScreenShareAnnounced = false;
      return { success: true };
    }

    if (this.localScreenShareState === 'idle') {
      this.stopScreenCaptureTracks();
      this.localScreenShareAnnounced = false;
      return { success: true };
    }

    const shouldAnnounceStopped = this.localScreenShareAnnounced;
    this.localScreenShareAnnounced = false;
    this.setLocalScreenShareState('stopping', context);

    try {
      await this.restoreSharedVideoTrack(context);
    } catch (error: unknown) {
      console.warn('[CallService] Failed to restore video sender while stopping screen share:', error);
    }

    this.stopScreenCaptureTracks();
    this.emitMediaUpdate(context);

    let signalError: string | null = null;
    if (shouldAnnounceStopped) {
      try {
        await this.sendScreenShareStoppedSignal(context, reason);
      } catch (error: unknown) {
        signalError = errStr(error, 'Failed to notify remote screen sharing stopped');
      }
    }

    // Phase 3 will update the WebRTC sender here.
    this.setLocalScreenShareState('idle', context);
    if (signalError) {
      console.warn('[CallService] Failed to notify remote screen sharing stopped:', signalError);
    }
    return { success: true };
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.muted;
      });
    }
    return this.muted;
  }

  toggleDeafen(): boolean {
    this.deafened = !this.deafened;
    if (this.remoteAudio) {
      this.remoteAudio.muted = this.deafened;
    }
    return this.deafened;
  }

  private applyRemoteScreenShareSignal(signal: CallSignal): void {
    if (!this.currentCall) return;
    if (
      signal.type === 'CALL_SCREEN_SHARE_STARTED'
      && (this.localScreenShareState === 'starting' || this.localScreenShareState === 'sharing')
    ) {
      console.warn('[CallService] Ignoring remote screen share STARTED while local screen sharing is active');
      return;
    }

    // Equal timestamps are allowed to apply in arrival order so same-ms STARTED/STOPPED pairs can settle correctly.
    if (this.remoteScreenShareLastSignalTs !== null && signal.timestamp < this.remoteScreenShareLastSignalTs) {
      return;
    }

    this.remoteScreenShareLastSignalTs = signal.timestamp;
    if (signal.type === 'CALL_SCREEN_SHARE_STARTED') {
      this.syncRemoteVideoReceivers(this.currentCall);
    }
    this.setRemoteScreenSharing(signal.type === 'CALL_SCREEN_SHARE_STARTED', this.currentCall);
  }

  async handleSignal(signal: CallSignal): Promise<void> {
    if (!this.currentCall) return;
    if (signal.callId !== this.currentCall.callId || signal.fromPeerId !== this.currentCall.peerId) return;

    try {
      switch (signal.type) {
        case 'CALL_ANSWER':
          if (!signal.answerSdp) return;
          this.clearRingTimeout();
          await this.setRemoteAnswerSdp(signal.answerSdp);
          this.emit({
            type: 'state',
            callId: signal.callId,
            peerId: signal.fromPeerId,
            state: 'connecting',
          });
          return;
        case 'CALL_ICE':
          await this.addRemoteIce(signal);
          return;
        case 'CALL_SCREEN_SHARE_STARTED':
        case 'CALL_SCREEN_SHARE_STOPPED':
          this.applyRemoteScreenShareSignal(signal);
          return;
        case 'CALL_REJECT':
        case 'CALL_BUSY':
        case 'CALL_END': {
          const reason = signal.reason ?? (signal.type === 'CALL_BUSY' ? 'busy' : 'hangup');
          this.clearDisconnectTimer();
          this.clearRingTimeout();
          this.closePeerConnection();
          this.stopStreams();
          this.emitMediaUpdate(this.currentCall);
          this.currentCall = null;
          this.emit({
            type: 'state',
            callId: signal.callId,
            peerId: signal.fromPeerId,
            state: 'ended',
            reason,
          });
          return;
        }
      }
    } catch (error: unknown) {
      const message = errStr(error, 'Failed to process call signal');
      this.emit({ type: 'error', message });
      if (this.currentCall) {
        await this.endCallInternal(this.currentCall, 'failed', true);
      }
    }
  }

  syncWithCoreState(event: CallStateChangedEvent): void {
    if (
      this.currentCall
      && this.currentCall.callId === event.callId
      && this.currentCall.peerId === event.peerId
      && event.state !== 'ringing_out'
    ) {
      this.clearRingTimeout();
    }

    if (event.state === 'idle' || event.state === 'ended') {
      if (this.currentCall && this.currentCall.callId === event.callId && this.currentCall.peerId === event.peerId) {
        this.clearDisconnectTimer();
        this.clearRingTimeout();
        this.closePeerConnection();
        this.stopStreams();
        this.emitMediaUpdate(this.currentCall);
        this.currentCall = null;
      }
      return;
    }

    if (!this.currentCall) {
      this.currentCall = {
        callId: event.callId,
        peerId: event.peerId,
        direction: event.direction,
        mediaType: event.mediaType ?? 'audio',
      };
    } else if (
      this.currentCall.callId === event.callId
      && this.currentCall.peerId === event.peerId
      && event.mediaType
    ) {
      this.currentCall.mediaType = event.mediaType;
    }
  }

  dispose(): void {
    this.clearDisconnectTimer();
    this.clearRingTimeout();
    this.closePeerConnection();
    this.stopStreams();
    this.currentCall = null;
    if (this.remoteAudio) {
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
  }
}

export const callService = new CallService();
