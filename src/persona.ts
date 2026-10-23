import { readFile } from "node:fs/promises";
import path from "node:path";

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
}

export interface PersonaFiles {
  soul: string;
  voice: string;
  personalitiesDir: string;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    const text = (await readFile(file, "utf8")).trim();
    return text.length ? text : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export async function loadPersona(files: PersonaFiles, personality?: string): Promise<Persona> {
  const [soul, voice] = await Promise.all([readOptional(files.soul), readOptional(files.voice)]);
  let overlay: Persona["personality"];
  if (personality) {
    if (!SAFE_NAME.test(personality)) throw new Error(`invalid personality name: ${personality}`);
    const text = await readOptional(path.join(files.personalitiesDir, `${personality}.md`));
    if (!text) throw new Error(`unknown personality: ${personality}`);
    overlay = { name: personality, text };
  }
  return { soul, voice, personality: overlay };
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
      "You are a personal and development agent running in VanillaCore Agent Harness.",
      `Your configured agent key is ${JSON.stringify(context.name ?? "agent")}; your SOUL defines your name, role and responsibilities. Do not invent a persona when none is configured.`,
      "The Harness owns your conversation routing, persistent work queue, goals, heartbeats, scheduled work and channels. PI supplies the underlying model/tool runtime; it is not your product identity or your terminal UI.",
      "Use SOUL.md for identity and duties, VOICE.md for tone, and the operator's requests for current priorities. Without these files, act as a direct, practical general-purpose personal and development assistant within this Harness.",
      "You can investigate and modify source through the tools actually available to you. Do not claim a change, build, deployment or self-update occurred until verified.",
      "When asked to change your own terminal UI or Harness, investigate VanillaCore Agent Harness source, not PI themes by default. Locate the checkout before editing; never assume the current workspace contains your source. Build/test changes and explain whether a restart is needed to activate them.",
      ...(context.workspace ? [`Your current tool workspace is ${JSON.stringify(context.workspace)}. This is not necessarily the Harness source checkout.`] : []),
      "Report unavailable integrations honestly; configured capability is not proof of authenticated access. Never expose credentials in output or commits.",
    ].join("\n"),
  ];
  if (persona.soul) out.push(`# Identity\n\n${persona.soul}`);
  if (persona.voice) out.push(`# Voice\n\nThis is how you sound everywhere (chat, reports, scheduled output). Stay in this voice.\n\n${persona.voice}`);
  if (persona.personality) out.push(`# Personality: ${persona.personality.name}\n\n${persona.personality.text}`);
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
