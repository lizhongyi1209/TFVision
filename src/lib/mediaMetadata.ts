export type VideoFileMetadata = {
  width: number;
  height: number;
  duration: number;
  frameRate: number;
};

/** Read reliable file metadata through the local Next server's ffprobe. */
export async function inspectVideoFile(file: File): Promise<VideoFileMetadata> {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch("/api/video/metadata", { method: "POST", body: form });
  const payload = (await response.json().catch(() => ({}))) as Partial<VideoFileMetadata> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "无法读取视频信息");
  return {
    width: Number(payload.width) || 0,
    height: Number(payload.height) || 0,
    duration: Number(payload.duration) || 0,
    frameRate: Number(payload.frameRate) || 0,
  };
}
