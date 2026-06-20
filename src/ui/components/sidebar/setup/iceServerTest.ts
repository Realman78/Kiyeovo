import type { IceServerConfig } from '../../../../core/types';
import type { IceTestStatus } from '../../../types';

export type IceTestResult = {
  status: IceTestStatus;
  detail?: string;
};


const ICE_TEST_TIMEOUT_MS = 5000;
const TURN_UNAUTHORIZED_ERROR_CODE = 401;

function toRtcIceServer(config: IceServerConfig): RTCIceServer {
  if (config.type === 'stun') {
    return { urls: config.url };
  }
  return { urls: config.url, username: config.username, credential: config.credential };
}

/**
 * What a `reachable` result means:
 *   - STUN: the server returned a server-reflexive (`srflx`) address.
 *   - TURN: a relay *allocation* succeeded (a `relay` candidate was gathered).
 *     This proves the server is reachable and the credentials were accepted; it
 *     does NOT prove media will actually relay end-to-end — that would require
 *     two peer connections exchanging data over relay-only candidates.
 *
 * Caveats handled below:
 *   - A working STUN server can legitimately surface no `srflx` candidate when
 *     the client already has a public address: ICE drops it as redundant with
 *     the host candidate (RFC 8445). With no candidate AND no error we report
 *     `indeterminate` instead of a false `unreachable`.
 *   - A TURN `401` on `icecandidateerror` is reported as `invalid_credentials`.
 */
export async function testIceServer(config: IceServerConfig): Promise<IceTestResult> {
  const isTurn = config.type !== 'stun';

  let pc: RTCPeerConnection;
  try {
    pc = new RTCPeerConnection({
      iceServers: [toRtcIceServer(config)],
      iceTransportPolicy: isTurn ? 'relay' : 'all',
    });
  } catch (error) {
    return { status: 'unreachable', detail: error instanceof Error ? error.message : undefined };
  }

  return new Promise<IceTestResult>((resolve) => {
    let settled = false;
    let authFailed = false;
    let sawError = false;
    let lastErrorText: string | undefined;

    const finish = (result: IceTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch { }
      resolve(result);
    };

    // Reached when the decisive candidate never arrived
    const resolveExhausted = () => {
      if (isTurn) {
        finish(authFailed
          ? { status: 'invalid_credentials', detail: lastErrorText }
          : { status: 'unreachable', detail: lastErrorText });
        return;
      }

      finish(sawError
        ? { status: 'unreachable', detail: lastErrorText }
        : {
            status: 'indeterminate',
            detail: 'You may already have a public address, or the server is unreachable.',
          });
    };

    const timer = setTimeout(resolveExhausted, ICE_TEST_TIMEOUT_MS);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate) return;
      const succeeds = isTurn ? candidate.type === 'relay' : candidate.type === 'srflx';
      if (succeeds) {
        finish({ status: 'reachable' });
      }
    };

    pc.onicecandidateerror = (event) => {
      sawError = true;
      lastErrorText = event.errorText || lastErrorText;
      if (event.errorCode === TURN_UNAUTHORIZED_ERROR_CODE) {
        authFailed = true;
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        resolveExhausted();
      }
    };

    // Starting gathering can throw synchronously
    try {
      pc.createDataChannel('ice-test');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch((error) => finish({
          status: 'unreachable',
          detail: error instanceof Error ? error.message : undefined,
        }));
    } catch (error) {
      finish({ status: 'unreachable', detail: error instanceof Error ? error.message : undefined });
    }
  });
}
