import {
  bufferController,
  type BufferController,
} from "../../Controller/BufferController.js";
import { playbackController } from "../../Controller/PlaybackController.js";
import { eventBus } from "../../Events/EventBus.js";
import { Events } from "../../Events/Events.js";
import { MediaPlayerEvents } from "../../Events/MediaPlayerEvents.js";
import { Assert } from "../../utils/assertion.js";
import { parseSeconds } from "../../utils/timeParser.js";
import { Scrubber } from "../Scrubber.js";
import { TrickplayPreview } from "./Trickplay/TrickplayPreview.js";

/**
 * Video player timeline/seekbar component with buffer display and scrubbing
 * Manages playback progress visualization, buffer level, seek interactions and trickplay previews
 */
export class Timeline {
  readonly #UPDATE_INTERVAL_MS = 40; // ~25fps update rate for smooth progress tracking
  #timeline: HTMLDivElement; // Container element
  #timebar: HTMLDivElement; // Playback progress indicator
  #bufferDiv: HTMLDivElement; // Buffer level indicator
  #scrubber: Scrubber = new Scrubber("scrubber-btn");
  #timeRemaining: HTMLSpanElement;
  #animationFrameId: number | null = null;
  #lastUpdate: number = 0;
  #trickplayPreview: TrickplayPreview;

  // Mouse interaction state
  #isDragging = false;
  #timelineRect: DOMRect;

  constructor(bifLink: string) {
    this.#timeline = document.getElementById("actualBar") as HTMLDivElement;
    this.#timeRemaining = document.getElementById(
      "time-remaining"
    ) as HTMLSpanElement;
    this.#timebar = this.#timeline.querySelector("#timebar")!;
    this.#bufferDiv = this.#timeline.querySelector("#buffered-amount")!;

    Assert.assertDefined(this.#timeline, "timeline");
    Assert.assertDefined(this.#timeRemaining, "timeRemaining");
    Assert.assertDefined(this.#timebar, "timebar");
    Assert.assertDefined(this.#bufferDiv, "bufferDiv");

    this.#trickplayPreview = new TrickplayPreview(this.#timeline, bifLink);
    this.#timelineRect = this.#timeline.getBoundingClientRect();
  }

  init = async (): Promise<void> => {
    const eventHandlers: [string, Function][] = [
      [MediaPlayerEvents.SEEKED, this.#onSeek],
      [MediaPlayerEvents.PLAYBACK_PAUSED, this.#stopUpdating],
      [Events.BUFFER_LEVEL_UPDATED, this.#onBufferLevelUpdated],
      [MediaPlayerEvents.PLAYBACK_STARTED, this.#onPlaybackStarted],
      [MediaPlayerEvents.DIMENSIONS_CHANGED, this.#onPlayerResize],
    ];

    eventHandlers.forEach(([handler, event]) => {
      eventBus.on(handler, event.bind(this), this);
    });

    this.#timeline.addEventListener("mousedown", this.#handleMouseDown);
    this.#timeline.addEventListener("touchstart", this.#handleTouchStart);

    // Track timeline dimensions to accurately calculate seek positions
    const ro = new ResizeObserver((entries) => {
      this.#timelineRect = entries[0].contentRect;
    });
    ro.observe(this.#timeline);

    await this.#trickplayPreview.init();
  };

  /**
   * Update buffer level indicator when buffer changes
   * Skips update when timeline is already being animated
   */
  #onBufferLevelUpdated = (): void => {
    if (this.#animationFrameId) return;

    this.#bufferDiv.style.transform = `scaleX(${
      (bufferController.getBufferLevel() + playbackController.getTime()) /
      playbackController.getDuration()
    })`;
  };

  /**
   * Update timeline dimensions when player size changes
   */
  #onPlayerResize = (): void => {
    this.#timelineRect = this.#timeline.getBoundingClientRect();
    requestAnimationFrame(this.#updateTimebar);
  };

  /**
   * Start animation loop when playback begins
   */
  #onPlaybackStarted = () => {
    this.#animationFrameId = requestAnimationFrame(this.#updateTimebar);
  };

  /**
   * Update timeline immediately after a seek operation
   */
  #onSeek = (): void => {
    requestAnimationFrame(this.#updateTimebar);
  };

  #handleTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.#isDragging = true;
    this.#timelineRect = this.#timeline.getBoundingClientRect();

    if (e.touches.length > 0) {
      const touch = e.touches[0];
      this.#updateScrubberPosition(touch.clientX);
      this.#trickplayPreview.updatePreviewForDrag(touch.clientX);
    }

    document.addEventListener("touchmove", this.#updatePreviewTouch, {
      passive: false,
    });
    document.addEventListener("touchend", this.#handleTouchEnd, {
      passive: false,
    });
  };

  #handleTouchEnd = (e: TouchEvent): void => {
    e.preventDefault();

    document.removeEventListener("touchmove", this.#updatePreviewTouch);
    document.removeEventListener("touchend", this.#handleTouchEnd);

    if (!this.#isDragging) return;

    if (e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      this.#updateScrubberPosition(touch.clientX);

      const progress = this.#calculateProgress(touch.clientX);
      eventBus.trigger(Events.SEEK_REQUESTED, {
        seekTo: playbackController.getDuration() * progress,
      });
      setTimeout(() => {
        this.#trickplayPreview.hidePreview();
      }, 1000);
    }

    this.#isDragging = false;
  };

  #updatePreviewTouch = (e: TouchEvent): void => {
    e.preventDefault();
    if (!this.#isDragging) return;
    if (e.touches.length === 0) return;

    const touch = e.touches[0];
    this.#updateScrubberPosition(touch.clientX);
    this.#trickplayPreview.updatePreviewForDrag(touch.clientX);
  };

  /**
   * Begin scrubbing when user clicks on timeline
   * Sets up document-level event tracking for drag operations
   */
  #handleMouseDown = (e: MouseEvent): void => {
    this.#isDragging = true;
    this.#timelineRect = this.#timeline.getBoundingClientRect();
    this.#updateScrubberPosition(e.clientX);

    // Track mouse movements outside timeline element
    document.addEventListener("mousemove", this.#handleMouseMove, {
      passive: true,
    });
    document.addEventListener("mouseup", this.#handleMouseUp, {
      passive: true,
    });

    e.preventDefault();
  };

  /**
   * Update scrubber position during drag operations
   * Also updates trickplay preview to show frame at potential seek position
   */
  #handleMouseMove = (e: MouseEvent): void => {
    if (!this.#isDragging) return;

    this.#updateScrubberPosition(e.clientX);
    this.#trickplayPreview.updatePreviewForDrag(e.clientX);
  };

  /**
   * Complete seek operation when mouse is released
   * Triggers actual seek to target position and cleans up event listeners
   */
  #handleMouseUp = (e: MouseEvent): void => {
    document.removeEventListener("mousemove", this.#handleMouseMove);
    document.removeEventListener("mouseup", this.#handleMouseUp);

    if (!this.#isDragging) return;

    this.#updateScrubberPosition(e.clientX);

    const progress = this.#calculateProgress(e.clientX);
    eventBus.trigger(Events.SEEK_REQUESTED, {
      seekTo: playbackController.getDuration() * progress,
    });
    setTimeout(() => {
      this.#trickplayPreview.hidePreview();
    }, 1000);

    this.#isDragging = false;
  };

  /**
   * Calculate relative progress (0-1) from mouse X position
   * Clamps value to valid range even if mouse is outside timeline bounds
   */
  #calculateProgress = (clientX: number): number => {
    return Math.max(
      0,
      Math.min(
        1,
        (clientX - this.#timelineRect.left) / this.#timelineRect.width
      )
    );
  };

  /**
   * Update UI components based on current scrubber position
   * Updates progress bar, scrubber handle and time display
   */
  #updateScrubberPosition = (clientX: number): void => {
    const progress = this.#calculateProgress(clientX);

    this.#timebar.style.transform = `scaleX(${progress})`;
    this.#scrubber.updatePos(progress);

    // Update time remaining display
    const duration = playbackController.getDuration();
    const newTime = duration * progress;
    this.#timeRemaining.textContent = parseSeconds(duration - newTime);
  };

  /**
   * Stop animation updates when playback is paused
   */
  #stopUpdating = (): void => {
    if (this.#animationFrameId) {
      cancelAnimationFrame(this.#animationFrameId);
      this.#animationFrameId = null;
    }
  };

  /**
   * Animation loop to update timeline based on current playback position
   * Throttles updates to maintain performance while ensuring smooth visuals
   */
  #updateTimebar = (): void => {
    // Skip position updates during drag operations
    if (this.#isDragging) {
      this.#animationFrameId = requestAnimationFrame(this.#updateTimebar);
      return;
    }

    const now = performance.now();

    // Only update at specified interval to reduce DOM operations
    if (now - this.#lastUpdate > this.#UPDATE_INTERVAL_MS) {
      this.#lastUpdate = now;

      const duration = playbackController.getDuration();
      const currTime = playbackController.getTime();

      // Update buffer level indicator (clamped to maximum of 100%)
      const bufferLevel = bufferController.getBufferLevel();
      this.#bufferDiv.style.transform = `scaleX(${Math.min(
        (bufferLevel + currTime) / duration,
        1
      )})`;

      // Update playback progress indicator
      const progress = Math.min(1, currTime / duration);
      this.#timebar.style.transform = `scaleX(${progress})`;
      this.#scrubber.updatePos(progress);

      this.#timeRemaining.textContent = parseSeconds(duration - currTime);
    }

    // Continue animation loop if still active
    if (this.#animationFrameId !== null) {
      this.#animationFrameId = requestAnimationFrame(this.#updateTimebar);
    }
  };
}
