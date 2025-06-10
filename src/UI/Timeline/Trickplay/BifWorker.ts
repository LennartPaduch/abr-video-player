/* import { logger } from "../Logger.js";
 */
const CACHE_SIZE_LIMIT = 50;
const PREFETCH_WINDOW = 10;
const BIF_HEADER_SIZE = 64;
const BIF_INDEX_ENTRY_SIZE = 8;
const FINAL_INDEX_INDICATOR = 0xffffffff;

interface FrameOffset {
  positionMillis: number;
  offsetBytes: number;
  size: number;
}

interface BifMetadata {
  version: number;
  imageCount: number;
  timestampMultiplier: number;
  averageFrameSize: number;
}

interface ProcessedFrame {
  frameIndex: number;
  imageData: Blob;
  quality: number;
}

interface BifOptions {
  cacheSize?: number;
}

class LRUCache<K, V> {
  #cache: Map<K, V>;
  readonly #limit: number;

  constructor(limit: number) {
    this.#cache = new Map();
    this.#limit = limit;
  }

  get(key: K): V | undefined {
    const value = this.#cache.get(key);
    if (value) {
      this.#cache.delete(key);
      this.#cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.#cache.size >= this.#limit) {
      const firstKey = Array.from(this.#cache.keys())[0];
      if (firstKey !== undefined) {
        this.delete(firstKey);
      }
    }
    this.#cache.set(key, value);
  }

  delete(key: K): void {
    if (typeof key === "number") {
      const url = this.#cache.get(key);
      if (typeof url === "string") {
        URL.revokeObjectURL(url);
      }
    }
    this.#cache.delete(key);
  }

  clear(): void {
    Array.from(this.#cache.keys()).forEach((key) => this.delete(key));
  }
}

class FrameLoader {
  #abortController: AbortController | null = null;
  #loading = false;
  readonly #frameCache: LRUCache<number, Promise<Blob>>;

  constructor(private readonly frameSource: BifFrameImageSource) {
    this.#frameCache = new LRUCache<number, Promise<Blob>>(CACHE_SIZE_LIMIT);
  }

  async loadFrame(frameIndex: number): Promise<Blob> {
    const cached = this.#frameCache.get(frameIndex);
    if (cached) return cached;

    const promise = this.#fetchFrame(frameIndex);
    this.#frameCache.set(frameIndex, promise);
    return promise;
  }

  #fetchFrame = async (frameIndex: number): Promise<Blob> => {
    return this.frameSource.getFrameBlob(frameIndex, frameIndex + 1);
  };

  prefetchFrames = (currentIndex: number): void => {
    if (this.#loading) return;

    this.#loading = true;
    this.#abortController?.abort();
    this.#abortController = new AbortController();

    const prefetchIndices = this.#calculatePrefetchIndices(currentIndex);

    Promise.all(
      prefetchIndices.map((index) =>
        this.loadFrame(index).catch((e) =>
          console.warn(`Prefetch failed for frame ${index}:`, e)
        )
      )
    ).finally(() => {
      this.#loading = false;
    });
  };

  #calculatePrefetchIndices = (currentIndex: number): number[] => {
    const indices: number[] = [];
    for (let i = 1; i <= PREFETCH_WINDOW; i++) {
      const nextIndex = currentIndex + i;
      if (nextIndex < this.frameSource.getFrameCount()) {
        indices.push(nextIndex);
      }
    }
    return indices;
  };

  abort(): void {
    this.#abortController?.abort();
    this.#loading = false;
  }
}

class BifFrameImageSource {
  readonly #bifFile: ArrayBuffer;
  readonly #frameOffsets: readonly FrameOffset[];
  readonly #metadata: BifMetadata;
  readonly #urlCache: LRUCache<number, string>;
  readonly #frameLoader: FrameLoader;

  constructor(
    bifFile: ArrayBuffer,
    frameOffsets: FrameOffset[],
    metadata: BifMetadata,
    options?: BifOptions
  ) {
    this.#bifFile = bifFile;
    this.#frameOffsets = Object.freeze(frameOffsets);
    this.#metadata = metadata;
    this.#urlCache = new LRUCache<number, string>(
      options?.cacheSize ?? CACHE_SIZE_LIMIT
    );
    this.#frameLoader = new FrameLoader(this);
  }

  #handleProcessedFrame = (
    frameIndex: number,
    imageData: Blob,
    quality: number
  ): void => {
    const url = URL.createObjectURL(imageData);
    this.#urlCache.set(frameIndex, url);
  };

  #getFrameIndexForTime = (timeMillis: number): number => {
    const searchFrame: FrameOffset = {
      positionMillis: timeMillis,
      offsetBytes: 0,
      size: 0,
    };

    const index = this.#findInsertionIndex(
      this.#frameOffsets,
      searchFrame,
      "positionMillis"
    );

    if (index <= 0 || index >= this.#frameOffsets.length) {
      return -1;
    }

    return index - 1;
  };

  #findInsertionIndex = (
    array: readonly FrameOffset[],
    value: FrameOffset,
    key: keyof FrameOffset
  ): number => {
    let low = 0;
    let high = array.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (array[mid][key] < value[key]) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  };

  getImgUrl = async (timeMillis: number): Promise<string> => {
    try {
      const frameIndex = this.#getFrameIndexForTime(timeMillis);
      if (frameIndex === -1) return "";

      const cachedUrl = this.#urlCache.get(frameIndex);
      if (cachedUrl) return cachedUrl;

      const blob = await this.#frameLoader.loadFrame(frameIndex);
      const url = URL.createObjectURL(blob);
      this.#urlCache.set(frameIndex, url);

      this.#frameLoader.prefetchFrames(frameIndex);

      return url;
    } catch (e) {
      console.error(`Failed to get image URL at ${timeMillis}ms:`, e);

      return "";
    }
  };

  getFrameBlob = (startFrame: number, endFrame: number): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      try {
        const startOffset = this.#frameOffsets[startFrame].offsetBytes;
        const endOffset = this.#frameOffsets[endFrame].offsetBytes;

        const frameData = new Uint8Array(
          this.#bifFile,
          startOffset,
          endOffset - startOffset
        );
        resolve(new Blob([frameData], { type: "image/jpeg" }));
      } catch (error) {
        reject(error);
      }
    });
  };

  getFrameCount = (): number => {
    return this.#frameOffsets.length - 1;
  };

  destroy = (): void => {
    this.#frameLoader.abort();
    this.#urlCache.clear();
  };
}

class BifParser {
  static async fromUrl(
    url: string,
    options?: BifOptions
  ): Promise<BifFrameImageSource> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch BIF file: ${response.statusText}`);
      }

      const bifFile = await response.arrayBuffer();
      return BifParser.parse(bifFile, options);
    } catch (error) {
      throw new Error(`Failed to load BIF file from URL: ${error}`);
    }
  }

  static parse(
    bifFile: ArrayBuffer,
    options?: BifOptions
  ): BifFrameImageSource {
    try {
      const dataView = new DataView(bifFile);

      // Parse metadata
      const version = dataView.getUint32(0, true);
      const numImages = dataView.getUint32(12, true);
      const timestampMultiplier = dataView.getUint32(16, true) || 1_000;

      console.info(
        `Parsing BIF v${version} with ${numImages} images and timestamp multiplier ${timestampMultiplier}`
      );

      // Parse frame offsets
      const frameOffsets: FrameOffset[] = [];
      let offset = BIF_HEADER_SIZE;
      let totalSize = 0;

      for (let i = 1; i <= numImages; i++) {
        const positionMillis =
          dataView.getUint32(offset, true) * timestampMultiplier;
        const offsetBytes = dataView.getUint32(offset + 4, true);

        // Calculate frame size (difference between current and next offset)
        const nextOffset = dataView.getUint32(offset + 12, true);
        const size = nextOffset - offsetBytes;
        totalSize += size;

        frameOffsets.push({ positionMillis, offsetBytes, size });
        offset += BIF_INDEX_ENTRY_SIZE;
      }

      // Handle final entry
      const lastOffsetBytes = dataView.getUint32(offset + 4, true);
      if (dataView.getUint32(offset, true) !== FINAL_INDEX_INDICATOR) {
        console.warn(
          "Missing final entry indicator, there may be missing frames."
        );
      }

      frameOffsets.push({
        positionMillis: Number.MAX_VALUE,
        offsetBytes: lastOffsetBytes,
        size: 0,
      });

      const metadata: BifMetadata = {
        version,
        imageCount: numImages,
        timestampMultiplier,
        averageFrameSize: totalSize / numImages,
      };

      return new BifFrameImageSource(bifFile, frameOffsets, metadata, options);
    } catch (error) {
      throw new Error(`Failed to parse BIF file: ${error}`);
    }
  }
}

type WorkerInitMessage = {
  type: "INIT";
  url: string;
  options?: BifOptions;
};

type WorkerFrameRequest = {
  type: "GET_FRAME";
  timeMillis: number;
};

type WorkerMessage = WorkerInitMessage | WorkerFrameRequest;

let bifFrameImgSource: BifFrameImageSource;

// Worker message handler
onmessage = async (event: MessageEvent): Promise<void> => {
  const msg = event.data as WorkerMessage;
  if (msg.type === "GET_FRAME") {
    const imgUrl = await bifFrameImgSource.getImgUrl(msg.timeMillis);
    postMessage({ imgUrl });
  } else if (msg.type === "INIT") {
    try {
      bifFrameImgSource = await BifParser.fromUrl(msg.url);
      postMessage({ success: true });
    } catch (e) {
      postMessage({ success: false, e });
    }
  }
};
