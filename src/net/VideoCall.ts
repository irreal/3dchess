import type { RtcSignalPayload } from './protocol';

function log(...args: unknown[]): void {
  console.info('[rtc]', ...args);
}


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
  private readonly audioTransceiver: RTCRtpTransceiver;
  private readonly videoTransceiver: RTCRtpTransceiver;

  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;

  constructor(
    private readonly polite: boolean,
    iceServers: RTCIceServer[],
    private readonly sendSignal: (payload: RtcSignalPayload) => void,
  ) {
    const urls = iceServers.flatMap((server) =>
      Array.isArray(server.urls) ? server.urls : [server.urls],
    );
    const hasTurn = urls.some((url) => String(url).startsWith('turn'));
    log(
      `call created (role: ${polite ? 'polite' : 'impolite'}, ` +
        `${urls.length} ICE urls, TURN ${hasTurn ? 'available' : 'NOT available'})`,
    );

    this.pc = new RTCPeerConnection({ iceServers });

    // One fixed transceiver per kind, created before any negotiation: the
    // SDP m-line layout is identical on both sides forever, and camera/mic
    // toggles become replaceTrack calls that need no renegotiation at all.
    // (Tearing tracks down and re-adding them instead reorders m-lines and
    // miscouples crossing offers/answers — the bug this design replaces.)
    this.audioTransceiver = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.videoTransceiver = this.pc.addTransceiver('video', { direction: 'sendrecv' });

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          log('negotiation needed → sending', this.pc.localDescription.type);
          this.sendSignal({ description: this.pc.localDescription.toJSON() });
        }
      } catch (error) {
        console.warn('[rtc] negotiation failed', error);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate) log('local candidate gathering complete');
      this.sendSignal({ candidate: candidate ? candidate.toJSON() : null });
    };

    this.pc.onicegatheringstatechange = () => {
      log('ICE gathering:', this.pc.iceGatheringState);
    };

    this.pc.oniceconnectionstatechange = () => {
      log('ICE connection:', this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === 'failed') {
        log('ICE failed → restarting ICE');
        this.pc.restartIce();
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      log('connection:', state);
      if (state === 'connected') void this.logSelectedPath();
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        for (const track of this.remote.getTracks()) this.remote.removeTrack(track);
        this.notifyRemote();
      }
    };

    // Tracks are aggregated per kind: a track "mutes" when the friend stops
    // sending it (e.g. camera off) and unmutes when media flows again.
    this.pc.ontrack = ({ track }) => {
      log(`remote ${track.kind} track arrived (muted: ${track.muted})`);
      const add = () => {
        // replaceTrack(null) leaves a muted video track that still holds the
        // last decoded frame — treat it as absent so the face screen falls
        // back to the cartoon placeholder.
        if (track.kind === 'video' && track.muted) {
          drop();
          return;
        }
        if (!this.remote.getTracks().includes(track)) this.remote.addTrack(track);
        log(`remote ${track.kind} track flowing`);
        this.notifyRemote();
      };
      const drop = () => {
        this.remote.removeTrack(track);
        log(`remote ${track.kind} track stopped`);
        this.notifyRemote();
      };
      add();
      track.onunmute = add;
      track.onmute = drop;
      track.onended = drop;
    };
  }

  /** Log whether the media flows directly or relayed through TURN. */
  private async logSelectedPath(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      stats.forEach((report: Record<string, unknown>) => {
        if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated)
          return;
        const local = stats.get(report.localCandidateId as string) as
          | Record<string, unknown>
          | undefined;
        const remote = stats.get(report.remoteCandidateId as string) as
          | Record<string, unknown>
          | undefined;
        const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        log(
          `media path: ${String(local?.candidateType)} ↔ ${String(remote?.candidateType)}` +
            (relayed ? ' (relayed through TURN)' : ' (direct P2P)'),
        );
      });
    } catch {
      // Stats are diagnostic only.
    }
  }

  private notifyRemote(): void {
    for (const track of [...this.remote.getTracks()]) {
      if (track.readyState === 'ended' || (track.kind === 'video' && track.muted)) {
        this.remote.removeTrack(track);
      }
    }
    this.onRemoteMedia?.(this.remote.getTracks().length > 0 ? this.remote : null);
  }

  /**
   * Replace what we send (any mix of camera and mic tracks). After the
   * initial handshake this is pure replaceTrack — instant, no renegotiation.
   */
  setLocalTracks(tracks: MediaStreamTrack[]): void {
    log('sending local tracks:', tracks.map((track) => track.kind).join(', ') || '(none)');
    const audio = tracks.find((track) => track.kind === 'audio') ?? null;
    const video = tracks.find((track) => track.kind === 'video') ?? null;
    void this.audioTransceiver.sender
      .replaceTrack(audio)
      .catch((error) => console.warn('[rtc] audio replaceTrack failed', error));
    void this.videoTransceiver.sender
      .replaceTrack(video)
      .catch((error) => console.warn('[rtc] video replaceTrack failed', error));
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
        if (this.ignoreOffer) {
          log('offer collision → ignoring (impolite side)');
          return;
        }

        log('received', description.type);
        this.settingRemoteAnswer = description.type === 'answer';
        await this.pc.setRemoteDescription(description);
        this.settingRemoteAnswer = false;

        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          if (this.pc.localDescription) {
            log('sending', this.pc.localDescription.type);
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
