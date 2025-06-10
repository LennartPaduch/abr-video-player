import { playbackController } from "../Controller/PlaybackController.js";
import { eventBus } from "../Events/EventBus.js";
import { Events } from "../Events/Events.js";
import { Assert } from "../utils/assertion.js";
import { Credits } from "./Credits.js";
import { PlayerIcons } from "./Icons.js";
import { VolumeControls } from "./Volume/VolumeControls.js";

export class Controls {
  #controls: HTMLDivElement;
  #pausePlayBtn: HTMLButtonElement;
  #fullscreenBtn: HTMLButtonElement;

  // Desktop only
  #jmpForwardBtn: HTMLButtonElement;
  #jmpBackwardsBtn: HTMLButtonElement;
  #volumeControls: VolumeControls;

  // Mobile only
  #jmpForwardBtnMobile: HTMLButtonElement;
  #jmpBackwardsBtnMobile: HTMLButtonElement;

  #credits?: Credits;

  #playSvg: SVGElement;
  #pauseSvg: SVGElement;

  constructor(controls: HTMLDivElement) {
    this.#controls = controls;

    this.#pausePlayBtn = this.#controls.querySelector(
      "#pause-play-btn"
    ) as HTMLButtonElement;
    this.#fullscreenBtn = this.#controls.querySelector(
      "#fullscreen-btn"
    ) as HTMLButtonElement;
    this.#jmpForwardBtn = this.#controls.querySelector(
      "#jmp-forward-btn"
    ) as HTMLButtonElement;
    this.#jmpBackwardsBtn = this.#controls.querySelector(
      "#jmp-backwards-btn"
    ) as HTMLButtonElement;
    this.#jmpForwardBtnMobile = document.getElementById(
      "mobile-jmp-forward-btn"
    ) as HTMLButtonElement;
    this.#jmpBackwardsBtnMobile = document.getElementById(
      "mobile-jmp-backwards-btn"
    ) as HTMLButtonElement;
    this.#volumeControls = new VolumeControls(controls);

    Assert.assertDefined(this.#pausePlayBtn, "Pause/Play Btn");
    Assert.assertDefined(this.#fullscreenBtn, "FullscreenBtn");
    Assert.assertDefined(this.#jmpForwardBtn, "Jump forward Btn");
    Assert.assertDefined(this.#jmpBackwardsBtn, "Jump backwards Btn");
    Assert.assertDefined(this.#jmpForwardBtnMobile, "Jump forward Btn Mobile");
    Assert.assertDefined(
      this.#jmpBackwardsBtnMobile,
      "Jump backwards Btn Mobile"
    );

    this.#playSvg = PlayerIcons.createPlaySVG("32px", "32px");
    this.#pauseSvg = PlayerIcons.createPauseSVG("32px", "32px");

    this.#credits = new Credits();

    this.#initEvents();
  }

  #initEvents() {
    eventBus.on(
      Events.SHOW_PERSISTENT_PLAY_BUTTON,
      () => this.onPlaybackPaused(),
      this
    );

    this.#fullscreenBtn.addEventListener("click", () =>
      eventBus.trigger(Events.TOGGLE_FULLSCREEN_REQUEST)
    );
    this.#pausePlayBtn.addEventListener("click", () => this.#togglePlayback());

    this.#jmpForwardBtn.addEventListener("click", () => {
      this.jumpBy(10);
    });

    this.#jmpBackwardsBtn.addEventListener("click", () => {
      this.jumpBy(-10);
    });

    this.#jmpForwardBtnMobile.addEventListener("click", () => {
      this.jumpBy(10);
    });

    this.#jmpBackwardsBtnMobile.addEventListener("click", () => {
      this.jumpBy(-10);
    });

    this.#volumeControls.init();
  }

  jumpBy = (timeOffset: number): void => {
    eventBus.trigger(Events.SEEK_REQUESTED, {
      seekTo: playbackController.getTime() + timeOffset,
    });
  };

  onPlaybackStarted = (): void => {
    this.#pausePlayBtn.innerHTML = "";
    this.#pausePlayBtn.appendChild(this.#pauseSvg);
    this.#pausePlayBtn.setAttribute("aria-label", "Pause");
  };

  onPlaybackPaused = (): void => {
    this.#pausePlayBtn.innerHTML = "";
    this.#pausePlayBtn.appendChild(this.#playSvg);
    this.#pausePlayBtn.setAttribute("aria-label", "Play");
  };

  hideMobileBtns = (): void => {
    this.#jmpForwardBtnMobile.style.opacity = "0";
    this.#jmpBackwardsBtnMobile.style.opacity = "0";
  };

  showMobileBtns = (): void => {
    this.#jmpForwardBtnMobile.style.opacity = "1";
    this.#jmpBackwardsBtnMobile.style.opacity = "1";
  };

  #togglePlayback = (): void => {
    eventBus.trigger(Events.TOGGLE_PLAYBACK_REQUESTED);
  };
}
