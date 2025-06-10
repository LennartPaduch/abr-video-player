import { Assert } from "./utils/assertion.js";

export class Emwa {
  #alpha: number;
  #estimate: number = 0;
  #totalWeight: number = 0;
  /**
   * @param {number} halfLife The quantity of prior samples (by weight) used
   *   when creating a new estimate.  Those prior samples make up half of the
   *   new estimate.
   */
  constructor(halfLife: number) {
    // Larger values of alpha expire historical data more slowly.
    this.#alpha = this.#calculateAlpha(halfLife);
    Assert.assert(this.#alpha > 0);
  }

  #calculateAlpha = (halfLife: number): number => {
    Assert.assert(halfLife > 0);
    return Math.exp(Math.log(0.5) / halfLife);
  };

  updateAlpha = (halfLife: number): void => {
    this.#alpha = this.#calculateAlpha(halfLife);
    Assert.assert(this.#alpha > 0);
  };

  sample = (weight: number, bandwidth: number): void => {
    Assert.assert(this.#alpha > 0);
    const adjAlpha = Math.pow(this.#alpha, weight);
    const newEstimate = bandwidth * (1 - adjAlpha) + adjAlpha * this.#estimate;

    if (!isNaN(newEstimate)) {
      this.#estimate = newEstimate;
      this.#totalWeight += weight;
    }
  };

  getEstimate = (): number => {
    const zeroFactor = 1 - Math.pow(this.#alpha, this.#totalWeight);
    return this.#estimate / zeroFactor;
  };
}
