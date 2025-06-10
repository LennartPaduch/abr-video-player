import { eventBus, Payload } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { Logger, logger } from "../Logger.js";
import { MediaPlayerEvents } from "../Events/MediaPlayerEvents.js";
import type {
  AudioRepresentation,
  FragmentLoadResult,
  MediaType,
  VideoRepresentation,
} from "../Types.js";
import { Assert } from "../utils/assertion.js";
import { throttle } from "../utils/throttle.js";
import { blacklistController } from "./BlacklistController.js";
import { playbackController } from "./PlaybackController.js";
import { SegmentIndex } from "../Dash/Segment/SegmentIndex.js";
import { SegmentReference } from "../Dash/Segment/SegmentReference.js";
import { manifestParser } from "../Dash/Segment/ManifestParser.js";

interface BufferRange {
  start: number;
  end: number;
}

interface ReplacementTask {
  segmentNumber: number;
  arrayBuffer: ArrayBuffer;
  representationId: string;
  durationMs: number;
  resourceBytes: number;
  transferredBytes: number;
  fromCache: boolean;
  status: number;
}

interface DownloadTask {
  segmentNumber: number;
  url: string;
  representationId: string;
  startTime: number;
  promise: Promise<FragmentLoadResult>;
  type: "media" | "init";
  abortController: AbortController;
  isReplacement?: boolean;
  replacingSegment?: number;
}

interface QueuedSegment {
  segmentNumber: number;
  data: ArrayBuffer;
  duration: number;
  timestamp: number;
  representationId: string;
  bitrate: number;
  bytes: number;
}

interface BufferedSegmentInfo {
  segmentNumber: number;
  startTime: number;
  endTime: number;
  representationId: string;
  bitrate: number;
  bytes: number;
}

interface BufferState {
  level: number;
  criticalLevel: number;
  isCompleted: boolean;
  lastUpdateTime: number;
}

export class BufferController {
  // Buffer configuration
  #config = {
    bufferingTarget: 60,
    bufferBehind: 5,
    pruningInterval: 5,
    pruningSafetyFactor: 0.7,
    behindLiveEdgeSafetyFactor: 0.9,
    quotaExceededCorrectionFactor: 0.8,
    maxConcurrentDownloads: 2,
    tolerance: 1.5,
    smallGapLimit: 1.5,
    jumpLargerGaps: true,
    maxGapSize: 5.0,
    segmentTimeout: 10000,
    maxAllowedOverrun: 4,
    fastSwitchingEnabled: true,
    replacementSafetyFactor: 1.5, // safety factor (1.5x segment duration)
  };

  // MMS detection
  #isManagedMSE: boolean = false;

  // State management
  #state: BufferState = {
    level: 0,
    criticalLevel: NaN,
    isCompleted: false,
    lastUpdateTime: 0,
  };

  // Pipeline and queue management
  #downloadPipeline = new Map<number, DownloadTask>();
  #appendQueue: QueuedSegment[] = [];
  #appendQueueDuration: number = 0;
  #nextSegmentToAppend: number | null = null;
  #nextSegmentToDownload: number | null = null;

  #replacementQueue: ReplacementTask[] = [];
  #isProcessingReplacement = false;
  #replacementsInProgress = new Set<number>();

  #bufferedSegments = new Map<number, BufferedSegmentInfo>();
  #currentRepresentationBitrate: number = 0;
  #currentRepresentationId: string | undefined;

  // Media source management
  #mediaSource: MediaSource | null = null;
  #sourceBuffer: SourceBuffer | null = null;
  #sourceBufferEventHandlers = new Map<string, EventListener>();

  // Utilities
  #type: MediaType;
  #logger: Logger;
  #throttledUpdateBufferLevel: (() => void) & { reset: () => void };
  #pruningIntervalId: number | null = null;
  #isProcessingQueue = false;
  #isShuttingDown = false;
  #quotaExceededInProgress = false;

  readonly #SMALL_GAP_LIMIT = 1.5; // Same as GapController
  readonly #JUMP_LARGER_GAPS = true; // Same as GapController
  // Additional sanity check: even with JUMP_LARGER_GAPS,
  // don't count gaps larger than our buffer target
  readonly #MAX_REASONABLE_GAP = this.#config.bufferingTarget;

  #isStreamingActive: boolean = false;

  constructor(type: MediaType) {
    this.#type = type;
    this.#isManagedMSE = "ManagedMediaSource" in window;
    this.#logger = logger.createChild(`BufferController_${type}`);

    this.#throttledUpdateBufferLevel = throttle(
      () => this.#updateBufferLevel(),
      500
    );

    this.#initEvents();
  }

  #onStartStreamingHandler = (): void => {
    this.#isStreamingActive = true;
  };

  #onStopStreamingHandler = (): void => {
    this.#isStreamingActive = false;
  };

  // Lifecycle methods
  destroy(): void {
    this.#isShuttingDown = true;
    this.#cleanup();
    this.#removeEvents();
  }

  #cleanup = (): void => {
    // Cancel all downloads
    this.#downloadPipeline.forEach((task) => {
      task.abortController.abort();
    });
    this.#downloadPipeline.clear();

    // Clear append queue
    this.#appendQueue = [];

    this.#bufferedSegments.clear();

    // Remove source buffer event listeners
    this.#removeSourceBufferEvents();

    // Clear pruning interval
    if (this.#pruningIntervalId !== null) {
      clearInterval(this.#pruningIntervalId);
      this.#pruningIntervalId = null;
    }
  };

  // Event handling
  #initEvents = (): void => {
    // Register event handlers
    if (this.#type === "video") {
      eventBus.on(
        Events.FORCE_VIDEO_BITRATE_CHANGE,
        this.#handleRepresentationChange,
        this
      );
      eventBus.on(
        Events.QUALITY_CHANGE_REQUESTED,
        this.#handleRepresentationChange,
        this
      );
      eventBus.on(Events.VIDEO_BITRATE_CHANGED, this.#onBitrateChanged, this);
    } else if (this.#type === "audio") {
      eventBus.on(Events.AUDIO_BITRATE_CHANGED, this.#onBitrateChanged, this);
    }

    eventBus.on(MediaPlayerEvents.SEEKED, this.#onSeeked, this);
    eventBus.on(MediaPlayerEvents.SOURCE_CHANGED, this.#onSourceChanged, this);
    eventBus.on(
      MediaPlayerEvents.PLAYBACK_PROGRESS,
      this.#onPlaybackProgress,
      this
    );

    if (!this.#isManagedMSE) {
      this.#pruningIntervalId = window.setInterval(() => {
        this.#pruneBuffer();
      }, this.#config.pruningInterval * 1000);
    }
  };

  #removeEvents = (): void => {
    // Remove all event bus handlers
    eventBus.off(
      Events.FORCE_VIDEO_BITRATE_CHANGE,
      this.#handleRepresentationChange,
      this
    );
    eventBus.off(
      Events.QUALITY_CHANGE_REQUESTED,
      this.#handleRepresentationChange,
      this
    );
    eventBus.off(Events.VIDEO_BITRATE_CHANGED, this.#onBitrateChanged, this);
    eventBus.off(MediaPlayerEvents.SEEKED, this.#onSeeked, this);
    eventBus.off(MediaPlayerEvents.SOURCE_CHANGED, this.#onSourceChanged, this);
    eventBus.off(
      MediaPlayerEvents.PLAYBACK_PROGRESS,
      this.#onPlaybackProgress,
      this
    );
  };

  #initSourceBufferEvents = (): void => {
    if (!this.#sourceBuffer) return;

    const updateEndHandler = () => {
      this.#throttledUpdateBufferLevel.reset();
      this.#updateBufferLevel();
      this.#syncSegmentTrackingWithBuffer();
      if (!this.#isShuttingDown && !this.#isProcessingQueue) {
        // setTimeout to prevent stack overflow
        setTimeout(() => this.#processAppendQueue(), 0);
      }
    };
    this.#sourceBufferEventHandlers.set("updateend", updateEndHandler);
    this.#sourceBuffer.addEventListener("updateend", updateEndHandler);

    const errorHandler = (e: Event) => {
      this.#logger.error("SourceBuffer error:", e);
    };
    this.#sourceBufferEventHandlers.set("error", errorHandler);
    this.#sourceBuffer.addEventListener("error", errorHandler);
  };

  #removeSourceBufferEvents = (): void => {
    if (!this.#sourceBuffer) return;

    this.#sourceBufferEventHandlers.forEach((handler, event) => {
      this.#sourceBuffer!.removeEventListener(event, handler);
    });
    this.#sourceBufferEventHandlers.clear();
  };

  #onPlaybackProgress = (): void => {
    this.#throttledUpdateBufferLevel();
  };

  #onSourceChanged = (payload: Payload): void => {
    Assert.assertDefined(
      payload.mediaSource,
      "Payload did not contain MediaSource"
    );
    this.#logger.debug("Setting mediasource!");
    this.#mediaSource = payload.mediaSource;

    if (this.#isManagedMSE) {
      this.#setupManagedMSE();
    } else {
      this.#setupStandardMSE();
    }
  };

  #setupManagedMSE = (): void => {
    Assert.assertDefined(this.#mediaSource);

    this.#mediaSource.addEventListener(
      "startstreaming",
      this.#onStartStreamingHandler
    );
    this.#mediaSource.addEventListener(
      "endstreaming",
      this.#onStopStreamingHandler
    );
    this.#mediaSource.addEventListener("bufferedchange", () => {
      this.#logger.info("MMS: Browser modified buffer");
    });

    ["sourceopen", "startstreaming", "endstreaming"].forEach((event) => {
      this.#mediaSource!.addEventListener(event, () => {
        this.#logger.debug(
          `MMS Event: ${event} at buffer level ${this.getBufferLevel()}s`
        );
      });
    });
  };

  #setupStandardMSE = (): void => {
    Assert.assertDefined(this.#mediaSource);

    this.#isStreamingActive = true;

    this.#mediaSource.addEventListener("sourceopen", () => {
      this.#logger.debug("MediaSource opened");
    });

    this.#mediaSource.addEventListener("sourceended", () => {
      this.#logger.debug("MediaSource ended");
    });

    this.#mediaSource.addEventListener("sourceclose", () => {
      this.#logger.warn("MediaSource closed");
      this.#cleanup();
    });
  };

  triggerEndOfStream = (): void => {
    this.#mediaSource?.endOfStream();
  };

  #onBitrateChanged = async (payload: Payload): Promise<void> => {
    if (!this.#sourceBuffer) {
      await this.#initBuffer();
    }

    if (
      (payload.videoRepresentation && this.#type === "video") ||
      (payload.audioRepresentation && this.#type === "audio")
    ) {
      const arrrayBuffer = await this.#fetchInitSegment();
      if (!arrrayBuffer) {
        this.#logger.warn(
          "Invalid arrayBuffer: Cannot proceed to append init arrBuffer to sourceBuffer!"
        );
        return;
      }

      try {
        if (this.#sourceBuffer?.updating) {
          await new Promise<void>((resolve) => {
            const onUpdateEnd = () => {
              this.#sourceBuffer!.removeEventListener("updateend", onUpdateEnd);
              resolve();
            };
            this.#sourceBuffer?.addEventListener("updateend", onUpdateEnd, {
              once: true,
            });
          });
        }

        await this.#appendSegment(arrrayBuffer);

        if (this.#type === "video") {
          if (payload.videoRepresentation && payload.switchReason) {
            this.#logger.info(
              `Switched to: ${payload.videoRepresentation.height}p (${payload.videoRepresentation.bitrate} bps), ` +
                `reason: ${payload.switchReason}`
            );
          }
          this.#updateSegmentTracking(payload.videoRepresentation!);
          this.#currentRepresentationBitrate =
            payload.videoRepresentation!.bitrate;
          this.#currentRepresentationId = payload.videoRepresentation?.id;

          if (this.#config.fastSwitchingEnabled) {
            this.#checkForReplaceableSegments();
          }
        } else if (this.#type === "audio") {
          if (payload.audioRepresentation && payload.switchReason) {
            this.#currentRepresentationId = payload.audioRepresentation?.id;
            this.#logger.info(
              `Switched to: ${payload.audioRepresentation.bitrate} bps, ` +
                `reason: ${payload.switchReason}`
            );
            this.#updateSegmentTracking(payload.audioRepresentation!);
          }
        }
      } catch (e) {
        this.#logger.error(
          "Something went wrong appending the init array Buffer to the source Buffer:",
          e
        );
      }
    }
  };

  #checkForReplaceableSegments = (): void => {
    if (!this.#config.fastSwitchingEnabled) return;

    const replaceableSegments = this.#findReplaceableSegments();
    if (replaceableSegments.length > 0) {
      this.#logger.info(
        `Found ${replaceableSegments.length} segments eligible for replacement`
      );

      // Log details about replaceable segments
      replaceableSegments.forEach((seg) => {
        this.#logger.debug(
          `Segment ${seg.segmentNumber} (${
            seg.bitrate
          } bps) can be replaced with ${this.#currentRepresentationBitrate} bps`
        );
      });
    }
  };

  #syncSegmentTrackingWithBuffer = (): void => {
    const ranges = this.#getAllBufferRanges();
    const segmentsToKeep = new Set<number>();

    this.#bufferedSegments.forEach((segInfo, segNum) => {
      // Check if segment is actually in buffer
      for (const range of ranges) {
        if (segInfo.startTime < range.end && segInfo.endTime > range.start) {
          segmentsToKeep.add(segNum);
          break;
        }
      }
    });

    // Remove segments not in buffer
    this.#bufferedSegments.forEach((_, segNum) => {
      if (!segmentsToKeep.has(segNum)) {
        this.#bufferedSegments.delete(segNum);
      }
    });
  };

  #findReplaceableSegments = (): BufferedSegmentInfo[] => {
    const currentTime = playbackController.getTime();
    const replaceable: BufferedSegmentInfo[] = [];

    // Get current representation for segment duration
    const rep = this.#getCurrentRepresentation();

    if (!rep) return replaceable;

    const segmentDuration = 3;
    const safeReplacementThreshold =
      currentTime + segmentDuration * this.#config.replacementSafetyFactor;

    // Check each buffered segment
    this.#bufferedSegments.forEach((segment, segNum) => {
      if (segment.endTime < currentTime) {
        this.#bufferedSegments.delete(segNum);
        return;
      }

      // Skip if segment is too close to playhead
      if (segment.startTime < safeReplacementThreshold) {
        return;
      }

      // Skip if segment is already at or above current bitrate
      if (segment.bitrate >= this.#currentRepresentationBitrate) {
        return;
      }

      // Skip if segment is already being replaced
      const isBeingReplaced = Array.from(this.#downloadPipeline.values()).some(
        (task) =>
          task.isReplacement && task.replacingSegment === segment.segmentNumber
      );
      if (isBeingReplaced) {
        return;
      }

      replaceable.push(segment);
    });

    // Sort by earliest deadline first (closest to playhead)
    replaceable.sort((a, b) => a.startTime - b.startTime);

    return replaceable;
  };

  #shouldDownloadReplacement = (): BufferedSegmentInfo | null => {
    if (!this.#config.fastSwitchingEnabled) return null;

    const replaceableSegments = this.#findReplaceableSegments();

    // Return the earliest replaceable segment (EDF order)
    return replaceableSegments.length > 0 ? replaceableSegments[0] : null;
  };

  #resetAppendQueue = (): void => {
    this.#appendQueue = [];
    this.#appendQueueDuration = 0;
  };

  #onSeeked = async (): Promise<void> => {
    if (!this.#sourceBuffer || !this.#mediaSource) return;

    // Abort current operations
    if (
      this.#mediaSource.readyState === "open" &&
      !this.#sourceBuffer.updating
    ) {
      this.#sourceBuffer.abort();
    }

    // Cancel pending downloads
    this.#cancelPendingDownloads();

    this.#resetAppendQueue();

    const currentTime = playbackController.getTime();
    await this.#pruneBufferOnSeek(currentTime);
    const rep = this.#getCurrentRepresentation();

    if (!rep) {
      this.#logger.error("Representation not set");
      throw new Error("Representation not set");
    }

    this.#updateCurrentSegmentLevel(rep.segmentIndex);

    // Reset expected segment for append queue
    this.#nextSegmentToAppend = this.#nextSegmentToDownload;

    await this.loadNextSegments();
  };

  // Buffer management
  #updateBufferLevel = (): void => {
    if (!this.#sourceBuffer) return;

    const bufferLevel = this.#calculateEffectiveBufferLevel();

    this.#state.level = bufferLevel;
    this.#state.lastUpdateTime = Date.now();

    this.#logger.debug(`Buffer level: ${bufferLevel.toFixed(2)}s`);
    if (this.#type === "video")
      eventBus.trigger(Events.BUFFER_LEVEL_UPDATED, { bufferLevel });
  };

  #calculateEffectiveBufferLevel = (): number => {
    if (!this.#sourceBuffer) return 0;

    const ranges = this.#sourceBuffer.buffered;
    if (ranges.length === 0) return 0;

    const currentTime = playbackController.getTime();

    // Find all ranges ahead of current time
    const futureRanges: BufferRange[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);

      // Include ranges that contain current time or are ahead of it
      if (end > currentTime) {
        futureRanges.push({
          start: Math.max(start, currentTime),
          end: end,
        });
      }
    }

    if (futureRanges.length === 0) return 0;

    // Calculate buffer level considering gaps that GapController will jump
    let effectiveLevel = 0;
    let lastIncludedEnd = currentTime;

    for (let i = 0; i < futureRanges.length; i++) {
      const range = futureRanges[i];
      const gap = range.start - lastIncludedEnd;

      if (gap > 0) {
        if (
          gap <= this.#SMALL_GAP_LIMIT ||
          (this.#JUMP_LARGER_GAPS && gap <= this.#MAX_REASONABLE_GAP)
        ) {
          // Check if this gap is reasonable in context
          // A gap larger than our pruning threshold after current position is suspicious
          const gapStartsNearCurrentPosition =
            gap < this.#config.bufferBehind * 2;

          if (gapStartsNearCurrentPosition || gap <= this.#SMALL_GAP_LIMIT) {
            // GapController will likely jump this gap
            effectiveLevel += gap;
            this.#logger.debug(
              `Including ${gap.toFixed(2)}s gap in buffer level`
            );
          } else {
            // Large gap far from current position - likely from seeking
            this.#logger.debug(
              `Ignoring ${gap.toFixed(2)}s gap - likely from seeking`
            );
            break;
          }
        } else {
          // Gap too large to jump
          this.#logger.debug(`Stopping at ${gap.toFixed(2)}s non-jumpable gap`);
          break;
        }
      }

      // Add the range duration
      effectiveLevel += range.end - range.start;
      lastIncludedEnd = range.end;
    }

    // Final sanity check: buffer level should never exceed our target
    // This handles cases where we have many small jumpable gaps
    effectiveLevel = Math.min(
      effectiveLevel,
      this.#config.bufferingTarget * 1.5
    );

    return Math.max(0, effectiveLevel);
  };

  #getRangeAt = (time: number): BufferRange | null => {
    if (!this.#sourceBuffer) return null;

    const ranges = this.#sourceBuffer.buffered;
    let currentStart: number | null = null;
    let currentEnd: number | null = null;

    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);

      if (currentStart === null) {
        if (time >= start && time < end) {
          currentStart = start;
          currentEnd = end;
        } else if (Math.abs(start - time) <= this.#config.tolerance) {
          currentStart = start;
          currentEnd = end;
        }
      } else if (currentEnd !== null) {
        const gap = start - currentEnd;
        if (gap <= this.#config.tolerance) {
          currentEnd = end;
        } else {
          break;
        }
      }
    }

    return currentStart !== null && currentEnd !== null
      ? { start: currentStart, end: currentEnd }
      : null;
  };

  #pruneBuffer = (): void => {
    if (!this.#sourceBuffer || this.#sourceBuffer.updating) return;
    if (this.#mediaSource?.readyState !== "open") return;

    const currentTime = playbackController.getTime();
    const currentRange = this.#getRangeAt(currentTime);
    if (!currentRange) return;

    const behindThreshold = Math.max(
      0,
      currentTime - this.#config.bufferBehind
    );
    const behindDiff = currentTime - currentRange.start;

    if (behindDiff > this.#config.bufferBehind) {
      try {
        this.#sourceBuffer.remove(0, behindThreshold);
        this.#logger.debug(
          `Pruned buffer from ${currentRange.start.toFixed(
            2
          )} to ${behindThreshold.toFixed(2)}`
        );
      } catch (e) {
        this.#logger.error("Error pruning buffer:", e);
      }
    }
  };

  #pruneBufferOnSeek = async (seekTime: number): Promise<void> => {
    if (!this.#sourceBuffer || this.#sourceBuffer.updating) return;
    if (this.#mediaSource?.readyState !== "open") return;

    const ranges = this.#getAllBufferRanges();
    if (ranges.length === 0) return;

    const keepStart = Math.max(0, seekTime - this.#config.bufferBehind);
    const keepEnd = seekTime + this.#config.bufferingTarget;

    this.#logger.info(
      `Pruning on seek to ${seekTime.toFixed(1)}s. ` +
        `Keep range: [${keepStart.toFixed(1)}, ${keepEnd.toFixed(1)}]. ` +
        `Current ranges: ${ranges
          .map((r) => `[${r.start.toFixed(1)}-${r.end.toFixed(1)}]`)
          .join(", ")}`
    );

    // Check if seek position is buffered
    let isSeekPositionBuffered = false;
    for (const range of ranges) {
      if (seekTime >= range.start && seekTime <= range.end) {
        isSeekPositionBuffered = true;
        break;
      }
    }

    try {
      // Process each buffered range to determine what to remove
      for (const range of ranges) {
        // Case 1: Range is completely before the keep window
        if (range.end <= keepStart) {
          this.#logger.debug(
            `Removing range [${range.start.toFixed(1)}-${range.end.toFixed(
              1
            )}] - completely before keep window`
          );
          await this.#removeBufferRange(range.start, range.end);
        }
        // Case 2: Range is completely after the keep window
        else if (range.start >= keepEnd) {
          this.#logger.debug(
            `Removing range [${range.start.toFixed(1)}-${range.end.toFixed(
              1
            )}] - completely after keep window`
          );
          await this.#removeBufferRange(range.start, range.end);
        }
        // Case 3: Range partially overlaps with keep window at the start
        else if (
          range.start < keepStart &&
          range.end > keepStart &&
          range.end <= keepEnd
        ) {
          this.#logger.debug(
            `Removing start of range [${range.start.toFixed(
              1
            )}-${keepStart.toFixed(1)}] from [${range.start.toFixed(
              1
            )}-${range.end.toFixed(1)}]`
          );
          await this.#removeBufferRange(range.start, keepStart);
        }
        // Case 4: Range partially overlaps with keep window at the end
        else if (
          range.start >= keepStart &&
          range.start < keepEnd &&
          range.end > keepEnd
        ) {
          this.#logger.debug(
            `Removing end of range [${keepEnd.toFixed(1)}-${range.end.toFixed(
              1
            )}] from [${range.start.toFixed(1)}-${range.end.toFixed(1)}]`
          );
          await this.#removeBufferRange(keepEnd, range.end);
        }
        // Case 5: Range extends beyond keep window on both sides
        else if (range.start < keepStart && range.end > keepEnd) {
          this.#logger.debug(
            `Range [${range.start.toFixed(1)}-${range.end.toFixed(
              1
            )}] extends beyond keep window on both sides`
          );
          // Remove the part before keep window
          await this.#removeBufferRange(range.start, keepStart);
          // Remove the part after keep window
          if (!this.#sourceBuffer.updating) {
            await this.#removeBufferRange(keepEnd, range.end);
          }
        }
        // Case 6: Range is completely within keep window - keep it
        else {
          this.#logger.debug(
            `Keeping range [${range.start.toFixed(1)}-${range.end.toFixed(
              1
            )}] - within keep window`
          );
        }
      }

      // Special handling for unbuffered seek positions
      if (!isSeekPositionBuffered) {
        this.#logger.warn(
          `Seek to unbuffered position ${seekTime.toFixed(1)}s. ` +
            `No buffered content at seek position, but kept useful ranges within window.`
        );

        // Log what we kept
        const newRanges = this.#getAllBufferRanges();
        if (newRanges.length > 0) {
          this.#logger.info(
            `Retained ranges after pruning: ${newRanges
              .map((r) => `[${r.start.toFixed(1)}-${r.end.toFixed(1)}]`)
              .join(", ")}`
          );
        }
      }
    } catch (e) {
      this.#logger.error("Error pruning buffer on seek:", e);
    }
  };

  #removeBufferRange = async (start: number, end: number): Promise<void> => {
    if (!this.#sourceBuffer) return;

    // Validate range
    if (start >= end) {
      this.#logger.warn(
        `Invalid range for removal: start (${start}) >= end (${end})`
      );
      return;
    }

    // Check if range intersects with any buffered content
    const ranges = this.#getAllBufferRanges();
    let hasIntersection = false;

    for (const range of ranges) {
      if (start < range.end && end > range.start) {
        hasIntersection = true;
        break;
      }
    }

    if (!hasIntersection) {
      this.#logger.debug(
        `No buffered content in range [${start.toFixed(1)}-${end.toFixed(1)}]`
      );
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const onUpdateEnd = () => {
        this.#sourceBuffer!.removeEventListener("updateend", onUpdateEnd);
        this.#sourceBuffer!.removeEventListener("error", onError);
        this.#logger.debug(
          `Successfully removed range [${start.toFixed(1)}-${end.toFixed(1)}]`
        );
        resolve();
      };

      const onError = (e: Event) => {
        this.#sourceBuffer!.removeEventListener("updateend", onUpdateEnd);
        this.#sourceBuffer!.removeEventListener("error", onError);
        this.#logger.error(
          `Error removing range [${start.toFixed(1)}-${end.toFixed(1)}]:`,
          e
        );
        reject(e);
      };

      Assert.assertDefined(
        this.#sourceBuffer,
        "SourceBuffer, removeBufferRange"
      );
      this.#sourceBuffer.addEventListener("updateend", onUpdateEnd, {
        once: true,
      });
      this.#sourceBuffer.addEventListener("error", onError, { once: true });

      try {
        this.#sourceBuffer.remove(start, end);
      } catch (e) {
        this.#sourceBuffer.removeEventListener("updateend", onUpdateEnd);
        this.#sourceBuffer.removeEventListener("error", onError);
        this.#logger.error(
          `Exception removing range [${start.toFixed(1)}-${end.toFixed(1)}]:`,
          e
        );
        reject(e);
      }
    });
  };

  #getAllBufferRanges = (): BufferRange[] => {
    if (!this.#sourceBuffer) return [];

    const ranges = this.#sourceBuffer.buffered;
    const result: BufferRange[] = [];

    for (let i = 0; i < ranges.length; i++) {
      result.push({
        start: ranges.start(i),
        end: ranges.end(i),
      });
    }

    return result;
  };

  // Segment management
  #updateSegmentTracking = (
    representation: VideoRepresentation | AudioRepresentation
  ): void => {
    const startNumber = representation.segment.startNumber;
    if (this.#nextSegmentToAppend === null) {
      this.#nextSegmentToAppend = startNumber;
    }
    this.#updateCurrentSegmentLevel(representation.segmentIndex);
  };

  #updateCurrentSegmentLevel = (segmentIndex: SegmentIndex): void => {
    if (!segmentIndex || segmentIndex.references.length === 0) {
      this.#logger.error(
        "Error updating segment levels: No segment index information available"
      );
      return;
    }

    const currentTime = playbackController.getTime();
    const currentRange = this.#getRangeAt(currentTime);

    let targetSegment: SegmentReference | null = null;

    if (currentRange) {
      // We have buffered content, find what to download next
      const bufferEnd = currentRange.end;

      // Get segment at buffer end
      const segmentAtBufferEnd = segmentIndex.getSegmentAtTime(bufferEnd);
      this.#logger.debug("segmentAtBufferEnd:", segmentAtBufferEnd);

      if (segmentAtBufferEnd) {
        // Check if we need more of this segment or the next one
        if (bufferEnd >= segmentAtBufferEnd.endTime - this.#config.tolerance) {
          // We've buffered this segment, get the next one
          targetSegment = segmentIndex.getNextSegment(segmentAtBufferEnd);
        } else {
          // Still need more of this segment
          targetSegment = segmentAtBufferEnd;
        }
      }
      // If segmentAtBufferEnd is null, we're past all segments (end of stream)
    } else {
      // No buffer at current position, get segment at current time
      targetSegment = segmentIndex.getSegmentAtTime(currentTime);

      if (!targetSegment) {
        // Current time is past all segments or before first segment
        targetSegment = segmentIndex.getFirstSegment();
      }
    }

    if (targetSegment) {
      this.#nextSegmentToDownload = targetSegment.segmentNumber;
      if (this.#nextSegmentToAppend === null) {
        this.#nextSegmentToAppend = targetSegment.segmentNumber;
      }
    } else {
      // We're at the end of the stream
      this.#logger.info("No more segments to download - end of stream");
      this.#nextSegmentToDownload = null;
    }

    this.#logger.debug(
      `Next segment to download: ${this.#nextSegmentToDownload}, ` +
        `Next to append: ${this.#nextSegmentToAppend}`
    );
  };

  // Download pipeline
  loadNextSegments = async (): Promise<void> => {
    if (this.#isShuttingDown) return;

    // Process append queue first
    await this.#processAppendQueue();

    // Check if we should download more
    let segmentsStarted = 0;
    while (this.#shouldStartNewDownload()) {
      const segmentToReplace = this.#shouldDownloadReplacement();

      if (segmentToReplace) {
        // Download replacement for lower quality segment
        const rep = this.#getCurrentRepresentation();

        if (rep) {
          this.#startSegmentDownload(
            segmentToReplace.segmentNumber,
            rep.id,
            true,
            segmentToReplace.segmentNumber
          );
          segmentsStarted++;
          this.#logger.info(
            `Starting replacement download for segment ${segmentToReplace.segmentNumber} ` +
              `(${segmentToReplace.bitrate} bps -> ${
                this.#currentRepresentationBitrate
              } bps)`
          );
        }
      } else {
        const nextSegment = this.#getNextSegmentToDownload();
        if (nextSegment === null) break;

        const rep = this.#getCurrentRepresentation();
        if (!rep) {
          this.#logger.error("Representation not set");
          throw new Error("Representation not set");
        }
        if (nextSegment > rep.segment.maxSegNum) break;

        this.#startSegmentDownload(nextSegment, rep.id);
        segmentsStarted++;
      }
    }

    // If we couldn't start any downloads and buffer is near full, don't immediately retry
    if (
      segmentsStarted === 0 &&
      this.#state.level > this.#config.bufferingTarget * 0.8
    ) {
      this.#logger.debug("Buffer near full");
      return;
    }
  };

  #shouldStartNewDownload = (): boolean => {
    if (!this.#isStreamingActive || this.#quotaExceededInProgress) return false;

    // For MMS, trust the browser's signal
    if (this.#isManagedMSE) {
      // Only check if we have segments in flight
      return this.#downloadPipeline.size === 0;
    }

    if (this.#downloadPipeline.size >= this.#config.maxConcurrentDownloads) {
      return false;
    }
    // If fast switching is enabled, check if we have replacements to do
    if (this.#config.fastSwitchingEnabled) {
      const replaceableSegments = this.#findReplaceableSegments();
      if (replaceableSegments.length > 0) {
        return true; // Always allow replacement downloads
      }
    }

    const currentBufferLevel = this.#state.level;
    const remainingBufferSpace = Math.max(
      0,
      this.#config.bufferingTarget - currentBufferLevel
    );

    if (remainingBufferSpace <= 0) {
      return false;
    }

    // Calculate total committed duration (append queue + downloading)
    const appendQueueDuration = this.#appendQueueDuration;
    const downloadingDuration = this.#getDownloadingDuration();
    const totalCommittedDuration = appendQueueDuration + downloadingDuration;

    // Add safety margin to account for concurrent operations
    const safetyMargin = 2;
    const effectiveRemainingSpace = remainingBufferSpace - safetyMargin;

    if (totalCommittedDuration >= effectiveRemainingSpace) {
      this.#logger.debug(
        `Not downloading: committed ${totalCommittedDuration.toFixed(1)}s >= ` +
          `remaining ${effectiveRemainingSpace.toFixed(1)}s
          BufferLevel: ${currentBufferLevel}
          AppendQueue Duration: ${this.#appendQueueDuration}
          Downloading duration: ${downloadingDuration}`
      );
      return false;
    }
    return true;
  };

  #getDownloadingDuration = (): number => {
    let totalDuration = 0;

    this.#downloadPipeline.forEach((task) => {
      const segmentInfo = this.#getSegmentRef(
        task.segmentNumber,
        task.representationId
      );
      const duration = segmentInfo
        ? segmentInfo.endTime - segmentInfo.startTime
        : 4;
      totalDuration += duration;
    });

    return totalDuration;
  };

  #getNextSegmentToDownload = (): number | null => {
    if (this.#nextSegmentToDownload === null) return null;

    let nextSegment = this.#nextSegmentToDownload;

    // Check all segments in flight (downloading + queued)
    const segmentsInFlight = new Set<number>();

    for (const segNum of this.#downloadPipeline.keys()) {
      segmentsInFlight.add(segNum);
    }

    for (const item of this.#appendQueue) {
      segmentsInFlight.add(item.segmentNumber);
    }

    // Find the next segment not already in flight
    while (segmentsInFlight.has(nextSegment)) {
      nextSegment++;
    }

    return nextSegment;
  };

  #startSegmentDownload = (
    segmentNumber: number,
    repId: string,
    isReplacement: boolean = false,
    replacingSegment?: number
  ): void => {
    if (this.#downloadPipeline.has(segmentNumber)) return;

    const segmentRef = this.#getSegmentRef(segmentNumber, repId);
    const url = segmentRef?.getUris();

    if (!url) {
      console.error("Invalid Segment url for segmentNumber:", segmentNumber);
      blacklistController.addSegNumToBlacklist(segmentNumber);
      return;
    }

    if (
      blacklistController.containsUrl(url) ||
      blacklistController.containsSegmentNumber(segmentNumber)
    ) {
      this.#logger.info(`Skipping blacklisted segment ${segmentNumber}`);
      this.#markSegmentAsSkipped(segmentNumber);
      return;
    }

    const abortController = new AbortController();
    const downloadTask: DownloadTask = {
      segmentNumber,
      url,
      representationId: repId,
      startTime: Date.now(),
      promise: this.#fetchWithTimeout(url, abortController.signal),
      type: "media",
      abortController,
      isReplacement,
      replacingSegment,
    };

    this.#downloadPipeline.set(segmentNumber, downloadTask);

    if (segmentRef && this.#type === "video") {
      eventBus.trigger(Events.FRAGMENT_LOADING_STARTED, {
        segmentRef,
        isReplacement,
      });
    }

    this.#logger.debug(
      `Starting ${isReplacement ? "replacement " : ""}download of segment: ${
        segmentRef?.segmentNumber
      }`
    );

    downloadTask.promise
      .then((result: FragmentLoadResult) => {
        // Check if task still exists (might have been cancelled)
        if (this.#downloadPipeline.has(segmentNumber)) {
          this.#onDownloadComplete(
            segmentNumber,
            result.data, // arrayBuffer
            result.durationMs, // durationMs
            result.resourceBytes, // resourceBytes (full size)
            result.status, // HTTP status
            result.transferredBytes, // actual network bytes
            result.fromCache // cache status
          );
        }
      })
      .catch((error) => {
        if (!abortController.signal.aborted) {
          this.#onDownloadError(segmentNumber, error);
        }
      });
  };

  #fetchWithTimeout = async (
    url: string,
    signal: AbortSignal
  ): Promise<FragmentLoadResult> => {
    // Clear existing entries for this URL to avoid confusion
    performance.clearResourceTimings();

    const startTime = performance.now();

    try {
      const response = await fetch(url, {
        signal,
        mode: "cors",
        credentials: "same-origin",
      });

      if (!response.ok) {
        if (response.status === 404) {
          blacklistController.addToUrlBlacklist(url);
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const endTime = performance.now();

      let perfEntry: PerformanceResourceTiming | undefined;

      // Method 1: Get by type and filter
      const allResourceEntries = performance.getEntriesByType(
        "resource"
      ) as PerformanceResourceTiming[];
      perfEntry = allResourceEntries.find(
        (entry) => entry.name.includes(url) || url.includes(entry.name)
      );

      // Method 2: Use observer (more reliable)
      if (!perfEntry) {
        perfEntry = await new Promise<PerformanceResourceTiming | undefined>(
          (resolve) => {
            const observer = new PerformanceObserver((list) => {
              const entries = list.getEntries() as PerformanceResourceTiming[];
              const entry = entries.find(
                (e) => e.name.includes(url) || url.includes(e.name)
              );
              if (entry) {
                observer.disconnect();
                resolve(entry);
              }
            });

            observer.observe({ entryTypes: ["resource"] });

            // Timeout after 100ms
            setTimeout(() => {
              observer.disconnect();
              resolve(undefined);
            }, 100);
          }
        );
      }

      // Analyze the result
      let transferredBytes = arrayBuffer.byteLength;
      let fromCache = false;

      if (perfEntry) {
        this.#logger.debug("Downloaded Segment's Performance Entry:", {
          name: perfEntry.name,
          transferSize: perfEntry.transferSize,
          encodedBodySize: perfEntry.encodedBodySize,
          decodedBodySize: perfEntry.decodedBodySize,
          duration: perfEntry.duration,
        });

        // Check if cached
        if (perfEntry.transferSize === 0) {
          fromCache = true;
          transferredBytes = 0;
        } else if (perfEntry.transferSize > 0) {
          transferredBytes = perfEntry.transferSize;
          // Very small transfer size compared to body size indicates 304
          fromCache = perfEntry.transferSize < perfEntry.decodedBodySize * 0.1;
        }
      }

      return {
        data: arrayBuffer,
        status: response.status,
        durationMs: endTime - startTime,
        fromCache,
        transferredBytes,
        resourceBytes: arrayBuffer.byteLength,
      };
    } catch (e) {
      throw e;
    }
  };

  #applySegmentReplacement = async (
    replacement: ReplacementTask
  ): Promise<void> => {
    // Prevent duplicate replacements
    if (this.#replacementsInProgress.has(replacement.segmentNumber)) {
      this.#logger.warn(
        `Segment ${replacement.segmentNumber} replacement already in progress, skipping`
      );
      return;
    }

    const segmentRef = this.#getSegmentRef(
      replacement.segmentNumber,
      replacement.representationId
    );
    if (!segmentRef) {
      this.#logger.error(
        `No segment reference found for replacement segment ${replacement.segmentNumber}`
      );
      return;
    }

    // Wait for source buffer to be ready
    if (this.#sourceBuffer?.updating || this.#isProcessingQueue) {
      await new Promise<void>((resolve) => {
        const checkReady = () => {
          if (!this.#sourceBuffer?.updating && !this.#isProcessingQueue) {
            resolve();
          } else {
            setTimeout(checkReady, 10);
          }
        };
        checkReady();
      });
    }

    this.#replacementsInProgress.add(replacement.segmentNumber);

    try {
      // Remove the old segment from buffer
      const startTime = segmentRef.startTime;
      const endTime = segmentRef.endTime;

      this.#logger.info(
        `Replacing segment ${replacement.segmentNumber} [${startTime.toFixed(
          2
        )}-${endTime.toFixed(2)}]`
      );

      // Remove old segment data
      if (this.#sourceBuffer && this.#mediaSource?.readyState === "open") {
        await this.#removeBufferRange(startTime, endTime);

        // Wait for removal to complete
        if (this.#sourceBuffer.updating) {
          await new Promise<void>((resolve) => {
            const onUpdateEnd = () => {
              this.#sourceBuffer!.removeEventListener("updateend", onUpdateEnd);
              resolve();
            };
            this.#sourceBuffer?.addEventListener("updateend", onUpdateEnd, {
              once: true,
            });
          });
        }
      }

      // Append new segment data
      await this.#appendSegment(
        replacement.arrayBuffer,
        replacement.segmentNumber
      );

      // Update tracking
      this.#bufferedSegments.set(replacement.segmentNumber, {
        segmentNumber: replacement.segmentNumber,
        startTime,
        endTime,
        representationId: replacement.representationId,
        bitrate: this.#currentRepresentationBitrate,
        bytes: replacement.arrayBuffer.byteLength,
      });

      this.#logger.info(
        `Successfully replaced segment ${replacement.segmentNumber} with higher quality version`
      );

      if (segmentRef && this.#type === "video") {
        this.#createFragmentLoadedEvent(
          segmentRef,
          {
            status: replacement.status,
            durationMs: replacement.durationMs,
            fromCache: replacement.fromCache,
            transferredBytes: replacement.transferredBytes,
            resourceBytes: replacement.resourceBytes,
          },
          true
        );
      }
    } catch (error) {
      this.#logger.error(
        `Failed to replace segment ${replacement.segmentNumber}:`,
        error
      );

      // Re-add to buffered segments with old info if replacement failed
      const oldSegmentInfo = this.#bufferedSegments.get(
        replacement.segmentNumber
      );
      if (oldSegmentInfo) {
        this.#bufferedSegments.set(replacement.segmentNumber, oldSegmentInfo);
      }
    } finally {
      this.#replacementsInProgress.delete(replacement.segmentNumber);
    }
  };

  #processReplacementQueue = async (): Promise<void> => {
    if (this.#isProcessingReplacement || this.#replacementQueue.length === 0) {
      return;
    }

    this.#isProcessingReplacement = true;

    while (this.#replacementQueue.length > 0) {
      const replacement = this.#replacementQueue.shift()!;

      try {
        await this.#applySegmentReplacement(replacement);

        // Small delay between replacements to ensure SourceBuffer is ready
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        this.#logger.error(
          `Failed to process replacement for segment ${replacement.segmentNumber}:`,
          error
        );
      }
    }

    this.#isProcessingReplacement = false;
  };

  #onDownloadComplete = (
    segmentNumber: number,
    arrayBuffer: ArrayBuffer,
    durationMs: number,
    resourceBytes: number,
    status: number,
    transferredBytes: number,
    fromCache: boolean
  ): void => {
    const task = this.#downloadPipeline.get(segmentNumber);
    if (!task) return;

    this.#downloadPipeline.delete(segmentNumber);

    const segmentRef = this.#getSegmentRef(
      segmentNumber,
      task.representationId
    );
    const duration = segmentRef ? segmentRef.endTime - segmentRef.startTime : 4;

    if (task.isReplacement && task.replacingSegment !== undefined) {
      // Add to replacement queue instead of processing immediately
      this.#replacementQueue.push({
        segmentNumber: task.replacingSegment,
        arrayBuffer,
        representationId: task.representationId,
        durationMs,
        resourceBytes,
        transferredBytes,
        fromCache,
        status,
      });

      this.#logger.info(
        `Queued replacement for segment ${task.replacingSegment} (queue size: ${
          this.#replacementQueue.length
        })`
      );

      if (!this.#isProcessingReplacement) {
        this.#processReplacementQueue();
      }

      return;
    }

    if (this.#isManagedMSE) {
      // For MMS, don't check buffer targets
      // Just queue the segment and let browser manage
      this.#insertIntoAppendQueue({
        segmentNumber,
        data: arrayBuffer,
        duration,
        timestamp: Date.now(),
        representationId: task.representationId,
        bitrate: this.#currentRepresentationBitrate,
        bytes: arrayBuffer.byteLength,
      });

      if (segmentRef) {
        this.#createFragmentLoadedEvent(
          segmentRef,
          {
            status,
            durationMs,
            fromCache,
            transferredBytes,
            resourceBytes,
          },
          (task.isReplacement && task.replacingSegment !== undefined) || false
        );
      }
      // Process queue
      if (!this.#isProcessingQueue) {
        setTimeout(() => this.#processAppendQueue(), 0);
      }

      return; // Skip all the buffer level checks
    }

    const currentBufferLevel = this.#state.level;
    const appendQueueDuration = this.#appendQueueDuration;
    const totalProjectedDuration =
      currentBufferLevel + appendQueueDuration + duration;

    const acceptanceLimit = this.#config.bufferingTarget;

    const hardLimit =
      this.#config.bufferingTarget + this.#config.maxAllowedOverrun;

    if (totalProjectedDuration > hardLimit) {
      // We're way over target - something unusual happened
      this.#logger.error(
        `Segment ${segmentNumber} would push buffer to ${totalProjectedDuration.toFixed(
          1
        )}s, ` +
          `exceeding hard limit of ${hardLimit}s. This suggests a logic error or race condition.`
      );

      // Still check if we absolutely need this segment
      const isNearStall = currentBufferLevel < 3.0;
      const appendQueueEmpty = this.#appendQueue.length === 0;

      if (!isNearStall || !appendQueueEmpty) {
        this.#logger.warn(
          `Discarding segment ${segmentNumber}: would exceed hard limit`
        );
        if (segmentRef) {
          this.#createFragmentLoadedEvent(
            segmentRef,
            {
              status,
              durationMs,
              fromCache,
              transferredBytes,
              resourceBytes,
            },
            (task.isReplacement && task.replacingSegment !== undefined) ||
              false,
            true,
            "hard_limit_exceeeded"
          );
        }
        return;
      }
    } else if (totalProjectedDuration > acceptanceLimit) {
      // Log that we're over target but accepting anyway
      this.#logger.info(
        `Accepting segment ${segmentNumber} even though buffer will be ${totalProjectedDuration.toFixed(
          1
        )}s ` +
          `(over target of ${acceptanceLimit}s). This segment was already downloading when buffer filled up.`
      );
    }

    // Add to append queue
    this.#insertIntoAppendQueue({
      segmentNumber,
      data: arrayBuffer,
      duration,
      timestamp: Date.now(),
      representationId: task.representationId,
      bitrate: this.#currentRepresentationBitrate,
      bytes: arrayBuffer.byteLength,
    });

    this.#appendQueue.sort((a, b) => a.segmentNumber - b.segmentNumber);

    if (segmentRef) {
      eventBus.trigger(Events.FRAGMENT_LOADING_COMPLETED, {
        fragmentLoadResult: {
          segmentRef,
          status,
          durationMs,
          fromCache,
          transferredBytes,
          resourceBytes,
          isReplacement:
            (task.isReplacement && task.replacingSegment !== undefined) ||
            false,
        },
      });
      this.#logger.debug(
        `Finished downloading segment ${segmentNumber} in ${durationMs}ms ` +
          `(transferred: ${(transferredBytes / 1024).toFixed(2)}KB, ` +
          `resource: ${(resourceBytes / 1024).toFixed(2)}KB, ` +
          `cached: ${fromCache})`
      );
    }

    // Try to process queue immediately (but async to prevent stack overflow)
    if (
      !this.#isProcessingQueue &&
      this.#sourceBuffer &&
      !this.#sourceBuffer.updating
    ) {
      setTimeout(() => this.#processAppendQueue(), 0);
    }
  };

  #getBufferedBytes = (): number => {
    let total = 0;
    for (const seg of this.#bufferedSegments.values()) {
      total += seg.bytes;
    }
    return total;
  };

  #onDownloadError = (segmentNumber: number, error: Error): void => {
    this.#logger.error(`Download failed for segment ${segmentNumber}:`, error);

    const task = this.#downloadPipeline.get(segmentNumber);
    if (task) {
      this.#downloadPipeline.delete(segmentNumber);

      const downloadTime = Date.now() - task.startTime;
      if (downloadTime > this.#config.segmentTimeout * 0.8) {
        blacklistController.addToUrlBlacklist(task.url);
        this.#markSegmentAsSkipped(segmentNumber);
      }
    }

    // Try next segment (async to prevent stack overflow)
    setTimeout(() => this.loadNextSegments(), 0);
  };

  #markSegmentAsSkipped = (segmentNumber: number): void => {
    this.#insertIntoAppendQueue({
      segmentNumber,
      data: new ArrayBuffer(0),
      duration: 0,
      timestamp: Date.now(),
      representationId:
        this.#currentRepresentationId ||
        playbackController.getCurrentVideoRepresentation().id,
      bitrate: this.#currentRepresentationBitrate,
      bytes: 0,
    });
  };

  #insertIntoAppendQueue = (segment: QueuedSegment): void => {
    this.#appendQueue.push(segment);
    this.#appendQueueDuration += segment.duration;
    this.#appendQueue.sort((a, b) => a.segmentNumber - b.segmentNumber);
  };

  #removeFromAppendQueue(index: number): QueuedSegment {
    const item = this.#appendQueue.splice(index, 1)[0];
    this.#appendQueueDuration -= item.duration;
    return item;
  }

  #cancelPendingDownloads = (): void => {
    this.#downloadPipeline.forEach((task) => {
      try {
        task.abortController.abort();
      } catch (error) {
        this.#logger.error("Error aborting download task:", error);
      }
    });
    this.#downloadPipeline.clear();
  };

  #createFragmentLoadedEvent = (
    segmentRef: SegmentReference,
    result: {
      status: number;
      durationMs: number;
      fromCache: boolean;
      transferredBytes: number;
      resourceBytes: number;
    },
    isReplacement: boolean = false,
    discarded: boolean = false,
    discardReason?: string
  ): void => {
    if (this.#type === "video") {
      eventBus.trigger(Events.FRAGMENT_LOADING_COMPLETED, {
        fragmentLoadResult: {
          segmentRef,
          status: result.status,
          durationMs: result.durationMs,
          fromCache: result.fromCache,
          transferredBytes: result.transferredBytes,
          resourceBytes: result.resourceBytes,
          isReplacement,
          discarded,
          ...(discardReason && { reason: discardReason }),
        },
      });
    }
  };

  #canProcessAppendQueue = (): boolean | null => {
    return (
      !this.#isShuttingDown &&
      this.#sourceBuffer &&
      !this.#sourceBuffer.updating &&
      this.#appendQueue.length > 0 &&
      this.#mediaSource?.readyState === "open" &&
      !this.#isShuttingDown &&
      !this.#isProcessingQueue &&
      !this.#quotaExceededInProgress
    );
  };

  // Append queue processing
  #processAppendQueue = async (): Promise<void> => {
    let segmentsAppended = 0;

    while (this.#canProcessAppendQueue()) {
      try {
        this.#isProcessingQueue = true;
        if (!this.#nextSegmentToAppend) {
          break;
        }

        if (this.#quotaExceededInProgress) {
          this.#logger.debug(
            "Quota exceeded in progress, stopping append queue processing"
          );
          break;
        }

        const nextIndex = this.#appendQueue.findIndex(
          (item) => item.segmentNumber === this.#nextSegmentToAppend
        );

        if (nextIndex === -1) {
          // Check if all segments in queue are ahead of what we need
          const allAhead = this.#appendQueue.every(
            (item) => item.segmentNumber > this.#nextSegmentToAppend!
          );

          // Could also mean that download failed, in that case, we'd need to check blacklisted segments and ignore this check if the segment we're waiting for is blacklisted.
          if (allAhead && this.#appendQueue.length > 3) {
            // appendQueue.length > 3 is kind of arbitrary
            // We're stuck - clear queue and reset
            this.#logger.warn(
              `Queue stuck waiting for segment ${this.#nextSegmentToAppend}. ` +
                `Clearing queue: [${this.#appendQueue
                  .map((s) => s.segmentNumber)
                  .join(", ")}]`
            );
            this.#resetAppendQueue();
            // Reset to download from current position
            if (this.#nextSegmentToDownload !== null) {
              this.#nextSegmentToAppend = this.#nextSegmentToDownload;
            }
            break;
          }

          this.#logger.debug(
            `AppendQueue: Waiting for segment ${this.#nextSegmentToAppend}, ` +
              `queue has: ${this.#appendQueue
                .map((s) => s.segmentNumber)
                .join(", ")}`
          );
          this.#logger.debug("Download status", this.getDownloadStatus());
          break;
        }

        const item = this.#removeFromAppendQueue(nextIndex);

        // Skip empty buffers (blacklisted segments)
        if (item.data.byteLength === 0) {
          this.#nextSegmentToAppend++;
          continue;
        }

        try {
          await this.#appendSegment(item.data, item.segmentNumber);
          this.#nextSegmentToAppend++;
          segmentsAppended++;

          const segmentRef = this.#getSegmentRef(
            item.segmentNumber,
            item.representationId
          );
          if (segmentRef) {
            this.#bufferedSegments.set(item.segmentNumber, {
              segmentNumber: item.segmentNumber,
              startTime: segmentRef.startTime,
              endTime: segmentRef.endTime,
              representationId: item.representationId,
              bitrate: item.bitrate,
              bytes: item.bytes,
            });
          }

          if (
            this.#nextSegmentToDownload !== null &&
            this.#nextSegmentToAppend > this.#nextSegmentToDownload
          ) {
            this.#nextSegmentToDownload = this.#nextSegmentToAppend;
          }

          if (segmentsAppended > 0) {
            this.#logger.debug(
              `Appended Segment ${item.segmentNumber}, ` +
                `Queue has segments: ${
                  this.#appendQueue.map((s) => s.segmentNumber).join(", ") ||
                  "none"
                }`
            );
          }
        } catch (e) {
          this.#logger.error(
            `Failed to append segment ${item.segmentNumber}:`,
            e
          );

          if (e instanceof DOMException && e.name === "QuotaExceededError") {
            this.#insertIntoAppendQueue(item);
            this.#handleQuotaExceeded();
            break;
          } else {
            this.#nextSegmentToAppend++;
          }
        }
      } finally {
        this.#isProcessingQueue = false;
      }
    }
  };

  // segmentSize is the size of the segment that caused the error.
  // This error can happen if A) the buffer memory is too full or B) the duration of the segments exceeds a limit
  #newHandleQuotaExceeded = (
    segmentSize: number,
    segmentDuration: number
  ): void => {
    this.#syncSegmentTrackingWithBuffer();
    const bufferedBytes = this.#getBufferedBytes();
    const newByteLimit =
      (bufferedBytes + segmentSize) *
      this.#config.quotaExceededCorrectionFactor; // 0.8

    const bufferLevel = this.#state.level;
    const minBufferLevel = Math.min(30, Math.max(15, segmentDuration * 4));
    if (bufferLevel < minBufferLevel) {
      // we should think about reducing the bitrate, s.t. we can buffer more content without hitting the memory limit
    }

    // prune buffer given the new limits and/or change bitrate
  };

  #appendSegment = async (
    data: ArrayBuffer,
    segmentNumber?: number
  ): Promise<void> => {
    Assert.assertDefined(this.#sourceBuffer, "SourceBuffer not initialized");

    // Check if MediaSource is in error state
    if (
      this.#mediaSource?.readyState === "closed" ||
      this.#mediaSource?.readyState === "ended"
    ) {
      throw new Error(`MediaSource in ${this.#mediaSource.readyState} state`);
    }

    return new Promise<void>((resolve, reject) => {
      const onUpdateEnd = () => {
        this.#sourceBuffer!.removeEventListener("updateend", onUpdateEnd);
        this.#sourceBuffer!.removeEventListener("error", onError);
        this.#logger.debug(
          `Appended ${(data.byteLength / 1024).toFixed(2)}KB to sourceBuffer`
        );
        resolve();
      };

      const onError = (e: Event) => {
        this.#sourceBuffer!.removeEventListener("updateend", onUpdateEnd);
        this.#sourceBuffer!.removeEventListener("error", onError);
        this.#logger.error("Error appending data to sourceBuffer", e);
        reject(e);
      };

      Assert.assertDefined(
        this.#sourceBuffer,
        "SourceBuffer not defined in appendSegment method's Promise"
      );
      this.#sourceBuffer.addEventListener("updateend", onUpdateEnd, {
        once: true,
      });
      this.#sourceBuffer.addEventListener("error", onError, { once: true });

      try {
        this.#sourceBuffer.appendBuffer(data);
      } catch (e) {
        this.#sourceBuffer.removeEventListener("updateend", onUpdateEnd);
        this.#sourceBuffer.removeEventListener("error", onError);

        reject(e);
      }
    });
  };

  #handleQuotaExceeded = async (retryCount: number = 0): Promise<void> => {
    this.#syncSegmentTrackingWithBuffer();
    const bufferedBytes = this.#getBufferedBytes();
    this.#logger.info("Buffered bytes:", bufferedBytes);
    if (this.#quotaExceededInProgress) {
      this.#logger.debug("QuotaExceeded handler already in progress, skipping");
      return;
    }
    this.#quotaExceededInProgress = true;

    this.#logger.warn(
      "QuotaExceeded Error at buffer level:",
      this.#state.level
    );

    this.#logger.debug(
      "Before handling QuotaExceeded Error buffered ranges:",
      this.#getAllBufferRanges()
    );

    try {
      if (!this.#sourceBuffer) {
        this.#logger.error(
          "No source buffer available during quota exceeded handling"
        );
        return;
      }

      // Wait for source buffer to be ready
      if (this.#sourceBuffer.updating) {
        if (retryCount >= 10) {
          this.#logger.error(
            "Source buffer still updating after 10 retries, giving up"
          );
          this.#quotaExceededInProgress = false;
          return;
        }

        this.#logger.debug(
          `Source buffer updating, retrying in 100ms (attempt ${
            retryCount + 1
          })`
        );
        setTimeout(() => {
          this.#quotaExceededInProgress = false;
          this.#handleQuotaExceeded(retryCount + 1);
        }, 100);
        return;
      }

      // Abort the source buffer to stop any pending operations
      try {
        this.#sourceBuffer.abort();
      } catch (e) {
        this.#logger.debug("Could not abort source buffer:", e);
      }

      // Calculate new critical level
      if (isNaN(this.#state.criticalLevel)) {
        this.#state.criticalLevel =
          this.#state.level * this.#config.quotaExceededCorrectionFactor;
      } else {
        this.#state.criticalLevel =
          this.#state.criticalLevel *
          this.#config.quotaExceededCorrectionFactor;
      }

      // Make sure critical level is reasonable
      this.#state.criticalLevel = Math.max(10, this.#state.criticalLevel);

      // Update buffer target
      this.#config.bufferingTarget = this.#state.criticalLevel;
      eventBus.trigger(Events.BUFFER_TARGET_CHANGED, {
        newBufferTarget: this.#config.bufferingTarget,
      });

      // Cancel all downloads
      this.#downloadPipeline.forEach((task) => {
        try {
          task.abortController.abort();
        } catch (error) {
          this.#logger.error("Error aborting download task:", error);
        }
      });
      this.#downloadPipeline.clear();

      // Clear ALL queues completely
      this.#resetAppendQueue();
      this.#replacementQueue = [];
      this.#isProcessingReplacement = false;
      this.#replacementsInProgress.clear();
      this.#isProcessingQueue = false;

      // Remove excess buffer data with proper tracking
      await this.#removeExcessBufferDataWithTracking();

      // Reset segment pointers based on actual buffer state
      this.#resetSegmentPointersAfterQuotaExceeded();

      // Force update buffer level
      this.#updateBufferLevel();

      this.#logger.warn(
        `QuotaExceededError: Setting critical level to ${this.#state.criticalLevel.toFixed(
          1
        )}s ` +
          `and removed excess buffer data (correction factor: ${this.#config.quotaExceededCorrectionFactor.toFixed(
            2
          )})`
      );

      // Wait longer before allowing new operations
      setTimeout(() => {
        this.#quotaExceededInProgress = false;
        // Only trigger new downloads if we have low buffer
        if (this.#state.level < 10) {
          this.loadNextSegments();
        }
      }, 2000);
    } catch (error) {
      this.#logger.error("Error in quota exceeded handler:", error);
      this.#quotaExceededInProgress = false;
    }
  };

  // Improved method to remove excess buffer and update tracking
  #removeExcessBufferDataWithTracking = async (): Promise<void> => {
    if (!this.#sourceBuffer || this.#sourceBuffer.updating) {
      this.#logger.debug("Cannot remove buffer data - source buffer not ready");
      return;
    }

    const currentTime = playbackController.getTime();
    const newTargetLevel = this.#state.criticalLevel;

    // Keep a smaller window to ensure we have enough quota
    const bufferBehind = Math.min(this.#config.bufferBehind, 2);
    const keepStart = Math.max(0, currentTime - bufferBehind);
    const keepEnd = currentTime + newTargetLevel;

    this.#logger.info(
      `QuotaExceeded: Removing buffer outside range [${keepStart.toFixed(
        1
      )}, ${keepEnd.toFixed(1)}], currentTime: ${currentTime.toFixed(1)}`
    );

    // Get all buffer ranges before removal
    const rangesBefore = this.#getAllBufferRanges();
    this.#logger.debug(
      "Buffer ranges before removal:",
      rangesBefore
        .map((r) => `[${r.start.toFixed(1)}-${r.end.toFixed(1)}]`)
        .join(", ")
    );

    // Clear segment tracking for segments outside keep window
    const segmentsToRemove = new Set<number>();
    this.#bufferedSegments.forEach((segInfo, segNum) => {
      if (segInfo.endTime <= keepStart || segInfo.startTime >= keepEnd) {
        segmentsToRemove.add(segNum);
      }
    });

    // Remove buffer ranges systematically
    let bytesRemoved = 0;
    for (const range of rangesBefore) {
      try {
        let removeStart = -1;
        let removeEnd = -1;

        if (range.end <= keepStart) {
          // Entire range is before keep window
          removeStart = range.start;
          removeEnd = range.end;
        } else if (range.start >= keepEnd) {
          // Entire range is after keep window
          removeStart = range.start;
          removeEnd = range.end;
        } else if (range.start < keepStart && range.end > keepStart) {
          // Range starts before keep window
          removeStart = range.start;
          removeEnd = Math.min(keepStart, range.end);
        } else if (range.start < keepEnd && range.end > keepEnd) {
          // Range ends after keep window
          removeStart = Math.max(keepEnd, range.start);
          removeEnd = range.end;
        } else if (range.start < keepStart && range.end > keepEnd) {
          // Range spans entire keep window - remove both edges
          // Remove before
          await this.#removeBufferRange(range.start, keepStart);
          bytesRemoved += (keepStart - range.start) * 1000000; // Rough estimate
          this.#logger.debug(
            `Removed edge before: [${range.start.toFixed(
              1
            )}-${keepStart.toFixed(1)}]`
          );

          // Remove after if buffer not updating
          if (!this.#sourceBuffer.updating) {
            removeStart = keepEnd;
            removeEnd = range.end;
          } else {
            continue;
          }
        }

        if (removeStart >= 0 && removeEnd > removeStart) {
          await this.#removeBufferRange(removeStart, removeEnd);
          bytesRemoved += (removeEnd - removeStart) * 1000000; // Rough estimate
          this.#logger.debug(
            `Removed range [${removeStart.toFixed(1)}-${removeEnd.toFixed(1)}]`
          );
        }
      } catch (e) {
        this.#logger.error(`Error removing range:`, e);
        // Continue with other ranges even if one fails
      }
    }

    // Calculate total buffered duration before
    const totalBufferedBefore = rangesBefore.reduce((total, range) => {
      return total + (range.end - range.start);
    }, 0);
    this.#logger.info(
      `Total buffered duration before: ${totalBufferedBefore.toFixed(1)}s`
    );

    // Update buffered segments tracking
    segmentsToRemove.forEach((segNum) => {
      this.#bufferedSegments.delete(segNum);
    });
    this.#logger.info(
      `Removed ${segmentsToRemove.size} segments from tracking`
    );

    // Log final state
    const rangesAfter = this.#getAllBufferRanges();
    const totalBufferedAfter = rangesAfter.reduce((total, range) => {
      return total + (range.end - range.start);
    }, 0);

    this.#logger.info(
      `Buffer removal complete: ${totalBufferedBefore.toFixed(
        1
      )}s -> ${totalBufferedAfter.toFixed(1)}s ` +
        `(removed ~${(bytesRemoved / 1024 / 1024 || 0).toFixed(1)}MB)`
    );
    this.#logger.debug(
      "Buffer ranges after removal:",
      rangesAfter
        .map((r) => `[${r.start.toFixed(1)}-${r.end.toFixed(1)}]`)
        .join(", ")
    );
  };

  #getCurrentRepresentation = ():
    | VideoRepresentation
    | AudioRepresentation
    | null => {
    if (this.#type === "video") {
      return playbackController.getCurrentVideoRepresentation();
    } else if (this.#type === "audio") {
      return playbackController.getCurrentAudioRepresentation();
    }
    return null;
  };

  // Improved method to reset segment pointers
  #resetSegmentPointersAfterQuotaExceeded = (): void => {
    const currentTime = playbackController.getTime();
    const ranges = this.#getAllBufferRanges();

    const rep = this.#getCurrentRepresentation();

    if (!rep || !rep.segmentIndex) {
      this.#logger.error("No representation available for pointer reset");
      return;
    }

    if (ranges.length === 0) {
      // No buffer left, reset to current time
      const segment = rep.segmentIndex.getSegmentAtTime(currentTime);
      if (segment) {
        this.#nextSegmentToDownload = segment.segmentNumber;
        this.#nextSegmentToAppend = segment.segmentNumber;
        this.#logger.info(
          `No buffer remaining - reset to segment ${
            segment.segmentNumber
          } at current time ${currentTime.toFixed(1)}s`
        );
      }
      return;
    }

    // Find the range containing current time or the closest future range
    let targetRange: BufferRange | null = null;

    // First, look for range containing current time
    for (const range of ranges) {
      if (currentTime >= range.start - 0.1 && currentTime <= range.end + 0.1) {
        targetRange = range;
        break;
      }
    }

    // If not found, look for closest future range
    if (!targetRange) {
      let minDistance = Infinity;
      for (const range of ranges) {
        if (range.start > currentTime) {
          const distance = range.start - currentTime;
          if (distance < minDistance) {
            minDistance = distance;
            targetRange = range;
          }
        }
      }
    }

    if (targetRange) {
      // Find segment at the end of target range
      const bufferEnd = targetRange.end;
      const segment = rep.segmentIndex.getSegmentAtTime(bufferEnd);

      if (segment) {
        // Check if we need the next segment
        if (bufferEnd >= segment.endTime - 0.1) {
          const nextSegment = rep.segmentIndex.getNextSegment(segment);
          if (nextSegment) {
            this.#nextSegmentToDownload = nextSegment.segmentNumber;
            this.#nextSegmentToAppend = nextSegment.segmentNumber;
            this.#logger.info(
              `Reset to next segment ${
                nextSegment.segmentNumber
              } after buffer end at ${bufferEnd.toFixed(1)}s`
            );
          } else {
            // End of stream
            this.#nextSegmentToDownload = null;
            this.#nextSegmentToAppend = null;
            this.#logger.info("End of stream reached");
          }
        } else {
          // Still within current segment
          this.#nextSegmentToDownload = segment.segmentNumber;
          this.#nextSegmentToAppend = segment.segmentNumber;
          this.#logger.info(
            `Reset to segment ${
              segment.segmentNumber
            } (buffer ends at ${bufferEnd.toFixed(1)}s within segment)`
          );
        }
      }
    } else {
      // Fallback to current time
      const segment = rep.segmentIndex.getSegmentAtTime(currentTime);
      if (segment) {
        this.#nextSegmentToDownload = segment.segmentNumber;
        this.#nextSegmentToAppend = segment.segmentNumber;
        this.#logger.warn(
          `No suitable buffer range found - reset to segment ${segment.segmentNumber} at current time`
        );
      }
    }
  };

  #getSegmentIndex = (): SegmentIndex => {
    if (this.#type === "audio") {
      return playbackController.getCurrentAudioRepresentation().segmentIndex;
    } else {
      return playbackController.getCurrentVideoRepresentation().segmentIndex;
    }
  };

  #initBuffer = async (): Promise<void> => {
    if (!this.#mediaSource) {
      throw new Error("MediaSource not set!");
    }

    this.#logger.debug(`[${this.#type}] initBuffer called`);

    if (this.#sourceBuffer) {
      this.#logger.debug(
        `[${this.#type}] sourceBuffer already exists, skipping`
      );
      return;
    }

    if (!this.#mediaSource) {
      throw new Error(`[${this.#type}] MediaSource not initialized`);
    }

    // Wait for MediaSource to be in 'open' state
    if (this.#mediaSource.readyState !== "open") {
      await new Promise<void>((resolve) => {
        const onOpen = () => {
          this.#mediaSource!.removeEventListener("sourceopen", onOpen);
          resolve();
        };
        this.#mediaSource?.addEventListener("sourceopen", onOpen);
      });
    }

    this.#logger.debug(
      `[${this.#type}] MediaSource state: ${this.#mediaSource.readyState}`
    );

    const rep = this.#getCurrentRepresentation();

    if (!rep) {
      throw new Error(`[${this.#type}] No representation available`);
    }

    const mimeType = this.#constructMimeType(rep.mimeType, rep.codecs);

    try {
      this.#logger.debug(`[${this.#type}] About to call addSourceBuffer...`);
      this.#sourceBuffer = this.#mediaSource.addSourceBuffer(mimeType);
      this.#logger.debug(`[${this.#type}] Successfully created SourceBuffer`);

      if ("mode" in this.#sourceBuffer) {
        try {
          this.#sourceBuffer.mode = "segments";
        } catch (e) {
          this.#logger.debug("Could not set mode to segments:", e);
        }
      }
      if ("timestampOffset" in this.#sourceBuffer) {
        this.#sourceBuffer.timestampOffset = 0;
      }

      this.#initSourceBufferEvents();
    } catch (error) {
      this.#logger.error("Failed to init Buffer", error);
      throw error;
    }
  };

  getSourceBuffer = (): SourceBuffer | null => {
    return this.#sourceBuffer;
  };

  #fetchInitSegment = async (): Promise<ArrayBuffer> => {
    if (!this.#mediaSource || !this.#sourceBuffer) {
      throw new Error("MediaSource or SourceBuffer not initialized");
    }

    const rep = this.#getCurrentRepresentation();

    if (!rep) {
      this.#logger.error("Invalid Representation");
      throw new Error("Invalid Representation");
    }
    const url = manifestParser.getInitializationUrl(rep);
    Assert.assert(
      url && url.length > 0,
      "Initialization url from segment invalid!"
    );
    this.#logger.info(`Fetching init segment: ${url}`);

    try {
      const response = await this.#fetchWithTimeout(
        url,
        new AbortController().signal
      );

      return response.data;
    } catch (e) {
      this.#logger.error("Failed to fetch init segment:", e);
      throw e;
    }
  };

  // Representation change handling
  #handleRepresentationChange = async (payload: Payload): Promise<void> => {
    if (!payload.videoRepresentation) return;

    const newRep = payload.videoRepresentation;

    if (!this.#sourceBuffer) {
      await this.#initBuffer();
      return;
    }

    // Check MediaSource state
    if (!this.#mediaSource || this.#mediaSource.readyState !== "open") {
      this.#logger.warn("MediaSource not ready for representation change");
      return;
    }

    // Cancel pending operations
    this.#cancelPendingDownloads();
    this.#resetAppendQueue();
    this.#updateSegmentTracking(newRep);

    // Use changeType if available
    if (typeof this.#sourceBuffer.changeType === "function") {
      try {
        // Wait for any pending operations
        if (this.#sourceBuffer.updating) {
          await new Promise<void>((resolve) => {
            const onUpdateEnd = () => {
              this.#sourceBuffer!.removeEventListener("updateend", onUpdateEnd);
              resolve();
            };
            Assert.assertDefined(
              this.#sourceBuffer,
              "SourceBuffer, handleRepresentationChange"
            );
            this.#sourceBuffer.addEventListener("updateend", onUpdateEnd, {
              once: true,
            });
          });
        }

        this.#sourceBuffer.abort();

        const newMimeType = this.#constructMimeType(
          newRep.mimeType,
          newRep.codecs
        );

        this.#sourceBuffer.changeType(newMimeType);

        this.#logger.info(`Changed buffer mimeType to: ${newMimeType}`);

        eventBus.trigger(Events.VIDEO_BITRATE_CHANGED, {
          videoRepresentation: newRep,
          switchReason: payload.switchReason,
        });
      } catch (e) {
        this.#logger.error("Failed to change buffer type:", e);
        await this.#recreateSourceBuffer(newRep);
      }
    } else {
      await this.#recreateSourceBuffer(newRep);
    }
  };

  #recreateSourceBuffer = async (
    representation: VideoRepresentation
  ): Promise<void> => {
    if (!this.#mediaSource || !this.#sourceBuffer) return;

    this.#logger.warn("changeType not supported, recreating SourceBuffer");

    try {
      // Clear state
      this.#cancelPendingDownloads();
      this.#appendQueue = [];

      // Remove old source buffer
      this.#removeSourceBufferEvents();
      this.#mediaSource.removeSourceBuffer(this.#sourceBuffer);
      this.#sourceBuffer = null;

      // Create new buffer
      await this.#initBuffer();

      eventBus.trigger(Events.FORCE_VIDEO_BITRATE_CHANGE, {
        videoRepresentation: representation,
      });
    } catch (e) {
      this.#logger.error("Failed to recreate source buffer:", e);
      throw e;
    }
  };

  #constructMimeType = (type: string, codec: string): string => {
    const mimeType = `${type}; codecs="${codec}"`;

    if (!this.#isTypeSupported(mimeType)) {
      this.#logger.warn(`Unsupported MIME type: ${mimeType}`);
    }

    this.#logger.debug(`Constructed mimeType: ${mimeType}`);
    this.#logger.debug(`isTypeSupported: ${this.#isTypeSupported(mimeType)}`);

    return mimeType;
  };

  #isTypeSupported = (mimeType: string): boolean => {
    // For ManagedMediaSource devices
    if (
      this.#isManagedMSE &&
      typeof (window as any).ManagedMediaSource !== "undefined"
    ) {
      return (window as any).ManagedMediaSource.isTypeSupported(mimeType);
    }

    // For regular MediaSource devices
    if (typeof MediaSource !== "undefined") {
      return MediaSource.isTypeSupported(mimeType);
    }

    // Fallback - assume supported if we can't check
    return true;
  };

  #getSegmentRef = (segNum: number, repId: string): SegmentReference | null => {
    const rep = this.#getCurrentRepresentation();

    // If representation has changed, segments from old representation are no longer valid
    if (!rep || rep.id !== repId) {
      return null;
    }

    const segmentIndex = rep.segmentIndex;

    if (!segmentIndex || segmentIndex.references.length === 0) {
      return null;
    }

    return segmentIndex.getSegmentByNumber(segNum);
  };

  // Public API
  getBufferLevel = (): number => {
    return this.#state.level;
  };

  getBufferRanges = (): TimeRanges | null => {
    return this.#sourceBuffer?.buffered || null;
  };

  getBufferTarget = (): number => {
    return this.#config.bufferingTarget;
  };

  getIsBufferingCompleted = (): boolean => {
    return this.#state.isCompleted;
  };

  setIsBufferingCompleted = (value: boolean): void => {
    this.#state.isCompleted = value;
  };

  getMemoryUsage = (): {
    appendQueueMB: number;
    appendQueueDuration: number;
    segmentCount: number;
    remainingBufferSpace: number;
    dynamicLimit: number;
    utilizationPercent: number;
  } => {
    const totalBytes = this.#appendQueue.reduce(
      (total, item) => total + item.data.byteLength,
      0
    );
    const totalDuration = this.#appendQueueDuration;
    const remainingSpace = Math.max(
      0,
      this.#config.bufferingTarget - this.#state.level
    );

    return {
      appendQueueMB: totalBytes / 1024 / 1024,
      appendQueueDuration: totalDuration,
      segmentCount: this.#appendQueue.length,
      remainingBufferSpace: remainingSpace,
      dynamicLimit: remainingSpace,
      utilizationPercent:
        remainingSpace > 0 ? (totalDuration / remainingSpace) * 100 : 100,
    };
  };

  getCurrentSegmentDownloads = (): number[] => {
    return Array.from(this.#downloadPipeline.keys());
  };

  getDownloadStatus = (): {
    downloading: number[];
    queued: Array<{ segment: number; duration: number; sizeMB: number }>;
    pipeline: Array<{ segment: number; url: string; elapsed: number }>;
    memoryPressure: number;
    canDownloadMore: boolean;
    bufferInfo: {
      current: number;
      target: number;
      remaining: number;
    };
  } => {
    const now = Date.now();
    const memoryUsage = this.getMemoryUsage();
    const remainingSpace = Math.max(
      0,
      this.#config.bufferingTarget - this.#state.level
    );
    const downloadingDuration = this.#getDownloadingDuration();

    return {
      downloading: Array.from(this.#downloadPipeline.keys()),
      queued: this.#appendQueue.map((item) => ({
        segment: item.segmentNumber,
        duration: item.duration,
        sizeMB: item.data.byteLength / 1024 / 1024,
      })),
      pipeline: Array.from(this.#downloadPipeline.values()).map((task) => ({
        segment: task.segmentNumber,
        url: task.url,
        elapsed: now - task.startTime,
      })),
      memoryPressure:
        remainingSpace > 0
          ? (memoryUsage.appendQueueDuration + downloadingDuration) /
            remainingSpace
          : 1,
      canDownloadMore: this.#shouldStartNewDownload(),
      bufferInfo: {
        current: this.#state.level,
        target: this.#config.bufferingTarget,
        remaining: remainingSpace,
      },
    };
  };

  // Load next segment - public interface
  loadNextVideoSegment = async (): Promise<void> => {
    await this.loadNextSegments();
  };

  // Add method to clear append queue if needed
  clearAppendQueue = (): void => {
    const clearedCount = this.#appendQueue.length;
    this.#appendQueue = [];
    if (clearedCount > 0) {
      this.#logger.warn(`Cleared ${clearedCount} segments from append queue`);
    }
  };

  purgeBuffer = async (): Promise<void> => {
    this.#logger.info("Detected restart - clearing all buffered content");
    const ranges = this.#getAllBufferRanges();
    for (const range of ranges) {
      try {
        await this.#removeBufferRange(range.start, range.end);
      } catch (e) {
        this.#logger.warn(
          `Failed to remove range [${range.start}-${range.end}]:`,
          e
        );
      }
    }
  };

  getAppendQueue = (): QueuedSegment[] => {
    return this.#appendQueue;
  };
}

// Export singleton instances
export const bufferController = new BufferController("video");
export const audioBufferController = new BufferController("audio");
