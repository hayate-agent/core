import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { writeFileDurable } from "./durable.js";
import type { PluginModule, PluginCommand } from "./plugins.js";
import type { Dispatcher } from "./dispatcher.js";

type Board = { profiles: Record<string, string>; tasks: Record<string, { profile: string; task: string; input: string }> };

/** Small operator-facing board. Execution and recovery belong to the existing dispatcher. */
export function workerTasksPlugin(home: string, getDispatcher: () => Dispatcher | undefined,
  submit: (parent: string, requestId: string, input: string) => ReturnType<Dispatcher["submit"]>): PluginModule {
  let writes = Promise.resolve();
  const directory = path.join(home, "worker-tasks");
  const file = (parent: string) => path.join(directory, createHash("sha256").update(parent).digest("hex") + ".json");
  const load = async (parent: string): Promise<Board> => {
    try { return JSON.parse(await readFile(file(parent), "utf8")) as Board; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { profiles: {}, tasks: {} }; }
  };
  const save = async (parent: string, board: Board) => {
    await mkdir(directory, { recursive: true });
    await writeFileDurable(file(parent), JSON.stringify(board));
  };
  return { apiVersion: 1, activate(api) {
    // Model tool calls pass fields structurally so whitespace in instructions/tasks is kept;
    // the slash command keeps its word-based parsing.
    type Operation = { action?: string; id?: string; profile?: string; text?: string };
    const parse = (args: string): Operation => {
      const [action = "status", id, profile, ...rest] = args.trim().split(/\s+/);
      return action === "profile" ? { action, id, text: [profile, ...rest].filter(Boolean).join(" ") || undefined }
        : { action, id, profile, text: rest.join(" ") || undefined };
    };
    const command: PluginCommand & { run(args: string | Operation, context: { sessionKey: string }, model?: boolean): Promise<string> } = { name: "worker-tasks", help: "Worker profiles and durable tasks: profile <name> <instructions> | submit <request-id> <profile> <task> | status",
      async run(args, context, model = false) {
        if (/^(dispatch|subagent):/.test(context.sessionKey)) throw Error("Nested delegation is disabled");
        const dispatcher = getDispatcher();
        if (!dispatcher) throw Error("Dispatcher is not active");
        const run = async () => {
          const board = await load(context.sessionKey);
          const { action, id, profile, text } = typeof args === "string" ? parse(args) : args;
          const valid = (value: string | undefined): value is string => !!value && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
          if (action === "profile" && valid(id) && text?.trim()) {
            const instructions = text;
            if (instructions.length > 16000) throw Error("Profile too large");
            board.profiles[id] = instructions;
            await save(context.sessionKey, board);
            return `Worker profile ${id} saved`;
          }
          if (action === "submit" && valid(id) && valid(profile) && text?.trim()) {
            const old = board.tasks[id];
            const task = text;
            const instructions = board.profiles[profile];
            if (!instructions) throw Error("Unknown worker profile");
            if (old && (old.profile !== profile || old.task !== task)) throw Error("Conflicting task request ID");
            const input = old?.input ?? `Worker profile: ${profile}\nInstructions: ${instructions}\n\nTask: ${task}`;
            if (input.length > 64000) throw Error("Task too large");
            // Save the immutable input before submission. A retry uses the same
            // dispatcher request identity even across a crash in this gap.
            board.tasks[id] = { profile, task, input };
            await save(context.sessionKey, board);
            // Model calls inherit the live parent mandate through normal dispatcher
            // admission. Only explicit operator commands may create a new mandate.
            const execution = await (model ? dispatcher.submit.bind(dispatcher) : submit)(context.sessionKey, `worker-tasks:${id}`, input);
            return JSON.stringify({ requestId: id, id: execution.id, status: execution.status });
          }
          if (action === "status" && !id) {
            const tasks = await Promise.all(Object.entries(board.tasks).map(async ([requestId, receipt]) => {
              const execution = await dispatcher.store.findRequest(context.sessionKey, `worker-tasks:${requestId}`);
              return { requestId, profile: receipt.profile, status: execution?.status ?? "not-submitted", id: execution?.id,
                result: execution?.result, checkpoint: execution?.checkpoint };
            }));
            return JSON.stringify({ profiles: board.profiles, tasks }, null, 2);
          }
          throw Error("Use /worker-tasks profile <name> <instructions> | submit <request-id> <profile> <task> | status");
        };
        const result = writes.then(run);
        writes = result.then(() => {}, () => {});
        return result;
      },
    };
    api.registerCommand(command);
    api.registerTool({
      name: "plugin_worker_tasks",
      description: "Manage conversation-scoped worker profiles and durable tasks using the existing dispatcher. Only submit work authorized by the current operator mandate. Results arrive as host events; status includes persisted results. Reuse requestId only for identical retries. Profiles do not grant permissions.",
      parameters: { type: "object", additionalProperties: false, properties: {
        action: { type: "string", enum: ["profile", "submit", "status"] },
        name: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" },
        instructions: { type: "string", minLength: 1, maxLength: 16000 },
        requestId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" },
        profile: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" },
        task: { type: "string", minLength: 1, maxLength: 64000 },
      }, required: ["action"] },
      async execute(input, context) {
        if (context.signal?.aborted) throw Error("Worker task call aborted");
        const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
        if (input.action === "status") return command.run("status", context, true);
        if (input.action === "profile" && identifier(input.name) && typeof input.instructions === "string" && input.instructions.trim())
          return command.run({ action: "profile", id: input.name, text: input.instructions }, context, true);
        if (input.action === "submit" && identifier(input.requestId) && identifier(input.profile) && typeof input.task === "string" && input.task.trim())
          return command.run({ action: "submit", id: input.requestId, profile: input.profile, text: input.task }, context, true);
        throw Error("Invalid worker task operation");
      },
    });
  } };
}
