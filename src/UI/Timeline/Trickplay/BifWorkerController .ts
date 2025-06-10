import { logger } from "../../../Logger.js";

type WorkerInitMessage = {
  type: "INIT";
  url: string;
  options?: BifOptions;
};

type WorkerFrameRequest = {
  type: "GET_FRAME";
  timeMillis: number;
};

type WorkerResponse = {
  type: "FRAME";
  imgUrl: string;
  frameIndex: number;
  error?: string;
};

export class BifWorkerController {
  #worker: Worker;
  #initPromise: Promise<void>;
  #initialized = false;
  #maxRetries = 3;
  #initialRetryDelay = 1000; // 1 second initial delay

  constructor(workerUrl: string, bifUrl: string, options?: BifOptions & { maxRetries?: number; initialRetryDelay?: number }) {
    this.#worker = new Worker(workerUrl);
    
    // Allow configuration of retry parameters
    if (options?.maxRetries !== undefined) this.#maxRetries = options.maxRetries;
    if (options?.initialRetryDelay !== undefined) this.#initialRetryDelay = options.initialRetryDelay;
    
    this.#initPromise = this.#initialize(bifUrl, options);
  }

  #initialize = async (bifUrl: string, options?: BifOptions): Promise<void> => {
    let attempts = 0;
    
    while (attempts <= this.#maxRetries) {
      try {
        await this.#attemptInitialize(bifUrl, options);
        return; // Success, exit the function
      } catch (error: unknown) {
        attempts++;
        
        if (attempts > this.#maxRetries) {
          // We've exhausted all retries, propagate the error
          const errorMessage = error instanceof Error 
            ? error.message 
            : String(error);
            
          throw new Error(`BIF initialization failed after ${this.#maxRetries} attempts: ${errorMessage}`);
        }
        
        // Calculate backoff with exponential increase 
        const backoffMs = Math.min(
          30000, // Cap at 30 seconds
          this.#initialRetryDelay * Math.pow(2, attempts - 1)
        );
        
        const errorMessage = error instanceof Error 
          ? error.message 
          : String(error);
          
        logger.warn(`BIF initialization attempt ${attempts} failed, retrying in ${Math.round(backoffMs)}ms: ${errorMessage}`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  };

  #attemptInitialize = async (bifUrl: string, options?: BifOptions): Promise<void> => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("BIF initialization timed out"));
      }, 10000); // 10s timeout
      
      const handleInit = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.error) {
          reject(new Error(e.data.error));
          return;
        }
        
        this.#initialized = true;
        clearTimeout(timeoutId);
        this.#worker.removeEventListener("message", handleInit);
        resolve();
      };
      
      this.#worker.addEventListener("message", handleInit);
      this.#worker.postMessage({
        type: "INIT",
        url: bifUrl,
        options,
      } as WorkerInitMessage);
    });
  };

  async getFrame(timeMillis: number): Promise<string> {
    if (!this.#initialized) {
      await this.#initPromise;
    }
    
    return new Promise((resolve, reject) => {
      const handleMessage = (e: MessageEvent<WorkerResponse>) => {
        this.#worker.removeEventListener("message", handleMessage);
        if (e.data.error) {
          reject(new Error(e.data.error));
          return;
        }
        resolve(e.data.imgUrl);
      };
      
      this.#worker.addEventListener("message", handleMessage);
      this.#worker.postMessage({
        type: "GET_FRAME",
        timeMillis,
      } as WorkerFrameRequest);
    });
  }

  destroy(): void {
    this.#worker.terminate();
  }
}