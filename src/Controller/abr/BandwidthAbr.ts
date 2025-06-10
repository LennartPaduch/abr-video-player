import { bandwidthEstimator } from "../../BandwidthEstimator.js";
import { eventBus, Payload } from "../../Events/EventBus.js";
import { Events } from "../../Events/Events.js";
import { logger } from "../../Logger.js";
import { VideoRepresentation } from "../../Types.js";
import { video, type Video } from "../../Video.js";

interface NetworkInformation extends EventTarget {
  // Connection type: 'slow-2g', '2g', '3g', '4g'
  effectiveType: "slow-2g" | "2g" | "3g" | "4g";

  // Downlink speed in Mbps
  downlink: number;

  // Round-trip time in milliseconds
  rtt: number;

  // Maximum downlink speed for the connection technology (Mbps)
  downlinkMax?: number;

  // Connection type (optional, not always available)
  type?:
    | "bluetooth"
    | "cellular"
    | "ethernet"
    | "none"
    | "wifi"
    | "wimax"
    | "other"
    | "unknown";

  // Data saver status
  saveData: boolean;

  // Event handlers
  onchange: ((this: NetworkInformation, ev: Event) => any) | null;

  addEventListener(
    type: "change",
    listener: (this: NetworkInformation, ev: Event) => any,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener(
    type: "change",
    listener: (this: NetworkInformation, ev: Event) => any,
    options?: boolean | EventListenerOptions
  ): void;
}

interface Navigator {
  connection?: NetworkInformation;
}

// Connection info type for your class
interface ConnectionInfo {
  effectiveType: "slow-2g" | "2g" | "3g" | "4g";
  downlink: number;
  rtt: number;
}

export class BandwidthAbr {
  #logger = logger.createChild("BandwidthAbr");
  #representations: VideoRepresentation[] = [];
  #video: Video = video;
  #lastTimeChosenMs: number | null = null;

  #navConnection = (navigator as Navigator).connection;
  #useNetworkInformation = true;
  #previousConnectionInfo: ConnectionInfo | null;

  constructor() {
    this.#initEventListeners();

    this.#previousConnectionInfo = this.#navConnection
      ? {
          effectiveType: this.#navConnection.effectiveType,
          downlink: this.#navConnection.downlink,
          rtt: this.#navConnection.rtt,
        }
      : null;

    if (this.#navConnection?.addEventListener) {
      this.#navConnection.addEventListener("change", () => {
        if (this.#useNetworkInformation) {
          const currentInfo: ConnectionInfo = {
            effectiveType: this.#navConnection!.effectiveType,
            downlink: this.#navConnection!.downlink,
            rtt: this.#navConnection!.rtt,
          };

          // Only trigger if there's a significant change
          if (
            this.#hasSignificantNetworkChange(
              this.#previousConnectionInfo,
              currentInfo
            )
          ) {
            const oldConnectionInfo = this.#previousConnectionInfo;

            this.#previousConnectionInfo = currentInfo;

            bandwidthEstimator.reset();
            const chosenRepresentation = this.chooseRepresentation();

            if (chosenRepresentation && navigator.onLine) {
              this.#logger.info(
                "Network Information API detected significant connection change!",
                {
                  from: oldConnectionInfo,
                  to: currentInfo,
                }
              );
              eventBus.trigger(Events.QUALITY_CHANGE_REQUESTED, {
                videoRepresentation: chosenRepresentation,
                switchReason: "Bandwidth",
              });
            }
          }
        }
      });
    }
  }

  #hasSignificantNetworkChange = (
    prev: ConnectionInfo | null,
    curr: ConnectionInfo | null
  ): boolean => {
    if (!prev || !curr) return true;

    // Check for effective type change (e.g., "4g" to "3g")
    if (prev.effectiveType !== curr.effectiveType) return true;

    // Check for significant bandwidth change (>20%)
    if (Math.abs(prev.downlink - curr.downlink) / prev.downlink > 0.2)
      return true;

    // Check for significant RTT change (>100ms)
    if (Math.abs(prev.rtt - curr.rtt) > 100) return true;

    return false;
  };

  #initEventListeners = (): void => {
    eventBus.on(
      Events.FRAGMENT_LOADING_COMPLETED,
      this.#onFragmentLoadingCompleted,
      this
    );
  };

  #onFragmentLoadingCompleted = (payload: Payload): void => {
    if (
      payload.fragmentLoadResult?.durationMs &&
      payload.fragmentLoadResult.transferredBytes
    ) {
      bandwidthEstimator.sample(
        payload.fragmentLoadResult.durationMs,
        payload.fragmentLoadResult.transferredBytes
      );
    }
  };

  setRepresentations = (representations: VideoRepresentation[]): void => {
    this.#representations = representations;
  };

  chooseRepresentation = (
    representations?: VideoRepresentation[]
  ): VideoRepresentation => {
    if (representations) {
      this.#representations = representations;
    }

    let chosen = this.#representations[0];
    const currBandwidth = bandwidthEstimator.getBandwidthEstimate();

    this.#logger.debug("Iterating through possible representations...");

    // Find the highest quality that fits within bandwidth constraints
    for (let i = 0; i < this.#representations.length; i++) {
      const rep = this.#representations[i];
      const playbackRate = this.#video.getPlaybackRate();
      const repBandwidth = playbackRate * rep.bitrate;
      const minBandwidth = repBandwidth * 1.05;

      // Calculate max bandwidth for this representation
      let maxBandwidth = Infinity;
      for (let j = i + 1; j < this.#representations.length; j++) {
        if (rep.bitrate !== this.#representations[j].bitrate) {
          const nextBandwidth = playbackRate * this.#representations[j].bitrate;
          maxBandwidth = nextBandwidth * 1.05;
          break;
        }
      }

      const canChoose =
        currBandwidth >= minBandwidth && currBandwidth <= maxBandwidth;

      this.#logger.debug(
        `Repr. ${rep.id} (${rep.height}p), bitrate: ${rep.bitrate}
       Min. Bandwidth: ${minBandwidth}
       Max. Bandwidth: ${maxBandwidth}
       Curr. Bandwidth: ${currBandwidth}
       Chosen?: ${canChoose}`
      );

      // Choose the highest quality that fits
      if (canChoose) {
        chosen = rep;
        // Continue to find potentially higher quality that also fits
      }
    }

    this.#lastTimeChosenMs = Date.now();
    return chosen;
  };
}

export const bandwidthAbr = new BandwidthAbr();
