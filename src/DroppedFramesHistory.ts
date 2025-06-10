import { Assert } from "./utils/assertion.js";

interface IVideoPlayBackQuality {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/VideoPlaybackQuality/droppedVideoFrames) */
  droppedVideoFrames: number;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/VideoPlaybackQuality/totalVideoFrames) */
  totalVideoFrames: number;
}

class DroppedFramesHistory {
  #values = new Map<string, IVideoPlayBackQuality>();
  #lastDroppedFrames: Map<number, number> = new Map();
  #lastTotalFrames: Map<number, number> = new Map();

  #getKey = (streamId: number, representationId: string): string => {
    return `${streamId}:${representationId}`;
  };

  /**
   * Pushes new video playback quality metrics for a specific stream and representation
   * @param streamId - The ID of the stream
   * @param representationId - The ID of the quality representation
   * @param playbackQuality - The VideoPlaybackQuality metrics
   * @throws {Error} If invalid parameters are provided
   */
  push = (
    streamId: number,
    representationId: string,
    playbackQuality: VideoPlaybackQuality
  ): void => {
    // Input validation
    Assert.assert(streamId >= 0, "streamId must be >= 0!");
    Assert.assert(
      representationId.length > 0,
      "representationId's length must be >0"
    );
    Assert.assertDefined(playbackQuality);

    const currentDroppedFrames = Math.max(
      0,
      playbackQuality?.droppedVideoFrames ?? 0
    );
    const currentTotalFrames = Math.max(
      0,
      playbackQuality?.totalVideoFrames ?? 0
    );

    const lastDropped = this.#lastDroppedFrames.get(streamId) ?? 0;
    const lastTotal = this.#lastTotalFrames.get(streamId) ?? 0;

    const intervalDroppedFrames = Math.max(
      0,
      currentDroppedFrames - lastDropped
    );
    const intervalTotalFrames = Math.max(0, currentTotalFrames - lastTotal);

    // Update last known values
    this.#lastDroppedFrames.set(streamId, currentDroppedFrames);
    this.#lastTotalFrames.set(streamId, currentTotalFrames);

    const key = this.#getKey(streamId, representationId);
    const history = this.#values.get(key);

    // Initialize stream history if needed
    if (history) {
      history.droppedVideoFrames += intervalDroppedFrames;
      history.totalVideoFrames += intervalTotalFrames;
    } else {
      this.#values.set(key, {
        droppedVideoFrames: intervalDroppedFrames,
        totalVideoFrames: intervalTotalFrames,
      });
    }
  };

  /**
   * Retrieves frame history for a specific stream and representation
   * @param streamId - The ID of the stream
   * @param representationId - The ID of the quality representation
   * @returns The video playback quality metrics
   * @throws {Error} If the requested history doesn't exist
   */
  getFrameHistory = (
    streamId: number,
    representationId: string
  ): IVideoPlayBackQuality => {
    Assert.assertDefined(streamId);
    Assert.assertDefined(representationId);

    const history = this.#values.get(this.#getKey(streamId, representationId));

    Assert.assertDefined(
      history,
      `No history found for stream ${streamId}, representation ${representationId}`
    );

    return {
      droppedVideoFrames: history.droppedVideoFrames,
      totalVideoFrames: history.totalVideoFrames,
    };
  };

  getDropRate = (streamId: number, representationId: string): number => {
    const history = this.#values.get(this.#getKey(streamId, representationId));
    if (!history || history.totalVideoFrames === 0) return 0;
    return history.droppedVideoFrames / history.totalVideoFrames;
  };

  clearStreamHistory = (streamId: number): void => {
    for (const key of this.#values.keys()) {
      if (key.startsWith(`${streamId}:`)) {
        this.#values.delete(key);
      }
    }
    this.#lastDroppedFrames.delete(streamId);
    this.#lastTotalFrames.delete(streamId);
  };

  clearAllHistory = (): void => {
    this.#values.clear();
    this.#lastDroppedFrames.clear();
    this.#lastTotalFrames.clear();
  };
}

export const droppedFramesHistory = new DroppedFramesHistory();
