"use client";

import { useEffect, useRef, useState } from "react";
import { createAgentClient, type AgentEvent, type RunRecord } from "agent-unit/client";

const agents = createAgentClient({ baseUrl: "/api/ai" });

const STATUS_COLOR: Record<string, string> = {
  running: "text-sky-300",
  interrupted: "text-amber-300",
  sleeping: "text-violet-300",
  completed: "text-emerald-300",
  failed: "text-red-400",
  cancelled: "text-neutral-500",
};

function describe(event: AgentEvent): string {
  switch (event.type) {
    case "STEP_STARTED":
    case "STEP_FINISHED":
      return event.stepName;
    case "RUN_INTERRUPTED":
      return `${event.interrupt.name} ${JSON.stringify(event.interrupt.payload)}`;
    case "RUN_SLEEPING":
      return `until ${new Date(event.wakeAt).toLocaleTimeString()}`;
    case "RUN_FINISHED":
      return JSON.stringify(event.result);
    case "RUN_ERROR":
      return event.message;
    default:
      return "";
  }
}

export function AgentsConsole() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState<string>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [orderId, setOrderId] = useState("o_1001");
  const following = useRef<AbortController | undefined>(undefined);

  async function refresh() {
    setRuns(await agents.list({ limit: 12 }));
  }

  // Follow one run's events: replays its history, then streams live until it settles.
  async function follow(runId: string, stream?: AsyncIterable<AgentEvent>) {
    following.current?.abort();
    const controller = new AbortController();
    following.current = controller;
    setSelected(runId);
    setEvents([]);
    let last: AgentEvent | undefined;
    try {
      for await (const event of stream ?? agents.events(runId, { signal: controller.signal })) {
        if (controller.signal.aborted) return;
        last = event;
        setEvents((previous) => [...previous, event]);
        if (event.type.startsWith("RUN_")) void refresh();
      }
      // A sleeping run's stream ends while it sleeps. Wait for it to wake, then keep following.
      const sleeping = last as AgentEvent | undefined;
      if (sleeping?.type === "RUN_SLEEPING") {
        const wakeAt = Date.parse(sleeping.wakeAt);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, wakeAt - Date.now())));
        while (!controller.signal.aborted && (await agents.get(runId)).status === "sleeping") {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (controller.signal.aborted) return;
        for await (const event of agents.events(runId, { after: sleeping.seq, signal: controller.signal })) {
          setEvents((previous) => [...previous, event]);
        }
        void refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error(error);
    }
  }

  async function start(agent: string, input: Record<string, unknown>) {
    const stream = agents.run(agent, input);
    const first = await stream.next();
    if (first.done) return;
    await refresh();
    const replay = (async function* () {
      yield first.value;
      yield* stream;
    })();
    await follow(first.value.runId, replay);
  }

  // Show the run's history up to the pause, then the events that follow the answer.
  async function answer(runId: string, approved: boolean) {
    await follow(
      runId,
      (async function* () {
        yield* agents.events(runId);
        yield* agents.resume(runId, { approved });
      })(),
    );
    await refresh();
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, []);

  const inbox = runs.filter((run) => run.status === "interrupted");

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-10 sm:px-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">agent-unit inside farm.js</p>
        <h1 className="text-3xl font-semibold tracking-tight">Durable agents, mounted at /api/ai</h1>
        <p className="max-w-2xl text-neutral-400">
          Runs pause for a human, sleep without holding a process, and resume where they stopped, even after
          the server restarts. Everything below talks to <code className="text-neutral-200">/api/ai</code>.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-3 rounded-lg border border-white/10 p-4">
          <h2 className="font-medium">Start a run</h2>
          <label className="flex flex-col gap-1 text-sm text-neutral-400">
            Order
            <input
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              className="rounded border border-white/15 bg-black px-2 py-1.5 font-mono text-neutral-100"
            />
          </label>
          <button
            onClick={() => void start("refund", { orderId })}
            className="rounded bg-white px-3 py-2 text-sm font-medium text-black hover:bg-neutral-200"
          >
            Request refund
          </button>
          <button
            onClick={() => void start("reminder", { seconds: 5 })}
            className="rounded border border-white/20 px-3 py-2 text-sm hover:bg-white/5"
          >
            Remind me in 5 seconds
          </button>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-white/10 p-4">
          <h2 className="font-medium">
            Approvals inbox <span className="text-neutral-500">({inbox.length})</span>
          </h2>
          {inbox.length === 0 && <p className="text-sm text-neutral-500">Nothing is waiting for you.</p>}
          {inbox.map((run) => (
            <div key={run.id} className="flex flex-col gap-2 rounded border border-amber-300/30 bg-amber-300/5 p-3">
              <p className="font-mono text-xs text-neutral-400">{run.id}</p>
              <p className="text-sm">
                {run.interrupt?.name}: <code className="break-all">{JSON.stringify(run.interrupt?.payload)}</code>
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void answer(run.id, true)}
                  className="rounded bg-emerald-400 px-3 py-1 text-sm font-medium text-black"
                >
                  Approve
                </button>
                <button
                  onClick={() => void answer(run.id, false)}
                  className="rounded border border-white/20 px-3 py-1 text-sm"
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-white/10 p-4">
          <h2 className="font-medium">Recent runs</h2>
          {runs.length === 0 && <p className="text-sm text-neutral-500">No runs yet.</p>}
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => void follow(run.id)}
              className={`flex items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-white/5 ${
                run.id === selected ? "bg-white/10" : ""
              }`}
            >
              <span>
                {run.agent} <span className="font-mono text-xs text-neutral-500">{run.id.slice(0, 12)}</span>
              </span>
              <span className={`font-mono text-xs ${STATUS_COLOR[run.status] ?? ""}`}>{run.status}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-white/10 p-4">
        <h2 className="font-medium">
          Events {selected && <span className="font-mono text-xs text-neutral-500">{selected}</span>}
        </h2>
        {events.length === 0 && <p className="text-sm text-neutral-500">Start or pick a run to watch its events.</p>}
        <ol className="flex flex-col gap-1 font-mono text-xs">
          {events.map((event) => (
            <li key={`${event.runId}:${event.seq}`} className="flex gap-3">
              <span className="w-6 text-right text-neutral-600">{event.seq}</span>
              <span className="w-40 text-neutral-200">{event.type}</span>
              <span className="truncate text-neutral-400">{describe(event)}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
