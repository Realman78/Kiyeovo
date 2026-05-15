export type DirectCallActivity = {
  callId: string;
  peerId: string;
};

export type GroupCallActivity = {
  callId: string;
  groupId: string;
};

export class CallActivityRegistry {
  private directCall: DirectCallActivity | null = null;
  private groupCall: GroupCallActivity | null = null;

  setDirectCall(activity: DirectCallActivity | null): void {
    this.directCall = activity;
  }

  setGroupCall(activity: GroupCallActivity | null): void {
    this.groupCall = activity;
  }

  getDirectCall(): DirectCallActivity | null {
    return this.directCall;
  }

  getGroupCall(): GroupCallActivity | null {
    return this.groupCall;
  }

  hasDirectCall(): boolean {
    return this.directCall !== null;
  }

  hasGroupCall(): boolean {
    return this.groupCall !== null;
  }

  canUseDirectCall(next: DirectCallActivity): { allowed: boolean; error: string | null } {
    if (this.groupCall) {
      return { allowed: false, error: 'Another call is already in progress' };
    }

    if (!this.directCall) {
      return { allowed: true, error: null };
    }

    const sameCall = this.directCall.callId === next.callId && this.directCall.peerId === next.peerId;
    return sameCall
      ? { allowed: true, error: null }
      : { allowed: false, error: 'Another call is already in progress' };
  }

  canUseGroupCall(next?: Partial<GroupCallActivity>): { allowed: boolean; error: string | null } {
    if (this.directCall) {
      return { allowed: false, error: 'Another call is already in progress' };
    }

    if (!this.groupCall) {
      return { allowed: true, error: null };
    }

    const sameCall = next?.callId && next.callId === this.groupCall.callId;
    const sameGroup = next?.groupId && next.groupId === this.groupCall.groupId;
    return sameCall || sameGroup
      ? { allowed: true, error: null }
      : { allowed: false, error: 'Another call is already in progress' };
  }
}
