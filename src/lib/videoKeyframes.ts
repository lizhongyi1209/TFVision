export type VideoKeyframe = {
  dataUrl: string;
  timestamp: number;
};

export type VideoKeyframeResult = {
  duration: number;
  width: number;
  height: number;
  frames: VideoKeyframe[];
};

const ANALYSIS_WIDTH = 48;
const ANALYSIS_HEIGHT = 27;
const OUTPUT_MAX_EDGE = 768;
const JPEG_QUALITY = 0.82;

function targetFrameCount(duration: number) {
  if (duration <= 5.25) return 12;
  if (duration <= 10.5) return 18;
  if (duration <= 15.5) return 24;
  if (duration <= 30.5) return 32;
  return 36;
}

function evenlySpacedTimes(duration: number, count: number) {
  if (count <= 1) return [0];
  const safeEnd = Math.max(0, duration - 0.001);
  return Array.from({ length: count }, (_, index) => (safeEnd * index) / (count - 1));
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: "loadedmetadata" | "loadeddata") {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("无法解码该视频，请尝试 MP4（H.264）格式"));
    };
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, timestamp: number) {
  const safeTime = Math.min(Math.max(0, timestamp), Math.max(0, video.duration - 0.001));
  if (Math.abs(video.currentTime - safeTime) < 0.002 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频取帧失败"));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = safeTime;
  });
}

function frameDifference(previous: Uint8ClampedArray | null, current: Uint8ClampedArray) {
  if (!previous) return 0;
  let difference = 0;
  for (let index = 0; index < current.length; index += 4) {
    difference += Math.abs(current[index] - previous[index]);
    difference += Math.abs(current[index + 1] - previous[index + 1]);
    difference += Math.abs(current[index + 2] - previous[index + 2]);
  }
  return difference / (current.length * 0.75 * 255);
}

function chooseTimes(duration: number, target: number, candidates: Array<{ time: number; score: number }>) {
  const uniformCount = Math.max(2, Math.round(target * 0.72));
  const selected = evenlySpacedTimes(duration, uniformCount);
  const minimumSpacing = duration / Math.max(8, target * 1.8);
  const isFarEnough = (time: number) => selected.every((chosen) => Math.abs(chosen - time) >= minimumSpacing);

  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (selected.length >= target) break;
    if (isFarEnough(candidate.time)) selected.push(candidate.time);
  }

  const pool = candidates.map((candidate) => candidate.time);
  while (selected.length < target && pool.length) {
    let bestIndex = -1;
    let bestDistance = -1;
    for (let index = 0; index < pool.length; index += 1) {
      const distance = Math.min(...selected.map((chosen) => Math.abs(chosen - pool[index])));
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    selected.push(pool.splice(bestIndex, 1)[0]);
  }

  return selected.sort((a, b) => a - b).slice(0, target);
}

export async function extractVideoKeyframes(
  sourceUrl: string,
  options: { maxFrames?: number; onProgress?: (progress: number) => void } = {},
): Promise<VideoKeyframeResult> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;

  const metadataPromise = waitForVideoEvent(video, "loadedmetadata");
  video.load();
  await metadataPromise;
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
    throw new Error("无法读取视频时长或画面尺寸");
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitForVideoEvent(video, "loadeddata");

  const duration = video.duration;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const target = Math.max(2, Math.min(options.maxFrames ?? 36, targetFrameCount(duration)));
  const probeCount = Math.min(72, Math.max(target * 2, Math.ceil(duration * 2.5)));
  const probeTimes = evenlySpacedTimes(duration, probeCount);
  const analysisCanvas = document.createElement("canvas");
  analysisCanvas.width = ANALYSIS_WIDTH;
  analysisCanvas.height = ANALYSIS_HEIGHT;
  const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
  if (!analysisContext) throw new Error("浏览器无法创建视频分析画布");

  const candidates: Array<{ time: number; score: number }> = [];
  let previousPixels: Uint8ClampedArray | null = null;
  for (let index = 0; index < probeTimes.length; index += 1) {
    const time = probeTimes[index];
    await seekVideo(video, time);
    analysisContext.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    const pixels = analysisContext.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
    candidates.push({ time, score: frameDifference(previousPixels, pixels) });
    previousPixels = new Uint8ClampedArray(pixels);
    options.onProgress?.(Math.round(((index + 1) / probeTimes.length) * 45));
  }

  const selectedTimes = chooseTimes(duration, target, candidates);
  const scale = Math.min(1, OUTPUT_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(2, Math.round(sourceWidth * scale));
  const height = Math.max(2, Math.round(sourceHeight * scale));
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext("2d");
  if (!outputContext) throw new Error("浏览器无法创建视频取帧画布");

  const frames: VideoKeyframe[] = [];
  for (let index = 0; index < selectedTimes.length; index += 1) {
    const timestamp = selectedTimes[index];
    await seekVideo(video, timestamp);
    outputContext.drawImage(video, 0, 0, width, height);
    frames.push({ dataUrl: outputCanvas.toDataURL("image/jpeg", JPEG_QUALITY), timestamp });
    options.onProgress?.(45 + Math.round(((index + 1) / selectedTimes.length) * 55));
  }

  video.removeAttribute("src");
  video.load();
  return { duration, width: sourceWidth, height: sourceHeight, frames };
}
