import { SegmentReference } from "./SegmentReference";

export class SegmentIndex {
  references: SegmentReference[] = [];

  getSegmentAtTime = (time: number): SegmentReference | null => {
    let left = 0;
    let right = this.references.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const ref = this.references[mid];

      if (time >= ref.startTime && time < ref.endTime) {
        return ref;
      }

      if (time < ref.startTime) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    // If we're here, time is in a gap or outside segments
    // Return the next segment if time is before any segment
    if (left < this.references.length) {
      return this.references[left];
    }

    return null;
  };

  getSegmentByNumber = (segmentNumber: number): SegmentReference | null => {
    // If segments are sequential
    if (this.references.length > 0) {
      const firstSegNum = this.references[0].segmentNumber;
      const index = segmentNumber - firstSegNum;

      if (index >= 0 && index < this.references.length) {
        const ref = this.references[index];
        // Verify it's the right segment
        if (ref.segmentNumber === segmentNumber) {
          return ref;
        }
      }
    }

    // Fallback to binary search if not sequential
    return (
      this.references.find((ref) => ref.segmentNumber === segmentNumber) || null
    );
  };

  getNextSegment = (
    currentSegment: SegmentReference
  ): SegmentReference | null => {
    const currentIndex = this.references.indexOf(currentSegment);
    if (currentIndex >= 0 && currentIndex < this.references.length - 1) {
      return this.references[currentIndex + 1];
    }
    return null;
  };

  getFirstSegment = (): SegmentReference | null => {
    return this.references[0] || null;
  };

  getLastSegment = (): SegmentReference | null => {
    return this.references[this.references.length - 1] || null;
  };

  hasSegmentNumber = (segmentNumber: number): boolean => {
    return this.getSegmentByNumber(segmentNumber) !== null;
  };
}
