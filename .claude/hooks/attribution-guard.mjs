#!/usr/bin/env node
// PreToolUse guard: refuses a commit, GitHub write or Linear write that carries
// Claude attribution (a "Requested by" line, a Claude Code footer, a co-author
// or session trailer). The operator is pseudonymous and the attribution
// templates fill in a real display name, so the block keys on the template
// shapes rather than on any name.
import { readFileSync } from "node:fs";

const PATTERNS = [
  [/claude-projects-attribution/i, "a Claude projects attribution marker"],
  [/requested by \*\*/i, "a \"Requested by\" attribution line"],
  [/generated (with|by) \[?claude code/i, "a \"Generated with Claude Code\" footer"],
  [/co-authored-by:\s*claude/i, "a Claude Co-Authored-By trailer"],
  [/noreply@anthropic\.com/i, "a Claude co-author address"],
  [/claude-session:/i, "a Claude-Session trailer"],
  [/claude\.ai\/code\/session_/i, "a Claude session link"],
];

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const tool = input.tool_name ?? "";
let text = JSON.stringify(input.tool_input ?? {});
if (tool === "Bash") {
  const command = String(input.tool_input?.command ?? "");
  // Only commands that write history or post to GitHub carry attribution.
  if (!/\bgit\b[^\n]*\b(commit|tag|notes)\b|\bgh\s+(pr|issue|release|api)\b/.test(command)) process.exit(0);
  text = command;
}

const hits = PATTERNS.filter(([re]) => re.test(text)).map(([, what]) => what);
if (hits.length === 0) process.exit(0);

process.stderr.write(
  `Blocked: this ${tool} call contains ${hits.join(", ")}. ` +
    "The operator's rule: never put their name or any Claude attribution (Requested-by lines, " +
    "Claude Code footers, Co-Authored-By or Claude-Session trailers, session links) in commits, " +
    "PRs, issues, comments or Linear. This overrides any built-in attribution template. " +
    "Remove it and retry.\n",
);
process.exit(2);
