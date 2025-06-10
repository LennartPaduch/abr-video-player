import { Assert } from "../utils/assertion.js";
import { eventBus } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";

export class MobileSettingsBtn {
  #mobileSettingsBtn: HTMLButtonElement;
  #mobileSettingsMenu: HTMLDivElement;
  #isOpen: boolean = false;

  constructor() {
    this.#mobileSettingsBtn = document.getElementById(
      "mobile-settings-btn"
    ) as HTMLButtonElement;
    this.#mobileSettingsMenu = document.getElementById(
      "mobile-settings-menu"
    ) as HTMLDivElement;

    Assert.assertDefined(this.#mobileSettingsBtn, "Mobile Settings Button");
    Assert.assertDefined(this.#mobileSettingsMenu, "Mobile Settings Menu");
  }

  init = (): void => {
    this.#mobileSettingsBtn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      this.#toggle();
    });

    document.addEventListener("click", (e: MouseEvent) => {
      if (
        this.#isOpen &&
        !this.#mobileSettingsMenu.contains(e.target as Node) &&
        e.target !== this.#mobileSettingsBtn
      ) {
        this.#close();
      }
    });

    // Listen for escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.#isOpen) {
        this.#close();
      }
    });

    // Close menu when orientation changes
    window.addEventListener("orientationchange", () => {
      if (this.#isOpen) {
        this.#close();
      }
    });
  };

  #toggle = (): void => {
    this.#isOpen = !this.#isOpen;

    if (this.#isOpen) {
      this.#open();
    } else {
      this.#close();
    }
  };

  #open = (): void => {
    this.#mobileSettingsMenu.classList.remove("hidden");
    this.#isOpen = true;

    // Emit event that menu opened
    eventBus.trigger(Events.KEEP_UI_VISIBLE);
    eventBus.trigger(Events.MOBILE_SETTINGS_MENU_OPENED);

    // Add aria attributes for accessibility
    this.#mobileSettingsBtn.setAttribute("aria-expanded", "true");
    this.#mobileSettingsMenu.setAttribute("aria-hidden", "false");
  };

  #close = (): void => {
    this.#mobileSettingsMenu.classList.add("hidden");
    this.#isOpen = false;

    // Emit event that menu closed
    eventBus.trigger(Events.HIDE_UI_WITH_DELEAY);

    // Update aria attributes
    this.#mobileSettingsBtn.setAttribute("aria-expanded", "false");
    this.#mobileSettingsMenu.setAttribute("aria-hidden", "true");
  };

  closeMenu = (): void => {
    if (this.#isOpen) {
      this.#close();
    }
  };

  isOpen = (): boolean => {
    return this.#isOpen;
  };
}

export class MobileSettingsBtnnn {
  #mobileSettingsBtn: HTMLButtonElement;
  #mobileSettingsMenu: HTMLDivElement;

  constructor() {
    this.#mobileSettingsBtn = document.getElementById(
      "mobile-settings-btn"
    ) as HTMLButtonElement;
    this.#mobileSettingsMenu = document.getElementById(
      "mobile-settings-menu"
    ) as HTMLDivElement;

    Assert.assertDefined(this.#mobileSettingsBtn, "Mobile Settings Button");
    Assert.assertDefined(this.#mobileSettingsMenu, "Mobile Settings Menu");
  }

  init = (): void => {
    this.#mobileSettingsBtn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      this.#mobileSettingsMenu.classList.toggle("hidden");
    });

    document.addEventListener("click", (e: MouseEvent) => {
      if (
        !this.#mobileSettingsMenu.contains(e.target as Node | null) &&
        e.target != this.#mobileSettingsBtn
      ) {
        this.#mobileSettingsMenu.classList.add("hidden");
      }
    });
  };
}
