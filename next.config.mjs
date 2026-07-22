/** @type {import('next').NextConfig} */
const nextConfig = {
  // Canvas snapshots and multi-ref submissions post large base64 payloads to
  // the local route handlers; keep the body limit above the 20MB upstream cap.
  experimental: {
    serverActions: { bodySizeLimit: "30mb" },
  },
};

export default nextConfig;
