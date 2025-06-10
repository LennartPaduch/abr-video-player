import { SegmentReference } from "../Dash/Segment/SegmentReference";
import {
  AbrStrategyType,
  AudioRepresentation,
  FragmentPayload,
  MediaType,
  VideoRepresentation,
} from "../Types";

const EVENT_PRIORITY_LOW = 0;
const EVENT_PRIORITY_HIGH = 5000;

export interface Payload {
  type?: string;
  mediaType?: MediaType;
  streamId?: number;
  videoRepresentation?: VideoRepresentation;
  audioRepresentation?: AudioRepresentation;
  representations?: {
    videoRepresentations: VideoRepresentation[];
    audioRepresentations: AudioRepresentation[];
  };
  bufferLevel?: number;
  seekTo?: number;
  newDuration?: number;
  mediaSource?: MediaSource;
  speed?: number;
  switchReason?: AbrStrategyType | "Start" | "ChosenByUser";
  error?: Error;
  // segmentRef?: SegmentReference;
  newVolume?: number;
  segmentRef?: SegmentReference;
  isReplacement?: boolean;
  fragmentLoadResult?: FragmentPayload;
  newBufferTarget?: number;
  targetLevel?: number;
}

interface Filters {
  mediaType?: MediaType;
  streamId?: number;
  mode?: any;
}

interface Options {
  priority?: number;
}

interface Handler {
  callback: Function;
  scope: any;
  executeOnce?: boolean;
  priority: number;
  streamId?: number;
  mediaType?: MediaType;
  mode?: any;
}

export class EventBus {
  #handlers: { [key: string]: (Handler | null)[] } = {};

  on = (
    type: string,
    listener: Function,
    scope: any,
    options: Options = {}
  ): void => {
    this.#commonOn(type, listener, scope, options);
  };

  once = (
    type: string,
    listener: Function,
    scope: any,
    options: Options = {}
  ): void => {
    this.#commonOn(type, listener, scope, options, true);
  };

  #commonOn = (
    type: string,
    listener: Function,
    scope: any,
    options: Options = {},
    executeOnce = false
  ): void => {
    if (!type) {
      throw new Error("event type cannot be null or undefined");
    }
    if (!listener || typeof listener !== "function") {
      throw new Error("listener must be a function: " + listener);
    }

    let priority = options?.priority || EVENT_PRIORITY_LOW;

    // Check if handler was already added
    if (this.#getHandlerIdx(type, listener, scope) >= 0) {
      return;
    }

    const handler: Handler = {
      callback: listener,
      scope,
      executeOnce,
      priority,
    };

    this.#handlers[type] = this.#handlers[type] || [];

    const inserted = this.#handlers[type].some((item, idx) => {
      if (item && priority > item.priority) {
        this.#handlers[type].splice(idx, 0, handler);
        return true;
      }
    });

    if (!inserted) {
      this.#handlers[type].push(handler);
    }
  };

  #getHandlerIdx = (type: string, listener: Function, scope: any): number => {
    let idx = -1;

    if (!this.#handlers[type]) {
      return idx;
    }

    this.#handlers[type].some((item, index) => {
      if (
        item &&
        item.callback === listener &&
        (!scope || scope === item.scope)
      ) {
        idx = index;
        return true;
      }
    });

    return idx;
  };

  trigger = (
    type: string,
    payload: Payload = {},
    filters: Filters = {}
  ): void => {
    if (!type || !this.#handlers[type]) {
      return;
    }

    if (payload.hasOwnProperty("type")) {
      throw new Error("'type' is a reserved word for event dispatching");
    }

    payload.type = type;

    if (filters.streamId) {
      payload.streamId = filters.streamId;
    }
    if (filters.mediaType) {
      payload.mediaType = filters.mediaType;
    }

    const handlersToRemove: Handler[] = [];
    this.#handlers[type]
      .filter((handler) => {
        if (!handler) {
          return false;
        }
        if (
          filters.streamId &&
          handler.streamId &&
          handler.streamId !== filters.streamId
        ) {
          return false;
        }
        if (
          filters.mediaType &&
          handler.mediaType &&
          handler.mediaType !== filters.mediaType
        ) {
          return false;
        }
        if (
          (filters.mode && handler.mode && handler.mode !== filters.mode) ||
          (!handler.mode &&
            filters.mode &&
            filters.mode === "eventModeOnReceive")
        ) {
          return false;
        }
        return true;
      })
      .forEach((handler) => {
        handler && handler.callback.call(handler.scope, payload);
        if (handler?.executeOnce) {
          handlersToRemove.push(handler);
        }
      });

    handlersToRemove.forEach((handler) => {
      this.off(type, handler.callback, handler.scope);
    });
  };

  off = (type: string, listener: Function, scope: any): void => {
    if (!type || !listener || !this.#handlers[type]) {
      return;
    }
    const idx = this.#getHandlerIdx(type, listener, scope);
    if (idx < 0) {
      return;
    }
    this.#handlers[type][idx] = null;
  };

  reset = (): void => {
    this.#handlers = {};
  };
}

export const eventBus = new EventBus();
