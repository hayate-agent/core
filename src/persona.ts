// SPDX-License-Identifier: Apache-2.0
import { open, readdir, realpath, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { developmentContext } from "./development.js";

/**
 * Persona = identity (SOUL.md) + voice (VOICE.md: personality, tone, style).
 * "Voice" means how the agent sounds in writing, not audio.
 * Runtime-independent: produces system-prompt sections.
 */
export interface Persona {
  soul?: string;
  voice?: string;
  /** Active named personality overlay (/personality <name>). */
  personality?: { name: string; text: string };
  overlays?: { name: string; text: string }[];
}

export interface PersonaFiles {
  soul: string;
  voice: string;
  personalitiesDir: string;
  /** Trusted instruction-only Markdown files, in configuration order. */
  overlays?: string[];
  /** Trusted instruction-only directory; direct .md children in filename order. */
  overlaysDir?: string;
}

async function readInstruction(file: string, optional = false): Promise<string | undefined> {
  let handle;
  try {
    // Do not follow a file symlink into credentials or another agent's identity.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()).trim();
    return text || undefined;
  } catch (err) {
    if (optional && (err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot load persona instruction ${file}; correct the file before retrying`, { cause: err });
  } finally { await handle?.close(); }
}

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export async function loadPersona(files: PersonaFiles, personality?: string): Promise<Persona> {
  const directoryFiles = async (directory: string): Promise<string[]> => {
    try {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) throw Error("invalid or symlink directory");
      return (await readdir(directory)).filter(name => name.endsWith(".md")).sort().map(name => path.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw Error(`Cannot load persona directory ${directory}; correct the path before retrying`);
    }
  };
  const layeredInstruction = async (file: string) => {
    const texts = [await readInstruction(file, true)];
    for (const child of await directoryFiles(`${file}.d`)) texts.push(await readInstruction(child));
    return texts.filter(Boolean).join("\n\n") || undefined;
  };
  const [soul, voice] = await Promise.all([layeredInstruction(files.soul), layeredInstruction(files.voice)]);
  const paths = [...(files.overlays ?? [])];
  if (files.overlaysDir) paths.push(...await directoryFiles(files.overlaysDir));
  const overlays: NonNullable<Persona["overlays"]> = [];
  for (const file of [...new Set(paths.map(file => path.resolve(file)))]) {
    if (path.extname(file) !== ".md") throw new Error(`Persona overlays must be Markdown instruction files: ${file}`);
    const text = await readInstruction(file, true);
    if (text) overlays.push({ name: path.basename(file), text });
  }
  let overlay: Persona["personality"];
  if (personality) {
    if (!SAFE_NAME.test(personality)) throw new Error(`invalid personality name: ${personality}`);
    const text = await readInstruction(path.join(files.personalitiesDir, `${personality}.md`), true);
    if (!text) throw new Error(`unknown personality: ${personality}`);
    overlay = { name: personality, text };
  }
  return { soul, voice, personality: overlay, overlays };
}

export interface AgentContext {
  name?: string;
  workspace?: string;
}

/** Product grounding precedes configurable identity/voice; PI is an implementation detail. */
export function personaSections(persona: Persona, context: AgentContext = {}): string[] {
  const out: string[] = [
    [
      "# Agent foundation",
      "You are a personal and development agent running in Hayate Agent.",
      `Your configured agent key is ${JSON.stringify(context.name ?? "agent")}; your SOUL defines your name, role and responsibilities. Do not invent a persona when none is configured.`,
      "Hayate Agent owns your conversation routing, persistent work queue, goals, heartbeats, scheduled work and channels. PI supplies the underlying model/tool runtime; it is not your product identity or your terminal UI.",
      "Use SOUL.md for identity and duties, VOICE.md for tone, and the operator's requests for current priorities. Without these files, act as a direct, practical general-purpose personal and development assistant within Hayate Agent.",
      "You can investigate and modify source through the tools actually available to you. Do not claim a change, build, deployment or self-update occurred until verified.",
      "When asked to change your own terminal UI or Hayate Agent, investigate Hayate Agent source, not PI themes by default. Locate the checkout before editing; never assume the current workspace contains your source. Build/test changes and explain whether a restart is needed to activate them.",
      ...(context.workspace ? [`Your current tool workspace is ${JSON.stringify(context.workspace)}. This is not necessarily the Hayate Agent source checkout.`] : []),
      "Report unavailable integrations honestly; configured capability is not proof of authenticated access. Never expose credentials in output or commits.",
    ].join("\n"),
  ];
  out.push(developmentContext());
  if (persona.soul) out.push(`# Identity\n\n${persona.soul}`);
  if (persona.voice) out.push(`# Voice\n\nThis is how you sound everywhere (chat, reports, scheduled output). Stay in this voice.\n\n${persona.voice}`);
  if (persona.personality) out.push(`# Personality: ${persona.personality.name}\n\n${persona.personality.text}`);
  for (const overlay of persona.overlays ?? []) out.push(`# Persona overlay: ${overlay.name}\n\n${overlay.text}`);
  out.push(
    [
      "# Conversation",
      "",
      "- You talk to people through chat channels. Write like a person in a chat, not like a report generator.",
      "- Match length to the message. Short questions get short answers.",
      "- In shared rooms you may stay silent when you are not addressed: reply with exactly NO_REPLY.",
    ].join("\n"),
  );
  return out;
}
