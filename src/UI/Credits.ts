import { eventBus } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { Assert } from "../utils/assertion.js";

export class Credits {
  #creditsBtn: HTMLButtonElement;
  #mobileCreditsBtn: HTMLButtonElement;
  #creditsText!: HTMLDivElement;
  #isMobile: boolean;
  #resizeListener: () => void = () => {};
  #isListening: boolean = false;

  constructor() {
    // Desktop credits button
    this.#creditsBtn = document.getElementById("credits") as HTMLButtonElement;
    if (this.#creditsBtn) {
      this.#creditsBtn.textContent = "©";
    }

    // Mobile credits button
    this.#mobileCreditsBtn = document.getElementById(
      "mobile-credits"
    ) as HTMLButtonElement;

    // Calculate once on initialization
    this.#isMobile = window.innerWidth <= 768;
    this.#createCreditsElement();
    this.#setupEventListeners();
    this.#setupResizeListener();
  }

  #createCreditsElement = (): void => {
    // Remove any existing credits text
    const existing = document.getElementById("credits-text");
    if (existing) {
      existing.remove();
    }

    // Find the appropriate container
    let outerContainer;
    if (this.#isMobile) {
      outerContainer = document.getElementById("videoPlayer");
    } else {
      outerContainer = this.#creditsBtn?.closest(".self-center");
    }

    this.#creditsText = document.createElement("div");
    this.#creditsText.id = "credits-text";

    if (this.#isMobile) {
      // Mobile positioning
      this.#creditsText.className =
        "fixed bg-amber-900 bottom-24 right-2 left-2 text-sm p-3 rounded-md hidden z-50 max-w-none";

      this.#creditsText.innerHTML = `<div class="text-center">
        <strong>Video: Sol Levante by Netflix</strong><br/>
        Licensed under CC BY 4.0<br/>
        <a href="https://opencontent.netflix.com/" style="color: #DDF45B; text-decoration: underline;" target="_blank">Netflix Open Content</a><br/>
        <small><em>Not affiliated with Netflix</em></small>
      </div>`;
    } else {
      // Desktop positioning
      this.#creditsText.className =
        "absolute bg-amber-900 left-1/2 -translate-x-1/2 bottom-full mb-2 text-nowrap text-base p-2 rounded-md hidden z-50";

      this.#creditsText.innerHTML = `Video content: Sol Levante by Netflix <br/>
      Licensed under Creative Commons Attribution 4.0 International <br/>
      Original content available at: <a href="https://opencontent.netflix.com/" style="color: #DDF45B" target="_blank">Netflix OPEN SOURCE CONTENT</a> <br/>
      Modified: Re-encoded using ffmpeg for adaptive bitrate streaming demonstration <br/>
      <br/>
      <em>This demonstration is an independent project and is not affiliated with or endorsed by Netflix.</em>`;
    }

    Assert.assertDefined(outerContainer, "Credits, outerContainer");
    outerContainer.appendChild(this.#creditsText);
  };

  #showCredits = (): void => {
    this.#creditsText.classList.remove("hidden");
    this.#startResizeListening();
    eventBus.trigger(Events.KEEP_UI_VISIBLE);
  };

  #hideCredits = (): void => {
    this.#creditsText.classList.add("hidden");
    this.#stopResizeListening();
    eventBus.trigger(Events.HIDE_UI_WITH_DELEAY);
  };

  #toggleCredits = (): void => {
    if (this.#creditsText.classList.contains("hidden")) {
      this.#showCredits();
    } else {
      this.#hideCredits();
    }
  };

  #startResizeListening = (): void => {
    if (!this.#isListening) {
      window.addEventListener("resize", this.#resizeListener);
      this.#isListening = true;
    }
  };

  #stopResizeListening = (): void => {
    if (this.#isListening) {
      window.removeEventListener("resize", this.#resizeListener);
      this.#isListening = false;
    }
  };

  #setupResizeListener = (): void => {
    let resizeTimeout: number;
    this.#resizeListener = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const wasMobile = this.#isMobile;
        this.#isMobile = window.innerWidth <= 768;

        // If screen size category changed, recreate the element
        if (wasMobile !== this.#isMobile) {
          this.#hideCredits(); // This will also stop listening
          setTimeout(() => {
            // Recalculate mobile state and recreate
            this.#createCreditsElement();
          }, 100);
        }
      }, 250);
    };
  };

  #setupEventListeners = (): void => {
    // Desktop click handler
    if (this.#creditsBtn) {
      this.#creditsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#toggleCredits();
      });
    }

    // Mobile click handler
    if (this.#mobileCreditsBtn) {
      this.#mobileCreditsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#toggleCredits();
      });
    }

    // Hide when clicking outside
    document.addEventListener("click", (e) => {
      if (
        !this.#creditsBtn?.contains(e.target as Node) &&
        !this.#mobileCreditsBtn?.contains(e.target as Node) &&
        !this.#creditsText.contains(e.target as Node)
      ) {
        this.#hideCredits();
      }
    });
  };
}
