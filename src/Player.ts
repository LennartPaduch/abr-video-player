import { manifestParser } from "./Dash/Segment/ManifestParser.js";
import { UI } from "./UI/UI.js";
import { eventBus } from "./Events/EventBus.js";
import { Events } from "./Events/Events.js";
import { MediaPlayerEvents } from "./Events/MediaPlayerEvents.js";
import { ScheduleController } from "./Controller/ScheduleController.js";
import { video } from "./Video.js";
import { playbackController } from "./Controller/PlaybackController.js";
import { GapController } from "./Controller/GapController/GapController.js";
import { logger } from "./Logger.js";
import { Assert } from "./utils/assertion.js";
import { bandwidthAbr } from "./Controller/abr/BandwidthAbr.js";
import {
  filterRepresentations,
  sortRepresentations,
} from "./Controller/abr/utils.js";
import { VideoRepresentation } from "./Types.js";

export class Player {
  #ms: MediaSource | any;
  #UI: UI;
  #scheduler: ScheduleController = new ScheduleController();
  #gapController: GapController = new GapController();
  #logger = logger.createChild("Player");
  #isManagedMediaSource: boolean = false;

  #title: string;

  constructor(
    title: string,
    manifestUrl: string,
    bifUrl: string,
    posterUrl?: string
  ) {
    this.#title = title;
    this.#UI = new UI(bifUrl);
    this.#ms = this.createMediaSource();
    manifestParser.setManifestUrl(manifestUrl);

    if (posterUrl) {
      video.getVideoElement().poster = posterUrl;
    }

    this.#setupMediaSourceHandlers();
  }

  #setupMediaSourceHandlers = (): void => {
    this.#ms.addEventListener("sourceopen", () => {
      this.#logger.info("MediaSource opened");

      this.#ms.duration = manifestParser.parsedManifest?.duration ?? 0;

      eventBus.trigger(MediaPlayerEvents.SOURCE_CHANGED, {
        mediaSource: this.#ms,
      });
    });

    this.#ms.addEventListener("sourceclose", () => {
      this.#logger.warn("MediaSource closed");
    });

    this.#ms.addEventListener("sourceended", () => {
      this.#logger.info("MediaSource ended");
    });

    this.#ms.addEventListener("error", (e: Event) => {
      this.#logger.error("MediaSource error:", e);
    });
  };

  startup = async (): Promise<void> => {
    eventBus.on(Events.MANIFEST_PARSED, this.#onManifestParsed, this);

    // Parse manifest first
    await manifestParser
      .loadMpdFile()
      .then((xml) => manifestParser.parseManifest(xml));

    // Set video source - this will trigger sourceopen
    video.setSource(this.#ms);

    // Initialize UI
    await this.#UI.init();
  };

  #onManifestParsed = (): void => {
    if (this.#ms.readyState === "open") {
      this.#preparePlayback();
    } else {
      this.#ms.addEventListener(
        "sourceopen",
        () => {
          this.#preparePlayback();
        },
        { once: true }
      );
    }
  };

  #preparePlayback = (): void => {
    this.#logger.info("Preparing playback");

    // Ensure MediaSource is ready
    if (this.#ms.readyState !== "open") {
      this.#logger.error("MediaSource not open, cannot prepare playback");
      return;
    }

    const parsedManifest = manifestParser.parsedManifest;

    if (parsedManifest?.duration) {
      try {
        this.#ms.duration = parsedManifest.duration;
        this.#logger.info(
          `Set MediaSource duration to: ${parsedManifest.duration}s`
        );
      } catch (e) {
        this.#logger.warn("Failed to set MediaSource duration:", e);
      }
    }

    Assert.assert(
      parsedManifest &&
        parsedManifest.videoRepresentations.length &&
        parsedManifest.audioRepresentations.length,
      "Missing video or audio representations"
    );

    const filteredVideoRepresentations = sortRepresentations(
      filterRepresentations(parsedManifest.videoRepresentations)
    ) as VideoRepresentation[];

    eventBus.trigger(Events.REPRESENTATIONS_CHANGED, {
      representations: {
        videoRepresentations: filteredVideoRepresentations,
        audioRepresentations: parsedManifest.audioRepresentations,
      },
    });

    const initialRepresentation = bandwidthAbr.chooseRepresentation(
      filteredVideoRepresentations
    );

    eventBus.trigger(Events.VIDEO_BITRATE_CHANGED, {
      videoRepresentation: initialRepresentation,
      switchReason: "Start",
    });

    eventBus.trigger(Events.AUDIO_BITRATE_CHANGED, {
      audioRepresentation: parsedManifest.audioRepresentations[1],
      switchReason: "Start",
    });

    Assert.assertDefined(
      playbackController.getCurrentVideoRepresentation(),
      "Initial representation should already be set."
    );

    this.#UI.setVideoTitle(
      this.#title.length
        ? this.#title
        : manifestParser.parsedManifest?.title ?? ""
    );

    this.#scheduler.init();
  };

  destroy = (): void => {
    if (this.#ms.readyState === "open") {
      this.#ms.endOfStream();
    }

    this.#scheduler.destroy();
    this.#gapController.destroy();

    eventBus.off(Events.MANIFEST_PARSED, this.#onManifestParsed, this);
  };

  createMediaSource() {
    // Try ManagedMediaSource first (iOS 17.1+)
    if (typeof window !== "undefined" && "ManagedMediaSource" in window) {
      console.log("Using ManagedMediaSource (iOS 17.1+)");
      this.#isManagedMediaSource = true;
      // CRITICAL: For ManagedMediaSource to work, you MUST disable remote playback
      if (this.#isManagedMediaSource) {
        const videoElement = video.getVideoElement();
        videoElement.disableRemotePlayback = true;
      }
      return new (window as any).ManagedMediaSource();
    }

    // Fall back to regular MediaSource (desktop, iPad)
    if (typeof MediaSource !== "undefined") {
      console.log("Using MediaSource");
      this.#isManagedMediaSource = false;
      return new MediaSource();
    }

    console.error("Neither ManagedMediaSource nor MediaSource available");
    return null;
  }

  isMediaSourceSupported() {
    // Check for ManagedMediaSource (iOS 17.1+)
    if (typeof window !== "undefined" && "ManagedMediaSource" in window) {
      return true;
    }

    // Check for regular MediaSource
    if (typeof MediaSource !== "undefined") {
      return true;
    }

    return false;
  }
}
