export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
) {
  let timer: number | null = null;

  const throttled = function (this: unknown, ...args: Parameters<T>) {
    if (timer === null) {
      fn.apply(this, args);
      timer = window.setTimeout(() => {
        timer = null;
      }, delay);
    }
  };

  throttled.reset = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
      }, delay);
    }
  };

  return throttled as typeof throttled & { reset: () => void };
}
