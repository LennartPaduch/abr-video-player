import { abrController } from "./abr/AbrController.js";
import { audioBufferController, bufferController } from "./BufferController.js";
import { eventBus, Payload } from "../Events/EventBus.js";
import { MediaPlayerEvents } from "../Events/MediaPlayerEvents.js";
import { Events } from "../Events/Events.js";
import { video } from "../Video.js";
import { droppedFramesHistory } from "../DroppedFramesHistory.js";
import { playbackController } from "./PlaybackController.js";
import { Logger, logger } from "../Logger.js";
import type { BufferController } from "./BufferController.js";

interface ScheduleConfig {
  // Initial delay before starting downloads (ms)
  initialDelay: number;
  // Base scheduling interval (ms)
  baseInterval: number;
  // Minimum interval between checks (ms)
  minInterval: number;
  // Maximum interval between checks (ms)
  maxInterval: number;
  // Buffer level percentage to start slowing down (0-1)
  slowdownThreshold: number;
  // Enable quality checking during playback
  enableQualityCheck: boolean;
  // Interval for quality checks (ms)
  qualityCheckInterval: number;
  // Enable pre-loading before playback starts
  enablePreload: boolean;
  // Target buffer level for pre-loading (seconds)
  preloadTarget: number;
  // Critical buffer level where we schedule aggressively (seconds)
  criticalBufferLevel: number;
}

interface ScheduleState {
  isActive: boolean;
  isPreloading: boolean;
  lastScheduleTime: number;
  lastQualityCheckTime: number;
  consecutiveErrors: number;
  currentInterval: number;
  averageSegmentDuration: number;
}

interface PerformanceMetrics {
  scheduleCalls: number;
  qualityChanges: number;
  bufferStalls: number;
  lastBufferLevel: number;
}

export class ScheduleController {
  #config: ScheduleConfig = {
    initialDelay: 100,
    baseInterval: 500,
    minInterval: 100,
    maxInterval: 2000,
    slowdownThreshold: 0.8, // Start slowing at 80% of target
    enableQualityCheck: true,
    qualityCheckInterval: 1000,
    enablePreload: true,
    preloadTarget: 20,
    criticalBufferLevel: 5, // Be aggressive below 5 seconds
  };

  #state: ScheduleState = {
    isActive: false,
    isPreloading: false,
    lastScheduleTime: 0,
    lastQualityCheckTime: 0,
    consecutiveErrors: 0,
    currentInterval: this.#config.baseInterval,
    averageSegmentDuration: 4, // Default assumption
  };

  #scheduleTimeout: number | null = null;
  #qualityCheckTimeout: number | null = null;
  #logger: Logger;

  // Track buffer controllers
  #bufferControllers: Map<string, BufferController> = new Map();

  // Performance tracking
  #performanceMetrics: PerformanceMetrics = {
    scheduleCalls: 0,
    qualityChanges: 0,
    bufferStalls: 0,
    lastBufferLevel: 0,
  };

  constructor() {
    this.#logger = logger.createChild("ScheduleController");
    this.#bufferControllers.set("video", bufferController);
    this.#bufferControllers.set("audio", audioBufferController);
  }

  init = (): void => {
    this.#logger.info("Initializing ScheduleController");

    // Register event handlers
    const eventHandlers: Array<[string, (payload: Payload) => void]> = [
      [MediaPlayerEvents.SOURCE_CHANGED, this.#onSourceChanged],
      [MediaPlayerEvents.PLAYBACK_STARTED, this.#onPlaybackStarted],
      [MediaPlayerEvents.PLAYBACK_PAUSED, this.#onPlaybackPaused],
      [MediaPlayerEvents.SEEKED, this.#onSeeked],
      [MediaPlayerEvents.PLAYBACK_ENDED, this.#onPlaybackEnded],
      [Events.BUFFER_LEVEL_UPDATED, this.#onBufferLevelUpdated],
      [Events.FRAGMENT_LOADING_COMPLETED, this.#onFragmentLoaded],
    ];

    eventHandlers.forEach(([event, handler]) => {
      eventBus.on(event, handler, this);
    });

    // Start scheduling if preload is enabled
    if (this.#config.enablePreload) {
      this.#startPreloading();
    }
  };

  destroy = (): void => {
    this.#logger.info("Destroying ScheduleController");
    this.#stopScheduling();
    this.#stopQualityCheck();

    // Remove all event listeners
    eventBus.off(MediaPlayerEvents.SOURCE_CHANGED, this.#onSourceChanged, this);
    eventBus.off(
      MediaPlayerEvents.PLAYBACK_STARTED,
      this.#onPlaybackStarted,
      this
    );
    eventBus.off(
      MediaPlayerEvents.PLAYBACK_PAUSED,
      this.#onPlaybackPaused,
      this
    );
    eventBus.off(MediaPlayerEvents.SEEKED, this.#onSeeked, this);
    eventBus.off(Events.BUFFER_LEVEL_UPDATED, this.#onBufferLevelUpdated, this);
    eventBus.off(
      Events.FRAGMENT_LOADING_COMPLETED,
      this.#onFragmentLoaded,
      this
    );
  };

  // Event handlers
  #onSourceChanged = (): void => {
    this.#logger.debug("Source changed, resetting state");
    this.#resetState();

    if (this.#config.enablePreload) {
      // Delay to allow manifest parsing and initialization
      setTimeout(() => this.#startPreloading(), this.#config.initialDelay);
    }
  };

  #onPlaybackEnded = (): void => {
    this.#stopScheduling();
  };

  #onPlaybackStarted = (): void => {
    this.#logger.info("Playback started");
    this.#state.isPreloading = false;
    this.#startScheduling();
    this.#startQualityCheck();
  };

  #onPlaybackPaused = (): void => {
    this.#logger.debug("Playback paused");
    // Continue buffering but at a slower rate only if buffer is healthy
    const bufferLevel = bufferController.getBufferLevel();
    if (bufferLevel > this.#config.criticalBufferLevel) {
      this.#state.currentInterval = Math.min(
        this.#config.maxInterval,
        this.#state.currentInterval * 2
      );
    }
  };

  #onSeeked = (): void => {
    this.#logger.debug("Seek completed");
    // Resume with aggressive scheduling after seek
    this.#state.currentInterval = this.#config.minInterval;
    this.#resumeScheduling();
  };

  #onBufferLevelUpdated = (payload: Payload): void => {
    const bufferLevel = payload.bufferLevel || 0;
    this.#performanceMetrics.lastBufferLevel = bufferLevel;

    // Adjust scheduling interval based on buffer level
    this.#adjustSchedulingInterval(bufferLevel);
  };

  #onFragmentLoaded = (payload: Payload): void => {
    // Reset error counter on successful load
    this.#state.consecutiveErrors = 0;

    // Update average segment duration if available
    if (payload.segmentRef) {
      const duration =
        payload.segmentRef.endTime - payload.segmentRef.startTime;
      // Exponential moving average
      this.#state.averageSegmentDuration =
        this.#state.averageSegmentDuration * 0.8 + duration * 0.2;
    }
  };

  // Scheduling logic
  #startPreloading = (): void => {
    if (this.#state.isActive) return;

    this.#logger.info("Starting pre-loading");
    this.#state.isPreloading = true;
    this.#state.isActive = true;
    this.#scheduleNext();
  };

  #startScheduling = (): void => {
    if (this.#state.isActive && !this.#state.isPreloading) return;

    this.#logger.info("Starting scheduling");
    this.#state.isActive = true;
    this.#state.isPreloading = false;
    this.#state.currentInterval = this.#config.baseInterval;
    this.#scheduleNext();
  };

  #stopScheduling = (): void => {
    this.#logger.debug("Stopping scheduling");
    this.#state.isActive = false;
    this.#clearScheduleTimer();
  };

  #resumeScheduling = (): void => {
    if (!this.#state.isActive) return;

    this.#logger.debug("Resuming scheduling");
    this.#scheduleNext();
  };

  #scheduleNext = (): void => {
    this.#clearScheduleTimer();

    if (!this.#state.isActive) return;

    this.#logger.debug(`Scheduling next in ${this.#state.currentInterval}ms`);
    this.#scheduleTimeout = window.setTimeout(() => {
      this.#schedule();
    }, this.#state.currentInterval);
  };

  #clearScheduleTimer = (): void => {
    if (this.#scheduleTimeout !== null) {
      clearTimeout(this.#scheduleTimeout);
      this.#scheduleTimeout = null;
    }
  };

  #schedule = async (): Promise<void> => {
    if (!this.#state.isActive) return;

    const startTime = performance.now();
    this.#performanceMetrics.scheduleCalls++;

    try {
      // Check if we should switch quality (only during playback)
      if (!this.#state.isPreloading && this.#shouldCheckQuality()) {
        const qualityChanged = await this.#checkAndSwitchQuality();
        if (qualityChanged) {
          this.#performanceMetrics.qualityChanges++;
          // Quality change will trigger its own scheduling
          return;
        }
      }

      // Load fragments for all buffer controllers
      await this.#loadFragments();

      // Update state
      this.#state.lastScheduleTime = Date.now();
    } catch (error) {
      this.#logger.error("Error during scheduling:", error);
      this.#state.consecutiveErrors++;
    } finally {
      const elapsed = performance.now() - startTime;
      this.#logger.debug(`Schedule cycle completed in ${elapsed.toFixed(2)}ms`);

      this.#scheduleNext();
    }
  };

  #loadFragments = async (): Promise<void> => {
    const promises: Promise<void>[] = [];

    // During preloading, limit how much we buffer
    const targetLevel = this.#state.isPreloading
      ? this.#config.preloadTarget
      : Number.POSITIVE_INFINITY; // Let buffer controller decide

    // Load video fragments
    if (bufferController.getBufferLevel() < targetLevel) {
      promises.push(bufferController.loadNextSegments());
    }

    // Load audio fragments if needed
    if (audioBufferController.getBufferLevel() < targetLevel) {
      promises.push(audioBufferController.loadNextSegments());
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  };

  #shouldCheckQuality = (): boolean => {
    if (!this.#config.enableQualityCheck) return false;
    if (playbackController.isPaused()) return false;

    const now = Date.now();
    const timeSinceLastCheck = now - this.#state.lastQualityCheckTime;

    return timeSinceLastCheck >= this.#config.qualityCheckInterval;
  };

  #checkAndSwitchQuality = async (): Promise<boolean> => {
    // Update dropped frames history
    const videoRep = playbackController.getCurrentVideoRepresentation();
    if (videoRep) {
      droppedFramesHistory.push(0, videoRep.id, video.getPlaybackQuality());
    }

    // Check if quality should change
    const qualityChanged = abrController.checkPlaybackQuality();

    if (qualityChanged) {
      this.#state.lastQualityCheckTime = Date.now();
    }

    return qualityChanged;
  };

  #adjustSchedulingInterval = (bufferLevel: number): void => {
    const bufferTarget = bufferController.getBufferTarget();

    let targetInterval: number;

    // Below critical level, always use minimum interval
    if (bufferLevel < this.#config.criticalBufferLevel) {
      targetInterval = this.#config.minInterval;
      this.#logger.debug(
        `Critical buffer level (${bufferLevel.toFixed(
          1
        )}s), using minimum interval (${this.#config.minInterval}ms)`
      );
    }
    // Buffer is filling: gradual slowdown as we approach target
    else if (bufferLevel < bufferTarget) {
      const fillRatio = bufferLevel / bufferTarget;

      if (fillRatio < this.#config.slowdownThreshold) {
        // Below slowdown threshold: use base interval
        targetInterval = this.#config.baseInterval;
      } else {
        // Above slowdown threshold: gradually increase interval
        // Linear interpolation from base to max based on how close to target
        const slowdownRange = 1.0 - this.#config.slowdownThreshold;
        const slowdownPosition =
          (fillRatio - this.#config.slowdownThreshold) / slowdownRange;

        targetInterval =
          this.#config.baseInterval +
          (this.#config.maxInterval - this.#config.baseInterval) *
            slowdownPosition;
      }

      // Never wait longer than segment duration when buffer isn't full
      const maxReasonableInterval =
        this.#state.averageSegmentDuration * 1000 * 0.5;
      targetInterval = Math.min(targetInterval, maxReasonableInterval);

      this.#logger.debug(
        `Buffer at ${bufferLevel.toFixed(1)}s/${bufferTarget}s ` +
          `(${(fillRatio * 100).toFixed(0)}%), interval: ${targetInterval}ms`
      );
    }
    // Buffer is at or above target
    else {
      // Use max interval but still check periodically
      targetInterval = this.#config.maxInterval;
      this.#logger.debug(
        `Buffer full (${bufferLevel.toFixed(
          1
        )}s/${bufferTarget}s), using max interval (${
          this.#config.maxInterval
        }ms)`
      );
    }

    // Smooth transition to avoid abrupt changes
    const currentInterval = this.#state.currentInterval;
    this.#state.currentInterval = currentInterval * 0.7 + targetInterval * 0.3;

    // Ensure within bounds
    this.#state.currentInterval = Math.max(
      this.#config.minInterval,
      Math.min(this.#config.maxInterval, this.#state.currentInterval)
    );
  };

  // Quality check management
  #startQualityCheck = (): void => {
    if (!this.#config.enableQualityCheck) return;

    this.#logger.debug("Starting quality check timer");
    this.#scheduleQualityCheck();
  };

  #stopQualityCheck = (): void => {
    if (this.#qualityCheckTimeout !== null) {
      clearTimeout(this.#qualityCheckTimeout);
      this.#qualityCheckTimeout = null;
    }
  };

  #scheduleQualityCheck = (): void => {
    this.#stopQualityCheck();

    if (playbackController.isPaused()) return;

    this.#qualityCheckTimeout = window.setTimeout(() => {
      this.#checkAndSwitchQuality().then(() => {
        this.#scheduleQualityCheck();
      });
    }, this.#config.qualityCheckInterval);
  };

  #resetState = (): void => {
    this.#state = {
      isActive: false,
      isPreloading: false,
      lastScheduleTime: 0,
      lastQualityCheckTime: 0,
      consecutiveErrors: 0,
      currentInterval: this.#config.baseInterval,
      averageSegmentDuration: 4,
    };

    this.#performanceMetrics = {
      scheduleCalls: 0,
      qualityChanges: 0,
      bufferStalls: 0,
      lastBufferLevel: 0,
    };
  };

  // Public API
  getState = (): Readonly<ScheduleState> => {
    return { ...this.#state };
  };

  getMetrics = (): Readonly<PerformanceMetrics> => {
    return { ...this.#performanceMetrics };
  };

  updateConfig = (config: Partial<ScheduleConfig>): void => {
    this.#config = { ...this.#config, ...config };
    this.#logger.info("Config updated:", this.#config);
  };

  forceSchedule = (): void => {
    this.#logger.debug("Force schedule requested");
    this.#clearScheduleTimer();
    this.#schedule();
  };
}
