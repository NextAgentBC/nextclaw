/**
 * Emit a Moderator-coined worker role as an OpenClaw skill so the SAME
 * specialist is available to BOTH paths:
 *
 *   1. Moderator dispatch path  — loads the role from moderator.worker_roles
 *      and runs a worker LLM call (this is where the role was born).
 *   2. Codex agent path         — reads SKILL.md from the configured skills
 *      directory at session start and lists the skill in its prompt; the
 *      user can then invoke it naturally in a DM.
 *
 * Concretely: when the Moderator designs `math_tutor_grade5` for a group
 * question, the same persona becomes a skill the user can lean on in
 * their DM with the bot — without anyone hand-writing a SKILL.md.
 *
 * Design choices:
 *   - Atomic write: temp file + rename. OpenClaw's skill watcher should
 *     never see a half-written SKILL.md.
 *   - Path sanitization: roleKey is sanitized to [A-Za-z0-9_-] before
 *     becoming a directory name. Garbage roleKeys can't escape the dir.
 *   - Idempotent: re-emitting the same role overwrites; safe to retry.
 *   - Best-effort: failure logs a warning, never throws. Skill emit is a
 *     synergy feature; if it breaks the Moderator must still answer.
 *   - Off by default: cfg.moderator.publishAsSkills.enabled gates the
 *     whole feature (operators on shared boxes shouldn't accidentally
 *     create files outside the plugin sandbox).
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type SkillEmitParams = {
  /** Absolute path to the directory that holds per-role subfolders.
   *  Defaults to ~/.openclaw/skills/nextclaw-roles when omitted. */
  dir: string;
  roleKey: string;
  displayName: string;
  /** The role's systemPrompt — becomes the body of SKILL.md (after the frontmatter). */
  systemPrompt: string;
  /** A short description shown to the agent in its skills prompt. Falls
   *  back to "Specialist '{roleKey}' — auto-registered by the Moderator." */
  description?: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
};

const ROLE_KEY_SAFE = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeRoleKey(raw: string): string | null {
  // Strip whitespace + lowercase common variants we accept; reject anything
  // we can't safely turn into a directory name.
  const trimmed = raw.trim();
  if (!trimmed) {return null;}
  if (ROLE_KEY_SAFE.test(trimmed)) {return trimmed;}
  // One last try: collapse non-safe chars into underscores. If still empty
  // after collapse, reject.
  const collapsed = trimmed.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 64);
  return ROLE_KEY_SAFE.test(collapsed) ? collapsed : null;
}

/**
 * Build the SKILL.md content. Body is just the role's systemPrompt; we
 * don't add OpenClaw-specific scaffolding because the systemPrompt is
 * the LLM-facing voice — adding meta-instructions on top would dilute it.
 */
function buildSkillMarkdown(params: SkillEmitParams, safeKey: string): string {
  const description = (params.description ?? "").trim()
    || `Specialist '${safeKey}' — auto-registered by the Moderator. ` +
       `Trigger when the user's question matches this specialist's domain.`;
  // YAML frontmatter — keep keys to the documented minimal set so we
  // don't depend on OpenClaw's parser accepting extras. Description is
  // ONE LINE (\n-escaped if needed); OpenClaw's prompt builder wants a
  // single-line summary.
  const yamlDescription = description.replace(/\n+/g, " ").trim();
  const yamlName = params.displayName.trim() || safeKey;
  const frontmatter = [
    "---",
    `name: ${safeKey}`,
    `description: ${yamlDescription}`,
    "---",
    "",
  ].join("\n");
  return frontmatter + `# ${yamlName}\n\n${params.systemPrompt.trim()}\n`;
}

/**
 * Atomic emit. Writes a temp file in tmpdir, then renames into place so
 * a concurrent skill watcher never reads a partial file. Creates parent
 * directories as needed.
 */
export async function emitRoleAsSkill(params: SkillEmitParams): Promise<{
  ok: boolean;
  path?: string;
  error?: string;
}> {
  const safeKey = sanitizeRoleKey(params.roleKey);
  if (!safeKey) {
    return { ok: false, error: `unsafe roleKey: ${JSON.stringify(params.roleKey)}` };
  }
  const skillDir = path.join(params.dir, safeKey);
  const skillFile = path.join(skillDir, "SKILL.md");
  const tmpPath = path.join(tmpdir(), `nextclaw-skill-${randomBytes(6).toString("hex")}.md`);
  const content = buildSkillMarkdown(params, safeKey);
  try {
    await mkdir(skillDir, { recursive: true, mode: 0o755 });
    await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o644 });
    await rename(tmpPath, skillFile);
    params.logger?.info?.(
      `skill-emit: wrote ${skillFile} (${content.length} bytes, role=${safeKey})`,
    );
    return { ok: true, path: skillFile };
  } catch (e) {
    const msg = (e as Error).message;
    params.logger?.warn?.(`skill-emit: failed for role ${safeKey}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Default skill emit directory. Lives under the user's openclaw workspace
 * skills root (which OpenClaw scans by default), under a subfolder we own
 * so we don't collide with hand-written skills.
 */
export function defaultSkillEmitDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".openclaw", "skills", "nextclaw-roles");
}
