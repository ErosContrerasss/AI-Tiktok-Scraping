import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the binary path of ffmpeg-static intact (bundling would rewrite it).
  serverExternalPackages: ["ffmpeg-static"],
};

export default nextConfig;
