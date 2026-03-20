import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: [".claude/", "dist/", "next-app-dist/", ".next/", "scripts/"],
  },
];

export default eslintConfig;
