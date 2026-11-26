const isPages = process.env.GITHUB_ACTIONS === "true";
export default { output: "export", trailingSlash: true, images: { unoptimized: true }, basePath: isPages ? "/sama-business" : "" };
