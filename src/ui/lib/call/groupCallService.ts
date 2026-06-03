import type {
  AdmissionToken,
  GroupCallControlSignalForRenderer,
  GroupCallPairSignalForRenderer,
  GroupCallRole,
  GroupCallStateChangedEvent,
  GroupCallParticipant,
  IceServerConfig,
} from '../../../core/types';
import { DEFAULT_WEBRTC_ICE_SERVERS } from '../../../core/network/default-infrastructure';
import { errStr } from '../../../core/utils/general-error';
import { log } from '../../../shared/logger';

export type GroupCallSnapshot = {
  chatId: number | null;
  groupId: string;
  callId: string;
  role: GroupCallRole | null;
  coreState: Exclude<GroupCallStateChangedEvent['state'], 'idle' | 'ended'>;
  state: 'idle' | 'joining' | 'waiting' | 'active' | 'ended';
  writerPeerId: string | null;
  localPeerId: string | null;
  participants: GroupCallParticipant[];
  participantPeerIds: string[];
  connectedPeerIds: string[];
  pendingDisconnects: { peerId: string; expiresAt: number }[];
  localMuted: boolean;
  recoveryFailed: boolean;
};

type GroupCallServiceEvent =
  | {
    type: 'state';
    previousState: GroupCallServiceState;
    snapshot: GroupCallSnapshot;
  }
  | {
    type: 'error';
    message: string;
  };

type GroupCallServiceState = GroupCallSnapshot['state'];

type JoinConnectContext = 'join' | 'writer_probe' | 'writer_recover';

type GroupCallSession = {
  chatId: number | null;
  groupId: string;
  callId: string;
  role: GroupCallRole | null;
  coreState: Exclude<GroupCallStateChangedEvent['state'], 'idle' | 'ended'>;
  writerPeerId: string | null;
  participants: GroupCallParticipant[];
  participantPeerIds: string[];
  pendingDisconnects: { peerId: string; expiresAt: number }[];
  recoveryFailed: boolean;
};

type PendingJoinAdmission = {
  groupId: string;
  callId: string;
  participants: GroupCallParticipant[];
  admissionToken: AdmissionToken;
};

type PeerState = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  remoteAudio: HTMLAudioElement;
  pendingRemoteIce: RTCIceCandidateInit[];
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  connected: boolean;
};

const PEER_DISCONNECT_GRACE_MS = 5_000;
const JOIN_AUDIO_CONNECT_TIMEOUT_MS = 15_000;

class GroupCallService {
  private session: GroupCallSession | null = null;
  private localPeerId: string | null = null;
  private localAudioStream: MediaStream | null = null;
  private localAudioStreamPromise: Promise<MediaStream> | null = null;
  private readonly listeners = new Set<(event: GroupCallServiceEvent) => void>();
  private readonly peers = new Map<string, PeerState>();
  private readonly pendingIceByPeerId = new Map<string, RTCIceCandidateInit[]>();
  private readonly offeredPeerIds = new Set<string>();
  private pendingJoinAdmission: PendingJoinAdmission | null = null;
  private joinConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private joinConnectContext: JoinConnectContext | null = null;
  private writerReconnectProbeInProgress = false;
  private lastEmittedState: GroupCallServiceState = 'idle';
  private lastSnapshotSignature = '';
  private iceServers: RTCIceServer[] = DEFAULT_WEBRTC_ICE_SERVERS.map((server) => ({ ...server }));
  private iceServersRefreshPromise: Promise<void> | null = null;
  private localMuted = false;
  private lastTransportResetAt = 0;
  private readonly LOCAL_RECOVERY_OFFER_TOAST_SUPPRESSION_MS = 30_000;

  subscribe(listener: (event: GroupCallServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: GroupCallServiceEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  private emitError(message: string): void {
    this.emit({ type: 'error', message });
  }

  private connectedPeerCount(): number {
    return this.connectedPeerIds().length;
  }

  private connectedPeerIds(): string[] {
    const connected: string[] = [];
    this.peers.forEach((peer, peerId) => {
      if (peer.connected) {
        connected.push(peerId);
      }
    });
    return connected.sort();
  }

  private computeState(): GroupCallServiceState {
    if (!this.session) {
      return 'idle';
    }
    if (this.connectedPeerCount() > 0) {
      return 'active';
    }
    if (this.session.coreState === 'joining') {
      return 'joining';
    }
    return 'waiting';
  }

  private buildSnapshot(): GroupCallSnapshot {
    if (!this.session) {
      return {
        chatId: null,
        groupId: '',
        callId: '',
        role: null,
        coreState: 'waiting',
        state: 'idle',
        writerPeerId: null,
        localPeerId: this.localPeerId,
        participants: [],
        participantPeerIds: [],
        connectedPeerIds: [],
        pendingDisconnects: [],
        localMuted: this.localMuted,
        recoveryFailed: false,
      };
    }

    return {
      chatId: this.session.chatId,
      groupId: this.session.groupId,
      callId: this.session.callId,
      role: this.session.role,
      coreState: this.session.coreState,
      state: this.computeState(),
      writerPeerId: this.session.writerPeerId,
      localPeerId: this.localPeerId,
      participants: [...this.session.participants],
      participantPeerIds: [...this.session.participantPeerIds],
      connectedPeerIds: this.connectedPeerIds(),
      pendingDisconnects: [...this.session.pendingDisconnects],
      localMuted: this.localMuted,
      recoveryFailed: this.session.recoveryFailed,
    };
  }

  private snapshotSignature(snapshot: GroupCallSnapshot): string {
    return JSON.stringify(snapshot);
  }

  getSnapshot(): GroupCallSnapshot {
    return this.buildSnapshot();
  }

  private emitState(force = false): void {
    const previousState = this.lastEmittedState;
    const snapshot = this.buildSnapshot();
    const signature = this.snapshotSignature(snapshot);
    if (!force && signature === this.lastSnapshotSignature) {
      return;
    }

    this.lastSnapshotSignature = signature;
    this.lastEmittedState = snapshot.state;
    this.emit({
      type: 'state',
      previousState,
      snapshot,
    });
  }

  private toRtcIceServers(servers: IceServerConfig[]): RTCIceServer[] {
    return servers.map((server) => ({
      urls: server.url,
      username: server.username,
      credential: server.credential,
    }));
  }

  private async refreshIceServers(): Promise<void> {
    try {
      const result = await window.kiyeovoAPI.getIceServers();
      if (!result.success) {
        return;
      }
      this.iceServers = this.toRtcIceServers(result.servers);
    } catch {
      // Keep the last-known/default ICE list.
    }
  }

  private queueIceServerRefresh(): void {
    if (this.iceServersRefreshPromise) {
      return;
    }
    this.iceServersRefreshPromise = this.refreshIceServers()
      .finally(() => {
        this.iceServersRefreshPromise = null;
      });
  }

  private getIceServers(): RTCIceServer[] {
    return this.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    }));
  }

  private clearJoinConnectTimer(): void {
    if (!this.joinConnectTimer) {
      return;
    }
    clearTimeout(this.joinConnectTimer);
    this.joinConnectTimer = null;
    this.joinConnectContext = null;
    this.writerReconnectProbeInProgress = false;
  }

  private scheduleJoinConnectTimeout(callId: string, context: JoinConnectContext): void {
    this.clearJoinConnectTimer();
    this.joinConnectContext = context;
    this.joinConnectTimer = setTimeout(() => {
      const timeoutContext = this.joinConnectContext;
      this.joinConnectTimer = null;
      this.joinConnectContext = null;
      this.writerReconnectProbeInProgress = false;
      if (!this.session || this.session.callId !== callId) {
        return;
      }
      if (this.connectedPeerCount() > 0) {
        return;
      }
      if (timeoutContext === 'writer_probe') {
        return;
      }
      if (timeoutContext === 'writer_recover' && this.session.role === 'writer' && this.session.chatId !== null) {
        void this.fallbackWriterRecovery(this.session.chatId);
        return;
      }
      this.emitError('Could not connect to any group call participants');
    }, context === 'writer_recover' ? 10_000 : JOIN_AUDIO_CONNECT_TIMEOUT_MS);
  }

  private async fallbackWriterRecovery(chatId: number): Promise<void> {
    const result = await window.kiyeovoAPI.fallbackGroupCallWriterRecovery(chatId);
    if (result.success) {
      return;
    }
    this.emitError(result.error || 'Could not reconnect to any group call participants');
  }

  private stopLocalAudio(): void {
    this.localAudioStreamPromise = null;
    if (!this.localAudioStream) {
      return;
    }
    this.localAudioStream.getTracks().forEach((track) => track.stop());
    this.localAudioStream = null;
  }

  private async ensureLocalAudioStream(): Promise<MediaStream> {
    if (this.localAudioStream) {
      return this.localAudioStream;
    }
    if (!this.localAudioStreamPromise) {
      this.localAudioStreamPromise = navigator.mediaDevices
        .getUserMedia({ audio: true, video: false })
        .then((stream) => {
          this.localAudioStream = stream;
          return stream;
        })
        .finally(() => {
          this.localAudioStreamPromise = null;
        });
    }
    return this.localAudioStreamPromise;
  }

  async prepareLocalAudio(): Promise<{ success: boolean; error: string | null }> {
    try {
      await this.ensureLocalAudioStream();
      return { success: true, error: null };
    } catch (error: unknown) {
      return {
        success: false,
        error: errStr(error, 'Microphone access is required for group calls'),
      };
    }
  }

  releasePreparedLocalAudio(): void {
    if (this.session) {
      return;
    }
    this.stopLocalAudio();
  }

  private attachRemoteAudio(peer: PeerState): void {
    peer.remoteAudio.srcObject = peer.remoteStream;
    void peer.remoteAudio.play().catch(() => {
      // Playback may wait for Chromium/Electron autoplay allowance.
    });
  }

  private createRemoteAudioElement(): HTMLAudioElement {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', 'true');
    audio.style.display = 'none';
    document.body.appendChild(audio);
    return audio;
  }

  private clearPeerDisconnectTimer(peer: PeerState): void {
    if (!peer.disconnectTimer) {
      return;
    }
    clearTimeout(peer.disconnectTimer);
    peer.disconnectTimer = null;
  }

  private schedulePeerDisconnect(peerId: string, peer: PeerState): void {
    this.clearPeerDisconnectTimer(peer);
    peer.disconnectTimer = setTimeout(() => {
      this.closePeer(peerId);
      this.emitState();
    }, PEER_DISCONNECT_GRACE_MS);
  }

  private closePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }

    this.clearPeerDisconnectTimer(peer);
    try {
      peer.pc.close();
    } catch {
      // Best-effort close.
    }
    peer.remoteAudio.srcObject = null;
    peer.remoteAudio.remove();
    peer.remoteStream.getTracks().forEach((track) => track.stop());
    this.peers.delete(peerId);
  }

  private resetSession(): void {
    this.clearJoinConnectTimer();
    this.pendingJoinAdmission = null;
    this.peers.forEach((_, peerId) => {
      this.closePeer(peerId);
    });
    this.peers.clear();
    this.pendingIceByPeerId.clear();
    this.offeredPeerIds.clear();
    this.stopLocalAudio();
    this.session = null;
    this.localPeerId = null;
    this.localMuted = false;
    this.emitState(true);
  }

  private resetTransportForRecovery(): void {
    this.clearJoinConnectTimer();
    this.pendingJoinAdmission = null;
    this.peers.forEach((_, peerId) => {
      this.closePeer(peerId);
    });
    this.peers.clear();
    this.pendingIceByPeerId.clear();
    this.offeredPeerIds.clear();
    this.writerReconnectProbeInProgress = false;
    this.queueIceServerRefresh();
    if (this.session) {
      this.session.recoveryFailed = false;
    }
    this.lastTransportResetAt = Date.now();
  }

  private async createPeer(peerId: string): Promise<PeerState> {
    if (this.iceServersRefreshPromise) {
      await this.iceServersRefreshPromise;
    }

    const remoteStream = new MediaStream();
    const remoteAudio = this.createRemoteAudioElement();
    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(),
      iceTransportPolicy: 'all',
    });

    const peer: PeerState = {
      pc,
      remoteStream,
      remoteAudio,
      pendingRemoteIce: this.pendingIceByPeerId.get(peerId) ?? [],
      disconnectTimer: null,
      connected: false,
    };
    this.pendingIceByPeerId.delete(peerId);

    pc.onicecandidate = (event) => {
      if (!event.candidate || !this.session) {
        return;
      }

      void window.kiyeovoAPI.sendGroupCallPairSignal({
        type: 'CALL_ICE',
        groupId: this.session.groupId,
        callId: this.session.callId,
        toPeerId: peerId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
        usernameFragment: event.candidate.usernameFragment ?? null,
      }).then((result) => {
        if (!result.success) {
          log(`[GROUP-CALL][PAIR][ICE_SEND_FAIL] to=${peerId.slice(-8)} reason=${result.error || 'Failed to send group call ICE candidate'}`);
        }
      }).catch((error: unknown) => {
        log(`[GROUP-CALL][PAIR][ICE_SEND_FAIL] to=${peerId.slice(-8)} reason=${errStr(error, 'Failed to send group call ICE candidate')}`);
      });
    };

    pc.ontrack = (event) => {
      if (event.streams.length === 0) {
        if (!peer.remoteStream.getTracks().some((track) => track.id === event.track.id)) {
          peer.remoteStream.addTrack(event.track);
        }
      } else {
        event.streams.forEach((stream) => {
          stream.getTracks().forEach((track) => {
            if (!peer.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
              peer.remoteStream.addTrack(track);
            }
          });
        });
      }
      this.attachRemoteAudio(peer);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        peer.connected = true;
        if (this.session) {
          this.session.recoveryFailed = false;
        }
        this.clearPeerDisconnectTimer(peer);
        this.clearJoinConnectTimer();
        this.emitState();
        return;
      }
      if (state === 'disconnected') {
        peer.connected = false;
        this.schedulePeerDisconnect(peerId, peer);
        this.emitState();
        return;
      }
      if (state === 'failed' || state === 'closed') {
        peer.connected = false;
        this.closePeer(peerId);
        this.emitState();
      }
    };

    this.peers.set(peerId, peer);
    return peer;
  }

  private async ensurePeer(peerId: string, replace = false): Promise<PeerState> {
    const existing = this.peers.get(peerId);
    if (existing && !replace) {
      return existing;
    }
    if (existing) {
      this.closePeer(peerId);
    }
    return this.createPeer(peerId);
  }

  private async addLocalTracks(peer: PeerState): Promise<void> {
    const stream = await this.ensureLocalAudioStream();
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('Local microphone track is not available');
    }
    audioTrack.enabled = !this.localMuted;
    const alreadyAdded = peer.pc.getSenders().some((sender) => sender.track?.id === audioTrack.id);
    if (!alreadyAdded) {
      peer.pc.addTrack(audioTrack, stream);
    }
  }

  private async flushPendingIce(peer: PeerState): Promise<void> {
    if (!peer.pc.remoteDescription || peer.pendingRemoteIce.length === 0) {
      return;
    }
    const queued = [...peer.pendingRemoteIce];
    peer.pendingRemoteIce = [];
    for (const candidate of queued) {
      await peer.pc.addIceCandidate(candidate);
    }
  }

  private queueIce(peerId: string, candidate: RTCIceCandidateInit): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.pendingRemoteIce.push(candidate);
      return;
    }
    const queued = this.pendingIceByPeerId.get(peerId) ?? [];
    queued.push(candidate);
    this.pendingIceByPeerId.set(peerId, queued);
  }

  private async startOffersForParticipants(
    participants: GroupCallParticipant[],
    admissionToken?: AdmissionToken,
  ): Promise<void> {
    if (!this.session || !this.localPeerId) {
      return;
    }

    const targets = participants
      .map((participant) => participant.peerId)
      .filter((peerId) => peerId !== this.localPeerId);
    if (targets.length === 0) {
      return;
    }

    this.scheduleJoinConnectTimeout(this.session.callId, 'join');
    await Promise.allSettled(targets.map(async (peerId) => {
      if (this.offeredPeerIds.has(peerId)) {
        return;
      }
      this.offeredPeerIds.add(peerId);
      await this.createOfferForPeer(peerId, admissionToken);
    }));
  }

  private maybeStartPendingJoinAdmission(): void {
    if (!this.session || !this.pendingJoinAdmission) {
      return;
    }
    if (
      this.pendingJoinAdmission.groupId !== this.session.groupId
      || this.pendingJoinAdmission.callId !== this.session.callId
    ) {
      this.pendingJoinAdmission = null;
      return;
    }
    if (this.session.coreState === 'joining') {
      return;
    }

    const pendingAdmission = this.pendingJoinAdmission;
    this.pendingJoinAdmission = null;
    void this.startOffersForParticipants(pendingAdmission.participants, pendingAdmission.admissionToken);
  }

  private reconcilePeersWithAuthoritativeRoster(participantPeerIds: string[]): void {
    const allowedPeerIds = new Set(
      participantPeerIds.filter((peerId) => peerId !== this.localPeerId),
    );
    this.peers.forEach((_, peerId) => {
      if (!allowedPeerIds.has(peerId)) {
        this.closePeer(peerId);
      }
    });
  }

  private async startWriterReconnectProbe(peerId: string): Promise<void> {
    if (!this.session || this.session.role !== 'writer' || this.writerReconnectProbeInProgress || !this.localPeerId) {
      return;
    }
    if (peerId === this.localPeerId || !this.session.participantPeerIds.includes(peerId)) {
      return;
    }

    this.writerReconnectProbeInProgress = true;
    this.offeredPeerIds.delete(peerId);
    this.scheduleJoinConnectTimeout(this.session.callId, 'writer_probe');
    await this.createOfferForPeer(peerId, undefined, true);
  }

  private async startWriterRecoveryProbe(): Promise<void> {
    if (!this.session || this.session.role !== 'writer' || this.writerReconnectProbeInProgress || !this.localPeerId) {
      return;
    }

    const targets = this.session.participantPeerIds
      .filter((peerId) => peerId !== this.localPeerId);
    if (targets.length === 0) {
      return;
    }

    this.writerReconnectProbeInProgress = true;
    targets.forEach((peerId) => {
      this.offeredPeerIds.delete(peerId);
    });
    this.scheduleJoinConnectTimeout(this.session.callId, 'writer_recover');
    await Promise.allSettled(targets.map(async (peerId) => {
      await this.createOfferForPeer(peerId, undefined, true);
    }));
  }

  private async createOfferForPeer(
    peerId: string,
    admissionToken?: AdmissionToken,
    replace = false,
  ): Promise<void> {
    if (!this.session) {
      return;
    }

    try {
      const peer = await this.ensurePeer(peerId, replace);
      await this.addLocalTracks(peer);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      const offerSdp = peer.pc.localDescription?.sdp;
      if (!offerSdp) {
        throw new Error('Failed to create group call offer');
      }

      const response = await window.kiyeovoAPI.sendGroupCallPairSignal({
        type: 'CALL_OFFER',
        groupId: this.session.groupId,
        callId: this.session.callId,
        toPeerId: peerId,
        offerSdp,
        mediaType: 'audio',
        admissionToken,
      });
      if (!response.success) {
        throw new Error(response.error || 'Failed to send group call offer');
      }
    } catch (error: unknown) {
      this.closePeer(peerId);
      const sinceTransportReset = Date.now() - this.lastTransportResetAt;
      if (this.lastTransportResetAt > 0 && sinceTransportReset < this.LOCAL_RECOVERY_OFFER_TOAST_SUPPRESSION_MS) {
        // We're inside a recovery window — OFFER failures are expected while
        // libp2p rebuilds its connections. Log only, don't toast.
        log(`[GROUP-CALL][PAIR][OFFER_SEND_FAIL] to=${peerId.slice(-8)} reason=${errStr(error, 'Failed to start group call audio negotiation')} suppressed=local_recovery sinceMs=${sinceTransportReset}`);
        return;
      }
      this.emitError(errStr(error, 'Failed to start group call audio negotiation'));
    }
  }

  private async handleIncomingOffer(signal: Extract<GroupCallPairSignalForRenderer, { type: 'CALL_OFFER' }>): Promise<void> {
    if (!this.session) {
      return;
    }

    const existing = this.peers.get(signal.fromPeerId);
    if (existing?.connected) {
      return;
    }

    try {
      const peer = await this.ensurePeer(signal.fromPeerId, Boolean(existing));
      await peer.pc.setRemoteDescription({
        type: 'offer',
        sdp: signal.offerSdp,
      });
      await this.flushPendingIce(peer);
      await this.addLocalTracks(peer);

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      const answerSdp = peer.pc.localDescription?.sdp;
      if (!answerSdp) {
        throw new Error('Failed to create group call answer');
      }

      const response = await window.kiyeovoAPI.sendGroupCallPairSignal({
        type: 'CALL_ANSWER',
        groupId: this.session.groupId,
        callId: this.session.callId,
        toPeerId: signal.fromPeerId,
        answerSdp,
      });
      if (!response.success) {
        throw new Error(response.error || 'Failed to send group call answer');
      }
    } catch (error: unknown) {
      this.closePeer(signal.fromPeerId);
      this.emitError(errStr(error, 'Failed to accept group call audio offer'));
    }
  }

  private async handleIncomingAnswer(signal: Extract<GroupCallPairSignalForRenderer, { type: 'CALL_ANSWER' }>): Promise<void> {
    const peer = this.peers.get(signal.fromPeerId);
    if (!peer) {
      return;
    }

    try {
      await peer.pc.setRemoteDescription({
        type: 'answer',
        sdp: signal.answerSdp,
      });
      await this.flushPendingIce(peer);
    } catch (error: unknown) {
      this.closePeer(signal.fromPeerId);
      this.emitError(errStr(error, 'Failed to apply group call answer'));
    }
  }

  private async handleIncomingIce(signal: Extract<GroupCallPairSignalForRenderer, { type: 'CALL_ICE' }>): Promise<void> {
    const candidate: RTCIceCandidateInit = {
      candidate: signal.candidate,
      sdpMid: signal.sdpMid ?? null,
      sdpMLineIndex: signal.sdpMLineIndex ?? null,
      usernameFragment: signal.usernameFragment ?? null,
    };

    const peer = this.peers.get(signal.fromPeerId);
    if (!peer || !peer.pc.remoteDescription) {
      this.queueIce(signal.fromPeerId, candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (error: unknown) {
      this.emitError(errStr(error, 'Failed to apply group call ICE candidate'));
    }
  }

  syncWithCoreState(event: GroupCallStateChangedEvent): void {
    if (event.state === 'idle') {
      return;
    }

    if (event.state === 'ended') {
      if (
        this.session
        && this.session.groupId === event.groupId
        && this.session.callId === event.callId
      ) {
        this.resetSession();
        this.emit({
          type: 'state',
          previousState: this.lastEmittedState,
          snapshot: {
            chatId: event.chatId,
            groupId: event.groupId,
            callId: event.callId ?? '',
            role: event.role,
            coreState: 'waiting',
            state: 'ended',
            writerPeerId: event.writerPeerId ?? null,
            localPeerId: this.localPeerId,
            participants: event.participants ?? [],
            participantPeerIds: event.participants?.map((participant) => participant.peerId) ?? [],
            connectedPeerIds: [],
            pendingDisconnects: [],
            localMuted: false,
            recoveryFailed: false,
          },
        });
        this.lastEmittedState = 'ended';
      }
      return;
    }

    const isSameSession = this.session
      && this.session.groupId === event.groupId
      && this.session.callId === event.callId;

    if (!isSameSession) {
      this.resetSession();
      if (!event.callId) {
        return;
      }
      this.session = {
        chatId: event.chatId,
        groupId: event.groupId,
        callId: event.callId,
        role: event.role,
        coreState: event.state,
        writerPeerId: event.writerPeerId ?? null,
        participants: event.participants ?? [],
        participantPeerIds: event.participants?.map((participant) => participant.peerId) ?? [],
        pendingDisconnects: event.pendingDisconnects ?? [],
        recoveryFailed: event.reason === 'recovery_failed',
      };
      if (event.role === 'writer' && event.writerPeerId) {
        this.localPeerId = event.writerPeerId;
      }
      this.queueIceServerRefresh();
      if (event.reason === 'transport_reset') {
        this.resetTransportForRecovery();
        if (this.session.role === 'writer') {
          void this.startWriterRecoveryProbe();
        }
      }
      if (event.reason === 'writer_reconnect_recover' && this.session.role === 'writer') {
        void this.startWriterRecoveryProbe();
      }
      this.emitState(true);
      return;
    }

    const currentSession = this.session;
    if (!currentSession) {
      return;
    }
    currentSession.chatId = event.chatId;
    currentSession.role = event.role;
    currentSession.coreState = event.state;
    if (event.writerPeerId) {
      currentSession.writerPeerId = event.writerPeerId;
      if (event.role === 'writer') {
        this.localPeerId = event.writerPeerId;
      }
    }
    if (event.participants) {
      currentSession.participants = event.participants;
      const nextParticipantPeerIds = event.participants.map((participant) => participant.peerId);
      this.reconcilePeersWithAuthoritativeRoster(nextParticipantPeerIds);
      currentSession.participantPeerIds = nextParticipantPeerIds;
    }
    if (event.pendingDisconnects) {
      currentSession.pendingDisconnects = event.pendingDisconnects;
    }
    if (event.reason === 'recovery_failed') {
      currentSession.recoveryFailed = true;
    } else if (
      event.reason === 'transport_reset'
      || event.reason === 'writer_reconnect_recover'
      || event.reason === 'joined'
    ) {
      currentSession.recoveryFailed = false;
    }
    if (event.reason === 'transport_reset') {
      this.resetTransportForRecovery();
      if (currentSession.role === 'writer') {
        void this.startWriterRecoveryProbe();
      }
    }
    if (event.reason === 'writer_reconnect_recover' && currentSession.role === 'writer') {
      void this.startWriterRecoveryProbe();
    }
    if (event.reason === 'writer_reconnect_probe' && currentSession.role === 'writer' && event.peerId) {
      void this.startWriterReconnectProbe(event.peerId);
    }
    this.maybeStartPendingJoinAdmission();
    this.emitState();
  }

  async handleControlSignal(signal: GroupCallControlSignalForRenderer): Promise<void> {
    if (!this.session || signal.groupId !== this.session.groupId) {
      return;
    }
    if ('callId' in signal && signal.callId !== this.session.callId) {
      return;
    }
    if ('toPeerId' in signal) {
      this.localPeerId = signal.toPeerId;
    }

    if (signal.type === 'CALL_GROUP_JOIN_RESPONSE' && signal.accepted) {
      // Core still decides whether this response is accepted; the renderer only keeps the token payload ready.
      this.pendingJoinAdmission = {
        groupId: signal.groupId,
        callId: signal.callId,
        participants: signal.participants,
        admissionToken: signal.admissionToken,
      };
      this.maybeStartPendingJoinAdmission();
      return;
    }
  }

  async toggleMute(): Promise<{ success: boolean; error: string | null }> {
    try {
      const stream = await this.ensureLocalAudioStream();
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        return { success: false, error: 'Local microphone track is not available' };
      }
      this.localMuted = !this.localMuted;
      audioTrack.enabled = !this.localMuted;
      this.emitState();
      return { success: true, error: null };
    } catch (error: unknown) {
      return {
        success: false,
        error: errStr(error, 'Failed to update group call microphone state'),
      };
    }
  }

  async leave(): Promise<{ success: boolean; error: string | null }> {
    if (!this.session || this.session.chatId === null) {
      return { success: false, error: 'No active group call' };
    }
    return window.kiyeovoAPI.leaveGroupCall(this.session.chatId);
  }

  async handlePairSignal(signal: GroupCallPairSignalForRenderer): Promise<void> {
    if (!this.session) {
      return;
    }
    if (signal.groupId !== this.session.groupId || signal.callId !== this.session.callId) {
      return;
    }

    this.localPeerId = signal.toPeerId;

    switch (signal.type) {
      case 'CALL_OFFER':
        await this.handleIncomingOffer(signal);
        return;
      case 'CALL_ANSWER':
        await this.handleIncomingAnswer(signal);
        return;
      case 'CALL_ICE':
        await this.handleIncomingIce(signal);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.resetSession();
    this.listeners.clear();
  }
}

export const groupCallService = new GroupCallService();
