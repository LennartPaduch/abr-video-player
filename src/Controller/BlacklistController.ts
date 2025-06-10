import { logger } from "../Logger.js";
import { Assert } from "../utils/assertion.js";

class BlacklistController {
  #blacklistedUrls: string[] = [];
  #blacklistedSegmentNumbers: number[] = [];
  #logger = logger.createChild("BlacklistController");

  addToUrlBlacklist = (url: string): void => {
    Assert.assert(url.length > 0);
    if (this.#blacklistedUrls.includes(url)) {
      return;
    }
    this.#logger.warn(`Blacklisting url: ${url}`);
    this.#blacklistedUrls.push(url);
  };

  addSegNumToBlacklist = (segNum: number): void => {
    Assert.assert(segNum >= 0);
    if (this.#blacklistedSegmentNumbers.includes(segNum)) {
      return;
    }
    this.#logger.warn(`Blacklisting Segment Number: ${segNum}`);
    this.#blacklistedSegmentNumbers.push(segNum);
  };

  reset = (): void => {
    this.#blacklistedUrls = [];
    this.#blacklistedUrls = [];
  };

  removeUrl = (url: string): void => {
    Assert.assert(url.length > 0);
    const idx = this.#blacklistedUrls.indexOf(url);
    if (idx !== -1) {
      this.#blacklistedUrls.splice(idx, 1);
    }
  };

  containsUrl = (url: string): boolean => {
    Assert.assert(url.length > 0);
    return this.#blacklistedUrls.includes(url);
  };

  removeSegmentNumber = (segNum: number): void => {
    Assert.assert(segNum >= 0);
    const idx = this.#blacklistedSegmentNumbers.indexOf(segNum);
    if (idx !== -1) {
      this.#blacklistedSegmentNumbers.splice(idx, 1);
    }
  };

  containsSegmentNumber = (segNumb: number): boolean => {
    Assert.assertDefined(segNumb);
    return this.#blacklistedSegmentNumbers.includes(segNumb);
  };
}

export const blacklistController = new BlacklistController();
