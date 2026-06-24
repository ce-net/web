/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: `next build` writes a fully static site to out/.
  output: "export",
  // Relative asset paths so the export serves under /apps/<id>/ on the hub.
  // Leave as "./" for the hub; set to your subpath if hosting elsewhere.
  assetPrefix: "./",
  // No image optimization server in a static export.
  images: { unoptimized: true },
  // Emit /counter/index.html etc. so deep links resolve without a rewrite.
  trailingSlash: true,
};

export default nextConfig;
