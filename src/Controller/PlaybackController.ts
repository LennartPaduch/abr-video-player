import { eventBus, Payload } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { AudioRepresentation, VideoRepresentation } from "../Types.js";
import { video } from "../Video.js";

export class PlaybackController {
  #currentVideoRepresentation: VideoRepresentation | null = null;
  #currentAudioRepresentation: AudioRepresentation | null = null;

  constructor() {
    eventBus.on(
      Events.VIDEO_BITRATE_CHANGED,
      this.#onVideoBitrateChanged,
      this,
      { priority: 5000 }
    );

    eventBus.on(
      Events.AUDIO_BITRATE_CHANGED,
      this.#onAudioBitrateChanged,
      this,
      { priority: 5000 }
    );

    eventBus.on(
      Events.TOGGLE_PLAYBACK_REQUESTED,
      this.#onTogglePlaybackRequest,
      this
    );
  }

  #onAudioBitrateChanged = (payload: Payload): void => {
    if (!payload.audioRepresentation)
      throw new Error("Payload doesn't contain audio representation data!");
    this.#currentAudioRepresentation = payload.audioRepresentation;
  };

  #onVideoBitrateChanged = (payload: Payload): void => {
    if (!payload.videoRepresentation)
      throw new Error("Payload doesn't contain video representation data!");
    this.#currentVideoRepresentation = payload.videoRepresentation;
  };

  #onTogglePlaybackRequest = async (): Promise<void> => {
    if (video.isPaused()) {
      await video.play();
    } else {
      video.pause();
    }
  };

  isPaused = (): boolean => {
    return video.isPaused();
  };

  getTime = (): number => {
    return video.getTime();
  };

  getDuration = (): number => {
    return video.getDuration();
  };

  // TODO not always 0?
  getStartTime = (): number => {
    return 0;
  };

  isSeeking = (): boolean => {
    return video.isSeeking();
  };

  getCurrentAudioRepresentation = (): AudioRepresentation => {
    if (!this.#currentAudioRepresentation)
      throw new Error("Current Audio representation not set.");
    return this.#currentAudioRepresentation;
  };

  getCurrentVideoRepresentation = (): VideoRepresentation => {
    if (!this.#currentVideoRepresentation)
      throw new Error("Current Video representation not set.");
    return this.#currentVideoRepresentation;
  };

  getTimeToStreamEnd = (): number => {
    return video.getDuration() - video.getTime();
  };

  getStreamEndTime = (): number => {
    return video.getDuration(); // TODO
  };
}

export const playbackController = new PlaybackController();
