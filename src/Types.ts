import { SegmentIndex } from "./Dash/Segment/SegmentIndex";
import { SegmentReference } from "./Dash/Segment/SegmentReference";

export type BolaAlgorithmState = "STARTUP" | "STEADY_STATE" | "ONE_BITRATE";

export interface FragmentLoadResult {
  data: ArrayBuffer;
  status: number;
  durationMs: number;
  fromCache: boolean;
  transferredBytes: number;
  resourceBytes: number;
}

export interface FragmentPayload {
  segmentRef: SegmentReference;
  status: number;
  durationMs: number;
  fromCache: boolean;
  transferredBytes: number;
  resourceBytes: number;
  discarded?: boolean;
  reason?: string;
  isReplacement: boolean;
}

export interface BolaState {
  representations: VideoRepresentation[];
  utilities: number[];
  bufferTimeDefault?: number;
  vp: number;
  gp: number;
  currentRepresentation: VideoRepresentation | null;
  placeholderBuffer: number;
  lastSegmentFinishTimeMs: number;
  lastCallTimeMs: number;
  lastSegmentStart: number;
  lastSegmentRequestTimeMs: number;

  algorithmState: BolaAlgorithmState;
  lastSegmentDurationS: number;
  mostAdvancedSegmentStart: number;
  lastSegmentWasReplacement: boolean;
  rebufferStartTimeMs: number;
  segmentCount: number; // Track segments downloaded since startup/seek
}

export interface BaseRepresentation {
  id: string;
  mimeType: string;
  codecs: string;
  bitrate: number;
  segment: Segment;
  segmentIndex: SegmentIndex;
}

export interface VideoRepresentation extends BaseRepresentation {
  width: number;
  height: number;
  fps: number;
}

export interface AudioRepresentation extends BaseRepresentation {
  audioChannels: number;
  audioSamplingRate: number;
}

export interface Segment {
  maxSegNum: number;
  timescale: number;
  startNumber: number;
  timeline: SegmentTimeline[];
  media?: string; // Media URL template (e.g., "$RepresentationID$/segment-$Number$.m4s")
  initialization?: string; // Init segment URL template
}

export type AbrStrategyType = "Bandwidth" | "Buffer" | "DroppedFrames";

// Interface that all ABR strategies must implement
export interface AbrStrategy {
  chooseRepresentation(): VideoRepresentation | null;
  setRepresentations(
    representations: VideoRepresentation[] | VideoRepresentation[]
  ): void;
}

export interface SegmentTimeline {
  start: number;
  duration: number;
  repeated: number;
}

export type MediaType = "video" | "audio";

export interface IManifestInfo {
  dvrWindowSize: number;
  availableFrom: Date;
  duration: number;
  isDynamic: boolean;
  loadedTime: Date;
  maxFragmentDuration: number;
  minBufferTime: number;
  serviceDescriptions: IServiceDescriptions[];
  protocol?: string;
}

export interface IServiceDescriptions {
  id: number;
  schemeIdUri: string;
  latency: number | null;
  playbackrate: number;
  contentSteering: IContentSteering | null;
}

export interface IContentSteering {
  defaultServiceLocation: string;
  defaultServiceLocationArray: string[];
  queryBeforeStart: boolean;
  serverUrl: string;
  clientRequirement: boolean;
}

export class StreamInfo {
  id: string;
  index: number;
  start: number;
  duration: number;
  manifestInfo: IManifestInfo;
  isLast: boolean;
  constructor(
    id: string,
    index: number,
    start: number,
    duration: number,
    manifestInfo: IManifestInfo,
    isLast: boolean
  ) {
    this.id = id;
    this.index = index;
    this.start = start;
    this.duration = duration;
    this.manifestInfo = manifestInfo;
    this.isLast = isLast;
  }
}

export class MediaInfo {
  id: string | null = null;
  index: number | null = null;
  type: MediaType | null = null;
  streamInfo: StreamInfo | null = null;
  representationCount: number = 0;
  labels: { text: string; lang?: string }[] = [];
  lang: string | null = null;
  codec: string | null = null;
  mimeType: string | null = null;
  contentProtection: any | null = null;
  isText: boolean = false;
  KID: any | null = null;
  bitrateList: Bitrate[] = [];
  isFragmented: any | null = null;
  isEmbedded: any | null = null;
  selectionPriority: number | null = null;
  supplementalProperties: object | null = null;
  essentialProperties: object | null = null;
  segmentAlignment: boolean = false;
  subSegmentAlignment: boolean = false;
}

export interface Bitrate {
  id?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  scanType?: string;
}
