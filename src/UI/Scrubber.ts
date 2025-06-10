import { Assert } from "../utils/assertion.js";

export class Scrubber {
  #scrubberBtn: HTMLDivElement;

  constructor(elementId: string) {
    this.#scrubberBtn = document.getElementById(elementId) as HTMLDivElement;
    Assert.assertDefined(this.#scrubberBtn, "Scrubber Button");
  }

  updatePos(progress: number) {
    const translateXValue =
      progress *
      /**Container Width */ this.#scrubberBtn.parentElement!.clientWidth;
    this.#scrubberBtn.style.transform = `translateX(${
      translateXValue - this.#scrubberBtn.clientWidth / 2
    }px)`;
  }
}
