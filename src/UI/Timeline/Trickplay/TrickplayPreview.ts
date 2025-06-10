import { logger } from "../../../Logger.js";
import { Assert } from "../../../utils/assertion.js";
import { parseSeconds } from "../../../utils/timeParser.js";
import { video } from "../../../Video.js";
import { BifWorkerController } from "./BifWorkerController .js";

/**
 * Handles video frame previews during timeline hover/scrubbing
 * Uses BIF (Binary Indexed Frame) files to show preview thumbnails
 * at the user's cursor position
 */
export class TrickplayPreview {
  readonly #timeline: HTMLDivElement;
  readonly #wrapper: HTMLDivElement;
  readonly #timeDiv: HTMLDivElement;
  readonly #img: HTMLImageElement;
  readonly #bifController: BifWorkerController;

  #rect: DOMRect;
  #dimensions = {
    mouseX: 0,
    mousePos: 0,
    newTime: 0,
    translateX: 0,
  };

  #lastUpdateTime = 0;
  static readonly UPDATE_INTERVAL = Math.round(1000 / 30); // ~30fps throttling
  #rafId: number | null = null;
  #destroyed = false;
  #isVisible = false;

  constructor(timeline: HTMLDivElement, bifUrl: string) {
    this.#timeline = timeline;
    this.#wrapper = document.getElementById(
      "seek-preview-wrapper"
    ) as HTMLDivElement;
    this.#timeDiv = this.#wrapper.querySelector(
      "#seek-preview-time"
    ) as HTMLDivElement;
    this.#img = this.#wrapper.querySelector(
      "#seek-preview-img"
    ) as HTMLImageElement;

    Assert.assertDefined(this.#wrapper);
    Assert.assertDefined(this.#timeDiv);
    Assert.assertDefined(this.#img);

    // Cache timeline dimensions for position calculations
    this.#rect = timeline.getBoundingClientRect();

    this.#bifController = new BifWorkerController(
      new URL("./BifWorker.js", import.meta.url).href,
      bifUrl
    );
  }

  async init(): Promise<void> {
    this.#initEvents();
  }

  #initEvents(): void {
    this.#timeline.addEventListener("mousemove", this.#updatePreview, {
      passive: true,
    });
    this.#timeline.addEventListener("mouseleave", this.hidePreview, {
      passive: true,
    });
    this.#timeline.addEventListener("mouseenter", this.#showPreview, {
      passive: true,
    });

    // Track timeline size changes to maintain accurate positioning
    const ro = new ResizeObserver((entries) => {
      this.#rect = entries[0].contentRect;
    });
    ro.observe(this.#timeline);
  }

  /**
   * Update preview during drag operations from Timeline component
   * Creates a synthetic event to reuse existing update logic
   */
  updatePreviewForDrag = (clientX: number): void => {
    if (this.#destroyed) return;

    if (!this.#isVisible) {
      this.#showPreview();
    }

    // Create synthetic event with minimal needed properties
    const syntheticEvent = {
      clientX,
    } as MouseEvent;

    this.#updatePreview(syntheticEvent);
  };

  /**
   * Update the preview position and content based on mouse position
   * Throttled to limit performance impact and network requests
   */
  #updatePreview = (e: MouseEvent): void => {
    // Throttle updates to maintain performance
    const now = performance.now();
    if (now - this.#lastUpdateTime < TrickplayPreview.UPDATE_INTERVAL) {
      return;
    }
    this.#lastUpdateTime = now;

    // Cancel any pending frame to avoid stale updates
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
    }

    this.#rafId = requestAnimationFrame(() => {
      if (this.#destroyed) return;

      // Calculate scaled position (0-1) along timeline
      this.#dimensions.mouseX = e.clientX;
      this.#dimensions.mousePos =
        (this.#dimensions.mouseX - this.#rect.left) / this.#rect.width;

      // Ensure position stays within valid range
      this.#dimensions.mousePos = Math.max(
        0,
        Math.min(1, this.#dimensions.mousePos)
      );

      // Convert to video time
      this.#dimensions.newTime = Math.floor(
        video.getDuration() * this.#dimensions.mousePos
      );

      // Update timestamp if changed
      const timeText = parseSeconds(this.#dimensions.newTime);
      if (this.#timeDiv.textContent !== timeText) {
        this.#timeDiv.textContent = timeText;
      }

      // Calculate horizontal position, keeping preview within viewport
      this.#dimensions.translateX = Math.min(
        Math.max(
          this.#dimensions.mouseX -
            this.#rect.left -
            this.#timeDiv.clientWidth / 2,
          0
        ),
        video.getClientWidth() - this.#timeDiv.clientWidth
      );

      // Apply transform to position preview
      this.#wrapper.style.transform = `translateX(${
        this.#dimensions.translateX
      }px)`;

      // Request thumbnail frame from worker
      this.#bifController
        .getFrame(this.#dimensions.newTime * 1000)
        .then((imgUrl) => {
          if (this.#destroyed) return;
          if (imgUrl) this.#img.src = imgUrl;
        })
        .catch((err) => {
          if (!this.#destroyed) {
            console.error("Failed to get preview frame:", err);
          }
        });

      this.#rafId = null;
    });
  };

  #showPreview = (): void => {
    if (this.#destroyed) return;
    this.#wrapper.style.display = "flex";
    this.#isVisible = true;
  };

  hidePreview = (): void => {
    if (this.#destroyed) return;
    this.#wrapper.style.display = "none";
    this.#isVisible = false;
  };

  destroy = (): void => {
    this.#destroyed = true;

    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
    }

    this.#timeline.removeEventListener("mousemove", this.#updatePreview);
    this.#timeline.removeEventListener("mouseleave", this.hidePreview);
    this.#timeline.removeEventListener("mouseenter", this.#showPreview);

    this.#bifController.destroy?.();
  };
}
