import type { RtcSignalPayload } from './protocol';

/**
 * One peer-to-peer audio/video connection to the online friend, signaled
 * through the game server's WebSocket relay. Implements the "perfect
 * negotiation" pattern: both sides may (re)negotiate at any time — e.g.
 * either player toggling their camera or microphone mid-game — and offer
 * collisions resolve by the pre-agreed polite/impolite roles.
 */
export class VideoCall {
  /**
   * Fired whenever the friend's live media changes: a stream holding the
   * currently flowing tracks (camera and/or mic), or null when none remain.
   * Tracks come and go independently, so a camera toggle never cuts voice.
   */
  onRemoteMedia: ((stream: MediaStream | null) => void) | null = null;

  private readonly pc: RTCPeerConnection;
  private readonly remote = new MediaStream();
  private senders: RTCRtpSender[] = [];

  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;

  constructor(
    private readonly polite: boolean,
    iceServers: RTCIceServer[],
    private readonly sendSignal: (payload: RtcSignalPayload) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this.sendSignal({ description: this.pc.localDescription.toJSON() });
        }
      } catch (error) {
        console.warn('[rtc] negotiation failed', error);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      this.sendSignal({ candidate: candidate ? candidate.toJSON() : null });
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.pc.restartIce();
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        for (const track of this.remote.getTracks()) this.remote.removeTrack(track);
        this.notifyRemote();
      }
    };

    // Tracks are aggregated per kind: a track "mutes" when the friend stops
    // sending it (e.g. camera off) and unmutes when media flows again.
    this.pc.ontrack = ({ track }) => {
      const add = () => {
        if (!this.remote.getTracks().includes(track)) this.remote.addTrack(track);
        this.notifyRemote();
      };
      const drop = () => {
        this.remote.removeTrack(track);
        this.notifyRemote();
      };
      add();
      track.onunmute = add;
      track.onmute = drop;
      track.onended = drop;
    };
  }

  private notifyRemote(): void {
    this.onRemoteMedia?.(this.remote.getTracks().length > 0 ? this.remote : null);
  }

  /**
   * Replace what we send (any mix of camera and mic tracks); triggers
   * renegotiation in both directions.
   */
  setLocalTracks(tracks: MediaStreamTrack[]): void {
    for (const sender of this.senders) this.pc.removeTrack(sender);
    this.senders = [];
    // One grouping stream so the receiver sees camera + mic as one unit.
    const group = new MediaStream(tracks);
    for (const track of tracks) {
      this.senders.push(this.pc.addTrack(track, group));
    }
  }

  /** Feed a relayed signal from the friend into the negotiation machine. */
  async handleSignal(payload: RtcSignalPayload): Promise<void> {
    try {
      if (payload.description) {
        const description = payload.description;
        const readyForOffer =
          !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingRemoteAnswer);
        const collision = description.type === 'offer' && !readyForOffer;

        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;

        this.settingRemoteAnswer = description.type === 'answer';
        await this.pc.setRemoteDescription(description);
        this.settingRemoteAnswer = false;

        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          if (this.pc.localDescription) {
            this.sendSignal({ description: this.pc.localDescription.toJSON() });
          }
        }
      } else if (payload.candidate !== undefined) {
        try {
          await this.pc.addIceCandidate(payload.candidate ?? undefined);
        } catch (error) {
          // Candidates of an offer we deliberately ignored are expected to fail.
          if (!this.ignoreOffer) throw error;
        }
      }
    } catch (error) {
      console.warn('[rtc] signaling error', error);
    }
  }

  close(): void {
    this.pc.close();
    for (const track of this.remote.getTracks()) this.remote.removeTrack(track);
    this.notifyRemote();
  }
}
