// assertions.ts

/**
 * Configuration for the assertion utility
 */
export class AssertConfig {
  // Default to enabled
  private static enabled = true;

  /**
   * Enable or disable assertions globally
   */
  static setEnabled(enabled: boolean) {
    AssertConfig.enabled = enabled;
  }

  /**
   * Check if assertions are enabled
   */
  static isEnabled(): boolean {
    return AssertConfig.enabled;
  }
}

/**
 * Define the V8 Error interface for TypeScript
 */
interface ErrorWithCaptureStackTrace extends ErrorConstructor {
  captureStackTrace?(error: Error, constructorOpt?: Function): void;
}

/**
 * Custom assertion error that preserves the original stack trace
 */
class AssertionError extends Error {
  constructor(message: string, assertFunction: Function) {
    super(message);
    this.name = "AssertionError";

    // Cast Error to our extended interface
    const ErrorConstructor = Error as ErrorWithCaptureStackTrace;

    if (ErrorConstructor.captureStackTrace) {
      // V8 environments - exclude the assert function from the stack
      ErrorConstructor.captureStackTrace(this, assertFunction);
    } else {
      // Non-V8 environments: manually clean up the stack
      const stack = new Error().stack;
      if (stack) {
        const stackLines = stack.split("\n");
        // Remove lines related to the assertion internals
        const cleanedStack = stackLines.filter((line, index) => {
          if (index === 0) return true; // Keep the error message
          return (
            !line.includes("AssertionError") &&
            !line.includes("Assert.assert") &&
            !line.includes("Assert.assertDefined") &&
            !line.includes("formatMessage")
          );
        });
        this.stack = cleanedStack.join("\n");
      }
    }
  }
}

/**
 * Stack trace parser for better formatting
 */
class StackTraceParser {
  /**
   * Extract the most relevant frame from a stack trace
   */
  static getRelevantFrame(
    stack: string | undefined,
    skipFrames: number = 0
  ): string {
    if (!stack) return "Unknown location";

    const lines = stack.split("\n");
    // Skip error message and specified number of frames
    const relevantLine = lines[1 + skipFrames];

    if (!relevantLine) return "Unknown location";

    // Extract file info from different stack trace formats
    const match = relevantLine.match(
      /(?:at\s+)?(?:.*?\s+)?(?:\()?([^:\s]+:[0-9]+:[0-9]+)/
    );
    if (match) {
      return match[1];
    }

    return relevantLine.trim();
  }

  /**
   * Format a clean stack trace for display
   */
  static formatStackTrace(
    stack: string | undefined,
    maxFrames: number = 5
  ): string {
    if (!stack) return "";

    const lines = stack.split("\n");
    const relevantLines = lines
      .slice(1, maxFrames + 1) // Skip the error message
      .filter((line) => {
        // Filter out internal assertion frames
        return (
          !line.includes("AssertionError") &&
          !line.includes("Assert.") &&
          !line.includes("formatMessage")
        );
      })
      .map((line) => `    ${line.trim()}`);

    return relevantLines.join("\n");
  }
}

/**
 * Custom assertion utility that can be stripped out in production
 */
export class Assert {
  /**
   * Gets detailed caller information including file, line, and column
   */
  private static getCallerLocation(skipFrames: number = 0): string {
    const err = new Error();
    return StackTraceParser.getRelevantFrame(err.stack, skipFrames + 1);
  }

  /**
   * Formats an assertion message with stack trace
   */
  private static formatMessage(
    message: string,
    additionalInfo?: string,
    includeFullStack: boolean = true
  ): string {
    const location = Assert.getCallerLocation(1);
    let formatted = `${message}`;

    if (additionalInfo) {
      formatted += `\n  Details: ${additionalInfo}`;
    }

    formatted += `\n  Location: ${location}`;

    if (includeFullStack) {
      const err = new Error();
      const stackTrace = StackTraceParser.formatStackTrace(err.stack);
      if (stackTrace) {
        formatted += `\n  Stack trace:\n${stackTrace}`;
      }
    }

    return formatted;
  }

  /**
   * Asserts that a condition is true, throws an error if false
   * @param condition - The condition to check
   * @param message - Optional message to display if assertion fails
   */
  static assert(
    condition: any,
    message: string = "Assertion failed"
  ): asserts condition {
    if (AssertConfig.isEnabled() && !condition) {
      const formattedMessage = Assert.formatMessage(
        message,
        `Condition evaluated to: ${String(condition)}`
      );
      throw new AssertionError(formattedMessage, Assert.assert);
    }
  }

  /**
   * Asserts that a value is not null or undefined
   * @param value - The value to check
   * @param message - Optional message to display if assertion fails
   */
  static assertDefined<T>(
    value: T | null | undefined,
    message: string = "Value must be defined"
  ): asserts value is T {
    if (AssertConfig.isEnabled() && (value === null || value === undefined)) {
      const valueType = value === null ? "null" : "undefined";
      const formattedMessage = Assert.formatMessage(
        message,
        `Value was: ${valueType}`
      );
      throw new AssertionError(formattedMessage, Assert.assertDefined);
    }
  }

  /**
   * Asserts that a value is of a specific type
   * @param value - The value to check
   * @param type - The expected type
   * @param message - Optional message
   */
  static assertType<T>(
    value: any,
    type: string,
    message?: string
  ): asserts value is T {
    if (AssertConfig.isEnabled()) {
      const actualType = typeof value;
      if (actualType !== type) {
        const formattedMessage = Assert.formatMessage(
          message || `Type assertion failed`,
          `Expected type: ${type}, Actual type: ${actualType}`
        );
        throw new AssertionError(formattedMessage, Assert.assertType);
      }
    }
  }

  /**
   * Asserts that a value is an instance of a specific class
   * @param value - The value to check
   * @param constructor - The constructor function
   * @param message - Optional message
   */
  static assertInstanceOf<T>(
    value: any,
    constructor: new (...args: any[]) => T,
    message?: string
  ): asserts value is T {
    if (AssertConfig.isEnabled() && !(value instanceof constructor)) {
      const actualType = value?.constructor?.name || typeof value;
      const formattedMessage = Assert.formatMessage(
        message || `Instance assertion failed`,
        `Expected instance of: ${constructor.name}, Actual: ${actualType}`
      );
      throw new AssertionError(formattedMessage, Assert.assertInstanceOf);
    }
  }

  /**
   * Asserts that an array is not empty
   * @param array - The array to check
   * @param message - Optional message
   */
  static assertNotEmpty<T>(
    array: T[] | undefined | null,
    message: string = "Array must not be empty"
  ): asserts array is T[] {
    if (AssertConfig.isEnabled()) {
      if (!array) {
        const formattedMessage = Assert.formatMessage(
          message,
          `Array was: ${array === null ? "null" : "undefined"}`
        );
        throw new AssertionError(formattedMessage, Assert.assertNotEmpty);
      }
      if (array.length === 0) {
        const formattedMessage = Assert.formatMessage(
          message,
          `Array length: 0`
        );
        throw new AssertionError(formattedMessage, Assert.assertNotEmpty);
      }
    }
  }

  /**
   * Asserts that a number is within a range
   * @param value - The value to check
   * @param min - Minimum value (inclusive)
   * @param max - Maximum value (inclusive)
   * @param message - Optional message
   */
  static assertInRange(
    value: number,
    min: number,
    max: number,
    message?: string
  ): void {
    if (AssertConfig.isEnabled() && (value < min || value > max)) {
      const formattedMessage = Assert.formatMessage(
        message || `Value out of range`,
        `Expected: [${min}, ${max}], Actual: ${value}`
      );
      throw new AssertionError(formattedMessage, Assert.assertInRange);
    }
  }

  /**
   * Always throws an error - useful for unreachable code paths
   * @param message - Error message
   */
  static fail(message: string = "Assertion failed"): never {
    const formattedMessage = Assert.formatMessage(message);
    throw new AssertionError(formattedMessage, Assert.fail);
  }
}
