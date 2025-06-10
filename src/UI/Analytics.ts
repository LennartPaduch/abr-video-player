import {
  bufferController,
  audioBufferController,
} from "../Controller/BufferController.js";
import { droppedFramesHistory } from "../DroppedFramesHistory.js";
import { playbackController } from "../Controller/PlaybackController.js";
import { Events } from "../Events/Events.js";
import { eventBus } from "../Events/EventBus.js";
import { Assert } from "../utils/assertion.js";
import type { Payload } from "../Events/EventBus.js";
import type { VideoRepresentation } from "../Types.js";
import { bandwidthEstimator } from "../BandwidthEstimator.js";

type DataKey =
  | "bufferSizes"
  | "bandwidth"
  | "droppedFrames"
  | "resolution"
  | "bitrate";

type BufferData = {
  video: number[];
  audio: number[];
};

/**
 * Analytics dashboard for visualizing video player performance metrics.
 * Displays real-time graphs for buffer levels, bandwidth, bitrate, resolution, and dropped frames.
 */
export class Analytics {
  // UI elements
  #container = document.createElement("div");
  #controlsContainer = document.createElement("div");
  #freezeGraphsBtn = document.createElement("button");
  #freezeLogsBtn = document.createElement("button");
  #toggleButtons: Record<DataKey, HTMLInputElement> = {} as any;

  // Canvas elements
  #canvasContainer = document.createElement("div");
  #graphContainers: Record<DataKey, HTMLDivElement> = {} as any;
  #graphCanvases: Record<DataKey, HTMLCanvasElement> = {} as any;
  #graphContexts: Record<DataKey, CanvasRenderingContext2D> = {} as any;

  // Tracking keys for metrics to visualize
  #dataKeys: readonly DataKey[] = [
    "bufferSizes",
    "bandwidth",
    "bitrate",
    "resolution",
    "droppedFrames",
  ];
  #data: {
    bufferSizes: BufferData;
    bandwidth: number[];
    droppedFrames: number[];
    resolution: number[];
    bitrate: number[];
  } = {
    bufferSizes: {
      video: [],
      audio: [],
    },
    bandwidth: [],
    droppedFrames: [],
    resolution: [],
    bitrate: [],
  };

  // Visual styling for different metrics
  #colors: { [key in DataKey]: string | { video: string; audio: string } } = {
    bufferSizes: {
      video: "rgba(75, 192, 192, 1)",
      audio: "rgba(255, 159, 64, 1)",
    },
    bandwidth: "rgba(255, 99, 132, 1)",
    droppedFrames: "rgba(255, 206, 86, 1)",
    resolution: "rgba(153, 102, 255, 1)",
    bitrate: "rgba(54, 162, 235, 1)",
  };
  #labels: { [key in DataKey]: string } = {
    bufferSizes: "Buffer Level (s)",
    bandwidth: "Estimated Bandwidth (Mbps)",
    droppedFrames: "Dropped Frames (%)",
    resolution: "Resolution (p)",
    bitrate: "Video Bitrate (Mbps)",
  };

  // Track available representation options from the ABR manifest
  #availableResolutions: number[] = [];
  #availableBitrates: number[] = [];

  // Maximum values for graph Y-axis scaling, adjusted dynamically
  #dynamicMaxValues: { [key in DataKey]: number } = {
    bufferSizes: 10,
    bandwidth: 10,
    droppedFrames: 5,
    resolution: 1080,
    bitrate: 5,
  };

  #maxDataPoints = 60; // Stores 1 minute of data (1 sample per second)
  #currentDataPoints = 0;
  #isFrozen = {
    graphs: false,
    logs: false,
  };
  #visibleGraphs: Set<DataKey> = new Set();

  constructor() {
    this.#container.style.width = "100%";
    this.#container.style.maxWidth = "1200px";
    this.#container.style.margin = "0 auto";
    this.#container.style.fontFamily = "Arial, sans-serif";

    this.#registerEventListeners();
    this.#setupControls();
    this.#setupGraphs();

    document.body.appendChild(this.#container);
  }

  /**
   * Register event listeners for video player events
   */
  #registerEventListeners = (): void => {
    eventBus.on(
      Events.REPRESENTATIONS_CHANGED,
      this.#onRepresentationsChanged,
      this
    );

    eventBus.on(
      Events.VIDEO_BITRATE_CHANGED,
      this.#onVideoBitRateChanged,
      this
    );
  };

  #onVideoBitRateChanged = (payload: Payload): void => {
    if (payload.switchReason === "Start" && payload.videoRepresentation) {
      this.#startCollection();
    }
  };

  /**
   * Handler for representation change events
   * Updates available bitrates and resolutions for graph scaling
   */
  #onRepresentationsChanged = (payload: Payload): void => {
    Assert.assert(
      payload.representations?.videoRepresentations.length,
      "No representations in payload!"
    );

    this.#setAvailableStreams(payload.representations.videoRepresentations);
  };

  /**
   * Extract available resolutions and bitrates from representation list
   * Updates graph scaling to match available options
   */
  #setAvailableStreams = (representations: VideoRepresentation[]): void => {
    this.#availableResolutions = [];
    this.#availableBitrates = [];

    // Extract unique values and sort numerically
    this.#availableResolutions = [
      ...new Set(representations.map((rep) => rep.height)),
    ].sort((a, b) => a - b);

    this.#availableBitrates = [
      ...new Set(
        representations.map((rep) => rep.bitrate / 1000000) // Convert to Mbps
      ),
    ].sort((a, b) => a - b);

    // Update max values to match highest available options
    if (this.#availableResolutions.length > 0) {
      const maxResolution = Math.max(...this.#availableResolutions);
      this.#dynamicMaxValues.resolution = maxResolution;
    }

    if (this.#availableBitrates.length > 0) {
      const maxBitrate = Math.max(...this.#availableBitrates);
      this.#dynamicMaxValues.bitrate = maxBitrate;
    }

    this.#updateGraphs();
  };

  destroy = (): void => {
    eventBus.off(
      Events.REPRESENTATIONS_CHANGED,
      this.#onRepresentationsChanged,
      this
    );

    if (this.#container.parentNode) {
      this.#container.parentNode.removeChild(this.#container);
    }
  };

  /**
   * Set up the controls UI for toggling graphs and freezing data
   */
  #setupControls = (): void => {
    this.#controlsContainer.style.background = "#f5f5f5";
    this.#controlsContainer.style.padding = "10px";
    this.#controlsContainer.style.borderRadius = "5px";
    this.#controlsContainer.style.marginBottom = "10px";
    this.#controlsContainer.style.display = "flex";
    this.#controlsContainer.style.justifyContent = "space-between";
    this.#controlsContainer.style.alignItems = "center";

    const title = document.createElement("h2");
    title.textContent = "Video Player Analytics";
    title.style.margin = "0";
    title.style.fontSize = "18px";

    const toggleContainer = document.createElement("div");

    // Create toggle buttons for each metric with color indicators
    this.#dataKeys.forEach((key) => {
      const label = document.createElement("label");
      label.style.marginRight = "15px";
      label.style.display = "inline-flex";
      label.style.alignItems = "center";
      label.style.cursor = "pointer";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true; // All graphs visible by default
      checkbox.style.marginRight = "5px";

      this.#visibleGraphs.add(key);
      this.#toggleButtons[key] = checkbox;

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.#visibleGraphs.add(key);
          if (this.#graphContainers[key]) {
            this.#graphContainers[key].style.display = "block";
          }
        } else {
          this.#visibleGraphs.delete(key);
          if (this.#graphContainers[key]) {
            this.#graphContainers[key].style.display = "none";
          }
        }
      });

      // Special handling for buffer sizes - show both video and audio colors
      if (key === "bufferSizes") {
        const videoColorIndicator = document.createElement("span");
        videoColorIndicator.style.display = "inline-block";
        videoColorIndicator.style.width = "12px";
        videoColorIndicator.style.height = "12px";
        videoColorIndicator.style.backgroundColor = (
          this.#colors.bufferSizes as { video: string; audio: string }
        ).video;
        videoColorIndicator.style.marginRight = "3px";
        videoColorIndicator.style.borderRadius = "2px";

        const audioColorIndicator = document.createElement("span");
        audioColorIndicator.style.display = "inline-block";
        audioColorIndicator.style.width = "12px";
        audioColorIndicator.style.height = "12px";
        audioColorIndicator.style.backgroundColor = (
          this.#colors.bufferSizes as { video: string; audio: string }
        ).audio;
        audioColorIndicator.style.marginRight = "5px";
        audioColorIndicator.style.borderRadius = "2px";

        label.appendChild(checkbox);
        label.appendChild(videoColorIndicator);
        label.appendChild(audioColorIndicator);
        label.appendChild(document.createTextNode(this.#labels[key]));
      } else {
        const colorIndicator = document.createElement("span");
        colorIndicator.style.display = "inline-block";
        colorIndicator.style.width = "12px";
        colorIndicator.style.height = "12px";
        colorIndicator.style.backgroundColor = this.#colors[key] as string;
        colorIndicator.style.marginRight = "5px";
        colorIndicator.style.borderRadius = "2px";

        label.appendChild(checkbox);
        label.appendChild(colorIndicator);
        label.appendChild(document.createTextNode(this.#labels[key]));
      }

      toggleContainer.appendChild(label);
    });

    // Configure freeze buttons for pausing data collection
    this.#freezeGraphsBtn.textContent = "Freeze Graphs";
    this.#freezeGraphsBtn.style.padding = "5px 10px";
    this.#freezeGraphsBtn.style.backgroundColor = "#fff";
    this.#freezeGraphsBtn.style.border = "1px solid #ddd";
    this.#freezeGraphsBtn.style.borderRadius = "3px";
    this.#freezeGraphsBtn.style.cursor = "pointer";

    this.#freezeGraphsBtn.addEventListener("click", () => {
      this.#isFrozen.graphs = !this.#isFrozen.graphs;
      this.#freezeGraphsBtn.textContent = this.#isFrozen.graphs
        ? "Resume Graphs"
        : "Freeze Graphs";
      this.#freezeGraphsBtn.style.backgroundColor = this.#isFrozen.graphs
        ? "#f0f0f0"
        : "#fff";
    });

    this.#freezeLogsBtn.textContent = "Freeze Logger";
    this.#freezeLogsBtn.style.padding = "5px 10px";
    this.#freezeLogsBtn.style.backgroundColor = "#fff";
    this.#freezeLogsBtn.style.border = "1px solid #ddd";
    this.#freezeLogsBtn.style.borderRadius = "3px";
    this.#freezeLogsBtn.style.cursor = "pointer";

    this.#freezeLogsBtn.addEventListener("click", () => {
      this.#isFrozen.logs = !this.#isFrozen.logs;
      this.#freezeLogsBtn.textContent = this.#isFrozen.logs
        ? "Resume Logger"
        : "Freeze Logger";
      this.#freezeLogsBtn.style.backgroundColor = this.#isFrozen.logs
        ? "#f0f0f0"
        : "#fff";
      eventBus.trigger(Events.FREEZE_LOGGING);
    });

    this.#controlsContainer.appendChild(title);
    this.#controlsContainer.appendChild(toggleContainer);
    this.#controlsContainer.appendChild(this.#freezeGraphsBtn);
    this.#controlsContainer.appendChild(this.#freezeLogsBtn);

    this.#container.appendChild(this.#controlsContainer);
  };

  /**
   * Create graph canvases for each metric
   */
  #setupGraphs = (): void => {
    this.#canvasContainer.style.display = "flex";
    this.#canvasContainer.style.flexDirection = "column";
    this.#canvasContainer.style.gap = "15px";

    this.#dataKeys.forEach((key) => {
      const graphContainer = document.createElement("div");
      graphContainer.style.position = "relative";
      graphContainer.style.height = "250px";
      graphContainer.style.border = "1px solid #ddd";
      graphContainer.style.borderRadius = "3px";
      graphContainer.style.background = "#f9f9f9";

      this.#graphContainers[key] = graphContainer;

      const canvas = document.createElement("canvas");
      canvas.width = 1000;
      canvas.height = 250;
      canvas.style.width = "100%";
      canvas.style.height = "100%";

      const ctx = canvas.getContext("2d")!;

      this.#graphCanvases[key] = canvas;
      this.#graphContexts[key] = ctx;

      // Create label overlay in top left corner
      const labelOverlay = document.createElement("div");
      labelOverlay.style.position = "absolute";
      labelOverlay.style.top = "5px";
      labelOverlay.style.left = "10px";
      labelOverlay.style.padding = "2px 5px";
      labelOverlay.style.background = "rgba(255, 255, 255, 0.7)";
      labelOverlay.style.borderRadius = "3px";
      labelOverlay.style.fontSize = "12px";
      labelOverlay.style.color = "#333";
      labelOverlay.textContent = this.#labels[key];

      // Create value overlay in top right corner
      const valueOverlay = document.createElement("div");
      valueOverlay.style.position = "absolute";
      valueOverlay.style.top = "5px";
      valueOverlay.style.right = "10px";
      valueOverlay.style.padding = "2px 5px";
      valueOverlay.style.background = "rgba(255, 255, 255, 0.7)";
      valueOverlay.style.borderRadius = "3px";
      valueOverlay.style.fontSize = "12px";
      valueOverlay.style.fontWeight = "bold";
      valueOverlay.style.color = "#333";

      // For buffer sizes, show both video and audio values
      if (key === "bufferSizes") {
        valueOverlay.innerHTML =
          '<span style="color: rgba(75, 192, 192, 1)">Video: 0s</span> | <span style="color: rgba(255, 159, 64, 1)">Audio: 0s</span>';
      } else {
        valueOverlay.textContent = "Current: 0";
      }

      valueOverlay.dataset.key = key;

      graphContainer.appendChild(canvas);
      graphContainer.appendChild(labelOverlay);
      graphContainer.appendChild(valueOverlay);

      this.#canvasContainer.appendChild(graphContainer);
    });

    this.#container.appendChild(this.#canvasContainer);
  };

  /**
   * Collect data every second and update graphs
   */
  #startCollection = (): void => {
    setTimeout(() => {
      if (!this.#isFrozen.graphs) {
        // Sample current player metrics
        const newVideoBufferLevel = bufferController.getBufferLevel();
        const newAudioBufferLevel = audioBufferController.getBufferLevel();
        const newBandwidth = parseFloat(
          (bandwidthEstimator.getBandwidthEstimate() / 1e6).toFixed(3)
        );
        const newDropRate = droppedFramesHistory.getDropRate(0, "0");
        const currentRepresentation =
          playbackController.getCurrentVideoRepresentation();
        const newResolution = currentRepresentation.height;
        const newBitrate = parseFloat(
          (currentRepresentation.bitrate / 1e6).toFixed(3)
        ); // convert to Mbps

        // Add data points
        this.#data.bufferSizes.video.push(newVideoBufferLevel);
        this.#data.bufferSizes.audio.push(newAudioBufferLevel);
        (this.#data.bandwidth as number[]).push(newBandwidth);
        (this.#data.resolution as number[]).push(newResolution);
        (this.#data.bitrate as number[]).push(newBitrate);
        (this.#data.droppedFrames as number[]).push(newDropRate);

        if (this.#currentDataPoints < this.#maxDataPoints) {
          this.#currentDataPoints++;
        }

        this.#updateDynamicMaxValues();

        // Maintain sliding window of data points
        for (const key of this.#dataKeys) {
          if (key === "bufferSizes") {
            if (this.#data.bufferSizes.video.length > this.#maxDataPoints) {
              this.#data.bufferSizes.video.shift();
            }
            if (this.#data.bufferSizes.audio.length > this.#maxDataPoints) {
              this.#data.bufferSizes.audio.shift();
            }
          } else {
            const dataArray = this.#data[key] as number[];
            if (dataArray.length > this.#maxDataPoints) {
              dataArray.shift();
            }
          }
        }

        this.#updateGraphs();
      }

      this.#startCollection();
    }, 1000);
  };

  /**
   * Update maximum Y-axis values based on collected data
   * Adds 20% headroom to prevent frequent rescaling
   */
  #updateDynamicMaxValues = (): void => {
    for (const key of this.#dataKeys) {
      if (key === "bufferSizes") {
        if (
          this.#data.bufferSizes.video.length > 0 ||
          this.#data.bufferSizes.audio.length > 0
        ) {
          const videoMax =
            this.#data.bufferSizes.video.length > 0
              ? Math.max(...this.#data.bufferSizes.video)
              : 0;
          const audioMax =
            this.#data.bufferSizes.audio.length > 0
              ? Math.max(...this.#data.bufferSizes.audio)
              : 0;
          const currentMax = Math.max(videoMax, audioMax);

          if (currentMax > this.#dynamicMaxValues[key]) {
            this.#dynamicMaxValues[key] = currentMax * 1.2;
          }
        }
      } else {
        const dataArray = this.#data[key] as number[];
        if (dataArray.length > 0) {
          const currentMax = Math.max(...dataArray);

          // Resolution and bitrate use fixed scales from available representations
          // Other metrics scale dynamically based on observed values
          if (
            key !== "resolution" &&
            key !== "bitrate" &&
            currentMax > this.#dynamicMaxValues[key]
          ) {
            this.#dynamicMaxValues[key] = currentMax * 1.2;
          }
        }
      }
    }
  };

  /**
   * Update all visible graphs and their current value displays
   */
  #updateGraphs = (): void => {
    this.#visibleGraphs.forEach((key) => {
      this.#drawGraph(key);

      const valueElement = this.#canvasContainer.querySelector(
        `div[data-key="${key}"]`
      );
      if (valueElement) {
        if (key === "bufferSizes") {
          if (
            this.#data.bufferSizes.video.length > 0 ||
            this.#data.bufferSizes.audio.length > 0
          ) {
            const currentVideoValue =
              this.#data.bufferSizes.video.length > 0
                ? this.#data.bufferSizes.video[
                    this.#data.bufferSizes.video.length - 1
                  ]
                : 0;
            const currentAudioValue =
              this.#data.bufferSizes.audio.length > 0
                ? this.#data.bufferSizes.audio[
                    this.#data.bufferSizes.audio.length - 1
                  ]
                : 0;

            valueElement.innerHTML = `<span style="color: rgba(75, 192, 192, 1)">Video: ${currentVideoValue.toFixed(
              2
            )}s</span> | <span style="color: rgba(255, 159, 64, 1)">Audio: ${currentAudioValue.toFixed(
              2
            )}s</span>`;
          }
        } else {
          const dataArray = this.#data[key] as number[];
          if (dataArray.length > 0) {
            const currentValue = dataArray[dataArray.length - 1];
            let valueText = "";

            switch (key) {
              case "bandwidth":
              case "bitrate":
                valueText = `${currentValue.toFixed(2)} Mbps`;
                break;
              case "resolution":
                valueText = `${currentValue}p`;
                break;
              case "droppedFrames":
                valueText = `${currentValue.toFixed(1)}%`;
                break;
              default:
                valueText = `${currentValue.toFixed(2)}s`;
            }

            valueElement.textContent = `Current: ${valueText}`;
          }
        }
      }
    });
  };

  /**
   * Draw a single graph for the specified metric
   */
  #drawGraph = (key: DataKey): void => {
    const ctx = this.#graphContexts[key];
    const canvas = this.#graphCanvases[key];

    if (!ctx) return;

    // Special handling for buffer sizes
    if (key === "bufferSizes") {
      if (
        this.#data.bufferSizes.video.length <= 1 &&
        this.#data.bufferSizes.audio.length <= 1
      )
        return;
    } else {
      const dataArray = this.#data[key] as number[];
      if (dataArray.length <= 1) return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const padding = { left: 65, right: 20, top: 35, bottom: 25 };
    const graphWidth = canvas.width - padding.left - padding.right;
    const graphHeight = canvas.height - padding.top - padding.bottom;

    this.#drawGridAndAxes(ctx, key, padding, graphWidth, graphHeight);

    if (key === "bufferSizes") {
      this.#drawDataLine(
        ctx,
        key,
        this.#data.bufferSizes,
        padding,
        graphWidth,
        graphHeight
      );
    } else {
      this.#drawDataLine(
        ctx,
        key,
        this.#data[key] as number[],
        padding,
        graphWidth,
        graphHeight
      );
    }
  };

  /**
   * Draw grid lines, axes, and labels for a graph
   * Uses different approaches for continuous vs. discrete values
   */
  #drawGridAndAxes = (
    ctx: CanvasRenderingContext2D,
    key: DataKey,
    padding: { left: number; right: number; top: number; bottom: number },
    graphWidth: number,
    graphHeight: number
  ): void => {
    const maxValue = this.#dynamicMaxValues[key];

    // Add alternating background stripes for discrete values (resolution, bitrate)
    if (
      (key === "resolution" || key === "bitrate") &&
      ((key === "resolution" && this.#availableResolutions.length > 0) ||
        (key === "bitrate" && this.#availableBitrates.length > 0))
    ) {
      ctx.fillStyle = "#f5f5f5";

      const sortedValues =
        key === "resolution"
          ? [...this.#availableResolutions].sort((a, b) => a - b)
          : [...this.#availableBitrates].sort((a, b) => a - b);

      const minValue = Math.min(...sortedValues);
      const logMin = Math.log(minValue || 1); // Prevent log(0)
      const logMax = Math.log(Math.max(...sortedValues));

      for (let i = 0; i < sortedValues.length - 1; i += 2) {
        if (i + 1 < sortedValues.length) {
          const value1 = sortedValues[i];
          const value2 = sortedValues[i + 1];

          const logValue1 = Math.log(value1 || 1); // Prevent log(0)
          const logValue2 = Math.log(value2);

          const normalized1 = (logValue1 - logMin) / (logMax - logMin);
          const normalized2 = (logValue2 - logMin) / (logMax - logMin);

          const y1 = padding.top + graphHeight - normalized1 * graphHeight;
          const y2 = padding.top + graphHeight - normalized2 * graphHeight;

          ctx.fillRect(padding.left, y1, graphWidth, y2 - y1);
        }
      }
    }

    // Special handling for discrete values (resolution, bitrate)
    if (key === "resolution" && this.#availableResolutions.length > 0) {
      this.#drawDiscreteAxis(
        ctx,
        this.#availableResolutions,
        padding,
        graphWidth,
        graphHeight,
        "p"
      );
    } else if (key === "bitrate" && this.#availableBitrates.length > 0) {
      this.#drawDiscreteAxis(
        ctx,
        this.#availableBitrates,
        padding,
        graphWidth,
        graphHeight,
        " Mbps"
      );
    }
    // Standard continuous axis for other metrics
    else {
      // Draw horizontal grid lines and y-axis labels
      ctx.beginPath();
      ctx.strokeStyle = "#ddd";
      ctx.fillStyle = "#666";
      ctx.textAlign = "right";
      ctx.font = "10px Arial";

      // Draw 5 horizontal lines with labels
      for (let i = 0; i <= 5; i++) {
        const y = padding.top + (i / 5) * graphHeight;
        const value = maxValue - (i / 5) * maxValue;

        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + graphWidth, y);

        let valueText = "";
        switch (key) {
          case "bandwidth":
            valueText = `${value.toFixed(2)} Mbps`;
            break;
          case "droppedFrames":
            valueText = `${value.toFixed(1)}%`;
            break;
          default:
            valueText = `${value.toFixed(2)}s`;
        }

        // Add background behind text for better readability
        const textWidth = ctx.measureText(valueText).width;
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
        // Add more padding to ensure text fits
        ctx.fillRect(padding.left - textWidth - 12, y - 7, textWidth + 10, 14);

        ctx.fillStyle = "#666";
        ctx.fillText(valueText, padding.left - 5, y + 3);
      }
      ctx.stroke();
    }

    // Draw vertical grid lines and x-axis labels (time)
    ctx.beginPath();
    ctx.textAlign = "center";
    ctx.strokeStyle = "#ddd";

    const timeRange = this.#currentDataPoints;
    for (let i = 0; i <= 10; i++) {
      const x = padding.left + (i / 10) * graphWidth;
      // Calculate time value based on actual data points
      const timeValue = -timeRange + (i / 10) * timeRange;

      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + graphHeight);

      if (i % 2 === 0) {
        // Draw every other label to avoid crowding
        ctx.fillText(
          `${Math.round(timeValue)}s`,
          x,
          padding.top + graphHeight + 15
        );
      }
    }
    ctx.stroke();

    // Draw axes
    ctx.beginPath();
    ctx.strokeStyle = "#999";
    ctx.lineWidth = 1;

    // Y-axis
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + graphHeight);

    // X-axis
    ctx.moveTo(padding.left, padding.top + graphHeight);
    ctx.lineTo(padding.left + graphWidth, padding.top + graphHeight);

    ctx.stroke();
    ctx.lineWidth = 1;
  };

  /**
   * Draw Y-axis with logarithmic scale for discrete values
   * Used for resolution and bitrate which have pre-defined levels
   */
  #drawDiscreteAxis = (
    ctx: CanvasRenderingContext2D,
    values: number[],
    padding: { left: number; right: number; top: number; bottom: number },
    graphWidth: number,
    graphHeight: number,
    unit: string
  ): void => {
    if (values.length === 0) return;

    // Get min and max values - ensure min value is at least 0.1 for log scale
    const maxValue = Math.max(...values);
    const minValue = Math.max(Math.min(...values), 0.1);

    // Calculate logs for scaling
    const logMin = Math.log(minValue);
    const logMax = Math.log(maxValue);

    ctx.beginPath();
    ctx.strokeStyle = "#ddd";
    ctx.textAlign = "right";
    ctx.font = "10px Arial";

    // Special case: handle 0 bitrate during initialization
    if (
      unit === " Mbps" &&
      this.#data.bitrate.length > 0 &&
      (this.#data.bitrate as number[])[this.#data.bitrate.length - 1] === 0
    ) {
      // Draw a label for 0 at the bottom
      const y = padding.top + graphHeight;

      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + graphWidth, y);

      const labelText = `0.00${unit}`;
      const textWidth = ctx.measureText(labelText).width;
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.fillRect(padding.left - textWidth - 10, y - 7, textWidth + 8, 14);

      ctx.fillStyle = "#666";
      ctx.fillText(labelText, padding.left - 5, y + 3);
    }

    // Draw a horizontal line for each discrete value
    values.forEach((value) => {
      // Skip 0 values for log scale
      if (value <= 0) return;

      // Calculate position using log scale
      const logValue = Math.log(value);

      // Normalize to 0-1 range using log scale
      const normalizedValue = (logValue - logMin) / (logMax - logMin);
      const y = padding.top + graphHeight - normalizedValue * graphHeight;

      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + graphWidth, y);

      // Format the value with proper decimal places based on magnitude
      let formattedValue = "";
      if (unit === " Mbps") {
        formattedValue = value.toFixed(2) + unit;
      } else {
        // For resolution, show as integer
        formattedValue = Math.round(value) + unit;
      }

      // Add background behind text for better readability
      const textWidth = ctx.measureText(formattedValue).width;
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      // Add more padding to ensure text fits
      ctx.fillRect(padding.left - textWidth - 12, y - 7, textWidth + 10, 14);

      // Label the line with the discrete value
      ctx.fillStyle = "#666";
      ctx.fillText(formattedValue, padding.left - 5, y + 3);
    });

    ctx.stroke();
  };

  /**
   * Draw the data line and fill for a specific metric
   * Uses different visualization approaches for continuous vs. discrete metrics
   */
  #drawDataLine = (
    ctx: CanvasRenderingContext2D,
    key: DataKey,
    data: BufferData | number[],
    padding: { left: number; right: number; top: number; bottom: number },
    graphWidth: number,
    graphHeight: number
  ): void => {
    // Handle buffer sizes differently since it has two lines
    if (key === "bufferSizes") {
      const bufferData = data as BufferData;

      // Draw video buffer line
      if (bufferData.video.length > 1) {
        this.#drawSingleDataLine(
          ctx,
          key,
          bufferData.video,
          padding,
          graphWidth,
          graphHeight,
          (this.#colors.bufferSizes as { video: string; audio: string }).video,
          "video"
        );
      }

      // Draw audio buffer line
      if (bufferData.audio.length > 1) {
        this.#drawSingleDataLine(
          ctx,
          key,
          bufferData.audio,
          padding,
          graphWidth,
          graphHeight,
          (this.#colors.bufferSizes as { video: string; audio: string }).audio,
          "audio"
        );
      }
    } else {
      // For other metrics, use the original drawing logic
      const dataArray = data as number[];
      if (dataArray.length <= 1) return;

      this.#drawSingleDataLine(
        ctx,
        key,
        dataArray,
        padding,
        graphWidth,
        graphHeight,
        this.#colors[key] as string
      );
    }
  };

  /**
   * Draw a single data line with the specified color
   * Used for both single-line graphs and multi-line graphs (buffer sizes)
   */
  #drawSingleDataLine = (
    ctx: CanvasRenderingContext2D,
    key: DataKey,
    data: number[],
    padding: { left: number; right: number; top: number; bottom: number },
    graphWidth: number,
    graphHeight: number,
    color: string,
    lineType?: "video" | "audio"
  ): void => {
    if (data.length <= 1) return;

    // Use logarithmic scale for resolution and bitrate
    const useLogScale = key === "resolution" || key === "bitrate";

    // Determine appropriate scale values
    let maxValue: number;
    let minValue = 1; // Prevent log(0)

    if (key === "resolution" && this.#availableResolutions.length > 0) {
      maxValue = Math.max(...this.#availableResolutions);
      minValue = Math.max(Math.min(...this.#availableResolutions), 1);
    } else if (key === "bitrate" && this.#availableBitrates.length > 0) {
      maxValue = Math.max(...this.#availableBitrates);
      minValue = Math.max(Math.min(...this.#availableBitrates), 0.1);
    } else {
      maxValue = this.#dynamicMaxValues[key];
      if (key === "bufferSizes") minValue = 0.1;
    }

    /**
     * Calculate Y position with appropriate scaling
     * Uses log scale for discrete values (resolution, bitrate)
     * Uses linear scale for continuous values (buffer, dropped frames)
     */
    const getYPosition = (value: number): number => {
      if (useLogScale) {
        // Use log scale for better distribution
        const logMin = Math.log(minValue);
        const logMax = Math.log(maxValue);
        const logValue = Math.log(Math.max(value, minValue));

        // Normalize to 0-1 range
        const normalizedValue = (logValue - logMin) / (logMax - logMin);
        return padding.top + graphHeight - normalizedValue * graphHeight;
      } else {
        // Linear scale for other metrics
        return padding.top + graphHeight - (value / maxValue) * graphHeight;
      }
    };

    // Save the current context state
    ctx.save();

    // Draw the data line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    // Create gradient fill with reduced opacity for buffer lines when both are present
    const gradient = ctx.createLinearGradient(
      0,
      padding.top,
      0,
      padding.top + graphHeight
    );

    // Use different opacity for buffer lines when both video and audio are present
    const fillOpacity = key === "bufferSizes" ? "0.2" : "0.3";
    gradient.addColorStop(0, color.replace("1)", `${fillOpacity})`));
    gradient.addColorStop(1, color.replace("1)", "0.0)"));

    // Move to first point
    const x0 = padding.left;
    const y0 = getYPosition(data[0]);
    ctx.moveTo(x0, y0);

    // Connect points - use stepped line for resolution/bitrate, curved for others
    data.forEach((value, index) => {
      const x =
        padding.left +
        (index / (this.#currentDataPoints - 1 || 1)) * graphWidth;
      const y = getYPosition(value);

      // For resolution and bitrate, use steps instead of lines to represent discrete changes
      if ((key === "resolution" || key === "bitrate") && index > 0) {
        const prevX =
          padding.left + ((index - 1) / (this.#maxDataPoints - 1)) * graphWidth;
        const prevY = getYPosition(data[index - 1]);

        // Draw horizontal line at previous height, then vertical line to new height
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    // Stroke the line
    ctx.stroke();

    // Add gradient fill below the line
    ctx.lineTo(
      padding.left +
        ((data.length - 1) / (this.#currentDataPoints - 1 || 1)) * graphWidth,
      padding.top + graphHeight
    );
    ctx.lineTo(padding.left, padding.top + graphHeight);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // For discrete values, add indicator dots at each value change point
    if (key === "resolution" || key === "bitrate") {
      let lastValue = data[0];

      data.forEach((value, index) => {
        // If value changed or first point, draw a dot
        if (value !== lastValue || index === 0) {
          const x =
            padding.left + (index / (this.#maxDataPoints - 1)) * graphWidth;
          const y = getYPosition(value);

          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();

          lastValue = value;
        }
      });
    }

    // Add a legend for buffer lines
    if (key === "bufferSizes" && lineType) {
      ctx.font = "11px Arial";
      ctx.fillStyle = color;
      const legendX =
        lineType === "video" ? padding.left + 10 : padding.left + 60;
      const legendY = padding.top + 20;

      // Draw a small line segment as legend
      ctx.beginPath();
      ctx.moveTo(legendX, legendY);
      ctx.lineTo(legendX + 15, legendY);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw legend text
      ctx.textAlign = "left";
      ctx.fillText(
        lineType.charAt(0).toUpperCase() + lineType.slice(1),
        legendX + 20,
        legendY + 3
      );
    }

    // Restore the context state
    ctx.restore();
  };
}
