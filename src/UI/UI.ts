import { Analytics } from "./Analytics.js";
import { Controls } from "./Controls.js";
import { PlaybackRateSelector } from "./PlaybackRateSelector.js";
import { PlaybackResSelector } from "./PlaybackResSelector.js";
import { Timeline } from "./Timeline/Timeline.js";
import { eventBus, EventBus, Payload } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { MediaPlayerEvents } from "../Events/MediaPlayerEvents.js";
import { Assert } from "../utils/assertion.js";
import { PlayButton } from "./PlayButton.js";
import { MobileSettingsBtn } from "./MobileSettingsBtn.js";
import { video } from "../Video.js";

interface UIElements {
  controls: HTMLDivElement;
  videoPlayer: HTMLDivElement;
  videoTitle: HTMLDivElement;
}

/**
 * Main UI controller for the video player
 * Manages controls visibility, user interactions, and coordinates UI components
 */
export class UI {
  private static readonly UI_HIDE_DELAY = 2000; // Auto-hide timeout in ms
  private static readonly DOUBLE_CLICK_THRESHOLD = 100; // Time window for detecting double clicks

  // DOM Element references
  readonly #elements: UIElements;

  // UI Component instances
  readonly #mobileSettingsBtn: MobileSettingsBtn;
  readonly #analytics = new Analytics();
  readonly #timeline: Timeline;
  readonly #controls: Controls;
  readonly #playbackResSelector: PlaybackResSelector;
  readonly #playbackRateSelector: PlaybackRateSelector;
  readonly #playButton: PlayButton;
  // UI State
  #idleTimer?: number;
  #clickTimeout?: number;
  #isUIVisible = false;

  #keepUiVisible = false;

  constructor(bifUrl: string) {
    const elements = this.#getDOMElements();
    this.#elements = elements;
    this.#controls = new Controls(elements.controls);
    this.#playbackResSelector = new PlaybackResSelector();
    this.#playbackRateSelector = new PlaybackRateSelector();
    this.#playButton = new PlayButton(this.#elements.videoPlayer);
    this.#timeline = new Timeline(bifUrl);
    this.#mobileSettingsBtn = new MobileSettingsBtn();
  }

  init = async (): Promise<void> => {
    this.#setupEventListeners();
    this.#mobileSettingsBtn.init();
    await this.#timeline.init();
  };

  setVideoTitle = (title: string): void => {
    this.#elements.videoTitle.textContent = title;
  };

  /**
   * Get and validate required DOM elements
   */
  #getDOMElements = (): UIElements => {
    const controls = document.getElementById("controls") as HTMLDivElement;
    const videoPlayer = document.getElementById(
      "videoPlayer"
    ) as HTMLDivElement;
    const videoTitle = document.getElementById("video-title") as HTMLDivElement;

    Assert.assert(controls && videoPlayer && videoTitle, "UI: DOM Elements");
    return { controls, videoPlayer, videoTitle };
  };

  /**
   * Set up event listeners for UI interactions
   * Handles both DOM events and player event bus events
   */
  #setupEventListeners = () => {
    const busEvents: [string, (payload: Payload) => void][] = [
      [MediaPlayerEvents.PLAYBACK_STARTED, this.#onPlaybackStarted],
      [MediaPlayerEvents.PLAYBACK_PAUSED, this.#onPlaybackPaused],
      [MediaPlayerEvents.SEEKED, this.#handlePlaybackChange],
      [Events.TOGGLE_FULLSCREEN_REQUEST, this.#handleFullscreenToggle],
      [Events.VIDEO_CLICKED, this.#handleVideoClick],
      [Events.KEEP_UI_VISIBLE, this.#onKeepUiVisible],
      [Events.HIDE_UI_WITH_DELEAY, this.#onHideUiWithDelay],
    ];

    busEvents.forEach(([event, handler]) =>
      eventBus.on(event, handler.bind(this), this)
    );

    // Show UI on mouse movement
    this.#elements.videoPlayer.addEventListener(
      "mousemove",
      this.#handleMouseMove,
      {
        passive: true,
      }
    );

    this.#elements.videoPlayer.addEventListener("touchmove", this.#onTouchMove);

    document.addEventListener("keydown", this.#handleKeyPress);
  };

  #onTouchMove = (): void => {
    this.#showUI();
  };

  #handleMouseMove = (): void => {
    this.#showUI();
  };

  #onKeepUiVisible = (): void => {
    this.#keepUiVisible = true;
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }

    this.#showUI();
  };

  #onHideUiWithDelay = (): void => {
    this.#keepUiVisible = false;
    if (!this.#idleTimer) {
      this.#idleTimer = setTimeout(() => {
        this.#hideUI();
      }, UI.UI_HIDE_DELAY);
    }
  };

  #onPlaybackStarted = (): void => {
    this.#controls.onPlaybackStarted();
    this.#showUI();
  };

  #onPlaybackPaused = (): void => {
    this.#controls.onPlaybackPaused();
    this.#showUI();
  };

  #handlePlaybackChange = (): void => {
    this.#showUI();
  };

  /**
   * Process video clicks with double-click detection
   * Single click: toggle playback,
   * Double click: toggle fullscreen
   */
  #handleVideoClick = (): void => {
    if (this.#clickTimeout) {
      // Double click detected - toggle fullscreen
      clearTimeout(this.#clickTimeout);
      this.#clickTimeout = undefined;
      this.#handleFullscreenToggle();
    } else {
      // Set timeout to distinguish from double clicks
      this.#clickTimeout = setTimeout(() => {
        if (this.#isUIVisible) {
          eventBus.trigger(Events.TOGGLE_PLAYBACK_REQUESTED);
        }
        this.#showUI();
        this.#clickTimeout = undefined;
      }, UI.DOUBLE_CLICK_THRESHOLD);
    }
  };

  #handleKeyPress = (event: KeyboardEvent): void => {
    switch (event.code) {
      case "Space":
        event.preventDefault(); // prevent scrolling
        // playback pause/play state toggling is supported natively
        eventBus.trigger(Events.TOGGLE_PLAYBACK_REQUESTED);
        break;
      case "ArrowRight":
        this.#controls.jumpBy(10);
        break;
      case "ArrowLeft":
        this.#controls.jumpBy(-10);
        break;
      case "KeyF":
        this.#handleFullscreenToggle();
        break;
    }
  };

  /**
   * Display UI controls and reset idle timer
   * Controls automatically hide after delay unless user interaction occurs
   * @param startTimer - Whether to start the hide timer (default: true)
   */
  #showUI = (): void => {
    if (!this.#isUIVisible) {
      this.#elements.controls.style.opacity = "1";
      this.#controls.showMobileBtns();
      this.#isUIVisible = true;
    }

    // Clear existing timer
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }

    // Only start a new timer if requested and menu is not open
    if (!this.#keepUiVisible && !this.#mobileSettingsBtn.isOpen()) {
      this.#idleTimer = setTimeout(() => {
        this.#hideUI();
      }, UI.UI_HIDE_DELAY);
    }
  };

  #hideUI = (): void => {
    if (this.#mobileSettingsBtn.isOpen()) {
      if (this.#idleTimer) {
        clearTimeout(this.#idleTimer);
        this.#idleTimer = undefined;
      }
      return;
    }

    this.#elements.controls.style.opacity = "0";
    this.#controls.hideMobileBtns();
    this.#isUIVisible = false;

    // Clear timer after hiding
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  };

  /**
   * Fullscreen Implementation Strategy
   *
   * Desktop/tablets: Use container fullscreen to preserve custom UI and controls.
   * iPhone: Limited to native video fullscreen which replaces custom UI with Safari's controls.
   *
   * Fallback order:
   * 1. Container fullscreen (preserves custom UI)
   * 2. Native video fullscreen (functional but loses custom UI)
   */
  #handleFullscreenToggle = async (): Promise<void> => {
    try {
      const videoEl = video.getVideoElement();
      const containerEl = this.#elements.videoPlayer;

      // Check if we're currently in any fullscreen mode
      const isInNativeFullscreen = (videoEl as any).webkitDisplayingFullscreen;
      const isInCustomFullscreen =
        document.body.classList.contains("custom-fullscreen");
      const isInContainerFullscreen =
        document.fullscreenElement === containerEl ||
        (document as any).webkitFullscreenElement === containerEl;

      if (
        isInNativeFullscreen ||
        isInCustomFullscreen ||
        isInContainerFullscreen
      ) {
        // Exit whatever fullscreen mode we're in
        await this.#exitAnyFullscreen(videoEl, containerEl);
      } else {
        // Enter fullscreen - try container first, then fallback to native on mobile
        await this.#enterBestFullscreen(videoEl, containerEl);
      }
    } catch (error) {
      console.error("Error toggling fullscreen:", error);
    }
  };

  #enterBestFullscreen = async (
    videoEl: HTMLVideoElement,
    containerEl: HTMLElement
  ): Promise<void> => {
    // First, try container fullscreen (preserves custom UI)
    if (this.#supportsContainerFullscreen(containerEl)) {
      console.log("Using container fullscreen");
      try {
        if (containerEl.requestFullscreen) {
          await containerEl.requestFullscreen();
        } else if ((containerEl as any).webkitRequestFullscreen) {
          await (containerEl as any).webkitRequestFullscreen();
        }
        return;
      } catch (error) {
        console.log(
          "Container fullscreen failed, trying fallback:",
          (error as any).message
        );
      }
    }

    // Fallback 1: Native video fullscreen on mobile (iPhone gets native controls)
    if (this.#isMobile() && this.#supportsNativeVideoFullscreen(videoEl)) {
      console.log("Using native video fullscreen (mobile fallback)");
      try {
        if ((videoEl as any).webkitEnterFullscreen) {
          (videoEl as any).webkitEnterFullscreen();
        }
        return;
      } catch (error) {
        console.log("Native video fullscreen failed:", (error as any).message);
      }
    }
  };

  #exitAnyFullscreen = async (
    videoEl: HTMLVideoElement,
    containerEl: HTMLElement
  ): Promise<void> => {
    // Exit native video fullscreen
    if (
      (videoEl as any).webkitDisplayingFullscreen &&
      (videoEl as any).webkitExitFullscreen
    ) {
      console.log("Exiting native video fullscreen");
      (videoEl as any).webkitExitFullscreen();
      return;
    }

    // Exit container fullscreen
    if (
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement
    ) {
      console.log("Exiting container fullscreen");
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
      return;
    }
  };

  #supportsContainerFullscreen = (containerEl: HTMLElement): boolean => {
    return !!(
      containerEl.requestFullscreen ||
      (containerEl as any).webkitRequestFullscreen ||
      (containerEl as any).mozRequestFullScreen ||
      (containerEl as any).msRequestFullscreen
    );
  };

  #supportsNativeVideoFullscreen = (videoEl: HTMLVideoElement): boolean => {
    return !!(videoEl as any).webkitEnterFullscreen;
  };

  #isMobile = (): boolean => {
    return (
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      ) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  };

  destroy = (): void => {
    this.#elements.videoPlayer.removeEventListener(
      "mousemove",
      this.#handleMouseMove
    );
    document.removeEventListener("keydown", this.#handleKeyPress);

    this.#playButton.destroy();
    this.#playbackRateSelector.destroy();

    // Clear any pending timers
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
    }
    if (this.#clickTimeout) {
      clearTimeout(this.#clickTimeout);
    }
  };
}
