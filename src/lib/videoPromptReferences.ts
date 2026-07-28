import type { VideoReferenceKind } from "./types";

export type VideoPromptReferenceRole = "first_frame" | "last_frame" | "reference";

export type VideoPromptReferenceInput = {
  key: string;
  kind: VideoReferenceKind;
  name: string;
  role?: VideoPromptReferenceRole;
  /** Lightweight visual shown in the @ picker and prompt binding chip. */
  previewUrl?: string;
  /** Used as a fallback preview for videos that do not have an extracted frame. */
  mediaUrl?: string;
};

export type VideoPromptReference<T extends VideoPromptReferenceInput = VideoPromptReferenceInput> = T & {
  promptId: string;
  token: string;
};

/**
 * Assign the exact IDs used in multimodal prompts. Counters are independent by
 * media kind, matching API tokens such as @image_1 and @video_1.
 */
export function assignVideoPromptReferences<T extends VideoPromptReferenceInput>(
  inputs: T[],
): VideoPromptReference<T>[] {
  const counters: Record<VideoReferenceKind, number> = { image: 0, video: 0, audio: 0 };
  return inputs.map((input) => {
    const promptId = `${input.kind}_${++counters[input.kind]}`;
    return { ...input, promptId, token: `@${promptId}` };
  });
}

export function activeVideoPromptMention(value: string, caret: number) {
  const safeCaret = Math.max(0, Math.min(value.length, caret));
  const prefix = value.slice(0, safeCaret);
  const match = prefix.match(/(?:^|[\s，。；;：:、（(])@([^\s@]*)$/u);
  if (!match) return null;
  const start = prefix.lastIndexOf("@");
  return { start, end: safeCaret, query: match[1].toLocaleLowerCase() };
}
