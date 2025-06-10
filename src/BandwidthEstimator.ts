import { Emwa } from "./Ewma.js";
import { logger } from "./Logger.js";
import { Assert } from "./utils/assertion.js";

/**
 * @summary
 * This class tracks bandwidth samples and estimates available bandwidth.
 * Based on the minimum of two exponentially-weighted moving averages with
 * different half-lives.
 *
 */
export class BandwidthEstimator {
  #fast: Emwa = new Emwa(2);
  #slow: Emwa = new Emwa(5);

  #navConnection = (navigator as any).connection;
  #useNetworkInformation: boolean;

  #bytesSampled: number = 0;
  #sampleCount: number = 0;
  /**
   * Minimum number of bytes sampled before we trust the estimate.  If we have
   * not sampled much data, our estimate may not be accurate enough to trust.
   * If #bytesSampled is less than #minTotalBytes, we use defaultEstimate.
   * This specific value is based on experimentation.
   */
  readonly #MIN_TOTAL_BYTES: number = 128e3; // 128kB

  /**
   * Minimum number of bytes, under which samples are discarded.  Our models
   * do not include latency information, so connection startup time (time to
   * first byte) is considered part of the download time.  Because of this, we
   * should ignore very small downloads which would cause our estimate to be
   * too low.
   * This specific value is based on experimentation.
   *
   */
  readonly #MIN_BYTES = 16e3; // 16kB

  #logger = logger.createChild("BandwidthEstimator");

  constructor(useNetworkInformation: boolean, navConnection: any) {
    this.#useNetworkInformation = useNetworkInformation;
    this.#navConnection = navConnection;
  }

  /**
   * Takes a bandwidth sample.
   *
   * @param {number} durationMs The amount of time, in milliseconds, for a
   *   particular request.
   * @param {number} numBytes The total number of bytes transferred in that
   *   request.
   */
  sample = (durationMs: number, numBytes: number): void => {
    Assert.assert(durationMs > 0 && Number.isFinite(durationMs));
    Assert.assert(numBytes > 0 && Number.isFinite(numBytes));

    if (numBytes < this.#MIN_BYTES) {
      return;
    }

    this.#sampleCount++;

    // bits per second
    const bandwidth = (8000 * numBytes) / durationMs;

    // Calculate weight for EWMA (in seconds)
    const weight = durationMs / 1000;

    this.#bytesSampled += numBytes;
    this.#fast.sample(weight, bandwidth);
    this.#slow.sample(weight, bandwidth);
  };

  /**
   * Gets the current bandwidth estimate.
   *
   * @param {number} defaultEstimate
   * @return {number} The bandwidth estimate in bits per second.
   */
  getBandwidthEstimate = (): number => {
    const defaultEstimate = this.#getDefaultBandwidth();

    this.#logger.debug(
      `Bandwidth estimation state: ${this.#sampleCount} samples, ${(
        this.#bytesSampled / 1024
      ).toFixed(1)}KB sampled, ` +
        `minimum needed: ${(this.#MIN_TOTAL_BYTES / 1024).toFixed(1)}KB`
    );

    if (this.#bytesSampled < this.#MIN_TOTAL_BYTES) {
      this.#logger.debug(
        `Not enough bytes sampled: ${(this.#bytesSampled / 1024).toFixed(
          1
        )}KB < ${(this.#MIN_TOTAL_BYTES / 1024).toFixed(1)}KB`
      );
      return defaultEstimate;
    }

    // Take the minimum of these two estimates. This should have the effect
    // of adapting down quickly, but up more slowly.
    const measuredEstimate = Math.min(
      this.#fast.getEstimate(),
      this.#slow.getEstimate()
    );

    if (
      this.#navConnection &&
      this.#navConnection.downlink &&
      this.#useNetworkInformation
    ) {
      const networkWeight = this.#getNetworkApiWeight();

      // Blend the two estimates with dynamic weighting
      const combinedWeightedEstimate =
        networkWeight * defaultEstimate +
        (1 - networkWeight) * measuredEstimate;

      this.#logger.debug(
        `
        Network API estimate: ${defaultEstimate / 1e6}Mpbs
        Network API weight: ${networkWeight.toFixed(2)}
        Bytes sampled: ${(this.#bytesSampled / 1024).toFixed(2)}KB
        Combined estimate: ${(combinedWeightedEstimate / 1e6).toFixed(2)}MBps`
      );

      return combinedWeightedEstimate;
    }

    this.#logger.debug(`Estimate: ${measuredEstimate}`);
    return measuredEstimate;
  };

  #getDefaultBandwidth = (): number => {
    let defaultBandwidthEstimate = 3e6;

    // Some browsers implement the Network Information API, which allows
    // retrieving information about a user's network connection.  Tizen 3 has
    // NetworkInformation, but not the downlink attribute.
    if (this.#navConnection && this.#navConnection.downlink) {
      // If it's available, get the bandwidth estimate from the browser (in
      // megabits per second) and use it as defaultBandwidthEstimate.
      // !! Some browsers cap this value i.e. at 10 Mbps !!
      defaultBandwidthEstimate = this.#navConnection.downlink * 1e6;
      //this.#logger.debug(`Downlink: ${this.#navConnection.downlink}*1e6 Mbps`);
    }
    return defaultBandwidthEstimate;
  };

  #getNetworkApiWeight = (): number => {
    // If no samples or bytes, use Network API fully
    if (this.#sampleCount === 0 || this.#bytesSampled < this.#MIN_BYTES) {
      return 1.0;
    }

    // Exponential decay
    // Weights samples more heavily at first, then diminishes influence
    return Math.max(0.1, Math.exp(-this.#sampleCount / 5));
  };

  reset = (): void => {
    this.#logger.info("Resetting Bandwidth Estimator");
    this.#sampleCount = 0;
    this.#bytesSampled = 0;
  };
}

export const bandwidthEstimator = new BandwidthEstimator(
  true, // useNetworkInformation
  (navigator as any).connection
);
