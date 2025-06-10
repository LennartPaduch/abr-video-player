import { eventBus } from "../../Events/EventBus.js";
import { MediaPlayerEvents } from "../../Events/MediaPlayerEvents.js";
import { Assert } from "../../utils/assertion.js";
import { video } from "../../Video.js";

export class VolumeMuteToggleBtn {
  #volumeBtn: HTMLButtonElement;
  #mutedIcon: SVGElement;
  #volumeIcon: SVGElement;

  constructor(controlsWrapper: HTMLDivElement) {
    this.#volumeBtn = controlsWrapper.querySelector(
      "#volume-btn"
    ) as HTMLButtonElement;
    this.#mutedIcon = controlsWrapper.querySelector(
      "#muted-icon"
    ) as SVGElement;
    this.#volumeIcon = controlsWrapper.querySelector(
      "#volume-icon"
    ) as SVGElement;

    Assert.assertDefined(this.#volumeBtn, "Volume Btn");
    Assert.assertDefined(this.#mutedIcon, "Muted Icon");
    Assert.assertDefined(this.#volumeIcon, "Volume Icon");
  }

  init = (): void => {
    this.#volumeBtn.addEventListener("click", this.#toggleMutedState);

    eventBus.on(
      MediaPlayerEvents.PLAYBACK_VOLUME_CHANGED,
      this.#syncWithVideo,
      this
    );

    this.#syncWithVideo();
  };

  #toggleMutedState = (): void => {
    video.setMuted(!video.isMuted());

    this.#syncWithVideo();
  };

  #syncWithVideo = (): void => {
    const muted = video.isMuted();
    const volume = video.getCurrVolume();

    const showMutedIcon = muted || volume === 0;

    this.#volumeIcon.classList.toggle("hidden", showMutedIcon);
    this.#mutedIcon.classList.toggle("hidden", !showMutedIcon);
  };

  destroy = (): void => {
    this.#volumeBtn.removeEventListener("click", this.#toggleMutedState);
    eventBus.off(
      MediaPlayerEvents.PLAYBACK_VOLUME_CHANGED,
      this.#syncWithVideo,
      this
    );
  };
}
