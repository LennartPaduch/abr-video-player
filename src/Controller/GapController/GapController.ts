import { eventBus, Payload } from "../../Events/EventBus.js";
import { Events } from "../../Events/Events.js";
import { MediaPlayerEvents } from "../../Events/MediaPlayerEvents.js";
import { logger } from "../../Logger.js";
import { StallDetector } from "./StallDetector.js";
import { Assert } from "../../utils/assertion.js";
import { video } from "../../Video.js";
import { bufferController } from "../BufferController.js";
import { playbackController } from "../PlaybackController.js";

const GAP_HANDLER_INTERVAL = 100;
const SMALL_GAP_LIMIT = 1.5;
const STALL_SEEK_OFFSET = 0.1;
const STALL_FIX_ENABLED = true;
const JUMP_LARGER_GAPS = true;
const STALL_DETECTION_ENABLED = true;

// Threshold for confirming stalls (similar to dash.js)
const STALL_CONFIRMATION_THRESHOLD = 3;
const GAP_JUMP_TOLERANCE = 0.3;

export class GapController {
  #logger = logger.createChild("GapController");
  #gapHandlerInterval: number | null = null;
  #jumpTimeoutHandler: number | null = null;
  #lastGapJumpPosition: number = NaN;
  #threshold = GAP_JUMP_TOLERANCE;
  #active: boolean = true;
  #trackSwitchByMediaType: { [key: string]: boolean } = {};
  #stallDetector: StallDetector | null = null;

  // Stall confirmation tracking
  #consecutiveStallDetections: number = 0;
  #lastStallCheckTime: number = 0;

  // State tracking
  #isQualitySwitching: boolean = false;
  #lastSeekTime: number = 0;

  constructor() {
    this.#initializeEventListeners();
  }

  #initializeEventListeners(): void {
    eventBus.on(
      Events.VIDEO_BITRATE_CHANGED,
      this.#onVideoRepresentationChanged,
      this
    );
    eventBus.on(Events.SEEK_REQUESTED, this.#onSeekRequested, this);
    eventBus.on(MediaPlayerEvents.SEEKED, this.#onSeeked, this);
    eventBus.on(
      Events.QUALITY_CHANGE_REQUESTED,
      this.#onQualityChangeRequested,
      this
    );
    eventBus.on(
      MediaPlayerEvents.PLAYBACK_STARTED,
      this.#onPlaybackStarted,
      this
    );
  }

  #onVideoRepresentationChanged = (payload: Payload): void => {
    Assert.assertDefined(
      payload.videoRepresentation,
      "Payload must contain video representation data!"
    );

    this.#isQualitySwitching = false;

    if (payload.videoRepresentation && payload.switchReason === "Start") {
      this.#startGapHandler();
    }

    // Notify stall detector about quality switch completion
    if (this.#stallDetector) {
      // Give buffer time to fill after quality switch
      setTimeout(() => {
        this.#consecutiveStallDetections = 0;
      }, 1000);
    }
  };

  #onSeekRequested = (): void => {
    this.#lastSeekTime = Date.now();

    // Clear any pending gap jumps
    if (this.#jumpTimeoutHandler) {
      clearTimeout(this.#jumpTimeoutHandler);
      this.#jumpTimeoutHandler = null;
    }

    // Notify stall detector
    if (this.#stallDetector) {
      this.#stallDetector.notifySeek();
    }

    // Reset stall tracking
    this.#consecutiveStallDetections = 0;
  };

  #onSeeked = (): void => {
    // Reset stall tracking after seek completes
    this.#consecutiveStallDetections = 0;
    this.#lastGapJumpPosition = NaN;
  };

  #onQualityChangeRequested = (): void => {
    this.#isQualitySwitching = true;

    if (this.#stallDetector) {
      this.#stallDetector.notifyQualitySwitch();
    }

    this.#consecutiveStallDetections = 0;
  };

  #onPlaybackStarted = (): void => {
    if (this.#stallDetector) {
      this.#stallDetector.notifyPlaybackStart();
    }
  };

  #shouldIgnoreSeekingState = (): boolean => {
    const streamEnd = parseFloat(
      (
        playbackController.getStartTime() + playbackController.getDuration()
      ).toFixed(5)
    );
    return playbackController.getTime() + this.#threshold >= streamEnd;
  };

  #shouldCheckForGaps = (checkSeekingState: boolean = false): boolean => {
    const trackSwitchInProgress = Object.values(
      this.#trackSwitchByMediaType
    ).some((switching) => switching);

    const shouldIgnoreSeekingState = checkSeekingState
      ? this.#shouldIgnoreSeekingState()
      : false;

    // Don't check for gaps during quality switches
    if (this.#isQualitySwitching) {
      return false;
    }

    // Don't check immediately after seek
    const timeSinceSeek = Date.now() - this.#lastSeekTime;
    if (timeSinceSeek < 2000 && playbackController.isSeeking()) {
      return false;
    }

    return (
      !trackSwitchInProgress &&
      this.#active &&
      (!playbackController.isSeeking() || shouldIgnoreSeekingState) &&
      !playbackController.isPaused()
    );
  };

  #initializeStallDetector(): void {
    if (!this.#stallDetector && STALL_DETECTION_ENABLED) {
      const videoElement = video.getVideoElement();

      if (videoElement) {
        // Create stall detector with buffer state callbacks
        this.#stallDetector = new StallDetector(videoElement, {
          isPositionBuffered: (time: number) => this.#isPositionBuffered(time),
          isDownloadingForPosition: (time: number) =>
            this.#isDownloadingForPosition(time),
        });

        this.#logger.info("Stall detector initialized with buffer integration");
      } else {
        this.#logger.error(
          "Could not initialize stall detector - video element not available"
        );
      }
    }
  }

  #isPositionBuffered = (time: number): boolean => {
    const ranges = bufferController.getBufferRanges();
    if (!ranges) return false;

    for (let i = 0; i < ranges.length; i++) {
      if (time >= ranges.start(i) && time <= ranges.end(i)) {
        return true;
      }
    }
    return false;
  };

  #isDownloadingForPosition = (time: number): boolean => {
    try {
      const downloadingSegments = bufferController.getCurrentSegmentDownloads();

      if (!downloadingSegments || downloadingSegments.length === 0) {
        return false;
      }

      // Get current video representation
      const videoRep = playbackController.getCurrentVideoRepresentation();
      if (!videoRep || !videoRep.segmentIndex) {
        this.#logger.debug(
          "No video representation available for download check"
        );
        return false;
      }

      // Find the segment that contains this time position
      const segmentAtTime = videoRep.segmentIndex.getSegmentAtTime(time);
      if (!segmentAtTime) {
        return false;
      }

      // Check if this segment is currently being downloaded
      const isDownloading = downloadingSegments.includes(
        segmentAtTime.segmentNumber
      );

      if (isDownloading) {
        this.#logger.debug(
          `Segment ${segmentAtTime.segmentNumber} covering time ${time.toFixed(
            2
          )}s is currently downloading`
        );
      }

      // Also check if it's in the append queue (downloaded but not yet appended)
      const queuedSegments = bufferController.getAppendQueue();
      const isQueued = queuedSegments.some(
        (queuedSeg) => queuedSeg.segmentNumber === segmentAtTime.segmentNumber
      );

      return isDownloading || isQueued;
    } catch (error) {
      this.#logger.error("Error checking download position:", error);
      return false;
    }
  };

  #startGapHandler = (): void => {
    try {
      if (!this.#gapHandlerInterval) {
        this.#logger.debug("Starting Gap Controller");

        // Initialize stall detector
        this.#initializeStallDetector();

        this.#gapHandlerInterval = setInterval(() => {
          if (!this.#shouldCheckForGaps()) {
            return;
          }

          // Check for stalls using StallDetector
          let confirmedStall = false;

          if (this.#stallDetector && STALL_DETECTION_ENABLED) {
            const isStalled = this.#stallDetector.detectStall();

            if (isStalled) {
              this.#consecutiveStallDetections++;

              // Use threshold-based confirmation similar to dash.js
              if (
                this.#consecutiveStallDetections >= STALL_CONFIRMATION_THRESHOLD
              ) {
                confirmedStall = true;
                this.#logger.warn(
                  `Stall confirmed after ${
                    this.#consecutiveStallDetections
                  } consecutive detections`
                );
              }
            } else {
              // Reset counter if no stall detected
              this.#consecutiveStallDetections = 0;
            }
          }

          // Check for gaps and handle confirmed stalls
          this.#jumpGap(playbackController.getTime(), confirmedStall);
        }, GAP_HANDLER_INTERVAL);
      }
    } catch (e) {
      this.#logger.error("Error in gap handler:", e);
    }
  };

  #stopGapHandler = (): void => {
    if (this.#gapHandlerInterval) {
      clearInterval(this.#gapHandlerInterval);
      this.#gapHandlerInterval = null;
      this.#logger.debug("Stopped Gap Controller");
    }
  };

  #getNextRangeIndex = (
    ranges: TimeRanges,
    currentTime: number
  ): number | null => {
    if (!ranges || ranges.length <= 1) {
      return null;
    }

    for (let i = 0; i < ranges.length; i++) {
      const previousRangeEnd = i > 0 ? ranges.end(i - 1) : 0;

      if (
        currentTime < ranges.start(i) &&
        previousRangeEnd - currentTime < this.#threshold
      ) {
        return i;
      }
    }

    return null;
  };

  #jumpGap = (currentTime: number, playbackStalled: boolean = false): void => {
    const ranges = bufferController.getBufferRanges();
    if (!ranges || ranges.length === 0) return;

    let seekToPosition = NaN;
    let jumpToStreamEnd = false;
    let jumpReason = "";

    // Check for normal gaps
    const nextRangeIndex = this.#getNextRangeIndex(ranges, currentTime);
    if (nextRangeIndex !== null) {
      const start = ranges.start(nextRangeIndex);
      const gap = start - currentTime;

      if (gap > 0 && (gap <= SMALL_GAP_LIMIT || JUMP_LARGER_GAPS)) {
        seekToPosition = start;
        jumpReason = `gap of ${gap.toFixed(3)}s`;
      }
    }

    // Only handle stalls if confirmed through threshold
    if (isNaN(seekToPosition) && playbackStalled && ranges.length > 0) {
      // Find the closest buffered range ahead
      for (let i = 0; i < ranges.length; i++) {
        const start = ranges.start(i);
        const end = ranges.end(i);

        // Check if we're just before a buffered range
        if (currentTime < start && start - currentTime <= this.#threshold * 2) {
          seekToPosition = start;
          jumpReason = `confirmed stall before buffer at ${start.toFixed(2)}s`;
          break;
        }

        // Check if we're within a buffered range but stalled
        if (currentTime >= start && currentTime < end && STALL_FIX_ENABLED) {
          // Additional check: is this position really buffered?
          if (this.#isPositionBuffered(currentTime)) {
            const jumpTarget = Math.min(
              currentTime + STALL_SEEK_OFFSET,
              end - 0.1
            );
            if (jumpTarget > currentTime) {
              seekToPosition = jumpTarget;
              jumpReason = `confirmed stall within buffer [${start.toFixed(
                2
              )}-${end.toFixed(2)}]s`;
              break;
            }
          }
        }
      }
    }

    // Handle end of stream
    if (isNaN(seekToPosition) && playbackStalled) {
      const timeToStreamEnd = playbackController.getTimeToStreamEnd();
      if (isFinite(timeToStreamEnd) && timeToStreamEnd < SMALL_GAP_LIMIT) {
        seekToPosition = parseFloat(
          playbackController.getStreamEndTime().toString()
        );
        jumpToStreamEnd = true;
        jumpReason = "near end of stream";
        bufferController.triggerEndOfStream();
      }
    }

    // Execute the jump
    if (
      seekToPosition > 0 &&
      this.#lastGapJumpPosition !== seekToPosition &&
      seekToPosition > currentTime &&
      !this.#jumpTimeoutHandler
    ) {
      const jumpDistance = seekToPosition - currentTime;

      this.#logger.warn(
        `Jumping due to ${jumpReason}. ` +
          `From: ${currentTime.toFixed(2)}s to ${seekToPosition.toFixed(2)}s ` +
          `(distance: ${jumpDistance.toFixed(3)}s)`
      );

      // Reset stall detector and counter before jump
      if (this.#stallDetector) {
        this.#stallDetector.reset();
      }
      this.#consecutiveStallDetections = 0;

      // For confirmed stalls, jump immediately
      // For gaps, use a small delay
      const delay = playbackStalled ? 0 : Math.min(100, jumpDistance * 1000);

      this.#jumpTimeoutHandler = window.setTimeout(() => {
        eventBus.trigger(Events.SEEK_REQUESTED, { seekTo: seekToPosition });
        this.#jumpTimeoutHandler = null;
      }, delay);

      this.#lastGapJumpPosition = seekToPosition;
    }
  };

  // Public API
  destroy(): void {
    this.#stopGapHandler();

    if (this.#stallDetector) {
      this.#stallDetector.destroy();
      this.#stallDetector = null;
    }

    // Remove event listeners
    eventBus.off(
      Events.VIDEO_BITRATE_CHANGED,
      this.#onVideoRepresentationChanged,
      this
    );
    eventBus.off(Events.SEEK_REQUESTED, this.#onSeekRequested, this);
    eventBus.off(MediaPlayerEvents.SEEKED, this.#onSeeked, this);
    eventBus.off(
      Events.QUALITY_CHANGE_REQUESTED,
      this.#onQualityChangeRequested,
      this
    );
    eventBus.off(
      MediaPlayerEvents.PLAYBACK_STARTED,
      this.#onPlaybackStarted,
      this
    );
  }

  // Manual stall check (for testing or external use)
  checkForStall(): boolean {
    return this.#stallDetector?.detectStall() || false;
  }

  // Enable/disable gap handling
  setActive(active: boolean): void {
    this.#active = active;
    this.#logger.info(`Gap handling ${active ? "enabled" : "disabled"}`);
  }

  // Get diagnostic info
  getDiagnostics(): {
    isActive: boolean;
    consecutiveStalls: number;
    isQualitySwitching: boolean;
    timeSinceLastSeek: number;
  } {
    return {
      isActive: this.#active,
      consecutiveStalls: this.#consecutiveStallDetections,
      isQualitySwitching: this.#isQualitySwitching,
      timeSinceLastSeek: Date.now() - this.#lastSeekTime,
    };
  }
}
