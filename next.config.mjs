/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep output tracing inside this app. A parent-level lockfile otherwise
  // makes Next scan unrelated user temp files and can fail with EPERM.
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"],
  // Canvas snapshots and multi-ref submissions post large base64 payloads to
  // the local route handlers; keep the body limit above the 20MB upstream cap.
  experimental: {
    serverActions: { bodySizeLimit: "30mb" },
  },
};

export default nextConfig;
