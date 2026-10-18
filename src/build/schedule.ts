import { Cron } from "croner";

/** Presets where Nitro runs scheduled tasks itself. */
export const SCHEDULING_PRESETS = /^(node|node-server|node-cluster|node-middleware|bun|deno-server|cloudflare-module|cloudflare-pages|vercel)$/;

/** Where the sweep's schedule is used: Nitro's scheduler, or the Netlify scheduled function the build writes. */
export const sweepScheduled = (preset: string) => SCHEDULING_PRESETS.test(preset) || (/^netlify/.test(preset) && preset !== "netlify-edge");

/** Hosts whose own scheduler runs the crons, and takes only the five-field form. */
const FIVE_FIELD_PRESETS = /^(cloudflare-|vercel)/;

/**
 * Throws when `cron` would not run on `preset`: at startup a server's scheduler stops at the first
 * cron it cannot read, so one bad schedule would silently stop every task and the sweep. Called only
 * where the preset uses the schedule.
 */
export function checkSchedule(cron: string, what: string, preset: string): void {
  try {
    new Cron(cron, { paused: true }).stop();
  } catch (error) {
    throw new Error(`agent-unit: the schedule of ${what}, "${cron}", is not a cron expression: ${(error as Error).message}`);
  }
  if (FIVE_FIELD_PRESETS.test(preset) && cron.trim().split(/\s+/).length !== 5) {
    throw new Error(`agent-unit: the schedule of ${what}, "${cron}", needs five fields (minute hour day month weekday) on the "${preset}" preset, whose scheduler takes no other form.`);
  }
}
