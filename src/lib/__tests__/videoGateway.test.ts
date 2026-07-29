import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIDEO_MODEL_IDS,
  allowedVideoAspectRatios,
  allowedVideoResolutions,
  buildKlingOmniGenerationBody,
  buildSeedanceGenerationBody,
  extractVideoResultMetadata,
  shouldUseConnectedImageAsFirstFrame,
  supportsShots,
  videoStatusEndpoint,
} from "../videoGateway.ts";
import type { VideoJobParams } from "../types.ts";

function params(patch: Partial<VideoJobParams> = {}): VideoJobParams {
  return {
    model: "seedance-2.0",
    mode: "720p",
    duration: 5,
    prompt: "雨夜街头的电影感镜头",
    sound: false,
    aspectRatio: "智能",
    ...patch,
  };
}

test("视频模型映射和分辨率保持 TVision 契约", () => {
  assert.equal(VIDEO_MODEL_IDS["v3-omni"], "kling-v3-omni");
  assert.equal(VIDEO_MODEL_IDS["seedance-2.0"], "seedance-2.0");
  assert.deepEqual(allowedVideoResolutions("seedance-2.0"), ["720p", "1080p", "4K"]);
  assert.deepEqual(allowedVideoResolutions("seedance-2.0-fast"), ["720p"]);
});

test("各视频模型仅使用服务器指定的轮询地址", () => {
  assert.equal(videoStatusEndpoint("v3-omni", "task/123"), "/kling/omni-video/kling-3.0-omni/task%2F123");
  assert.equal(videoStatusEndpoint("seedance-2.0", "task-2"), "/v1/video/generations/task-2");
  assert.equal(videoStatusEndpoint("v3", "task-3"), "/kling/v1/videos/image2video/task-3");
});

test("可灵 Omni 与 Seedance 使用不同画面比例白名单", () => {
  assert.deepEqual(allowedVideoAspectRatios("v3-omni"), ["智能", "16:9", "9:16", "1:1"]);
  assert.deepEqual(allowedVideoAspectRatios("seedance-2.0"), ["智能", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  assert.equal(supportsShots("v3-omni"), true);
  assert.equal(supportsShots("seedance-2.0"), false);
});

test("可灵 Omni 紧凑成功响应会保留视频、时长、计费和请求 ID", () => {
  const result = extractVideoResultMetadata({
    task_id: "task_SpcKYldewyZpFgqwWdplUV5ViGXFiP19",
    status: "SUCCESS",
    video_url: "https://cdn.example.com/result.mp4",
    duration: 5.041,
    model: "kling-3.0-omni",
    cost: "4.5",
    request_id: "9808ba3e-0b06-4b0f-8ae0-6c7ea08070b9",
  }, "task_SpcKYldewyZpFgqwWdplUV5ViGXFiP19");

  assert.deepEqual(result, {
    videoUrl: "https://cdn.example.com/result.mp4",
    watermarkUrl: undefined,
    outputDuration: "5.041",
    requestId: "9808ba3e-0b06-4b0f-8ae0-6c7ea08070b9",
    billing: [{ charge_type: "unit", amount: "4.5" }],
  });
});

test("只有首尾帧模式或旧模型会把连线图片作为首帧", () => {
  assert.equal(shouldUseConnectedImageAsFirstFrame("v3-omni", "references", false), false);
  assert.equal(shouldUseConnectedImageAsFirstFrame("v3-omni", "keyframes", false), true);
  assert.equal(shouldUseConnectedImageAsFirstFrame("v3", "references", false), true);
  assert.equal(shouldUseConnectedImageAsFirstFrame("v2-6", "references", false), true);
  assert.equal(shouldUseConnectedImageAsFirstFrame("v3", "references", true), false);
});

test("Seedance 请求体透传专属参数和多模态素材", () => {
  const body = buildSeedanceGenerationBody(params({
    mode: "4K",
    duration: 12,
    sound: true,
    aspectRatio: "9:16",
    webSearch: true,
    cameraFixed: true,
    seed: 42,
    refUrls: ["https://cdn.example.com/ref.png"],
    videoUrls: ["https://cdn.example.com/ref.mp4"],
    audioUrls: ["https://cdn.example.com/ref.wav"],
  }));

  assert.deepEqual(body, {
    model: "seedance-2.0",
    prompt: "雨夜街头的电影感镜头",
    resolution: "4k",
    ratio: "9:16",
    duration: 12,
    camera_fixed: true,
    generate_audio: true,
    web_search: true,
    seed: 42,
    images: [{ url: "https://cdn.example.com/ref.png", role: "reference_image" }],
    videos: ["https://cdn.example.com/ref.mp4"],
    audios: ["https://cdn.example.com/ref.wav"],
  });
});

test("Seedance 智能比例不透传 ratio，且音频不能单独提交", () => {
  assert.equal(buildSeedanceGenerationBody(params()).ratio, undefined);
  assert.throws(
    () => buildSeedanceGenerationBody(params({ audioUrls: ["https://cdn.example.com/ref.mp3"] })),
    /音频不能单独提交/,
  );
});

test("可灵 Omni 使用最新 contents/settings/options 协议并固定关闭水印", () => {
  const body = buildKlingOmniGenerationBody(params({
    model: "v3-omni",
    mode: "4K",
    duration: 8,
    aspectRatio: "9:16",
    audioMode: "native",
    sound: true,
    imageUrl: "https://cdn.example.com/first.png",
    tailUrl: "https://cdn.example.com/last.png",
    refUrls: ["https://cdn.example.com/style.png"],
  }));

  assert.deepEqual(body, {
    contents: [
      { type: "prompt", text: "雨夜街头的电影感镜头" },
      { type: "first_frame", url: "https://cdn.example.com/first.png", id: "image_1" },
      { type: "last_frame", url: "https://cdn.example.com/last.png", id: "image_2" },
      { type: "refer_image", url: "https://cdn.example.com/style.png", id: "image_3" },
    ],
    settings: {
      multi_shot: false,
      audio: "native",
      resolution: "4k",
      duration: 8,
      aspect_ratio: "9:16",
    },
    options: { watermark_info: { enabled: false } },
  });
});

test("可灵 Omni 分镜编码、视频音频约束和必填比例符合最新协议", () => {
  const featureBody = buildKlingOmniGenerationBody(params({
    model: "v3-omni",
    duration: 5,
    aspectRatio: "智能",
    audioMode: "off",
    videoUrls: ["https://cdn.example.com/motion.mp4"],
    shots: [
      { index: 1, prompt: "镜头推进", duration: 2 },
      { index: 2, prompt: "人物回头", duration: 3 },
    ],
  }));
  assert.deepEqual(featureBody.contents, [
    { type: "prompt", text: "shot 1, 2, 镜头推进; shot 2, 3, 人物回头;" },
    { type: "feature_video", url: "https://cdn.example.com/motion.mp4", id: "video_1" },
  ]);
  assert.equal((featureBody.settings as Record<string, unknown>).multi_shot, true);
  assert.equal((featureBody.settings as Record<string, unknown>).aspect_ratio, undefined);

  const featureOriginalBody = buildKlingOmniGenerationBody(params({
    model: "v3-omni",
    aspectRatio: "智能",
    audioMode: "original",
    videoUrls: ["https://cdn.example.com/motion.mp4"],
  }));
  assert.equal((featureOriginalBody.settings as Record<string, unknown>).audio, "original");

  const baseBody = buildKlingOmniGenerationBody(params({
    model: "v3-omni",
    aspectRatio: "智能",
    audioMode: "original",
    referType: "base",
    videoUrls: ["https://cdn.example.com/edit.mp4"],
  }));
  assert.equal((baseBody.settings as Record<string, unknown>).audio, "original");
  assert.equal((baseBody.settings as Record<string, unknown>).multi_shot, false);

  assert.throws(
    () => buildKlingOmniGenerationBody(params({ model: "v3-omni", aspectRatio: "智能" })),
    /必须选择/,
  );
  assert.throws(
    () => buildKlingOmniGenerationBody(params({ model: "v3-omni", aspectRatio: "16:9", tailUrl: "https:\/\/cdn.example.com\/last.png" })),
    /不支持仅尾帧/,
  );
  assert.throws(
    () => buildKlingOmniGenerationBody(params({
      model: "v3-omni",
      aspectRatio: "智能",
      audioMode: "native",
      videoUrls: ["https://cdn.example.com/motion.mp4"],
    })),
    /不能生成原生音频/,
  );
});

test("可灵 Omni AI 自动多镜头不需要自定义分镜文本", () => {
  const body = buildKlingOmniGenerationBody(params({
    model: "v3-omni",
    aspectRatio: "16:9",
    audioMode: "off",
    shotMode: "auto",
  }));
  assert.equal((body.settings as Record<string, unknown>).multi_shot, true);
  assert.deepEqual(body.contents, [{ type: "prompt", text: "雨夜街头的电影感镜头" }]);
});
