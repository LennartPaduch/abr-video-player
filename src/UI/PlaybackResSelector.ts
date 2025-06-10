import { playbackController } from "../Controller/PlaybackController.js";
import { eventBus, Payload } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { logger } from "../Logger.js";
import { VideoRepresentation } from "../Types.js";
import { Assert } from "../utils/assertion.js";

export class PlaybackResSelector {
  #representations: VideoRepresentation[] = [];
  #expanded: boolean = false;

  #abrEnabled: boolean = true;
  #needsUpdate: boolean = true;
  #isMobile: boolean = false;

  // Desktop
  #playbackResWrapper: HTMLDivElement;
  #playbackResBtn: HTMLButtonElement;

  // Mobile
  #mobileResWrapper: HTMLDivElement;
  #mobileSettingsBtn: HTMLButtonElement;
  #mobileSettingsMenu: HTMLDivElement;

  constructor() {
    // Check if mobile
    this.#isMobile = window.matchMedia("(max-width: 768px)").matches;

    // Listen for screen size changes
    window.matchMedia("(max-width: 768px)").addEventListener("change", (e) => {
      this.#isMobile = e.matches;
      this.#needsUpdate = true;
    });

    eventBus.on(
      Events.VIDEO_BITRATE_CHANGED,
      this.#onVideoBitrateChanged,
      this
    );

    eventBus.on(
      Events.REPRESENTATIONS_CHANGED,
      this.#onRepresentationsChanged,
      this
    );

    this.#playbackResWrapper = document.getElementById(
      "playback-res-wrapper"
    ) as HTMLDivElement;
    this.#playbackResBtn = document.getElementById(
      "playback-res-btn"
    ) as HTMLButtonElement;
    this.#mobileResWrapper = document.getElementById(
      "mobile-quality-options"
    ) as HTMLDivElement;
    this.#mobileSettingsBtn = document.getElementById(
      "mobile-settings-btn"
    ) as HTMLButtonElement;
    this.#mobileSettingsMenu = document.getElementById(
      "mobile-settings-menu"
    ) as HTMLDivElement;

    Assert.assertDefined(this.#playbackResWrapper, "playbackResWrapper");
    Assert.assertDefined(this.#playbackResBtn, "playbackResBtn!");
    Assert.assertDefined(this.#mobileResWrapper, "mobileResWrapper!");
    Assert.assertDefined(this.#mobileSettingsBtn, "mobileSettingsBtn!");
    Assert.assertDefined(this.#mobileSettingsMenu, "mobileSettingsMenu!");

    // Desktop event listeners
    this.#playbackResWrapper.addEventListener(
      "mouseleave",
      this.#toggleDropdown
    );
    this.#playbackResBtn.addEventListener("click", this.#toggleDropdown);

    eventBus.on(
      Events.MOBILE_SETTINGS_MENU_OPENED,
      this.#onMobileMenuOpened,
      this
    );
  }

  #onMobileMenuOpened = (): void => {
    if (this.#isMobile && this.#needsUpdate) {
      this.#populateMobileDropdown();
    }
  };

  #createDropdownItem = (
    res: number,
    representation?: VideoRepresentation
  ): HTMLDivElement => {
    const dropdownItem = document.createElement("div");

    dropdownItem.style.display = "flex";
    dropdownItem.style.padding = "6px";
    dropdownItem.style.paddingRight = "70px";
    dropdownItem.style.backgroundColor = "rgba(0,0,0,0.5)";
    dropdownItem.style.cursor = "pointer";

    const isSelectedCheckmark = document.createElement("div");
    isSelectedCheckmark.style.width = "16px";

    const resString = document.createElement("div");
    if (!representation) {
      resString.textContent = "Auto";
      if (this.#abrEnabled) {
        isSelectedCheckmark.textContent = "✓";
        if (res) {
          resString.textContent += ` (${res}p)`;
        }
      }
      dropdownItem.addEventListener("click", () => this.#enableAbr());
    } else {
      resString.textContent = res + "p";
      if (res === 2160) {
        resString.textContent += " (4k)";
      }
      if (
        representation.id ===
          playbackController.getCurrentVideoRepresentation().id &&
        !this.#abrEnabled
      ) {
        isSelectedCheckmark.textContent = "✓";
      }
      dropdownItem.addEventListener("click", () =>
        this.#requestResChange(representation)
      );
    }

    dropdownItem.addEventListener("mouseenter", () => {
      dropdownItem.style.backgroundColor = "rgba(110,110,110,0.5)";
    });
    dropdownItem.addEventListener("mouseleave", () => {
      dropdownItem.style.backgroundColor = "rgba(0,0,0,0.5)";
    });

    dropdownItem.appendChild(isSelectedCheckmark);
    dropdownItem.appendChild(resString);

    return dropdownItem;
  };

  #createMobileQualityItem = (
    res: number,
    representation?: VideoRepresentation
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.className =
      "w-full text-left py-3 px-4 rounded-lg transition-colors";

    const isSelected = representation
      ? representation.id ===
          playbackController.getCurrentVideoRepresentation().id &&
        !this.#abrEnabled
      : this.#abrEnabled;

    if (isSelected) {
      button.className += " bg-white text-black font-semibold";
    } else {
      button.className += " bg-gray-800 text-gray-300 active:bg-gray-700";
    }

    const contentWrapper = document.createElement("div");
    contentWrapper.className = "flex items-center justify-between";

    const label = document.createElement("span");
    if (!representation) {
      label.textContent = "Auto";
      if (res) {
        label.textContent += ` (${res}p)`;
      }
      button.addEventListener("click", () => {
        this.#enableAbr();
        this.#populateMobileDropdown();
      });
    } else {
      label.textContent = `${res}p`;
      if (res === 2160) {
        label.textContent += " 4K";
      } else if (res === 1080) {
        label.textContent += " HD";
      }
      button.addEventListener("click", () => {
        this.#requestResChange(representation);
        this.#populateMobileDropdown();
      });
    }

    contentWrapper.appendChild(label);

    if (isSelected) {
      const checkmark = document.createElement("span");
      checkmark.textContent = "✓";
      checkmark.className = "ml-2";
      contentWrapper.appendChild(checkmark);
    }

    button.appendChild(contentWrapper);
    return button;
  };

  #populateDropdown = (): void => {
    if (this.#isMobile) {
      this.#populateMobileDropdown();
    } else {
      this.#populateDesktopDropdown();
    }
  };

  #populateDesktopDropdown = (): void => {
    this.#playbackResWrapper.innerHTML = "";
    const dropdownWrapper = document.createElement("div");
    dropdownWrapper.style.display = "flex";
    dropdownWrapper.style.flexDirection = "column";

    this.#representations.sort((a, b) => b.bitrate - a.bitrate);

    for (const res of this.#representations) {
      const dropdownItem = this.#createDropdownItem(res.height, res);
      dropdownWrapper.appendChild(dropdownItem);
    }
    const abrItem = this.#createDropdownItem(
      playbackController.getCurrentVideoRepresentation().height || NaN
    );
    dropdownWrapper.appendChild(abrItem);

    this.#playbackResWrapper.appendChild(dropdownWrapper);
    this.#needsUpdate = false;
  };

  #populateMobileDropdown = (): void => {
    this.#mobileResWrapper.innerHTML = "";

    // Sort representations by bitrate (highest first)
    this.#representations.sort((a, b) => b.bitrate - a.bitrate);

    // Add quality options
    for (const res of this.#representations) {
      const qualityButton = this.#createMobileQualityItem(res.height, res);
      this.#mobileResWrapper.appendChild(qualityButton);
    }

    const autoButton = this.#createMobileQualityItem(
      playbackController.getCurrentVideoRepresentation().height || NaN
    );
    this.#mobileResWrapper.appendChild(autoButton);

    this.#needsUpdate = false;
  };

  #enableAbr = (): void => {
    eventBus.trigger(Events.ENABLE_ABR);
    this.#abrEnabled = true;
    if (this.#isMobile) {
      this.#populateMobileDropdown();
    } else {
      this.#populateDropdown();
    }
  };

  #setAvailableStreams = (representations: VideoRepresentation[]): void => {
    this.#representations = representations;
    this.#needsUpdate = true;
  };

  #toggleDropdown = (): void => {
    if (!this.#isMobile) {
      this.#expanded ? this.#collapseDropdown() : this.#expandDropdown();
    }
  };

  #collapseDropdown = (): void => {
    this.#playbackResWrapper.style.display = "none";
    this.#expanded = false;
  };

  #expandDropdown = (): void => {
    if (this.#needsUpdate) {
      this.#populateDropdown();
    }
    this.#playbackResWrapper.style.display = "flex";
    this.#expanded = true;
  };

  #onRepresentationsChanged = (payload: Payload): void => {
    Assert.assert(
      payload.representations?.videoRepresentations.length,
      "No video representations in payload!"
    );

    this.#setAvailableStreams(payload.representations.videoRepresentations);

    // Update mobile menu if it's open
    if (
      this.#isMobile &&
      !this.#mobileSettingsMenu.classList.contains("hidden")
    ) {
      this.#populateMobileDropdown();
    }
  };

  #onVideoBitrateChanged = (payload: Payload): void => {
    Assert.assert(
      payload.videoRepresentation,
      "No video representation in payload!"
    );

    if (this.#isMobile) {
      // Update mobile menu if it's open
      if (!this.#mobileSettingsMenu.classList.contains("hidden")) {
        this.#populateMobileDropdown();
      } else {
        this.#needsUpdate = true;
      }
    } else {
      // Desktop behavior
      if (this.#expanded) {
        this.#populateDropdown();
      } else {
        this.#needsUpdate = true;
      }
    }
  };

  #requestResChange = (representation: VideoRepresentation): void => {
    this.#abrEnabled = false;
    logger.info(
      `Forcing bitrate change to: ${representation.height}p (${representation.bitrate} bits)`
    );
    eventBus.trigger(Events.FORCE_VIDEO_BITRATE_CHANGE, {
      videoRepresentation: representation,
      switchReason: "ChosenByUser",
    });
  };
}
