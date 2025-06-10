import { eventBus, Payload } from "./Events/EventBus.js";
import { Events } from "./Events/Events.js";
import { logger } from "./Logger.js";
import { MediaPlayerEvents } from "./Events/MediaPlayerEvents.js";
import { Assert } from "./utils/assertion.js";
import { VideoRepresentation } from "./Types.js";
import {
  audioBufferController,
  bufferController,
} from "./Controller/BufferController.js";

export class Video {
  #logger = logger.createChild("Video");
  #element: HTMLVideoElement = document.getElementById(
    "video"
  ) as HTMLVideoElement;
  #currentVideoRepresentation: VideoRepresentation | null = null;
  #currentResolution: string = "";
  #currentFps: number = 0;
  #resizeObserver: ResizeObserver | null = null;
  #isMetadataLoaded: boolean = false;
  readonly #autoplay = false;

  constructor() {
    Assert.assertDefined(this.#element, "Video element should exist");
    this.#initEventListeners();
    this.#initializeResizeObserver();
    //  this.#element.muted = false;
    this.#element.volume = 0.5;

    /*     this.#element.muted = true;
    this.#element.playsInline = true;
    this.#element.setAttribute("webkit-playsinline", "webkit-playsinline"); */
  }

  #initEventListeners(): void {
    // to track when video dimensions are available
    this.#element.addEventListener("loadedmetadata", () => {
      this.#isMetadataLoaded = true;
      this.#logger.debug(
        `Video metadata loaded: ${this.#element.videoWidth}x${
          this.#element.videoHeight
        }`
      );
      eventBus.trigger(MediaPlayerEvents.DIMENSIONS_CHANGED);
    });

    this.#element.addEventListener(
      "durationchange",
      () => this.#initializeStatsOverlay(),
      { once: true }
    );

    this.#element.addEventListener("canplay", () => {
      const debugDiv = document.getElementById("debug");
      if (debugDiv) {
        debugDiv.innerHTML += `Canplay Event<br>`;
      }

      if (this.#autoplay && this.#element.paused) {
        this.#element.play().catch((e) => {
          this.#logger.info("Autoplay prevented or failed");
          if (this.#element.paused) {
            eventBus.trigger(Events.SHOW_PERSISTENT_PLAY_BUTTON);
          }
        });
      } else if (this.#element.paused && !this.#element.played.length) {
        eventBus.trigger(Events.SHOW_PERSISTENT_PLAY_BUTTON);
      }
    });

    this.#element.addEventListener(
      "touchstart",
      function () {
        // This activates the video element for iOS
      },
      { once: true }
    );

    const videoElementEvents: [string, (e: Event) => void][] = [
      ["play", () => eventBus.trigger(MediaPlayerEvents.PLAYBACK_STARTED)],
      ["pause", () => eventBus.trigger(MediaPlayerEvents.PLAYBACK_PAUSED)],
      ["click", () => eventBus.trigger(Events.VIDEO_CLICKED)],
      ["dblclick", () => eventBus.trigger(Events.TOGGLE_FULLSCREEN_REQUEST)],
      ["progress", (e: Event) => this.#onProgress(e)],
      ["error", (e) => this.#handleError(e)],
      ["ended", () => eventBus.trigger(MediaPlayerEvents.PLAYBACK_ENDED)],
    ];

    videoElementEvents.forEach(([event, handler]) => {
      this.#element.addEventListener(event, handler as EventListener);
    });

    const busEvents: [string, (payload: Payload) => void][] = [
      [Events.PLAYBACK_RATE_REQUESTED, this.#onPlaybackRateRequested],
      [Events.SEEK_REQUESTED, this.#onSeekRequest],
      [Events.VIDEO_BITRATE_CHANGED, this.#onVideoBitrateChange],
      [Events.RESTART_VIDEO_REQUESTED, this.#videoRestartRequested],
    ];

    busEvents.forEach(([event, handler]) => {
      eventBus.on(event, handler.bind(this), this);
    });
  }

  #videoRestartRequested = async (): Promise<void> => {
    await this.#restart();
  };

  #restart = async (): Promise<void> => {
    this.#logger.info("Restarting video");
    await bufferController.purgeBuffer();
    await audioBufferController.purgeBuffer();
    this.#seek(0, true);
  };

  getCurrVolume = (): number => {
    return this.#element.volume;
  };

  setVolume = (newVolume: number): void => {
    this.#logger.debug("New volume:", newVolume);
    this.#element.volume = newVolume;
    if (newVolume > 0) {
      this.setMuted(false);
    }
    eventBus.trigger(MediaPlayerEvents.PLAYBACK_VOLUME_CHANGED, { newVolume });
  };

  setMuted = (muted: boolean): void => {
    this.#element.muted = muted;
  };

  #onProgress = (e: Event): void => {
    // Check if we have metadata and are actively loading
    if (
      this.#element.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA &&
      this.#element.networkState === HTMLMediaElement.NETWORK_LOADING
    ) {
      // Normal playback progress
      eventBus.trigger(MediaPlayerEvents.PLAYBACK_PROGRESS);
    }
    // Check if we're potentially rebuffering
    else if (
      this.#element.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA &&
      !this.#element.paused &&
      !this.#element.seeking
    ) {
      // We're playing but don't have enough data - likely rebuffering
      this.#onPlayerRebuffering(e);
    }
  };

  #onPlayerRebuffering = (e: Event): void => {
    this.#logger.warn(
      "Player does not have enough data - likely rebuferring!",
      e
    );
  };

  #initializeResizeObserver = (): void => {
    let resizeTimeout: number;

    this.#resizeObserver = new ResizeObserver(() => {
      if (!this.#isMetadataLoaded) {
        this.#logger.debug(
          "ResizeObserver fired but video metadata not ready yet"
        );
        return;
      }

      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.#logger.debug(
          `Video element resized: ${this.#element.clientWidth}x${
            this.#element.clientHeight
          }`
        );
        eventBus.trigger(MediaPlayerEvents.DIMENSIONS_CHANGED);
      }, 100);
    });

    this.#resizeObserver.observe(this.#element);
  };

  isMetadataLoaded = (): boolean => {
    return (
      this.#isMetadataLoaded &&
      this.#element.videoWidth > 0 &&
      this.#element.videoHeight > 0
    );
  };

  #initializeStatsOverlay(): void {
    const duration = this.getDuration();
    if (!(duration > 0)) return;

    const textTrack = this.#element.addTextTrack("captions");
    textTrack.mode = "showing";

    const cue = new VTTCue(0, duration, "");
    cue.line = 1;
    textTrack.addCue(cue);

    let lastUpdateTime = 0;
    const updateInterval = Math.round(1000 / 30);

    const updateStats = (timestamp: number) => {
      if (timestamp - lastUpdateTime >= updateInterval) {
        cue.text = `Time: ${this.#element.currentTime.toFixed(
          2
        )}s | Frame: ${Math.floor(this.getTime() * this.#currentFps)} | ${
          this.#element.videoHeight
        }p`;
        lastUpdateTime = timestamp;
      }

      requestAnimationFrame(updateStats);
    };

    requestAnimationFrame(updateStats);
  }

  #handleError = (e: Event): void => {
    const debugDiv = document.getElementById("debug");
    if (debugDiv) {
      debugDiv.innerHTML += `Error: ${e}<br>`;
    }
    const errorEvent = e as ErrorEvent;
    let msg;
    console.error(errorEvent);
    if (e.type !== "error" || !errorEvent.error) return;

    switch (errorEvent.error.code) {
      case 1:
        this.#logger.error("", errorEvent.error);
        break;
      case 2:
        this.#logger.error("", errorEvent.error);
        break;
      case 3:
        msg = "MEDIA_ERR_DECODE";
        break;
      case 4:
        this.#logger.error("", errorEvent.error);
        break;
    }

    if (msg === "MEDIA_ERR_DECODE") {
      this.#handleMediaErrorDecode();
    }
  };

  getPlaybackQuality = (): VideoPlaybackQuality => {
    return this.#element.getVideoPlaybackQuality();
  };

  #handleMediaErrorDecode = (): void => {
    this.#logger.error("A MEDIA_ERR_DECODE occured: Resetting the MediaSource");
    //! TODO
  };

  #onVideoBitrateChange = (payload: Payload): void => {
    Assert.assertDefined(
      payload.videoRepresentation,
      "Payload must contain video representation"
    );
    const representation = payload.videoRepresentation;

    this.#currentVideoRepresentation = representation;
    this.#currentResolution = `${representation.height}p ${(
      representation.bitrate / 1e6
    ).toFixed(1)}mb/s`;
    this.#currentFps = representation.fps;
  };

  #onPlaybackRateRequested = (payload: Payload): void => {
    Assert.assertDefined(payload.speed, "Payload didn't contain speed data");

    this.#element.playbackRate = payload.speed;
    eventBus.trigger(MediaPlayerEvents.PLAYBACK_RATE_CHANGED, {
      speed: payload.speed,
    });
  };

  #seek = (time: number, playAfterSeek: boolean = false): void => {
    Assert.assert(time >= 0, "Seek time must be >= 0");
    Assert.assert(time <= this.getDuration(), "Seek time must be <= duration");

    this.#element.currentTime = time;
    this.#logger.info(`Seeked to ${time}`);
    eventBus.trigger(MediaPlayerEvents.SEEKED, { seekTo: time });
    if (playAfterSeek) {
      this.#element.play();
    }
  };

  #onSeekRequest = (payload: Payload): void => {
    Assert.assertDefined(payload.seekTo);
    Assert.assertDefined(this.#currentVideoRepresentation);

    const timescale = this.#currentVideoRepresentation.segment.timescale;
    const duration = video.getDuration();

    //Snap to the nearest segment
    const seekTo = Math.round(
      ((timescale * payload.seekTo) / duration) * (duration / timescale)
    );

    this.#seek(seekTo);
  };

  getPlaybackRate = (): number => {
    Assert.assert(
      this.#element.playbackRate > 0,
      "Playbackrate has to be greater than 0!"
    );
    return this.#element.playbackRate;
  };

  getDuration = (): number => {
    Assert.assert(
      this.#element.duration > 0,
      "Duration has to greater than 0!"
    );
    return this.#element.duration;
  };

  getClientWidth = (): number => {
    return this.#element.clientWidth;
  };

  getClientHeight = (): number => {
    return this.#element.clientHeight;
  };

  isPaused = (): boolean => {
    return this.#element ? this.#element.paused : false;
  };

  getTime = (): number => {
    return this.#element.currentTime;
  };

  setSource = (mediaSource: MediaSource) => {
    if (mediaSource) {
      this.#element.src = window.URL.createObjectURL(mediaSource);
      eventBus.trigger(MediaPlayerEvents.SOURCE_CHANGED, {
        mediaSource,
      });
    } else {
      // reset
      this.#element.removeAttribute("src");
      this.#element.load();
    }
  };

  play = async () => {
    try {
      await this.#element.play();
    } catch (error) {
      this.#logger.error("Play failed:", error);
    }
  };

  pause = (): void => {
    this.#element.pause();
  };

  isSeeking = (): boolean => {
    return this.#element.seeking;
  };

  getVideoElement = (): HTMLVideoElement => {
    return this.#element;
  };

  isMuted = (): boolean => {
    return this.#element.muted;
  };

  getActualVideoDisplaySize(): { width: number; height: number } {
    if (!this.isMetadataLoaded()) {
      this.#logger.debug("Video metadata not ready for size calculation");
      return { width: this.getClientWidth(), height: this.getClientHeight() };
    }

    const elementWidth = this.getClientWidth();
    const elementHeight = this.getClientHeight();
    const videoWidth = this.#element.videoWidth;
    const videoHeight = this.#element.videoHeight;

    // Calculate aspect ratios
    const elementAspect = elementWidth / elementHeight;
    const videoAspect = videoWidth / videoHeight;

    let actualWidth, actualHeight;

    if (Math.abs(elementAspect - videoAspect) < 0.01) {
      // Aspects are nearly identical - video fills element
      actualWidth = elementWidth;
      actualHeight = elementHeight;
    } else if (elementAspect > videoAspect) {
      // Element is wider than video - letterboxing on sides
      actualHeight = elementHeight;
      actualWidth = elementHeight * videoAspect;
    } else {
      // Element is taller than video - letterboxing on top/bottom
      actualWidth = elementWidth;
      actualHeight = elementWidth / videoAspect;
    }

    return { width: actualWidth, height: actualHeight };
  }
}

export const video = new Video();
