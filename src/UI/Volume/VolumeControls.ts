import { VolumeBar } from "./VolumeBar.js";
import { VolumeMuteToggleBtn } from "./VolumeMuteToggleBtn.js";

export class VolumeControls {
  #volumeBar: VolumeBar;
  #volumeMuteToggleBtn: VolumeMuteToggleBtn;

  constructor(controlsWrapper: HTMLDivElement) {
    this.#volumeBar = new VolumeBar(controlsWrapper);
    this.#volumeMuteToggleBtn = new VolumeMuteToggleBtn(controlsWrapper);
  }

  init = (): void => {
    this.#volumeBar.init();
    this.#volumeMuteToggleBtn.init();
  };

  destory = (): void => {
    this.#volumeBar.destroy();
    this.#volumeMuteToggleBtn.destroy();
  };
}
