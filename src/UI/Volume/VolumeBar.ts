import { Assert } from "../../utils/assertion.js";
import { video } from "../../Video.js";
import { Scrubber } from "../Scrubber.js";

export class VolumeBar {
  static readonly #UPDATE_INTERVAL_MS = 40;
  static readonly #VOLUME_STEP = 0.05;
  static readonly #VIDEO_UPDATE_DELAY_MS = 16; // Debounce actual video updates

  #volumeBarWrapper: HTMLDivElement;
  #volumeBar: HTMLDivElement;
  #currentVolumeBar: HTMLDivElement;
  #scrubber: Scrubber;

  #isDragging = false;
  #lastNonZeroVolume = 0.5;
  #animationFrameId: number | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #boundingRect: DOMRect;
  #lastUpdateTime = 0;

  // Debouncing properties
  #uiUpdateTimer: number | null = null;
  #videoUpdateTimer: number | null = null;
  #pendingVolume: number | null = null;

  constructor(controlsWrapper: HTMLDivElement) {
    Assert.assertDefined(
      controlsWrapper,
      "VolumeControls: Invalid controls wrapper"
    );

    this.#volumeBarWrapper = this.#getRequiredElement(
      controlsWrapper,
      "#volume-bar-wrapper"
    );
    this.#volumeBar = this.#getRequiredElement(controlsWrapper, "#volume-bar");
    this.#currentVolumeBar = this.#getRequiredElement(
      controlsWrapper,
      "#current-volume-bar"
    );
    this.#scrubber = new Scrubber("volume-scrubber-btn");

    this.#boundingRect = this.#volumeBarWrapper.getBoundingClientRect();
  }

  init = (): void => {
    this.#setupEventListeners();
    this.#setupAccessibility();
    this.#setupResizeObserver();
    this.#syncWithVideo();
    this.#startUpdateLoop();
  };

  #setupEventListeners = (): void => {
    this.#volumeBarWrapper.addEventListener("mousedown", this.#handleMouseDown);
    this.#volumeBarWrapper.addEventListener("keydown", this.#handleKeyDown);
    this.#volumeBarWrapper.addEventListener("wheel", this.#handleWheel, {
      passive: false,
    });
  };

  #setupAccessibility = (): void => {
    this.#volumeBarWrapper.setAttribute("role", "slider");
    this.#volumeBarWrapper.setAttribute("aria-label", "Volume");
    this.#volumeBarWrapper.setAttribute("aria-valuemin", "0");
    this.#volumeBarWrapper.setAttribute("aria-valuemax", "100");
    this.#volumeBarWrapper.setAttribute("tabindex", "0");
    this.#volumeBarWrapper.classList.add(
      "focus:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-white",
      "focus-visible:ring-opacity-80"
    );
  };

  #setupResizeObserver = (): void => {
    this.#resizeObserver = new ResizeObserver((entries) => {
      this.#boundingRect = entries[0].target.getBoundingClientRect();
    });
    this.#resizeObserver.observe(this.#volumeBarWrapper);
  };

  #syncWithVideo = (): void => {
    const volume = video.getCurrVolume();
    const muted = video.isMuted();

    if (volume > 0) {
      this.#lastNonZeroVolume = volume;
    }

    this.#updateUI(muted ? 0 : volume);
    this.#updateAccessibility(volume, muted);
  };

  #startUpdateLoop = (): void => {
    const update = (timestamp: number) => {
      if (timestamp - this.#lastUpdateTime >= VolumeBar.#UPDATE_INTERVAL_MS) {
        this.#lastUpdateTime = timestamp;

        if (!this.#isDragging) {
          this.#syncWithVideo();
        }
      }

      this.#animationFrameId = requestAnimationFrame(update);
    };

    this.#animationFrameId = requestAnimationFrame(update);
  };

  #handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;

    this.#isDragging = true;
    this.#boundingRect = this.#volumeBarWrapper.getBoundingClientRect();

    this.#setVolumeFromPosition(event.clientX);

    document.addEventListener("mousemove", this.#handleMouseMove, {
      passive: true,
    });
    document.addEventListener("mouseup", this.#handleMouseUp, {
      passive: true,
    });

    event.preventDefault();
  };

  #handleMouseMove = (event: MouseEvent): void => {
    if (!this.#isDragging) return;
    this.#setVolumeFromPosition(event.clientX);
  };

  #handleMouseUp = (event: MouseEvent): void => {
    if (!this.#isDragging) return;

    this.#isDragging = false;
    this.#setVolumeFromPosition(event.clientX);

    // Ensure final volume is applied immediately when dragging ends
    this.#flushPendingVolumeUpdate();

    document.removeEventListener("mousemove", this.#handleMouseMove);
    document.removeEventListener("mouseup", this.#handleMouseUp);
  };

  #handleKeyDown = (event: KeyboardEvent): void => {
    const currentVolume = video.getCurrVolume();
    let handled = true;

    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        this.#setVolume(currentVolume + VolumeBar.#VOLUME_STEP);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        this.#setVolume(currentVolume - VolumeBar.#VOLUME_STEP);
        break;
      case "Home":
        this.#setVolume(0);
        break;
      case "End":
        this.#setVolume(1);
        break;
      case " ":
      case "Enter":
        this.#toggleMute();
        break;
      default:
        handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  #handleWheel = (event: WheelEvent): void => {
    const currentVolume = video.getCurrVolume();
    const delta =
      event.deltaY > 0 ? -VolumeBar.#VOLUME_STEP : VolumeBar.#VOLUME_STEP;
    this.#setVolume(currentVolume + delta);
    event.preventDefault();
  };

  #setVolumeFromPosition = (clientX: number): void => {
    const progress = this.#calculateProgress(clientX);
    this.#setVolume(progress);
  };

  #calculateProgress = (clientX: number): number => {
    const relativeX = clientX - this.#boundingRect.left;
    const progress = relativeX / this.#boundingRect.width;
    return Math.max(0, Math.min(1, progress));
  };

  #setVolume = (volume: number): void => {
    const clampedVolume = Math.max(0, Math.min(1, volume));
    this.#pendingVolume = clampedVolume;

    // Update UI immediately for responsive feel (debounced lightly)
    this.#debouncedUIUpdate(clampedVolume);

    // Update video with more aggressive debouncing
    this.#debouncedVideoUpdate(clampedVolume);
  };

  #debouncedUIUpdate = (volume: number): void => {
    if (this.#uiUpdateTimer !== null) {
      clearTimeout(this.#uiUpdateTimer);
    }

    this.#updateUI(volume);
    this.#updateAccessibility(volume, volume === 0);
    this.#uiUpdateTimer = null;
  };

  #debouncedVideoUpdate = (volume: number): void => {
    if (this.#videoUpdateTimer !== null) {
      clearTimeout(this.#videoUpdateTimer);
    }

    this.#videoUpdateTimer = setTimeout(() => {
      this.#applyVolumeToVideo(volume);
      this.#videoUpdateTimer = null;
    }, VolumeBar.#VIDEO_UPDATE_DELAY_MS);
  };

  #applyVolumeToVideo = (volume: number): void => {
    video.setVolume(volume);

    // Store last non-zero volume for mute toggle
    if (volume > 0) {
      this.#lastNonZeroVolume = volume;
    }
  };

  #flushPendingVolumeUpdate = (): void => {
    if (this.#videoUpdateTimer !== null) {
      clearTimeout(this.#videoUpdateTimer);
      this.#videoUpdateTimer = null;
    }

    if (this.#pendingVolume !== null) {
      this.#applyVolumeToVideo(this.#pendingVolume);
    }
  };

  #toggleMute = (): void => {
    const currentVolume = video.getCurrVolume();
    const isMuted = video.isMuted() || currentVolume === 0;

    if (isMuted) {
      this.#setVolume(this.#lastNonZeroVolume);
    } else {
      this.#setVolume(0);
    }
  };

  #updateUI = (displayVolume: number): void => {
    // Update progress bar
    this.#currentVolumeBar.style.transform = `scaleX(${displayVolume})`;

    // Update scrubber position
    this.#scrubber.updatePos(displayVolume);
  };

  #updateAccessibility = (volume: number, muted: boolean): void => {
    const volumePercent = Math.round(volume * 100);
    this.#volumeBarWrapper.setAttribute(
      "aria-valuenow",
      volumePercent.toString()
    );
    this.#volumeBarWrapper.setAttribute(
      "aria-valuetext",
      muted ? "Muted" : `${volumePercent}%`
    );
  };

  #getRequiredElement = <T extends HTMLElement>(
    container: HTMLElement,
    selector: string
  ): T => {
    const element = container.querySelector(selector) as T;
    Assert.assertDefined(element, `Required element not found: ${selector}`);
    return element;
  };

  toggleMute = (): void => this.#toggleMute();

  destroy = (): void => {
    // Clear any pending debounced updates
    if (this.#uiUpdateTimer !== null) {
      clearTimeout(this.#uiUpdateTimer);
      this.#uiUpdateTimer = null;
    }

    if (this.#videoUpdateTimer !== null) {
      clearTimeout(this.#videoUpdateTimer);
      this.#videoUpdateTimer = null;
    }

    if (this.#animationFrameId !== null) {
      cancelAnimationFrame(this.#animationFrameId);
      this.#animationFrameId = null;
    }

    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }

    this.#volumeBarWrapper.removeEventListener(
      "mousedown",
      this.#handleMouseDown
    );
    this.#volumeBarWrapper.removeEventListener("keydown", this.#handleKeyDown);
    this.#volumeBarWrapper.removeEventListener("wheel", this.#handleWheel);

    document.removeEventListener("mousemove", this.#handleMouseMove);
    document.removeEventListener("mouseup", this.#handleMouseUp);
  };
}
