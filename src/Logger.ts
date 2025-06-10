// logger.ts
import { eventBus } from "./Events/EventBus.js";
import { Events } from "./Events/Events.js";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";

export interface LoggerConfig {
  level?: LogLevel;
  useColors?: boolean;
  timestampFormat?: "ISO" | "LOCALE";
  prefix?: string;
  includeSourceLocation?: boolean | LogLevel[]; // Enable for specific levels or all
  stackTraceEnabled?: boolean | LogLevel[]; // Enable stack traces for specific levels or all
  maxStackFrames?: number; // Maximum number of stack frames to include
}

interface ErrorWithCaptureStackTrace extends ErrorConstructor {
  captureStackTrace?(error: Error, constructorOpt?: Function): void;
}

export class Logger {
  static readonly levels: Record<LogLevel, number> = {
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    CRITICAL: 5,
  } as const;

  static readonly styles: Record<LogLevel, string> = {
    DEBUG: "color: dodgerblue",
    INFO: "color: green",
    WARN: "color: orange",
    ERROR: "color: red",
    CRITICAL: "color: white; background-color: red; font-weight: bold",
  } as const;

  #currentLevel: number;
  #useColors: boolean;
  #timestampFormat: "ISO" | "LOCALE";
  #prefix: string;
  #includeSourceLocation: boolean | LogLevel[];
  #stackTraceEnabled: boolean | LogLevel[];
  #maxStackFrames: number;
  #frozen: boolean;

  constructor(config: LoggerConfig = {}) {
    const {
      level = "DEBUG",
      useColors = true,
      timestampFormat = "ISO",
      prefix = "",
      includeSourceLocation = ["ERROR", "CRITICAL"],
      stackTraceEnabled = ["CRITICAL"],
      maxStackFrames = 10,
    } = config;

    this.#currentLevel = Logger.levels[level];
    this.#useColors = useColors;
    this.#timestampFormat = timestampFormat;
    this.#prefix = prefix;
    this.#includeSourceLocation = includeSourceLocation;
    this.#stackTraceEnabled = stackTraceEnabled;
    this.#maxStackFrames = maxStackFrames;
    this.#frozen = false;

    eventBus.on(
      Events.FREEZE_LOGGING, 
      () => this.#frozen = !this.#frozen, 
      this
    );
  }

  /**
   * Creates a new logger instance with a specific prefix while inheriting other settings
   */
  createChild = (prefix: string): Logger => {
    return new Logger({
      level: this.getCurrentLevel(),
      useColors: this.#useColors,
      timestampFormat: this.#timestampFormat,
      prefix: this.#prefix ? `${this.#prefix}:${prefix}` : prefix,
      includeSourceLocation: this.#includeSourceLocation,
      stackTraceEnabled: this.#stackTraceEnabled,
      maxStackFrames: this.#maxStackFrames,
    });
  };

  getCurrentLevel = (): LogLevel => {
    return Object.entries(Logger.levels).find(
      ([, value]) => value === this.#currentLevel
    )?.[0] as LogLevel;
  };

  setLevel = (level: LogLevel) => {
    if (!(level in Logger.levels)) {
      throw new Error(`Invalid logging level: ${level}`);
    }
    this.#currentLevel = Logger.levels[level];
  };

  setUseColors = (useColors: boolean) => {
    this.#useColors = useColors;
  };

  #shouldIncludeSourceLocation = (level: LogLevel): boolean => {
    return typeof this.#includeSourceLocation === "boolean"
      ? this.#includeSourceLocation
      : this.#includeSourceLocation.includes(level);
  };

  #shouldIncludeStackTrace = (level: LogLevel): boolean => {
    return typeof this.#stackTraceEnabled === "boolean"
      ? this.#stackTraceEnabled
      : this.#stackTraceEnabled.includes(level);
  };

  #getSourceLocation = (): string => {
    const ErrorConstructor = Error as ErrorWithCaptureStackTrace;
    const err = new Error();

    if (ErrorConstructor.captureStackTrace) {
      ErrorConstructor.captureStackTrace(err, this.#log);
    }

    const stackLines = err.stack?.split("\n") || [];
    // Skip internal frames to get to the actual caller
    const callerLine = stackLines[3] || "";
    return callerLine.trim().replace(/^\s*at\s+/, "");
  };

  #getStackTrace = (): string => {
    const ErrorConstructor = Error as ErrorWithCaptureStackTrace;
    const err = new Error();

    if (ErrorConstructor.captureStackTrace) {
      ErrorConstructor.captureStackTrace(err, this.#log);
    }

    const stackLines = err.stack?.split("\n") || [];
    // Skip the error message and internal frames
    return stackLines
      .slice(3, 3 + this.#maxStackFrames)
      .map((line) => line.trim())
      .join("\n");
  };

  #formatTimestamp = (): string => {
    const date = new Date();
    return this.#timestampFormat === "ISO"
      ? date.toISOString()
      : date.toLocaleString();
  };

  #formatMessage = (
    level: LogLevel,
    message: string
  ): [string, ...(string[])] => {
    const timestamp = this.#formatTimestamp();
    const prefix = this.#prefix ? `[${this.#prefix}] ` : "";
    const styled = this.#useColors;
  
    let baseMsg = `[${timestamp}] ${prefix}[${level}]: ${message}`;
  
    if (this.#shouldIncludeSourceLocation(level)) {
      const sourceLocation = this.#getSourceLocation();
      baseMsg += `\n    at ${sourceLocation}`;
    }
  
    if (this.#shouldIncludeStackTrace(level)) {
      const stackTrace = this.#getStackTrace();
      baseMsg += `\nStack trace:\n${stackTrace}`;
    }
  
    return styled
      ? [`%c${baseMsg}`, Logger.styles[level]]
      : [baseMsg];
  };
  
  #log = (level: LogLevel, message: string, ...args: any[]) => {
    if(this.#frozen) return;

    if (Logger.levels[level] >= this.#currentLevel) {
      const [formattedMessage, ...styles] = this.#formatMessage(level, message);
      const logArgs = styles.length ? [formattedMessage, ...styles, ...args] : [formattedMessage, ...args];
      
      switch (level) {
        case "DEBUG":
          console.debug(...logArgs);
          break;
        case "INFO":
          console.info(...logArgs);
          break;
        case "WARN":
          console.warn(...logArgs);
          break;
        case "ERROR":
        case "CRITICAL":
          console.error(...logArgs);
          break;
      }
    }
  };
  

  debug = (message: string, ...args: any[]) => {
    this.#log("DEBUG", message, ...args);
  };

  info = (message: string, ...args: any[]) => {
    this.#log("INFO", message, ...args);
  };

  warn = (message: string, ...args: any[]) => {
    this.#log("WARN", message, ...args);
  };

  error = (message: string, ...args: any[]) => {
    this.#log("ERROR", message, ...args);
  };

  critical = (message: string, ...args: any[]) => {
    this.#log("CRITICAL", message, ...args);
  };
}

export const logger = new Logger();
