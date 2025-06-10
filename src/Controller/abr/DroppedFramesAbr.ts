import { droppedFramesHistory } from "../../DroppedFramesHistory.js";
import { logger } from "../../Logger.js";
import { Assert } from "../../utils/assertion.js";
import { AbrStrategy, VideoRepresentation } from "../../Types.js";
import { playbackController } from "../PlaybackController.js";

export class DroppedFramesAbr implements AbrStrategy {
  readonly #DROPPED_FRAMES_PERCENTAGE_THRESHOLD = 0.15;
  readonly #MINIMUM_SAMPLE_SIZE = 375;
  readonly #MAX_CONSECUTIVE_DOWNGRADES = 2;
  readonly #DOWNGRADE_COOLDOWN_MS = 10000;

  #downgrades = new Map<
    number,
    {
      count: number;
      lastDowngradeTime: number;
    }
  >();

  #logger = logger.createChild("DroppedFramesAbr");
  #representations: VideoRepresentation[] = [];

  constructor() {}

  setRepresentations(representations: VideoRepresentation[]): void {
    this.#representations = representations;
  }

  chooseRepresentation = (): VideoRepresentation | null => {
    // Default to first stream for now - could be made configurable
    const streamId = 0;
    const currentRepresentation =
      playbackController.getCurrentVideoRepresentation();

    Assert.assert(currentRepresentation && this.#representations.length);

    if (this.#shouldLowerResolution(streamId, currentRepresentation.id)) {
      // Find next lower quality representation
      const currentIndex = this.#representations.findIndex(
        (r) => r.id === currentRepresentation.id
      );

      return currentIndex > 0
        ? this.#representations[currentIndex - 1]
        : this.#representations[0];
    }

    return null;
  };

  /**
   * Determines if video quality should be lowered based on dropped frame metrics
   * @param streamId - The ID of the stream
   * @param representationId - The ID of the quality representation
   * @returns boolean indicating if quality should be lowered
   */
  #shouldLowerResolution = (
    streamId: number,
    representationId: string
  ): boolean => {
    Assert.assertDefined(streamId);
    Assert.assertDefined(representationId);

    try {
      const videoQuality = droppedFramesHistory.getFrameHistory(
        streamId,
        representationId
      );

      if (videoQuality.totalVideoFrames < this.#MINIMUM_SAMPLE_SIZE) {
        return false;
      }

      const streamDowngrades = this.#downgrades.get(streamId);
      const now = Date.now();
      if (streamDowngrades) {
        const timeSinceLastDowngrade = now - streamDowngrades.lastDowngradeTime;
        if (timeSinceLastDowngrade < this.#DOWNGRADE_COOLDOWN_MS) {
          return false;
        }

        if (streamDowngrades.count >= this.#MAX_CONSECUTIVE_DOWNGRADES) {
          return false;
        }
      }

      const dropRate =
        videoQuality.droppedVideoFrames / videoQuality.totalVideoFrames;

      // Update downgrade tracking
      if (dropRate > this.#DROPPED_FRAMES_PERCENTAGE_THRESHOLD) {
        if (streamDowngrades) {
          streamDowngrades.count++;
          streamDowngrades.lastDowngradeTime = now;
        } else {
          this.#downgrades.set(streamId, {
            count: 1,
            lastDowngradeTime: now,
          });
        }
        return true;
      }

      // Reset counter if drop rate is significantly lower
      if (dropRate < this.#DROPPED_FRAMES_PERCENTAGE_THRESHOLD / 2) {
        this.#downgrades.delete(streamId);
      }

      return false;
    } catch (error) {
      this.#logger.debug(
        `Error checking dropped frames for stream ${streamId}, representation ${representationId}:`,
        error
      );
      return false;
    }
  };

  reset(): void {
    this.#downgrades.clear();
  }
}
