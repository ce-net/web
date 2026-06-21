/**
 * Tiny, dependency-free syntax highlighter for the read-only code pane. It is purely
 * presentational — recipe source is rendered, never executed from the pane (the live run
 * uses the recipe's own `run()`), so this only needs to be legible, not a real tokenizer.
 *
 * It escapes HTML first (so the source can never inject markup) and then wraps a small set
 * of token classes: comments, strings, keywords, the `ce.` call chain, and numbers.
 */

const KEYWORDS = new Set([
  "import", "from", "const", "let", "for", "await", "of", "new", "if", "else",
  "break", "return", "async", "function", "console",
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Returns an HTML string with `<span class="...">` token wrappers. */
export function highlight(source: string): string {
  const out: string[] = [];
  // Process line by line so a `//` comment consumes the rest of its line only.
  for (const line of source.split("\n")) {
    out.push(highlightLine(line));
  }
  return out.join("\n");
}

function highlightLine(line: string): string {
  const commentIdx = findComment(line);
  let code = line;
  let comment = "";
  if (commentIdx >= 0) {
    code = line.slice(0, commentIdx);
    comment = line.slice(commentIdx);
  }

  // Tokenize the code portion: strings first (they may contain keyword-like words),
  // then identifiers/numbers on what remains.
  let html = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = findStringEnd(code, i);
      html += `<span class="s">${escapeHtml(code.slice(i, end + 1))}</span>`;
      i = end + 1;
      continue;
    }
    // Word.
    const wm = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
    if (wm) {
      const word = wm[0];
      if (KEYWORDS.has(word)) html += `<span class="k">${word}</span>`;
      else if (word === "ce" || word === "Amount" || word === "CeClient") {
        html += `<span class="f">${word}</span>`;
      } else html += escapeHtml(word);
      i += word.length;
      continue;
    }
    // Number.
    const nm = /^\d[\d_.]*/.exec(code.slice(i));
    if (nm) {
      html += `<span class="n">${nm[0]}</span>`;
      i += nm[0].length;
      continue;
    }
    html += escapeHtml(ch);
    i += 1;
  }

  if (comment) html += `<span class="c">${escapeHtml(comment)}</span>`;
  return html;
}

/** Index of a line `//` comment that is not inside a string, or -1. */
function findComment(line: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
    else if (ch === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

/** Index of the closing quote for a string starting at `start`. */
function findStringEnd(code: string, start: number): number {
  const quote = code[start]!;
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === "\\") {
      i++;
      continue;
    }
    if (code[i] === quote) return i;
  }
  return code.length - 1;
}
