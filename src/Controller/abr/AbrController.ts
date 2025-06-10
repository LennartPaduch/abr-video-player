import { eventBus, Payload } from "../../Events/EventBus.js";
import { Events } from "../../Events/Events.js";
import { logger } from "../../Logger.js";
import {
  AbrStrategy,
  AbrStrategyType,
  VideoRepresentation,
} from "../../Types.js";
import { Assert } from "../../utils/assertion.js";
import { bandwidthAbr } from "./BandwidthAbr.js";
import { BufferAbr } from "./BufferAbr.js";
import { bufferController } from "../BufferController.js";
import { DroppedFramesAbr } from "./DroppedFramesAbr.js";
import { playbackController } from "../PlaybackController.js";
import { MediaPlayerEvents } from "../../Events/MediaPlayerEvents.js";
import { filterRepresentations, sortRepresentations } from "./utils.js";

interface AbrConfig {
  minBufferLevel: number;
  maxBufferLevel: number;
  qualityChangeThreshold: number;
  switchCooldownPeriod: number;
  startupStrategy: AbrStrategyType;
  allowSmoothing: boolean;
  smoothingEnableDelay: number;
  smoothingFactor: number;
  abrEnabled: boolean;
}

class AbrController {
  // Default configuration
  static readonly DEFAULT_CONFIG: AbrConfig = {
    minBufferLevel: 10,
    maxBufferLevel: 90, // BOLAE internal only for virtual buffer
    qualityChangeThreshold: 0.2,
    switchCooldownPeriod: 5000, // 5 seconds
    startupStrategy: "Bandwidth",
    allowSmoothing: true, //
    smoothingEnableDelay: 5000, // delay in ms after which smoothing is enabled if allowSmothing flag is set to true, for quicker reponses after seeks and playback starts
    smoothingFactor: 0.5,
    abrEnabled: true,
  };

  #config: AbrConfig;

  #smoothingActive: boolean = false; // <— runtime state
  #smoothingTimerId: number | null = null;

  // ABR strategies
  #strategies: Map<AbrStrategyType, AbrStrategy>;
  #currentStrategy: AbrStrategyType;

  // State management
  #lastSwitchTime: number = 0;
  #representations: VideoRepresentation[] = [];
  #filteredRepresentations: VideoRepresentation[] = [];
  #qualityHistory: Array<{ timestamp: number; quality: number }> = [];
  #logger = logger.createChild("AbrController");

  constructor(config: Partial<AbrConfig> = {}) {
    this.#config = { ...AbrController.DEFAULT_CONFIG, ...config };
    this.#currentStrategy = this.#config.startupStrategy;

    const bufferAbr = new BufferAbr(
      this.#config.minBufferLevel,
      this.#config.maxBufferLevel,
      this.#config.qualityChangeThreshold
    );
    const droppedFramesAbr = new DroppedFramesAbr();

    this.#strategies = new Map<AbrStrategyType, AbrStrategy>();
    this.#strategies.set("Bandwidth", bandwidthAbr);
    this.#strategies.set("Buffer", bufferAbr);
    this.#strategies.set("DroppedFrames", droppedFramesAbr);

    this.#initEventListeners();
  }

  #initEventListeners = (): void => {
    const busEvents: [string, (payload: Payload) => void][] = [
      [Events.REPRESENTATIONS_CHANGED, this.#onRepresentationsChanged],
      [MediaPlayerEvents.DIMENSIONS_CHANGED, this.#onDimensionsChange],
      [MediaPlayerEvents.PLAYBACK_STARTED, this.#onPlaybackStarted],
      [Events.FORCE_VIDEO_BITRATE_CHANGE, this.#onForcedBitrateChange],
      [Events.VIDEO_BITRATE_CHANGED, this.#onVideoBitRateChanged],
      [Events.ENABLE_ABR, this.#onEnableAbr],
      [MediaPlayerEvents.SEEKED, this.#onSeeked],
      /*     [
          MediaPlayerEvents.QUALITY_CHANGE_RENDERED,
          this.#onQualityChangeRendered,  
        ], */
    ];

    busEvents.forEach(([event, handler]) => {
      eventBus.on(event, handler.bind(this), this);
    });
  };

  #resetSmoothingTimer(): void {
    // stop any previous delay
    if (this.#smoothingTimerId !== null) {
      clearTimeout(this.#smoothingTimerId);
    }

    // if the feature is allowed, start the delay
    if (this.#config.allowSmoothing) {
      this.#logger.info(
        `Disabling smoothing for ${
          (this, this.#config.smoothingEnableDelay / 1e3)
        }s`
      );
      this.#smoothingActive = false;
      this.#smoothingTimerId = window.setTimeout(() => {
        this.#logger.info("Enabling smoothing");
        this.#smoothingActive = true;
        this.#smoothingTimerId = null;
      }, this.#config.smoothingEnableDelay);
    }
  }

  #onVideoBitRateChanged = (payload: Payload): void => {
    Assert.assertDefined(payload.switchReason);
    if (payload.switchReason === "Start") {
      this.#resetSmoothingTimer();
    }
  };

  #onSeeked = (): void => {
    this.#resetSmoothingTimer();
  };

  #onForcedBitrateChange = (): void => {
    this.#config.abrEnabled = false;
  };

  #onEnableAbr = (): void => {
    this.#config.abrEnabled = true;
  };

  #onDimensionsChange = (): void => {
    if (this.#representations.length === 0) return;

    const filteredRepresentations = sortRepresentations(
      filterRepresentations(this.#representations)
    ) as VideoRepresentation[];

    if (
      filteredRepresentations.length !== this.#filteredRepresentations?.length
    ) {
      this.#updateFilteredRepresentations(filteredRepresentations);
      return;
    }

    const hasChanged = filteredRepresentations.some(
      (rep, index) => rep.id !== this.#filteredRepresentations[index]?.id
    );

    if (hasChanged) {
      this.#updateFilteredRepresentations(filteredRepresentations);
    }
  };

  #updateFilteredRepresentations = (
    newRepresentations: VideoRepresentation[]
  ): void => {
    this.#filteredRepresentations = newRepresentations;

    for (const strategy of this.#strategies.values()) {
      strategy.setRepresentations(this.#filteredRepresentations);
    }
  };

  #onRepresentationsChanged = (payload: Payload): void => {
    Assert.assert(
      payload.representations?.videoRepresentations.length,
      "Payload has to contain representation data!"
    );

    this.#representations = payload.representations.videoRepresentations;
    this.#filteredRepresentations = sortRepresentations(
      filterRepresentations(this.#representations)
    ) as VideoRepresentation[];

    // Update representations for all strategies
    for (const strategy of this.#strategies.values()) {
      strategy.setRepresentations(this.#filteredRepresentations);
    }
  };

  #onPlaybackStarted = (): void => {
    this.#qualityHistory = [];
    this.#lastSwitchTime = 0;
  };

  /*   #onQualityChangeRendered = (payload: Payload): void => {
      const representation = payload.representation as Representation;
      this.#qualityHistory.push({
        timestamp: Date.now(),
        quality: representation.id,
      });

      if (this.#qualityHistory.length > 10) {
        this.#qualityHistory.shift();
      }
    }; */

  #detectOscillation = (): boolean => {
    if (this.#qualityHistory.length < 4) return false;

    const recentSwitches = this.#qualityHistory.slice(-4);
    return recentSwitches.every((switch_, index) =>
      index % 2 === 0
        ? switch_.quality === recentSwitches[0].quality
        : switch_.quality === recentSwitches[1].quality
    );
  };

  #smoothQualitySelection = (
    chosen: VideoRepresentation
  ): VideoRepresentation => {
    if (!this.#smoothingActive) return chosen;

    const current = playbackController.getCurrentVideoRepresentation();
    const availableQualities = this.#filteredRepresentations;

    const currentIndex = availableQualities.findIndex(
      (r) => r.id === current.id
    );

    if (currentIndex === -1) {
      this.#logger.debug(
        "Current quality not in filtered list, skipping smoothing"
      );
      return chosen;
    }

    if (this.#detectOscillation()) {
      this.#logger.debug(
        "Quality oscillation detected, applying conservative smoothing"
      );
      return chosen.bitrate > current.bitrate
        ? availableQualities[currentIndex]
        : chosen;
    }

    const targetIndex = availableQualities.findIndex((r) => r.id === chosen.id);
    const smoothedIndex = Math.round(
      currentIndex + (targetIndex - currentIndex) * this.#config.smoothingFactor
    );

    return availableQualities[smoothedIndex];
  };

  checkPlaybackQuality = (): boolean => {
    const now = Date.now();

    if (now - this.#lastSwitchTime < this.#config.switchCooldownPeriod) {
      this.#logger.debug("Quality switch prevented by cooldown period");
      return false;
    }

    if (!this.#config.abrEnabled) {
      this.#logger.debug("ABR disabled, skipping quality check");
      return false;
    }

    const currentRepresentation =
      playbackController.getCurrentVideoRepresentation();
    if (!currentRepresentation) {
      this.#logger.warn("No current representation available");
      return false;
    }

    let usedStrategy: AbrStrategyType = this.#currentStrategy;
    let chosenRepresentation: VideoRepresentation | null = null;

    // Check DroppedFrames strategy first (emergency downscaling)
    const droppedFramesStrategy = this.#strategies.get(
      "DroppedFrames"
    ) as DroppedFramesAbr;
    chosenRepresentation = droppedFramesStrategy.chooseRepresentation();

    if (chosenRepresentation) {
      usedStrategy = "DroppedFrames";
      this.#logger.debug("DroppedFrames strategy selected representation");
    } else {
      // Choose strategy based on buffer level
      const bufferLevel = bufferController.getBufferLevel();
      usedStrategy =
        bufferLevel >= this.#config.minBufferLevel ? "Buffer" : "Bandwidth";

      this.#logger.debug(
        `Using ${usedStrategy} strategy (buffer: ${bufferLevel.toFixed(1)}s)`
      );

      const strategy = this.#strategies.get(usedStrategy);
      if (!strategy) {
        this.#logger.error(`Strategy ${usedStrategy} not found`);
        return false;
      }

      chosenRepresentation = strategy.chooseRepresentation();
    }

    if (!chosenRepresentation) {
      this.#logger.debug("No representation chosen by strategy");
      return false;
    }

    if (currentRepresentation.id === chosenRepresentation.id) {
      this.#logger.debug(
        `Strategy "${usedStrategy}" chose same quality (${chosenRepresentation.height}p), no change needed`
      );
      return false;
    }

    // Apply smoothing if enabled
    const originalChoice = chosenRepresentation;
    if (this.#smoothingActive) {
      chosenRepresentation = this.#smoothQualitySelection(chosenRepresentation);

      if (currentRepresentation.id === chosenRepresentation.id) {
        this.#logger.debug(
          `Smoothing returned same quality (${chosenRepresentation.height}p), no change needed. `
        );
        return false;
      } else {
        this.#logger.debug(
          `After smoothing: ${chosenRepresentation.height}p. ` +
            `Original choice was ${originalChoice.height}p`
        );
      }
    }

    // Final validation before triggering
    if (currentRepresentation.id === chosenRepresentation.id) {
      this.#logger.warn(
        "Unexpected: chosen representation same as current after all checks"
      );
      return false;
    }

    // All checks passed - trigger the change
    this.#currentStrategy = usedStrategy;
    this.#lastSwitchTime = now;

    this.#logger.info(
      `Quality change: ${currentRepresentation.height}p → ${chosenRepresentation.height}p ` +
        `(${currentRepresentation.bitrate} → ${chosenRepresentation.bitrate} bps) | ` +
        `strategy: ${usedStrategy}${this.#smoothingActive ? " (smoothed)" : ""}`
    );

    eventBus.trigger(Events.QUALITY_CHANGE_REQUESTED, {
      videoRepresentation: chosenRepresentation,
      switchReason: usedStrategy,
    });

    return true;
  };

  updateConfig = (newConfig: Partial<AbrConfig>): void => {
    this.#config = { ...this.#config, ...newConfig };

    const bufferStrategy = this.#strategies.get("Buffer") as BufferAbr;
    if (bufferStrategy) {
      bufferStrategy.updateConfig({
        minBufferLevel: this.#config.minBufferLevel,
        maxBufferLevel: this.#config.maxBufferLevel,
        qualityChangeThreshold: this.#config.qualityChangeThreshold,
      });
    }
  };

  getQualityHistory = (): Array<{ timestamp: number; quality: number }> => {
    return [...this.#qualityHistory];
  };

  getCurrentStrategy = (): AbrStrategyType => {
    return this.#currentStrategy;
  };
}

export const abrController = new AbrController();
