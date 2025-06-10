import { bufferController } from "../BufferController.js";
import {
  BolaAlgorithmState,
  BolaState,
  VideoRepresentation,
} from "../../Types.js";
import { logger } from "../../Logger.js";
import { eventBus, Payload } from "../../Events/EventBus.js";
import { Events } from "../../Events/Events.js";
import { Assert } from "../../utils/assertion.js";
import { MediaPlayerEvents } from "../../Events/MediaPlayerEvents.js";
import { SegmentReference } from "../../Dash/Segment/SegmentReference.js";
import { bandwidthEstimator } from "../../BandwidthEstimator.js";

export class BufferAbr {
  readonly #SAFETY_FACTOR_INCREASE = 1.2;
  readonly #SAFETY_FACTOR_DECREASE = 0.95;
  readonly #MINIMUM_BUFFER_PER_BITRATE_LEVEL = 2;
  readonly #STARTUP_SEGMENTS_THRESHOLD = 2; // Switch to steady state after this many segments
  readonly #THROUGHPUT_SAFETY_FACTOR = 0.9;

  #minBufferLevel: number;
  #maxBufferLevel: number;
  #qualityChangeThreshold: number;
  #bufferTarget: number;

  #bolaState: BolaState | null = null;
  #logger = logger.createChild("BufferAbr");

  constructor(
    minBufferLevel: number,
    maxBufferLevel: number,
    qualityChangeThreshold: number
  ) {
    this.#minBufferLevel = minBufferLevel;
    this.#maxBufferLevel = maxBufferLevel;
    this.#qualityChangeThreshold = qualityChangeThreshold;
    this.#bufferTarget = bufferController.getBufferTarget() || 60;

    this.#initEventHandlers();
  }

  #initEventHandlers = (): void => {
    const busEvents: [string, (payload: Payload) => void][] = [
      [Events.BUFFER_EMPTY, this.#onBufferEmpty],
      [Events.FRAGMENT_LOADING_STARTED, this.#onFragmentLoadingStarted],
      [Events.FRAGMENT_LOADING_COMPLETED, this.#onFragmentLoadingCompleted],
      [Events.BUFFER_TARGET_CHANGED, this.#onBufferTargetChanged],
      [MediaPlayerEvents.SEEKED, this.#onPlaybackSeeked],
      [MediaPlayerEvents.PLAYBACK_STARTED, this.#onPlaybackStarted],
    ];

    busEvents.forEach(([event, handler]) => {
      eventBus.on(event, handler.bind(this), this);
    });
  };

  #onBufferTargetChanged = (payload: Payload): void => {
    if (payload.newBufferTarget) this.#bufferTarget = payload.newBufferTarget;
  };

  #onPlaybackStarted = (): void => {
    if (!this.#bolaState) return;

    // Start in STARTUP state
    this.#bolaState.algorithmState = "STARTUP";
    this.#clearBolaStateOnSeek();
    this.#logger.info("Playback started - using STARTUP state");
  };

  #onPlaybackSeeked = (): void => {
    if (!this.#bolaState) return;

    if (this.#bolaState.algorithmState !== "ONE_BITRATE") {
      this.#bolaState.algorithmState = "STARTUP";
      this.#clearBolaStateOnSeek();
      this.#logger.info("Seek detected - switched to STARTUP state");
    }
  };

  #clearBolaStateOnSeek = (): void => {
    if (!this.#bolaState) return;

    // Clear all timing and placeholder data
    this.#bolaState.placeholderBuffer = 0;
    this.#bolaState.mostAdvancedSegmentStart = NaN;
    this.#bolaState.lastSegmentWasReplacement = false;
    this.#bolaState.lastSegmentStart = NaN;
    this.#bolaState.lastSegmentDurationS = NaN;
    this.#bolaState.lastSegmentRequestTimeMs = NaN;
    this.#bolaState.lastSegmentFinishTimeMs = NaN;
    this.#bolaState.segmentCount = 0;
  };

  #onBufferEmpty = (): void => {
    if (!this.#bolaState) return;

    // Record rebuffer time and clear placeholder
    this.#bolaState.rebufferStartTimeMs = Date.now();
    this.#bolaState.placeholderBuffer = 0;

    // Switching back to STARTUP state
    if (this.#bolaState.algorithmState === "STEADY_STATE") {
      this.#bolaState.algorithmState = "STARTUP";
      this.#logger.info("Buffer empty - switched back to STARTUP state");
    }
  };

  #onFragmentLoadingStarted = (payload: Payload): void => {
    Assert.assertDefined(payload.segmentRef);
    this.#onSegmentDownloadBegin(payload.segmentRef);
  };

  #onFragmentLoadingCompleted = (payload: Payload): void => {
    this.#onSegmentDownloadEnd(payload);
  };

  setRepresentations = (representations: VideoRepresentation[]): void => {
    Assert.assert(representations.length > 0, "Empty representations array");

    this.#logger.debug("Setting representations:", representations);

    const wasInitialized = this.#bolaState !== null;
    const previousRepresentation = this.#bolaState?.currentRepresentation;

    // Initialize new state but preserve algorithm state
    const previousAlgorithmState = this.#bolaState?.algorithmState;
    this.#bolaState = this.#initBolaState(representations);

    // Restore or determine algorithm state
    if (!wasInitialized) {
      this.#bolaState.algorithmState = "STARTUP";
    } else if (previousAlgorithmState) {
      this.#bolaState.algorithmState = previousAlgorithmState;
    }

    // Check if there is only one representation
    if (representations.length === 1) {
      this.#bolaState.algorithmState = "ONE_BITRATE";
      this.#bolaState.currentRepresentation = representations[0];
    } else if (previousRepresentation) {
      // Try to preserve the current representation
      const matchingRep = representations.find(
        (rep) => rep.id === previousRepresentation.id
      );

      if (matchingRep) {
        // Same representation still exists
        this.#bolaState.currentRepresentation = matchingRep;
      } else {
        // Find closest representation by bitrate
        this.#bolaState.currentRepresentation = this.#findClosestRepresentation(
          previousRepresentation,
          representations
        );
        if (
          this.#bolaState.currentRepresentation &&
          previousRepresentation &&
          this.#bolaState.currentRepresentation.id !== previousRepresentation.id
        ) {
          // Adjust placeholder buffer for the new quality level
          const bufferLevel = bufferController.getBufferLevel();
          const minBufferForNewRep = this.#getMinBufferLevelForRepresentation(
            this.#bolaState.currentRepresentation
          );

          // Only increase placeholder if needed for new quality
          if (
            bufferLevel + this.#bolaState.placeholderBuffer <
            minBufferForNewRep
          ) {
            this.#bolaState.placeholderBuffer = Math.max(
              this.#bolaState.placeholderBuffer,
              minBufferForNewRep - bufferLevel
            );
          }
        }
      }

      this.#logger.debug(
        `Preserved/adapted representation: ${
          previousRepresentation.height
        }p -> ${this.#bolaState.currentRepresentation.height}p`
      );
    }

    this.#logger.debug("BOLA State initialized:", this.#bolaState);
  };

  #findClosestRepresentation = (
    targetRep: VideoRepresentation,
    availableReps: VideoRepresentation[]
  ): VideoRepresentation => {
    // Find representation with closest bitrate
    let closest = availableReps[0];
    let minDiff = Math.abs(targetRep.bitrate - closest.bitrate);

    for (const rep of availableReps) {
      const diff = Math.abs(targetRep.bitrate - rep.bitrate);
      if (diff < minDiff) {
        minDiff = diff;
        closest = rep;
      }
    }

    return closest;
  };

  chooseRepresentation = (): VideoRepresentation | null => {
    Assert.assertDefined(this.#bolaState);

    switch (this.#bolaState.algorithmState) {
      case "ONE_BITRATE":
        return this.#bolaState.representations[0];

      case "STARTUP":
        return this.#chooseThroughputBasedRepresentation();

      case "STEADY_STATE":
        return this.#chooseBufferBasedRepresentation();

      default:
        return this.#chooseBufferBasedRepresentation();
    }
  };

  #chooseThroughputBasedRepresentation = (): VideoRepresentation => {
    Assert.assertDefined(this.#bolaState);

    const throughputBps = bandwidthEstimator.getBandwidthEstimate();

    if (isNaN(throughputBps)) {
      // No throughput data yet, return lowest quality
      return this.#bolaState.representations[0];
    }

    const safeThroughput = throughputBps * this.#THROUGHPUT_SAFETY_FACTOR;

    // Select best representation for throughput
    let selected = this.#bolaState.representations[0];
    for (const rep of this.#bolaState.representations) {
      if (rep.bitrate <= safeThroughput) {
        selected = rep;
      } else {
        break;
      }
    }

    // Set placeholder buffer to reach the required buffer level for this quality
    const bufferLevel = bufferController.getBufferLevel();
    const minBufferForRep = this.#getMinBufferLevelForRepresentation(selected);
    this.#bolaState.placeholderBuffer = Math.max(
      0,
      minBufferForRep - bufferLevel
    );

    this.#logger.debug(
      `STARTUP state - Throughput: ${(throughputBps / 1e6).toFixed(1)}Mbps, ` +
        `Selected: ${selected.height}p, ` +
        `Buffer: ${bufferLevel.toFixed(2)}s, ` +
        `MinRequired: ${minBufferForRep.toFixed(2)}s, ` +
        `Placeholder: ${this.#bolaState.placeholderBuffer.toFixed(2)}s`
    );

    // Store current representation
    this.#bolaState.currentRepresentation = selected;

    // Transition to steady state if buffered enough (at least one segment duration)
    if (
      !isNaN(this.#bolaState.lastSegmentDurationS) &&
      bufferLevel >= this.#bolaState.lastSegmentDurationS
    ) {
      this.#bolaState.algorithmState = "STEADY_STATE";
      this.#logger.info("Transitioned to STEADY_STATE");
    }

    return selected;
  };

  #shouldTransitionToSteadyState = (): boolean => {
    if (!this.#bolaState) return false;

    // Transition after downloading enough segments and having sufficient buffer
    const bufferLevel = bufferController.getBufferLevel();
    const hasEnoughSegments =
      this.#bolaState.segmentCount >= this.#STARTUP_SEGMENTS_THRESHOLD;
    const hasEnoughBuffer = bufferLevel >= this.#minBufferLevel;

    return hasEnoughSegments && hasEnoughBuffer;
  };

  #chooseBufferBasedRepresentation = (): VideoRepresentation => {
    Assert.assertDefined(this.#bolaState);
    Assert.assertDefined(this.#bolaState.currentRepresentation);

    // Update placeholder buffer for non-bandwidth delays
    this.#updatePlaceholderBuffer();

    const bufferLevel = bufferController.getBufferLevel();
    const effectiveBuffer = bufferLevel + this.#bolaState.placeholderBuffer;

    // Get BOLA's choice based on effective buffer
    let representation =
      this.#getRepresentationFromBufferLevel(effectiveBuffer);

    // Prevent oscillations by checking throughput
    const throughputBps = bandwidthEstimator.getBandwidthEstimate();
    if (!isNaN(throughputBps)) {
      const safeThroughput = throughputBps * this.#THROUGHPUT_SAFETY_FACTOR;
      const throughputRep =
        this.#getOptimalRepresentationForThroughput(safeThroughput);

      // Only intervene if trying to increase quality to an unsustainable level
      if (
        representation.bitrate >
          this.#bolaState.currentRepresentation?.bitrate &&
        representation.bitrate > throughputRep.bitrate
      ) {
        // Choose the higher of: throughput-based choice or current quality
        if (
          throughputRep.bitrate > this.#bolaState.currentRepresentation.bitrate
        ) {
          representation = throughputRep;
        } else {
          representation = this.#bolaState.currentRepresentation;
        }
        this.#logger.debug("BOLA-O: Prevented unsustainable quality increase");
      }
    }

    // Handle buffer overflow - reduce placeholder or delay downloads
    const maxBufferForRep =
      this.#getMaxBufferLevelForRepresentation(representation);
    let delayS = Math.max(0, effectiveBuffer - maxBufferForRep);

    if (delayS > 0) {
      // First reduce placeholder buffer
      if (delayS <= this.#bolaState.placeholderBuffer) {
        this.#bolaState.placeholderBuffer -= delayS;
        delayS = 0;
        this.#logger.debug(
          `Reduced placeholder by ${delayS.toFixed(2)}s to prevent overflow`
        );
      } else {
        // Reduce placeholder to 0 and report remaining delay
        delayS -= this.#bolaState.placeholderBuffer;
        this.#bolaState.placeholderBuffer = 0;

        if (!this.#isTopQuality(representation)) {
          this.#logger.debug(
            `Need to delay next download by ${delayS.toFixed(2)}s`
          );
        }
      }
    }

    this.#logger.debug(
      `STEADY_STATE - Buffer: ${bufferLevel.toFixed(2)}s, ` +
        `Placeholder: ${this.#bolaState.placeholderBuffer.toFixed(2)}s, ` +
        `Effective: ${effectiveBuffer.toFixed(2)}s, ` +
        `Selected: ${representation.height}p`
    );

    // Update current representation
    this.#bolaState.currentRepresentation = representation;

    return representation;
  };

  #updatePlaceholderBuffer = (): void => {
    if (!this.#bolaState) return;

    const nowMs = Date.now();
    const MS_TO_SEC = 0.001;

    // Calculate delay to add to placeholder
    if (!isNaN(this.#bolaState.lastSegmentFinishTimeMs)) {
      // Time since last segment finished downloading
      const delay =
        MS_TO_SEC * (nowMs - this.#bolaState.lastSegmentFinishTimeMs);
      this.#bolaState.placeholderBuffer += Math.max(0, delay);
    } else if (!isNaN(this.#bolaState.lastCallTimeMs)) {
      // No download happened between calls to this algorithm
      const delay = MS_TO_SEC * (nowMs - this.#bolaState.lastCallTimeMs);
      this.#bolaState.placeholderBuffer += Math.max(0, delay);
    }

    // Reset timing data after calculating delay
    // This prevents accumulating the same delay multiple times
    this.#bolaState.lastCallTimeMs = nowMs;
    this.#bolaState.lastSegmentStart = NaN;
    this.#bolaState.lastSegmentRequestTimeMs = NaN;
    this.#bolaState.lastSegmentFinishTimeMs = NaN;

    // Check against maximum allowed placeholder
    this.#checkPlaceholderBufferLimit();
  };

  #checkPlaceholderBufferLimit = (): void => {
    if (!this.#bolaState) return;

    const maxPlaceholder = this.#maxBufferLevel - this.#bufferTarget;

    if (this.#bolaState.placeholderBuffer > maxPlaceholder) {
      this.#logger.debug(
        `Placeholder buffer (${this.#bolaState.placeholderBuffer.toFixed(
          2
        )}s) ` + `exceeds maximum (${maxPlaceholder.toFixed(2)}s), capping`
      );
      this.#bolaState.placeholderBuffer = maxPlaceholder;
    }
  };

  #debugBufferThresholds = (): void => {
    if (!this.#bolaState || !this.#bolaState.representations.length) return;
    this.#logger.info("Buffer Thresholds:");
    for (let i = 0; i < this.#bolaState.representations.length; i++) {
      const minBuffer = this.#getMinBufferLevelForRepresentation(
        this.#bolaState.representations[i]
      );
      const maxBuffer = this.#getMaxBufferLevelForRepresentation(
        this.#bolaState.representations[i]
      );
      this.#logger.debug(
        `${this.#bolaState.representations[i].height}p: ` +
          `${minBuffer.toFixed(1)}s - ${maxBuffer.toFixed(1)}s`
      );
    }
  };

  #initBolaState = (representations: VideoRepresentation[]): BolaState => {
    Assert.assert(
      representations.length > 0,
      "Cannot initialize BOLA with empty representations"
    );

    // Calculate utilities using log function
    let utilities = representations.map((representation) =>
      Math.log(representation.bitrate)
    );

    // Normalize utilities so lowest is 1
    utilities = utilities.map((u) => u - utilities[0] + 1);

    const bufferTimeDefault = 12;
    const bufferTime = Math.max(
      bufferTimeDefault,
      this.#minBufferLevel +
        this.#MINIMUM_BUFFER_PER_BITRATE_LEVEL * representations.length
    );

    const gp =
      (utilities[utilities.length - 1] - 1) /
      (bufferTime / this.#minBufferLevel - 1);
    const vp = this.#minBufferLevel / gp;

    const existingState = this.#bolaState?.algorithmState || "STARTUP";

    this.#debugBufferThresholds();

    return {
      representations,
      utilities,
      gp,
      vp,
      placeholderBuffer: 0,
      currentRepresentation: null,
      lastCallTimeMs: Date.now(),
      lastSegmentStart: NaN,
      lastSegmentRequestTimeMs: NaN,
      lastSegmentFinishTimeMs: NaN,
      algorithmState: existingState,
      lastSegmentDurationS: NaN,
      mostAdvancedSegmentStart: NaN,
      lastSegmentWasReplacement: false,
      rebufferStartTimeMs: NaN,
      segmentCount: 0,
    };
  };

  #onSegmentDownloadBegin = (segmentRef: SegmentReference): void => {
    if (!this.#bolaState) return;

    this.#bolaState.lastSegmentRequestTimeMs = Date.now();
    this.#bolaState.lastSegmentStart = segmentRef.startTime;

    // Track most advanced segment
    if (
      isNaN(this.#bolaState.mostAdvancedSegmentStart) ||
      segmentRef.startTime > this.#bolaState.mostAdvancedSegmentStart
    ) {
      this.#bolaState.mostAdvancedSegmentStart = segmentRef.startTime;
    }
  };

  #onSegmentDownloadEnd = (payload: Payload): void => {
    if (!this.#bolaState) return;

    this.#bolaState.lastSegmentFinishTimeMs = Date.now();
    this.#bolaState.segmentCount++;

    // Track segment duration if available
    if (payload.segmentRef) {
      this.#bolaState.lastSegmentDurationS =
        payload.segmentRef.endTime - payload.segmentRef.startTime;
    }

    // Track if this was a replacement segment
    this.#bolaState.lastSegmentWasReplacement = payload.isReplacement || false;
  };

  #getRepresentationFromBufferLevel = (
    bufferLevel: number
  ): VideoRepresentation => {
    Assert.assertDefined(this.#bolaState);

    let quality = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    // Get current representation for hysteresis
    let currentRepIndex = -1;

    if (this.#bolaState.currentRepresentation) {
      currentRepIndex = this.#bolaState.representations.findIndex(
        (r) => r.id === this.#bolaState!.currentRepresentation!.id
      );
    }

    for (let i = 0; i < this.#bolaState.representations.length; ++i) {
      const score =
        (this.#bolaState.vp *
          (this.#bolaState.utilities[i] + this.#bolaState.gp - 1) -
          bufferLevel) /
        this.#bolaState.representations[i].bitrate;

      // Apply hysteresis to avoid oscillation
      let adjustedScore = score;
      if (currentRepIndex >= 0) {
        const switchingUp = i > currentRepIndex;
        const safetyFactor = switchingUp
          ? this.#SAFETY_FACTOR_INCREASE
          : this.#SAFETY_FACTOR_DECREASE;
        adjustedScore *= safetyFactor;
      }

      if (adjustedScore >= bestScore) {
        bestScore = adjustedScore;
        quality = i;
      }
    }

    const selectedRepresentation = this.#bolaState.representations[quality];
    this.#bolaState.currentRepresentation = selectedRepresentation;

    return selectedRepresentation;
  };

  #getMinBufferLevelForRepresentation = (rep: VideoRepresentation): number => {
    Assert.assertDefined(this.#bolaState);

    const repIndex = this.#bolaState.representations.findIndex(
      (r) => r.id === rep.id
    );
    if (repIndex === -1) return 0;

    // Use BOLA formula to find minimum buffer where this quality would be chosen
    // This is the buffer level where this representation's score equals the next lower one
    if (repIndex === 0) {
      // Lowest quality - always chosen at 0 buffer
      return 0;
    }

    // Find buffer level where rep[i] score = rep[i-1] score
    // Score = (Vp * (utility + gp - 1) - buffer) / bitrate
    const util_i = this.#bolaState.utilities[repIndex];
    const util_prev = this.#bolaState.utilities[repIndex - 1];
    const bitrate_i = this.#bolaState.representations[repIndex].bitrate;
    const bitrate_prev = this.#bolaState.representations[repIndex - 1].bitrate;

    // Solve for buffer level where scores are equal
    const numerator =
      this.#bolaState.vp *
      (util_i * bitrate_prev -
        util_prev * bitrate_i +
        this.#bolaState.gp * (bitrate_prev - bitrate_i));
    const denominator = bitrate_prev - bitrate_i;

    return Math.max(0, numerator / denominator);
  };

  #getMaxBufferLevelForRepresentation = (rep: VideoRepresentation): number => {
    Assert.assertDefined(this.#bolaState);

    const repIndex = this.#bolaState.representations.findIndex(
      (r) => r.id === rep.id
    );
    if (
      repIndex === -1 ||
      repIndex === this.#bolaState.representations.length - 1
    ) {
      // Highest quality or not found - use max buffer
      return this.#maxBufferLevel;
    }

    // Find buffer level where next higher quality would be chosen
    return this.#getMinBufferLevelForRepresentation(
      this.#bolaState.representations[repIndex + 1]
    );
  };

  #getOptimalRepresentationForThroughput = (
    throughputBps: number
  ): VideoRepresentation => {
    Assert.assertDefined(this.#bolaState);

    let selected = this.#bolaState.representations[0];

    for (const rep of this.#bolaState.representations) {
      if (rep.bitrate <= throughputBps) {
        selected = rep;
      } else {
        break;
      }
    }

    return selected;
  };

  #isTopQuality = (rep: VideoRepresentation): boolean => {
    Assert.assertDefined(this.#bolaState);

    const maxBitrate = Math.max(
      ...this.#bolaState.representations.map((r) => r.bitrate)
    );
    return rep.bitrate === maxBitrate;
  };

  updateConfig = (config: {
    minBufferLevel: number;
    maxBufferLevel: number;
    qualityChangeThreshold: number;
  }): void => {
    this.#minBufferLevel = config.minBufferLevel;
    this.#maxBufferLevel = config.maxBufferLevel;
    this.#qualityChangeThreshold = config.qualityChangeThreshold;

    if (this.#bolaState) {
      const currentState = this.#bolaState.algorithmState;
      this.#bolaState = this.#initBolaState(this.#bolaState.representations);
      this.#bolaState.algorithmState = currentState;
    }
  };

  getCurrentState = (): BolaAlgorithmState | null => {
    return this.#bolaState?.algorithmState || null;
  };
}
