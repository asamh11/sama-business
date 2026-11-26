const isPages = process.env.GITHUB_ACTIONS === "true";
export default { output: "export", trailingSlash: true, images: { unoptimized: true }, allowedDevOrigins: ["*.cloudshell.dev"], basePath: isPages ? "/sama-business" : "" };
