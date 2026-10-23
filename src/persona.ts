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

/** Sections appended to the runtime's system prompt. Order: identity, voice, personality overlay, channel rules. */
export function personaSections(persona: Persona): string[] {
  const out: string[] = [];
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
