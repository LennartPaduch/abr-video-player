import { eventBus, Payload } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { MediaPlayerEvents } from "../Events/MediaPlayerEvents.js";
import { Assert } from "../utils/assertion.js";

export class PlaybackRateSelector {
  #expanded: boolean = false;
  #currentSpeed: number = 1; // Default playback rate

  //Desktop
  #wrapper: HTMLElement;
  #button: HTMLElement;
  #speedItems: NodeListOf<HTMLDivElement>;

  //Mobile
  #mobileSpeedItems: NodeListOf<HTMLButtonElement>;

  constructor() {
    this.#wrapper = document.getElementById(
      "playbackRate-selector-wrapper"
    ) as HTMLElement;
    this.#button = document.getElementById("playbackRate-btn") as HTMLElement;
    this.#mobileSpeedItems = document.querySelectorAll(".mobile-speed-option");

    Assert.assertDefined(this.#wrapper, "PlaybackRate-selector-wrapper");
    Assert.assertDefined(this.#button, "PlaybackRate-btn");
    Assert.assertDefined(this.#mobileSpeedItems, "Mobile speed items");

    this.#speedItems = this.#wrapper.querySelectorAll(".playback-speed-item");

    this.#initEventListeners();

    this.#updateActiveSpeed(1);

    eventBus.on(
      MediaPlayerEvents.PLAYBACK_RATE_CHANGED,
      this.#onPlaybackRateChanged,
      this
    );
  }

  #initEventListeners = (): void => {
    this.#button.addEventListener("click", this.#toggleDropdown);

    this.#speedItems.forEach((item) => {
      item.addEventListener("click", this.#onSpeedSelected);
    });
    this.#mobileSpeedItems.forEach((item) => {
      item.addEventListener("click", this.#onSpeedSelected);
    });

    document.addEventListener("click", this.#handleOutsideClick);

    this.#wrapper.addEventListener(
      "keydown",
      this.#handleKeyboardNavigation.bind(this)
    );
  };

  #onSpeedSelected = (event: Event): void => {
    const target = event.currentTarget as HTMLElement;
    const speed = parseFloat(target.getAttribute("data-speed") || "1");

    this.#currentSpeed = speed;
    this.#updateActiveSpeed(speed);

    eventBus.trigger(Events.PLAYBACK_RATE_REQUESTED, { speed });
  };

  /**
   * Handle playback rate change event from outside
   */
  #onPlaybackRateChanged = (payload: Payload): void => {
    Assert.assertDefined(payload.speed, "Payload didn't contain speed data!");
    this.#currentSpeed = payload.speed as number;
    this.#updateActiveSpeed(this.#currentSpeed);
  };

  /**
   * Update visual indication of active speed
   */
  #updateActiveSpeed = (speed: number): void => {
    this.#speedItems.forEach((item) => {
      const itemSpeed = parseFloat(item.getAttribute("data-speed") || "1");
      const circle = item.querySelector(".speed-circle") as HTMLElement;
      const label = item.querySelector(".speed-label") as HTMLElement;

      if (itemSpeed === speed) {
        // Add active styling
        item.classList.add("active");

        // Update circle styling
        circle.classList.remove("bg-gray-500");
        circle.classList.add("bg-white", "scale-110");

        // Update label styling
        label.classList.remove("text-gray-400");
        label.classList.add("text-white", "font-bold");
      } else {
        // Remove active styling
        item.classList.remove("active");

        // Reset circle styling
        circle.classList.remove("bg-white", "scale-110");
        circle.classList.add("bg-gray-500");

        // Reset label styling
        label.classList.remove("text-white", "font-bold");
        label.classList.add("text-gray-400");
      }
    });

    this.#mobileSpeedItems.forEach((item) => {
      const itemSpeed = parseFloat(item.getAttribute("data-speed") || "1");

      if (itemSpeed === speed) {
        item.classList.add("bg-gray-800", "text-gray-400");
        item.classList.add("bg-white", "text-black", "font-semibold");
      } else {
        item.classList.remove("bg-white", "text-black", "font-semibold");
        item.classList.add("bg-gray-800", "text-gray-400");
      }
    });
  };

  #toggleDropdown = (): void => {
    this.#expanded ? this.#collapseDropdown() : this.#expandDropdown();
  };

  #expandDropdown = (): void => {
    this.#wrapper.classList.remove("hidden");
    this.#expanded = true;

    this.#focusCurrentSpeed();
  };

  #collapseDropdown = (): void => {
    this.#wrapper.classList.add("hidden");
    this.#expanded = false;
  };

  #handleOutsideClick = (event: MouseEvent): void => {
    if (
      this.#expanded &&
      !this.#wrapper.contains(event.target as Node) &&
      !this.#button.contains(event.target as Node)
    ) {
      this.#collapseDropdown();
    }
  };

  #focusCurrentSpeed = (): void => {
    this.#speedItems.forEach((item) => {
      const speed = parseFloat(item.getAttribute("data-speed") || "1");
      if (speed === this.#currentSpeed) {
        item.focus();
      }
    });
  };

  #handleKeyboardNavigation = (event: KeyboardEvent): void => {
    if (!this.#expanded) return;

    const currentIndex = Array.from(this.#speedItems).findIndex(
      (item) =>
        parseFloat(item.getAttribute("data-speed") || "1") ===
        this.#currentSpeed
    );

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        if (currentIndex < this.#speedItems.length - 1) {
          const nextItem = this.#speedItems[currentIndex + 1];
          const speed = parseFloat(nextItem.getAttribute("data-speed") || "1");
          this.#currentSpeed = speed;
          this.#updateActiveSpeed(speed);
          nextItem.focus();
          eventBus.trigger(Events.PLAYBACK_RATE_REQUESTED, { speed });
        }
        break;

      case "ArrowLeft":
        event.preventDefault();
        if (currentIndex > 0) {
          const prevItem = this.#speedItems[currentIndex - 1];
          const speed = parseFloat(prevItem.getAttribute("data-speed") || "1");
          this.#currentSpeed = speed;
          this.#updateActiveSpeed(speed);
          prevItem.focus();
          eventBus.trigger(Events.PLAYBACK_RATE_REQUESTED, { speed });
        }
        break;

      case "Escape":
        event.preventDefault();
        this.#collapseDropdown();
        this.#button.focus();
        break;

      case "Enter":
      case " ":
        event.preventDefault();
        // Already handled by click event
        break;
    }
  };

  destroy = (): void => {
    eventBus.off(
      MediaPlayerEvents.PLAYBACK_RATE_CHANGED,
      this.#onPlaybackRateChanged,
      this
    );
    document.removeEventListener("click", this.#handleOutsideClick.bind(this));
  };
}
