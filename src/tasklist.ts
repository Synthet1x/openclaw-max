/**
 * Task-list rendering for MAX.
 *
 * MAX has no native checkbox entity, so a markdown task list would arrive as
 * raw `- [ ] текст`. This converts task-list lines into a visual checklist that
 * survives plain text and reads the same on every MAX client:
 *
 *   - [ ] Собрать данные   →  ⬜ Собрать данные
 *   - [x] Проверить        →  ✅ Проверить
 *   - [~] В работе         →  🔄 В работе
 *
 * Everything outside task-list lines is left byte-identical.
 */

const CHECK_PENDING = "⬜";
const CHECK_DONE = "✅";
const CHECK_ACTIVE = "🔄";
const CHECK_SKIPPED = "⏭️";

const TASK_LINE = /^(\s*)[-*+]\s+\[( |x|X|~|\/|-)\]\s+(.*)$/;

function glyphFor(mark: string): string {
  switch (mark) {
    case "x":
    case "X":
      return CHECK_DONE;
    case "~":
    case "/":
      return CHECK_ACTIVE;
    case "-":
      return CHECK_SKIPPED;
    default:
      return CHECK_PENDING;
  }
}

/** Convert markdown task-list lines to visible checklist lines. */
export function renderTaskList(text: string): string {
  if (!text || (!text.includes("[ ]") && !text.includes("[x") && !text.includes("[X") && !text.includes("[~"))) {
    return text;
  }

  let changed = false;
  const out = text.split("\n").map((line) => {
    const match = TASK_LINE.exec(line);
    if (!match) return line;
    const [, indent, mark, body] = match;
    // Nested lists keep their indentation, one level = two spaces.
    changed = true;
    return `${indent}${glyphFor(mark)} ${body}`;
  });

  return changed ? out.join("\n") : text;
}

/** True when the text already carries checklist glyphs (idempotency guard). */
export function hasChecklistGlyphs(text: string): boolean {
  return /(?:^|\n)\s*(?:⬜|✅|🔄|⏭️)\s/.test(text || "");
}
