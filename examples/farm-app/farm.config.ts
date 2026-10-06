import { defineConfig } from "@farm.js/core";
import { devtools } from "@farm.js/devtools";

export default defineConfig({
  plugins: [devtools()],
  theme: {
    default: "dark",
  },
  deploy: {
    target: "vercel",
  },
});
