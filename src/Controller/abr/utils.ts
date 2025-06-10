import { logger } from "../../Logger.js";
import { AudioRepresentation, VideoRepresentation } from "../../Types";
import { video } from "../../Video.js";

const filterLogger = logger.createChild("Rep DimFilter");

export interface IRestrictions {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  minPixels: number;
  maxPixels: number;
}

export const DEFAULT_RESTRICTIONS: IRestrictions = {
  minWidth: 0,
  maxWidth: Number.POSITIVE_INFINITY,
  minHeight: 0,
  maxHeight: Number.POSITIVE_INFINITY,
  minPixels: 0,
  maxPixels: Number.POSITIVE_INFINITY,
};

export const filterRepresentations = (
  representations: VideoRepresentation[],
  maxBitrate?: number
): VideoRepresentation[] => {
  const devicePixelRatio = window.devicePixelRatio || 1;

  // Get screen dimensions
  const screenHeight = window.screen.height * devicePixelRatio;
  const screenWidth = window.screen.width * devicePixelRatio;

  const { width: videoWidth, height: videoHeight } =
    video.getActualVideoDisplaySize();
  const actualVideoHeight = videoHeight * devicePixelRatio;
  const actualVideoWidth = videoWidth * devicePixelRatio;

  const targetHeight = !isNaN(actualVideoHeight)
    ? Math.min(screenHeight, actualVideoHeight)
    : screenHeight;
  const targetWidth = !isNaN(actualVideoWidth)
    ? Math.min(screenWidth, actualVideoWidth)
    : screenWidth;

  filterLogger.debug("Filtering with constraints:", {
    targetHeight,
    targetWidth,
    maxBitrate,
    devicePixelRatio,
  });

  const startCount = representations.length;

  // PASS 1: Filter by basic restrictions and bitrate (without size limits)
  let filtered = representations.filter((representation) =>
    meetsBasicRestrictions(representation, DEFAULT_RESTRICTIONS)
  );

  // Filter by bitrate if specified
  if (maxBitrate) {
    filtered = filtered.filter(
      (representation) =>
        !representation.bitrate || representation.bitrate <= maxBitrate
    );
  }

  // PASS 2: Find the optimal resolution cap (Shaka's approach)
  let maxAllowedHeight = Number.POSITIVE_INFINITY;
  let maxAllowedWidth = Number.POSITIVE_INFINITY;

  if (
    targetHeight !== Number.POSITIVE_INFINITY ||
    targetWidth !== Number.POSITIVE_INFINITY
  ) {
    const resolutions = getResolutionList(filtered);

    // Find the first resolution that meets or exceeds the target
    // This allows for better quality when available
    for (const resolution of resolutions) {
      if (
        resolution.height >= targetHeight &&
        resolution.width >= targetWidth
      ) {
        maxAllowedHeight = resolution.height;
        maxAllowedWidth = resolution.width;
        break;
      }
    }

    // Apply the size restrictions
    filtered = filtered.filter((representation) =>
      meetsSizeRestrictions(representation, maxAllowedWidth, maxAllowedHeight)
    );
  }
  filterLogger.debug(
    `Max allowed resolution: ${maxAllowedWidth}x${maxAllowedHeight}`
  );
  filterLogger.debug(
    `Filtered ${startCount - filtered.length}/${startCount} representations`
  );

  // Soft restriction fallback - always return something
  if (!filtered.length && representations.length) {
    filterLogger.warn(
      "No representations met restrictions. Using lowest quality fallback."
    );
    const sortedByBandwidth = [...representations].sort(
      (a, b) => (a.bitrate || 0) - (b.bitrate || 0)
    );
    filtered = [sortedByBandwidth[0]];
  }

  return filtered;
};

/**
 * Basic restriction checking (non-size related)
 */
const meetsBasicRestrictions = (
  representation: VideoRepresentation,
  restrictions: IRestrictions
): boolean => {
  if (!representation.width || !representation.height) {
    return true;
  }

  const pixels = representation.width * representation.height;

  return (
    representation.width >= restrictions.minWidth &&
    representation.height >= restrictions.minHeight &&
    pixels >= restrictions.minPixels &&
    pixels <= restrictions.maxPixels
  );
};

/**
 * Size-specific restriction checking
 */
const meetsSizeRestrictions = (
  representation: VideoRepresentation,
  maxWidth: number,
  maxHeight: number
): boolean => {
  if (!representation.width || !representation.height) {
    return true;
  }

  const withinLimits =
    representation.width <= maxWidth && representation.height <= maxHeight;

  filterLogger.debug(`
    Max allowed: ${maxWidth}x${maxHeight}
    Representation ${representation.width}x${representation.height}
    Passes: ${withinLimits}
  `);

  return withinLimits;
};

/**
 * Get list of unique resolutions sorted by total pixels (ascending)
 */
const getResolutionList = (
  representations: VideoRepresentation[]
): Array<{ height: number; width: number }> => {
  const resolutions: Array<{ height: number; width: number }> = [];
  const seen = new Set<string>();

  for (const representation of representations) {
    if (!representation.width || !representation.height) {
      continue;
    }

    const key = `${representation.width}x${representation.height}`;
    if (!seen.has(key)) {
      seen.add(key);
      resolutions.push({
        height: representation.height,
        width: representation.width,
      });
    }
  }

  // Sort by total pixels (smallest first)
  return resolutions.sort((a, b) => a.width * a.height - b.width * b.height);
};

export const sortRepresentations = (
  representations: VideoRepresentation[] | AudioRepresentation[]
): VideoRepresentation[] | AudioRepresentation[] => {
  return representations.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
};
