import { parse_ISO_8601_duration } from "../../utils/timeParser.js";
import { AudioRepresentation, VideoRepresentation } from "../../Types.js";
import { logger } from "../../Logger.js";
import { Assert } from "../../utils/assertion.js";
import { eventBus } from "../../Events/EventBus.js";
import { Events } from "../../Events/Events.js";
import { SegmentReference } from "./SegmentReference.js";
import { SegmentIndex } from "./SegmentIndex.js";

export interface ParsedManifest {
  videoRepresentations: VideoRepresentation[];
  audioRepresentations: AudioRepresentation[];
  duration: number;
  title: string | null;
  maxSegmentDuration: number;
  audioLanguages: string[];
}

export interface RepresentationWithIndex extends VideoRepresentation {
  segmentIndex: SegmentIndex;
}

export interface AudioRepresentationWithIndex extends AudioRepresentation {
  segmentIndex: SegmentIndex;
}

type ContentType = "video" | "audio" | "text";

interface SegmentTemplateInfo {
  initialization?: string | null;
  media?: string | null;
  timescale?: number;
  startNumber?: number;
  duration?: number;
  segmentTimeline?: Element | null;
}

export class ManifestParser {
  #logger = logger.createChild("ManifestParser");
  #parser: DOMParser = new DOMParser();
  #manifestUrl: string | undefined;
  #manifestBaseUrl: string | undefined;
  parsedManifest: ParsedManifest | null = null;

  setManifestUrl(manifestUrl: string) {
    this.#manifestUrl = manifestUrl;
    this.#manifestBaseUrl = this.#manifestUrl.substring(
      0,
      this.#manifestUrl.lastIndexOf("/")
    );
  }

  async loadMpdFile(): Promise<Document | null> {
    if (!this.#manifestUrl) {
      console.error("Manifest URL not set.");
      return null;
    }

    try {
      const response = await fetch(this.#manifestUrl, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const mpdString = await response.text();
      const xmlDoc = this.#parser.parseFromString(mpdString, "text/xml");
      this.#logger.debug("Loaded Manifest XML Doc", xmlDoc);
      return xmlDoc;
    } catch (error) {
      this.#logger.error("Failed to fetch MPD file:", error);
    }
    return null;
  }

  parseManifest = (xmlDoc: Document | null) => {
    Assert.assertDefined(xmlDoc);

    const mpd = xmlDoc.getElementsByTagName("MPD")[0];
    const duration = parse_ISO_8601_duration(
      mpd.getAttribute("mediaPresentationDuration") || ""
    );

    const titleElement = mpd
      .getElementsByTagName("ProgramInformation")[0]
      ?.getElementsByTagName("Title");

    const title = titleElement?.length ? titleElement[0].textContent : null;
    const maxSegmentDuration = parse_ISO_8601_duration(
      mpd.getAttribute("maxSegmentDuration") || ""
    );

    Assert.assert(
      maxSegmentDuration > 0,
      "MaxSegmentDuration failed greater than 0 check!"
    );
    Assert.assert(duration > 0, "Duration failed greater than 0 check!");

    const videoRepresentations: VideoRepresentation[] = [];
    const audioRepresentations: AudioRepresentation[] = [];
    const audioLanguages = new Set<string>();

    // Process all AdaptationSets
    const adaptationSets = xmlDoc.getElementsByTagName("AdaptationSet");

    for (const adaptationSet of adaptationSets) {
      const contentType =
        this.#determineAdaptationSetContentType(adaptationSet);

      if (!contentType) {
        this.#logger.warn("Could not determine content type for AdaptationSet");
        continue;
      }

      // Get SegmentTemplate from AdaptationSet level (if exists)
      const asSegmentTemplate = this.#extractSegmentTemplate(adaptationSet);

      // Get language for audio
      const lang = adaptationSet.getAttribute("lang");
      if (lang && contentType === "audio") {
        audioLanguages.add(lang);
      }

      // Process all Representations in this AdaptationSet
      const representations =
        adaptationSet.getElementsByTagName("Representation");

      for (const representation of representations) {
        // Get SegmentTemplate from Representation level (if exists)
        const repSegmentTemplate = this.#extractSegmentTemplate(representation);

        // Merge templates - Representation level overrides AdaptationSet level
        const mergedTemplate = { ...asSegmentTemplate, ...repSegmentTemplate };

        const rep = this.#parseRepresentation(
          representation,
          contentType,
          mergedTemplate,
          adaptationSet,
          duration
        );

        if (rep) {
          if (contentType === "video") {
            videoRepresentations.push(rep as VideoRepresentation);
          } else if (contentType === "audio") {
            audioRepresentations.push(rep as AudioRepresentation);
          }
        }
      }
    }

    this.parsedManifest = {
      duration,
      title,
      videoRepresentations,
      audioRepresentations,
      maxSegmentDuration,
      audioLanguages: Array.from(audioLanguages),
    };

    eventBus.trigger(Events.MANIFEST_PARSED);

    //this.#logger.info("Parsed Manifest:", this.parsedManifest);
  };

  #extractSegmentTemplate = (element: Element): SegmentTemplateInfo => {
    const segmentTemplate = element.getElementsByTagName("SegmentTemplate")[0];

    if (!segmentTemplate || segmentTemplate.parentElement !== element) {
      const segmentBase = element.getElementsByTagName("SegmentBase")[0];
      const segmentList = element.getElementsByTagName("SegmentList")[0];

      if (segmentBase || segmentList) {
        this.#logger.warn("SegmentBase/SegmentList not yet supported");
      }

      return {};
    }

    return {
      initialization: segmentTemplate.getAttribute("initialization"),
      media: segmentTemplate.getAttribute("media"),
      timescale: segmentTemplate.hasAttribute("timescale")
        ? Number(segmentTemplate.getAttribute("timescale"))
        : undefined,
      startNumber: segmentTemplate.hasAttribute("startNumber")
        ? Number(segmentTemplate.getAttribute("startNumber"))
        : undefined,
      duration: segmentTemplate.hasAttribute("duration")
        ? Number(segmentTemplate.getAttribute("duration"))
        : undefined,
      segmentTimeline:
        segmentTemplate.getElementsByTagName("SegmentTimeline")[0] || null,
    };
  };

  #determineAdaptationSetContentType = (
    adaptationSet: Element
  ): ContentType | null => {
    // Check contentType attribute
    const contentType = adaptationSet.getAttribute("contentType");
    if (
      contentType === "video" ||
      contentType === "audio" ||
      contentType === "text"
    ) {
      return contentType as ContentType;
    }

    // Check mimeType
    const mimeType = adaptationSet.getAttribute("mimeType");
    if (mimeType) {
      if (mimeType.startsWith("video/")) return "video";
      if (mimeType.startsWith("audio/")) return "audio";
      if (mimeType.startsWith("text/")) return "text";
    }

    // Check for video-specific attributes
    if (
      adaptationSet.hasAttribute("width") ||
      adaptationSet.hasAttribute("height") ||
      adaptationSet.hasAttribute("frameRate") ||
      adaptationSet.hasAttribute("scanType")
    ) {
      return "video";
    }

    // Check for audio-specific attributes
    if (
      adaptationSet.querySelector("AudioChannelConfiguration") ||
      adaptationSet.hasAttribute("audioSamplingRate") ||
      adaptationSet.hasAttribute("lang")
    ) {
      return "audio";
    }

    // Check first Representation as fallback
    const firstRep = adaptationSet.getElementsByTagName("Representation")[0];
    if (firstRep) {
      return this.#determineContentType(firstRep);
    }

    return null;
  };

  #determineContentType = (representation: Element): ContentType | null => {
    // Check parent AdaptationSet first
    const adaptationSet = representation.closest("AdaptationSet");
    const asContentType = adaptationSet?.getAttribute("contentType");
    if (
      asContentType === "video" ||
      asContentType === "audio" ||
      asContentType === "text"
    ) {
      return asContentType as ContentType;
    }

    // Check mimeType on representation
    const mimeType = representation.getAttribute("mimeType");
    if (mimeType) {
      if (mimeType.startsWith("video/")) return "video";
      if (mimeType.startsWith("audio/")) return "audio";
      if (mimeType.startsWith("text/")) return "text";
    }

    // Check mimeType on AdaptationSet
    const asMimeType = adaptationSet?.getAttribute("mimeType");
    if (asMimeType) {
      if (asMimeType.startsWith("video/")) return "video";
      if (asMimeType.startsWith("audio/")) return "audio";
      if (asMimeType.startsWith("text/")) return "text";
    }

    // Check for video-specific attributes
    if (
      representation.hasAttribute("width") ||
      representation.hasAttribute("height") ||
      representation.hasAttribute("frameRate") ||
      adaptationSet?.hasAttribute("width") ||
      adaptationSet?.hasAttribute("height") ||
      adaptationSet?.hasAttribute("frameRate")
    ) {
      return "video";
    }

    // Check for audio-specific attributes
    if (
      representation.querySelector("AudioChannelConfiguration") ||
      representation.hasAttribute("audioSamplingRate") ||
      adaptationSet?.hasAttribute("audioSamplingRate")
    ) {
      return "audio";
    }

    return null;
  };

  #parseRepresentation = (
    representation: Element,
    contentType: ContentType,
    segmentTemplateInfo: SegmentTemplateInfo,
    adaptationSet: Element,
    manifestDuration: number
  ): (VideoRepresentation | AudioRepresentation) | null => {
    // Get attributes from Representation or fall back to AdaptationSet
    const id = representation.getAttribute("id") || "";
    const width = Number(
      representation.getAttribute("width") ||
        adaptationSet.getAttribute("width")
    );
    const height = Number(
      representation.getAttribute("height") ||
        adaptationSet.getAttribute("height")
    );
    const codecs =
      representation.getAttribute("codecs") ||
      adaptationSet.getAttribute("codecs");
    const mimeType =
      representation.getAttribute("mimeType") ||
      adaptationSet.getAttribute("mimeType");
    const bitrate = Number(representation.getAttribute("bandwidth"));

    const frameRateStr =
      representation.getAttribute("frameRate") ||
      adaptationSet.getAttribute("frameRate");
    const fps = frameRateStr
      ? Number(
          (
            Number(frameRateStr.split("/")[0]) /
            Number(frameRateStr.split("/")[1] || 1)
          ).toPrecision(2)
        )
      : 0;

    const audioSamplingRate = Number(
      representation.getAttribute("audioSamplingRate") ||
        adaptationSet.getAttribute("audioSamplingRate")
    );

    const audioChannelConfiguration =
      representation.getElementsByTagName("AudioChannelConfiguration")[0] ||
      adaptationSet.getElementsByTagName("AudioChannelConfiguration")[0];

    const audioChannels = audioChannelConfiguration
      ? Number(audioChannelConfiguration.getAttribute("value"))
      : 0;

    // Validate we have segment template info
    if (!segmentTemplateInfo.timescale) {
      this.#logger.error("No timescale found for representation", id);
      return null;
    }

    const timescale = segmentTemplateInfo.timescale;
    const startNumber = segmentTemplateInfo.startNumber || 1;
    const initTemplate = segmentTemplateInfo.initialization || null;
    const mediaTemplate = segmentTemplateInfo.media || null;

    // Build SegmentIndex
    const segmentIndex = new SegmentIndex();
    let maxSegNum = 0;

    if (segmentTemplateInfo.segmentTimeline) {
      // Timeline-based segments
      const s = segmentTemplateInfo.segmentTimeline.getElementsByTagName("S");
      let cumulativeTime = 0;
      let currentSegNum = startNumber;
      let position = 1;

      for (const data of s) {
        const repeated = Number(data.getAttribute("r") || 0);
        const duration = Number(data.getAttribute("d") || 0);
        const explicitStart = data.hasAttribute("t");
        let start = explicitStart
          ? Number(data.getAttribute("t"))
          : cumulativeTime;

        // Generate SegmentReferences for this timeline entry and all repeats
        const count = Math.max(1, repeated + 1);
        for (let i = 0; i < count; i++) {
          const segStart = start / timescale;
          const segDuration = duration / timescale;
          const segEnd = segStart + segDuration;

          // Create URL callback
          const capturedSegNum = currentSegNum;
          const capturedId = id;
          const capturedContentType = contentType;

          if (mediaTemplate) {
            const uriCallback = () => {
              return this.#generateSegmentUrlFromTemplate(
                mediaTemplate,
                capturedId,
                capturedSegNum,
                bitrate
              );
            };
            const segmentRef = new SegmentReference(
              position,
              segStart,
              segEnd,
              uriCallback
            );

            segmentIndex.references.push(segmentRef);
            //Fallback would be good?
          }

          // Update tracking variables
          start += duration;
          cumulativeTime = start;
          currentSegNum++;
          position++;
        }

        maxSegNum += Math.max(repeated + 1, 1);
      }
    } else if (segmentTemplateInfo.duration) {
      // Duration-based segments (no timeline)
      const segmentDuration = segmentTemplateInfo.duration / timescale;
      const totalDuration = manifestDuration;
      const totalSegments = Math.ceil(totalDuration / segmentDuration);

      for (let i = 0; i < totalSegments; i++) {
        const segNum = startNumber + i;
        const segStart = i * segmentDuration;
        const segEnd = Math.min((i + 1) * segmentDuration, totalDuration);

        const capturedSegNum = segNum;
        const capturedId = id;

        if (mediaTemplate) {
          const uriCallback = () => {
            return this.#generateSegmentUrlFromTemplate(
              mediaTemplate,
              capturedId,
              capturedSegNum,
              bitrate
            );
          };
          const segmentRef = new SegmentReference(
            i + 1,
            segStart,
            segEnd,
            uriCallback
          );
          // Fallback would be good?

          segmentIndex.references.push(segmentRef);
        }
      }

      maxSegNum = totalSegments;
    }

    const segment = {
      maxSegNum: maxSegNum + startNumber - 1,
      timescale,
      startNumber,
      timeline: [], // For compatibility
      initialization: initTemplate,
      media: mediaTemplate,
    };

    if (id && codecs && mimeType && bitrate && segment) {
      const baseRep = {
        id: id, // Keep as string for flexibility
        mimeType,
        codecs,
        bitrate,
        segment,
        segmentIndex,
      };

      if (contentType === "video") {
        Assert.assert(
          fps > 0,
          "Encountered invalid FPS during video manifest parsing"
        );
        Assert.assert(
          height > 0,
          "Encountered invalid height during video manifest parsing"
        );
        Assert.assert(
          width > 0,
          "Encountered invalid width during video manifest parsing"
        );
        return {
          ...baseRep,
          width,
          height,
          fps,
        } as VideoRepresentation;
      } else if (contentType === "audio") {
        Assert.assert(
          audioChannels > 0,
          "Encountered invalid audioChannel number during audio manifest parsing"
        );
        Assert.assert(
          audioSamplingRate > 0,
          "Encountered invalid audioSamplingRate during audio manifest parsing"
        );
        return {
          ...baseRep,
          audioChannels,
          audioSamplingRate,
        } as AudioRepresentation;
      }
    }
    return null;
  };

  #generateSegmentUrlFromTemplate = (
    template: string,
    representationId: string | number,
    segmentNumber: number,
    bandwidth: number
  ): string => {
    let url = template;

    // Replace template variables
    url = url.replace(/\$RepresentationID\$/g, String(representationId));
    url = url.replace(/\$Bandwidth\$/g, String(bandwidth));

    // Handle Number with optional padding
    url = url.replace(/\$Number(?:%0(\d+)d)?\$/g, (match, padLength) => {
      if (padLength) {
        return String(segmentNumber).padStart(parseInt(padLength), "0");
      }
      return String(segmentNumber);
    });

    // Check if URL is already absolute
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }

    return `${this.#manifestBaseUrl}/${url}`;
  };

  // Helper method to get initialization URL
  getInitializationUrl(
    representation: VideoRepresentation | AudioRepresentation
  ): string {
    const { segment, id, bitrate } = representation;
    const contentType = "width" in representation ? "video" : "audio";

    if (segment.initialization) {
      let url = segment.initialization;
      url = url.replace(/\$RepresentationID\$/g, String(id));
      url = url.replace(/\$Bandwidth\$/g, String(bitrate));

      return `${this.#manifestBaseUrl}/${url}`;
    }

    // Fallback
    if (contentType === "video") {
      return `${this.#manifestBaseUrl}/init-stream${id}.m4s`;
    } else {
      return `${this.#manifestBaseUrl}/audio_51_${id}_init.m4s`;
    }
  }
}

export const manifestParser = new ManifestParser();
