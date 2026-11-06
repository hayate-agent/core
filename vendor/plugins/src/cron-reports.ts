// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";
import type { Address } from "./types.js";

export interface CronReport {
  id: string;
  job: string;
  runId: string;
  createdAt: number;
  audience: "agent" | "user";
  original: string;
  output: string;
  destination?: Address;
  authorization?: string;
  maxTasks: number;
  submitted?: string[];
  analysis?: { summary: string; actions: Array<{ task: string; disposition: "authorized" | "approval-required" }>; };
}

/** Output is evidence, never authorization. Reports are retained independently of delivery. */
export class CronReports {
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.writing.catch(() => {}).then(run); this.writing = result; return result;
  }
  private file(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid cron report ID");
    return path.join(this.directory, `${id}.json`);
  }
  async record(report: Omit<CronReport, "id" | "analysis">): Promise<CronReport> {
    return this.serialize(async () => {
    const id = createHash("sha256").update(report.job + "\0" + report.runId).digest("hex");
    const prior = await this.get(id);
    if (prior) {
      if (JSON.stringify({ ...prior, analysis: undefined, submitted: undefined }) !== JSON.stringify({ ...report, id, analysis: undefined, submitted: undefined })) {
        // Compare fields independent of property insertion order.
        for (const key of Object.keys(report) as Array<keyof typeof report>) {
          if (JSON.stringify(prior[key]) !== JSON.stringify(report[key])) throw Error("Cron report run identity conflict");
        }
      }
      return prior;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const saved = { ...report, id };
    await writeFileDurable(this.file(id), JSON.stringify(saved));
    return saved;
    });
  }
  async get(id: string): Promise<CronReport | undefined> {
    try { return JSON.parse(await readFile(this.file(id), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  async save(report: CronReport): Promise<void> {
    await this.serialize(async () => { await writeFileDurable(this.file(report.id), JSON.stringify(report)); });
  }
  async all(): Promise<CronReport[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const reports: CronReport[] = [];
    for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const report = await this.get(file.slice(0, -5)); if (report) reports.push(report);
    }
    return reports;
  }
  async recent(destination: Address, limit = 5): Promise<CronReport[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const reports: CronReport[] = [];
    for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const report = await this.get(file.slice(0, -5));
      if (report?.audience === "user" && report.destination?.channel === destination.channel &&
          report.destination.target === destination.target && report.destination.thread === destination.thread) reports.push(report);
    }
    return reports.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.min(20, Math.max(0, limit)));
  }
}
