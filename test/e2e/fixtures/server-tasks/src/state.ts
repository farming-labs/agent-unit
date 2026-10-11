// What the task did, read back by the server. One module instance, shared by the server and its tasks.
export const runs: { name: string; scheduledTime: number }[] = [];
export const followUps: number[] = [];
