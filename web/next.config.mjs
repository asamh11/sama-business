const isGHA = process.env.GITHUB_ACTIONS === "true";
const repo = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split("/")[1] : "";
const isUserSite = repo.endsWith(".github.io");
const basePath = isGHA && repo && !isUserSite ? `/${repo}` : "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
