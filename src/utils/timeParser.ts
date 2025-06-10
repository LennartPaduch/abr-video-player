// Constants for time calculations
const SECONDS_IN_HOUR = 3600;
const SECONDS_IN_MINUTE = 60;

// Input: seconds i.e. 340
// Output: hours:minutes:seconds (hours only for values >0) i.e. 5:40 (for input 340)
export const parseSeconds = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / SECONDS_IN_HOUR);
  const minutes = Math.floor(
    (totalSeconds % SECONDS_IN_HOUR) / SECONDS_IN_MINUTE
  );
  const seconds = Math.floor(totalSeconds % SECONDS_IN_MINUTE);

  if (hours > 0) {
    return `${hours}:${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const ISO_8601_DURATION_REGEX =
  /PT(?:([.,\d]+)H)?(?:([.,\d]+)M)?(?:([.,\d]+)S)?/;

export const parse_ISO_8601_duration = (period: string): number => {
  const matches = period.match(ISO_8601_DURATION_REGEX);
  if (!matches) return 0;

  const hours: number = matches[1] ? Number(matches[1]) : 0;
  const minutes: number = matches[2] ? Number(matches[2]) : 0;
  const seconds: number = matches[3] ? Number(matches[3]) : 0;

  return seconds + minutes * SECONDS_IN_MINUTE + hours * SECONDS_IN_HOUR;
};
