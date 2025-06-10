import { logger, type Logger } from "../../Logger.js";

interface IStallDetector {
  detectStall(): boolean;
  isPlaybackBlocked(): boolean;
  reset(): void;
  destroy(): void;
  notifySeek(): void;
  notifyQualitySwitch(): void;
  notifyPlaybackStart(): void;
}

// Player states that affect stall detection
enum PlayerContext {
  STARTUP = "startup",
  SEEKING = "seeking",
  QUALITY_SWITCHING = "quality_switching",
  NORMAL_PLAYBACK = "normal_playback",
  BUFFERING = "buffering",
}

// Grace periods for different contexts (in milliseconds)
const GRACE_PERIODS = {
  [PlayerContext.STARTUP]: 2000,
  [PlayerContext.SEEKING]: 2000,
  [PlayerContext.QUALITY_SWITCHING]: 1500,
  [PlayerContext.NORMAL_PLAYBACK]: 0,
  [PlayerContext.BUFFERING]: 3000,
};

// Stall detection thresholds
const STALL_THRESHOLD_MS = 250; // Minimum time before considering it a stall
const CONSECUTIVE_CHECKS_THRESHOLD = 3; // Number of checks before confirming stall
const CHECK_INTERVAL_MS = 100;

export class StallDetector implements IStallDetector {
  #video: HTMLVideoElement;
  #logger: Logger;
  #lastPlaybackTime: number = 0;
  #lastCheckTime: number = 0;
  #consecutiveStallChecks: number = 0;
  #isStalled: boolean = false;
  #lastReadyState: number = 0;
  #eventHandlers: Map<string, EventListener> = new Map();

  // Context tracking
  #currentContext: PlayerContext = PlayerContext.STARTUP;
  #contextStartTime: number = 0;
  #hasPlaybackStarted: boolean = false;

  // Stall history for threshold-based detection
  #stallHistory: boolean[] = [];
  #historySize: number = 5;

  // Callback to check buffer state
  #isPositionBuffered: ((time: number) => boolean) | null = null;
  #isDownloadingForPosition: ((time: number) => boolean) | null = null;

  constructor(
    video: HTMLVideoElement,
    options?: {
      isPositionBuffered?: (time: number) => boolean;
      isDownloadingForPosition?: (time: number) => boolean;
    }
  ) {
    this.#video = video;
    this.#logger = logger.createChild("StallDetector");
    this.#isPositionBuffered = options?.isPositionBuffered || null;
    this.#isDownloadingForPosition = options?.isDownloadingForPosition || null;

    this.#initializeState();
    this.#attachEventListeners();
  }

  #initializeState = (): void => {
    this.#lastPlaybackTime = this.#video.currentTime;
    this.#lastCheckTime = Date.now();
    this.#lastReadyState = this.#video.readyState;
    this.#contextStartTime = Date.now();
  };

  #attachEventListeners = (): void => {
    const handlers = {
      waiting: () => this.#onWaiting(),
      stalled: () => this.#onStalled(),
      playing: () => this.#onPlaying(),
      play: () => this.#onPlay(),
      canplay: () => this.#onCanPlay(),
      loadstart: () => this.#onLoadStart(),
      seeking: () => this.#onSeeking(),
      seeked: () => this.#onSeeked(),
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      this.#eventHandlers.set(event, handler);
      this.#video.addEventListener(event, handler);
    });
  };

  #onWaiting = (): void => {
    this.#logger.debug('Video element fired "waiting" event');
    this.#updateContext(PlayerContext.BUFFERING);
  };

  #onStalled = (): void => {
    this.#logger.debug('Video element fired "stalled" event');
  };

  #onPlaying = (): void => {
    if (this.#isStalled) {
      this.#logger.info('Stall resolved - "playing" event fired');
      this.reset();
    }
    if (!this.#hasPlaybackStarted) {
      this.#hasPlaybackStarted = true;
    }
    this.#updateContext(PlayerContext.NORMAL_PLAYBACK);
  };

  #onPlay = (): void => {
    if (!this.#hasPlaybackStarted) {
      this.#updateContext(PlayerContext.STARTUP);
    }
  };

  #onCanPlay = (): void => {
    if (this.#currentContext === PlayerContext.BUFFERING) {
      this.#updateContext(PlayerContext.NORMAL_PLAYBACK);
    }
  };

  #onLoadStart = (): void => {
    this.#updateContext(PlayerContext.STARTUP);
    this.#hasPlaybackStarted = false;
  };

  #onSeeking = (): void => {
    this.#updateContext(PlayerContext.SEEKING);
  };

  #onSeeked = (): void => {
    // Don't immediately switch to normal playback - wait for playing event
    if (this.#currentContext === PlayerContext.SEEKING) {
      this.#consecutiveStallChecks = 0;
      this.#stallHistory = [];
    }
  };

  #updateContext = (newContext: PlayerContext): void => {
    if (this.#currentContext !== newContext) {
      this.#logger.debug(
        `Context change: ${this.#currentContext} → ${newContext}`
      );
      this.#currentContext = newContext;
      this.#contextStartTime = Date.now();

      // Reset stall detection on context change
      this.#consecutiveStallChecks = 0;
      this.#stallHistory = [];
    }
  };

  detectStall = (): boolean => {
    const currentTime = this.#video.currentTime;
    const currentCheckTime = Date.now();
    const readyState = this.#video.readyState;

    // Don't detect stalls if explicitly paused, seeking, or ended
    if (this.#video.paused || this.#video.seeking || this.#video.ended) {
      this.reset();
      return false;
    }

    // Check if we're still in grace period for current context
    const gracePeriod = GRACE_PERIODS[this.#currentContext];
    const timeSinceContextChange = currentCheckTime - this.#contextStartTime;

    if (timeSinceContextChange < gracePeriod) {
      this.#logger.debug(
        `In grace period for ${
          this.#currentContext
        }: ${timeSinceContextChange}ms / ${gracePeriod}ms`
      );
      return false;
    }

    // Log readyState changes
    if (readyState !== this.#lastReadyState) {
      this.#logger.debug(
        `ReadyState: ${this.#getReadyStateName(
          this.#lastReadyState
        )} → ${this.#getReadyStateName(readyState)}`
      );
      this.#lastReadyState = readyState;
    }

    // Check playback progress
    const playbackDelta = currentTime - this.#lastPlaybackTime;
    const timeDelta = currentCheckTime - this.#lastCheckTime;

    // Determine if this check indicates a stall
    let isCurrentlyStalled = false;

    if (timeDelta >= CHECK_INTERVAL_MS) {
      if (playbackDelta < 0.01) {
        // No playback progress
        isCurrentlyStalled = true;

        // Additional checks to reduce false positives
        if (this.#shouldIgnoreStall(currentTime)) {
          isCurrentlyStalled = false;
        }
      }

      // Update stall history
      this.#updateStallHistory(isCurrentlyStalled);

      // Check if we have enough consecutive stalls to confirm
      if (isCurrentlyStalled) {
        this.#consecutiveStallChecks++;

        const stallDuration = this.#consecutiveStallChecks * CHECK_INTERVAL_MS;
        const confirmedStall =
          stallDuration >= STALL_THRESHOLD_MS &&
          this.#consecutiveStallChecks >= CONSECUTIVE_CHECKS_THRESHOLD &&
          this.#isStallPatternConfirmed();

        if (confirmedStall && !this.#isStalled) {
          this.#isStalled = true;
          this.#logger.warn(
            `Stall detected at ${currentTime.toFixed(2)}s, ` +
              `ReadyState: ${this.#getReadyStateName(readyState)}, ` +
              `Context: ${this.#currentContext}, ` +
              `Stalled for: ${stallDuration}ms`
          );
          return true;
        }
      } else {
        // Playback is progressing
        this.#lastPlaybackTime = currentTime;
        this.#consecutiveStallChecks = 0;

        if (this.#isStalled) {
          this.#isStalled = false;
          this.#logger.info("Stall resolved - playback progressing");
        }
      }

      this.#lastCheckTime = currentCheckTime;
    }

    return this.#isStalled;
  };

  #shouldIgnoreStall = (currentTime: number): boolean => {
    // Check if position is buffered
    if (this.#isPositionBuffered && this.#isPositionBuffered(currentTime)) {
      // Position is buffered but not playing - this might be a real stall
      // unless we're downloading the next segment
      if (
        this.#isDownloadingForPosition &&
        this.#isDownloadingForPosition(currentTime)
      ) {
        this.#logger.debug(
          "Ignoring stall - downloading segment for current position"
        );
        return true;
      }

      // Check readyState - if we have enough data but aren't playing, it's likely a real stall
      if (this.#video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
        return false; // Don't ignore - this is likely a real stall
      }
    }

    // Check if we're at the very beginning (common false positive)
    if (currentTime < 0.1 && !this.#hasPlaybackStarted) {
      return true;
    }

    // Check network state
    if (this.#video.networkState === HTMLMediaElement.NETWORK_LOADING) {
      // Still loading - might not be a real stall
      return this.#currentContext !== PlayerContext.NORMAL_PLAYBACK;
    }

    return false;
  };

  #updateStallHistory = (isStalled: boolean): void => {
    this.#stallHistory.push(isStalled);
    if (this.#stallHistory.length > this.#historySize) {
      this.#stallHistory.shift();
    }
  };

  #isStallPatternConfirmed = (): boolean => {
    // Check if we have a consistent pattern of stalls
    if (this.#stallHistory.length < 3) {
      return true; // Not enough history, trust current detection
    }

    // Count recent stalls
    const recentStalls = this.#stallHistory.slice(-3).filter((s) => s).length;
    return recentStalls >= 2; // At least 2 out of last 3 checks were stalls
  };

  isPlaybackBlocked = (): boolean => {
    const hasEnoughBuffer =
      this.#video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    const isBuffered = this.#isPositionBuffered
      ? this.#isPositionBuffered(this.#video.currentTime)
      : false;

    return (
      !this.#video.paused &&
      !this.#video.seeking &&
      !this.#video.ended &&
      (!hasEnoughBuffer || !isBuffered)
    );
  };

  notifySeek = (): void => {
    this.#updateContext(PlayerContext.SEEKING);
    this.reset();
  };

  notifyQualitySwitch = (): void => {
    this.#updateContext(PlayerContext.QUALITY_SWITCHING);
    this.reset();
  };

  notifyPlaybackStart = (): void => {
    this.#updateContext(PlayerContext.STARTUP);
    this.#hasPlaybackStarted = false;
  };

  reset = (): void => {
    this.#lastPlaybackTime = this.#video.currentTime;
    this.#lastCheckTime = Date.now();
    this.#consecutiveStallChecks = 0;
    this.#isStalled = false;
    this.#lastReadyState = this.#video.readyState;
    this.#stallHistory = [];
  };

  destroy = (): void => {
    this.#eventHandlers.forEach((handler, event) => {
      this.#video.removeEventListener(event, handler);
    });
    this.#eventHandlers.clear();
  };

  #getReadyStateName = (state: number): string => {
    const names = [
      "HAVE_NOTHING",
      "HAVE_METADATA",
      "HAVE_CURRENT_DATA",
      "HAVE_FUTURE_DATA",
      "HAVE_ENOUGH_DATA",
    ];
    return names[state] || "UNKNOWN";
  };
}
