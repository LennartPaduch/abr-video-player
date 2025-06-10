export class SegmentReference {
  segmentNumber: number;
  startTime: number;
  endTime: number;
  getUris: () => string;

  constructor(
    segmentNumber: number,
    startTime: number,
    endTime: number,
    uriCallback: () => string
  ) {
    this.segmentNumber = segmentNumber;
    this.startTime = startTime;
    this.endTime = endTime;
    this.getUris = uriCallback;
  }

  get duration() {
    return this.endTime - this.startTime;
  }
}
