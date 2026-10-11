import { followUps, runs } from "./state";

export default {
  fetch: () => Response.json({ runs, followUps: followUps.length }),
};
