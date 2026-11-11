/**
 * Staged plan animation for MAX.
 *
 * MAX has no native checkbox entity and no message-editing UI of its own, so a
 * "live" checklist is built from two primitives the Bot API does expose:
 *
 *   1. `PUT /messages?message_id=…` rewrites one message in place;
 *   2. the glyphs ⬜ / 🔄 / ✅ / ⏭️ read as a checklist on every MAX client.
 *
 * This module owns the state machine. A plan is captured from a checklist the
 * model already narrates, then advanced one stage at a time while the turn
 * runs, so the user watches ⬜ → 🔄 → ✅ instead of a static block.
 *
 * Everything here is pure: no network, no timers, no logging. The channel
 * decides when to advance and how often to edit.
 */

export type StageMark = "pending" | "active" | "done" | "skipped";

export interface PlanStage {
  /** Leading whitespace, preserved so nested steps keep their nesting. */
  indent: string;
  label: string;
}

const TASK_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s*\[( |x|X|~|\/|-)\]\s*(.*)$/;

const GLYPH: Record<StageMark, string> = {
  pending: "⬜",
  active: "🔄",
  done: "✅",
  skipped: "⏭️",
};

/** Collect checklist entries in source order. Non-task lines are ignored. */
export function extractPlan(text: string): PlanStage[] {
  if (!text) return [];
  const stages: PlanStage[] = [];
  for (const line of text.split("\n")) {
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const label = (match[3] ?? "").trimEnd();
    if (!label) continue;
    stages.push({ indent: match[1] ?? "", label });
  }
  return stages;
}

/**
 * First non-empty line before the checklist, used as the plan title.
 * Returns an empty string when the checklist starts the message.
 */
export function extractPlanHeader(text: string): string {
  if (!text) return "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TASK_LINE.test(line)) return "";
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  }
  return "";
}

/** True when a message carries at least two checklist entries worth animating. */
export function hasAnimatablePlan(text: string): boolean {
  return extractPlan(text).length >= 2;
}

/**
 * Stage cursor for one plan. The first stage starts active; `advance()` retires
 * the current stage and promotes the next; `complete()` closes everything out.
 */
export class StageAnimator {
  private readonly stages: PlanStage[];
  private marks: StageMark[];
  private cursor = 0;

  constructor(stages: PlanStage[]) {
    this.stages = stages.map((stage) => ({ indent: stage.indent, label: stage.label }));
    this.marks = this.stages.map((_, index) => (index === 0 ? "active" : "pending"));
  }

  get size(): number {
    return this.stages.length;
  }

  get doneCount(): number {
    return this.marks.filter((mark) => mark === "done").length;
  }

  /** True when the last stage reached `done`. */
  get finished(): boolean {
    return this.stages.length > 0 && this.marks[this.stages.length - 1] === "done";
  }

  /**
   * True when `stages` describes the same plan (same labels, same order).
   * Used to avoid re-rendering an answer whose checklist the model rewrote
   * with different wording than the plan captured at the start of the turn.
   */
  matches(stages: PlanStage[]): boolean {
    if (stages.length !== this.stages.length) return false;
    return stages.every((stage, index) => stage.label === this.stages[index].label);
  }

  /** Promote the next stage. Returns false at the end of the plan. */
  advance(): boolean {
    if (this.cursor >= this.stages.length - 1) return false;
    this.marks[this.cursor] = "done";
    this.cursor += 1;
    this.marks[this.cursor] = "active";
    return true;
  }

  /** Close every stage as done, used when the answer is finally delivered. */
  complete(): void {
    this.cursor = Math.max(0, this.stages.length - 1);
    this.marks = this.stages.map(() => "done" as StageMark);
  }

  /** Mark one stage skipped, leaving the cursor alone. */
  skip(index: number): void {
    if (index < 0 || index >= this.marks.length) return;
    this.marks[index] = "skipped";
  }

  /** Render the checklist body, optionally prefixed by a title line. */
  render(header?: string): string {
    const lines: string[] = [];
    if (header) {
      lines.push(header, "");
    }
    this.stages.forEach((stage, index) => {
      lines.push(`${stage.indent}${GLYPH[this.marks[index]]} ${stage.label}`);
    });
    return lines.join("\n");
  }
}

/**
 * Replace the checklist block inside `text` with the animator's rendering.
 * Non-checklist lines keep their order; the animated block is emitted at the
 * position of the first checklist line, so prose above and below survives.
 */
export function substitutePlan(text: string, animator: StageAnimator): string {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => TASK_LINE.test(line));
  if (firstIndex === -1) return text;
  const before = lines.slice(0, firstIndex);
  const after = lines.slice(firstIndex).filter((line) => !TASK_LINE.test(line));
  const rendered = animator.render("").split("\n");
  return [...before, ...rendered, ...after].join("\n");
}
