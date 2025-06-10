import { playbackController } from "../Controller/PlaybackController.js";
import { eventBus } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { MediaPlayerEvents } from "../Events/MediaPlayerEvents.js";
import { PlayerIcons } from "./Icons.js";

/**
 * Displays play/pause/replay indicators in the video player.
 * Shows a persistent play button on initial load when autoplay is prevented,
 * and brief transient play/pause/replay indicators during normal playback.
 */
export class PlayButton {
  #overlay!: HTMLDivElement;
  #persistentButton: HTMLButtonElement | null = null;
  #transientIndicator!: HTMLDivElement;
  #videoContainer: HTMLElement;
  #fadeTimeout: number | null = null;
  #isVideoEnded: boolean = false;

  static #styles = {
    overlay: {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "5",
    },
    button: {
      width: "80px",
      height: "80px",
      borderRadius: "50%",
      background: "rgba(0, 0, 0, 0.6)",
      border: "2px solid white",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      cursor: "pointer",
      transition: "transform 0.2s ease, background 0.2s ease",
      boxShadow: "0 0 20px rgba(0, 0, 0, 0.3)",
      padding: "0",
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      pointerEvents: "auto",
      opacity: "0",
    },
    transient: {
      width: "80px",
      height: "80px",
      borderRadius: "50%",
      background: "rgba(0, 0, 0, 0.6)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      opacity: "0",
      transition: "opacity 0.3s ease",
      pointerEvents: "none",
    },
  };

  constructor(videoContainer: HTMLElement) {
    this.#videoContainer = videoContainer;
    this.#createElements();
    this.#initEvents();
  }

  /**
   * Creates all DOM elements and appends them to the container
   */
  #createElements(): void {
    // Create overlay
    this.#overlay = document.createElement("div");
    this.#overlay.className = "play-button-overlay";
    Object.assign(this.#overlay.style, PlayButton.#styles.overlay);

    // Create persistent button
    this.#persistentButton = this.#createButton("persistent-play-button");
    this.#overlay.appendChild(this.#persistentButton);

    // Create transient indicator
    this.#transientIndicator = document.createElement("div");
    this.#transientIndicator.className = "transient-indicator";
    Object.assign(this.#transientIndicator.style, PlayButton.#styles.transient);
    this.#overlay.appendChild(this.#transientIndicator);

    this.#videoContainer.appendChild(this.#overlay);
  }

  /**
   * Creates a styled button element
   */
  #createButton(className: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = className;
    Object.assign(button.style, PlayButton.#styles.button);

    // Hover effects
    button.addEventListener("mouseover", () => {
      button.style.transform = "translate(-50%, -50%) scale(1.1)";
      button.style.background = "rgba(0, 0, 0, 0.7)";
    });

    button.addEventListener("mouseout", () => {
      button.style.transform = "translate(-50%, -50%)";
      button.style.background = "rgba(0, 0, 0, 0.6)";
    });

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.#isVideoEnded) {
        eventBus.trigger(Events.RESTART_VIDEO_REQUESTED);
      } else {
        eventBus.trigger(Events.TOGGLE_PLAYBACK_REQUESTED);
      }
    });

    return button;
  }

  /**
   * Updates the button icon based on the current state
   */
  #updateButtonIcon(button: HTMLButtonElement): void {
    button.innerHTML = "";

    if (this.#isVideoEnded) {
      const replayIcon =
        PlayerIcons.createReplaySVG?.("40px", "40px") ||
        this.#createReplayIcon();
      button.appendChild(replayIcon);
    } else {
      const playIcon = PlayerIcons.createPlaySVG("40px", "40px");
      button.appendChild(playIcon);
    }
  }

  /**
   * Creates a replay icon if PlayerIcons doesn't provide one
   */
  #createReplayIcon(): SVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "40");
    svg.setAttribute("height", "40");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "white");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
    );
    svg.appendChild(path);

    return svg;
  }

  #initEvents(): void {
    eventBus.on(
      MediaPlayerEvents.PLAYBACK_STARTED,
      this.#onPlaybackStarted,
      this
    );
    eventBus.on(
      MediaPlayerEvents.PLAYBACK_PAUSED,
      this.#onPlaybackPaused,
      this
    );
    eventBus.on(MediaPlayerEvents.PLAYBACK_ENDED, this.#onPlaybackEnded, this);
    eventBus.on(
      Events.SHOW_PERSISTENT_PLAY_BUTTON,
      this.#showInitialPlayButton,
      this
    );
  }

  #onPlaybackStarted = (): void => {
    this.#isVideoEnded = false;
    this.#hidePersistentButton();
    if (playbackController.getTime() > 0.5) {
      this.#showTransientIndicator("play");
    }
  };

  #onPlaybackPaused = (): void => {
    if (playbackController.getTimeToStreamEnd() < 0.5) {
      this.#isVideoEnded = true;
    }

    if (!this.#isVideoEnded) {
      this.#showTransientIndicator("pause");
    }
  };

  #onPlaybackEnded = (): void => {
    this.#isVideoEnded = true;
    this.#showPersistentButton();
  };

  #showPersistentButton(): void {
    if (!this.#persistentButton) {
      this.#persistentButton = this.#createButton("persistent-play-button");
      this.#overlay.appendChild(this.#persistentButton);
    }

    this.#updateButtonIcon(this.#persistentButton);
    this.#persistentButton.style.opacity = "1";
    this.#persistentButton.style.pointerEvents = "auto";
  }

  #hidePersistentButton(): void {
    if (this.#persistentButton) {
      this.#persistentButton.style.opacity = "0";
      this.#persistentButton.style.pointerEvents = "none";
    }
  }

  /**
   * Briefly displays a play, pause, or replay icon in the center of the video
   */
  #showTransientIndicator(type: "play" | "pause" | "replay"): void {
    if (this.#fadeTimeout !== null) {
      clearTimeout(this.#fadeTimeout);
    }

    this.#transientIndicator.innerHTML = "";

    let icon: SVGElement | HTMLElement;
    switch (type) {
      case "play":
        icon = PlayerIcons.createPlaySVG("40px", "40px");
        break;
      case "pause":
        icon = PlayerIcons.createPauseSVG("30px", "30px");
        break;
      case "replay":
        icon =
          PlayerIcons.createReplaySVG?.("40px", "40px") ||
          this.#createReplayIcon();
        break;
    }

    this.#transientIndicator.appendChild(icon);
    this.#transientIndicator.style.opacity = "1";

    this.#fadeTimeout = setTimeout(() => {
      this.#transientIndicator.style.opacity = "0";
      this.#fadeTimeout = null;
    }, 800);
  }

  #showInitialPlayButton = (): void => {
    this.#isVideoEnded = false;
    this.#showPersistentButton();
  };

  destroy(): void {
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
    eventBus.off(MediaPlayerEvents.PLAYBACK_ENDED, this.#onPlaybackEnded, this);
    eventBus.off(
      Events.SHOW_PERSISTENT_PLAY_BUTTON,
      this.#showInitialPlayButton,
      this
    );

    if (this.#fadeTimeout !== null) {
      clearTimeout(this.#fadeTimeout);
    }

    if (this.#overlay.parentNode) {
      this.#overlay.parentNode.removeChild(this.#overlay);
    }
  }
}
