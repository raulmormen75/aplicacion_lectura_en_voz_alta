/** Reconstruct PDF.js text in the browser without sending the document elsewhere. */
export type PdfSourceBlock = {
  kind: "heading" | "subheading" | "paragraph" | "bullet";
  text: string;
};

export type PdfStructureOptions = {
  styles?: Record<string, { fontFamily?: string }>;
  structure?: unknown;
  pageWidth?: number;
  pageHeight?: number;
};

export type PdfStructureResult = {
  text: string;
  needsReview: boolean;
  usedTags: boolean;
  blocks: PdfSourceBlock[];
};

// Match import-file.ts budgets; marked-content events also count as fragments.
const MAX_ITEMS = 20_000;
const MAX_CHARS = 100_000;
const MAX_DIMENSION = 14_400;
const MAX_TREE_NODES = 40_000;
const MAX_TREE_DEPTH = 64;
const BULLET_GLYPHS = /^[\u2022\u00b7\u25aa\u25ab\u25a0\u25a1\u25c6\u25c7\u25cb\u25cf\u25e6]\s*/u;
const BULLET_MARKER = /^(?:[-*]|(?:\d+(?:\.\d+)*|[a-zA-Z])[.)])\s+/u;
const MARKER_ONLY = /^(?:[-*\u2022\u00b7\u25aa\u25ab\u25a0\u25a1\u25c6\u25c7\u25cb\u25cf\u25e6]|(?:\d+(?:\.\d+)*|[a-zA-Z])[.)])$/u;

export class PdfStructureLimitError extends Error {}

type PdfItem = { str: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean; fontName?: string; paragraphId?: number };
type SourceFragment = { item: PdfItem; index: number; id?: string; text: string };
type PdfPart = {
  x: number; y: number; width: number; height: number; text: string; bold: boolean; index: number;
  paragraphId?: number; spaceNeighbor?: number;
};
type PdfLine = { y: number; height: number; parts: PdfPart[] };
type PdfReadingLine = {
  y: number; x: number; end: number; height: number; text: string; bullet: boolean;
  contentX: number; bold: boolean; parts: PdfPart[]; paragraphId?: number;
};
type GeometryResult = Omit<PdfStructureResult, "usedTags"> & { orderedParts: PdfPart[] };
type TaggedDraft = { kind: PdfSourceBlock["kind"]; fragments: SourceFragment[] };
type TaggedPlan = { drafts: TaggedDraft[]; artifacts: Set<number>; table: boolean; complete: boolean };

function limit(message: string): never {
  throw new PdfStructureLimitError(`${message} Divide el documento en archivos más pequeños e intenta de nuevo.`);
}

function checkTextSize(length: number) {
  if (length > MAX_CHARS) limit(`El texto supera el límite de ${MAX_CHARS.toLocaleString("es-MX")} caracteres.`);
}

function ambiguousPdf(): never {
  throw new Error("No se pudo establecer un orden de lectura fiable para esta página PDF (columnas, tabla o texto girado). Exporta una versión de una columna o copia el texto en el lector para revisarlo.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFragments(items: unknown[]) {
  if (items.length > MAX_ITEMS) limit(`Una página PDF supera el límite de ${MAX_ITEMS.toLocaleString("es-MX")} fragmentos de texto.`);
  const fragments: SourceFragment[] = [];
  const stack: { id?: string; artifact: boolean }[] = [];
  let chars = 0;
  let validMarking = true;
  for (let index = 0; index < items.length; index++) {
    const value = items[index];
    if (!record(value)) continue;
    if (value.type === "beginMarkedContent" || value.type === "beginMarkedContentProps") {
      const parent = stack[stack.length - 1];
      const id = typeof value.id === "string" && value.id.length <= 256 ? value.id : undefined;
      if (typeof value.id === "string" && value.id.length > 256) validMarking = false;
      stack.push({ id: id ?? parent?.id, artifact: !!parent?.artifact || value.tag === "Artifact" });
      if (stack.length > MAX_TREE_DEPTH) validMarking = false;
      continue;
    }
    if (value.type === "endMarkedContent") {
      if (!stack.length) validMarking = false;
      else stack.pop();
      continue;
    }
    if (typeof value.str !== "string") continue;
    // Count discarded artifacts too, so a tag cannot bypass the input budget.
    chars += value.str.length;
    checkTextSize(chars);
    const active = stack[stack.length - 1];
    if (active?.artifact) continue;
    const text = value.str.trim();
    // Whitespace-only items can carry a space or an explicit line ending in a
    // page without geometry. Retain them, but do not require a semantic tag.
    fragments.push({ item: value as PdfItem, index, id: active?.id, text });
  }
  if (stack.length) validMarking = false;
  return { fragments, validMarking };
}

/** Use exact PDF.js IDs, never synthesize an ID from a numeric MCID or role. */
function taggedPlan(structure: unknown, fragments: SourceFragment[], validMarking: boolean): TaggedPlan | undefined {
  if (!validMarking || !record(structure) || !fragments.some((fragment) => fragment.text)) return undefined;
  const byId = new Map<string, SourceFragment[]>();
  let complete = true;
  for (const fragment of fragments) {
    if (!fragment.text) continue;
    if (!fragment.id) { complete = false; continue; }
    const values = byId.get(fragment.id) ?? [];
    values.push(fragment);
    byId.set(fragment.id, values);
  }
  for (const fragment of fragments) {
    if (!fragment.text && fragment.id) byId.get(fragment.id)?.push(fragment);
  }
  for (const values of byId.values()) values.sort((a, b) => a.index - b.index);
  type Frame = { node: unknown; depth: number; draft?: TaggedDraft; inList: boolean; artifact: boolean; table: boolean };
  const pending: Frame[] = [{ node: structure, depth: 0, inList: false, artifact: false, table: false }];
  const visited = new WeakSet<object>();
  const usedIds = new Set<string>();
  const artifacts = new Set<number>();
  const drafts: TaggedDraft[] = [];
  const closedDrafts = new Set<TaggedDraft>();
  let lastDraft: TaggedDraft | undefined;
  let nodes = 0;
  let table = false;
  try {
    while (pending.length) {
      const frame = pending.pop()!;
      if (++nodes > MAX_TREE_NODES || frame.depth > MAX_TREE_DEPTH || !record(frame.node)) return undefined;
      const node = frame.node;
      if (visited.has(node)) return undefined;
      visited.add(node);
      if (node.type === "content" || node.type === "object") {
        if (node.type === "object") continue;
        if (typeof node.id !== "string" || node.id.length > 256) return undefined;
        const values = byId.get(node.id);
        // Non-text content such as an image may legitimately have a reference.
        if (!values) continue;
        if (usedIds.has(node.id)) return undefined;
        usedIds.add(node.id);
        if (frame.table) table = true;
        if (frame.artifact) values.forEach((fragment) => artifacts.add(fragment.index));
        else if (!frame.table) {
          if (!frame.draft) complete = false;
          else {
            if (lastDraft !== frame.draft) {
              if (lastDraft) closedDrafts.add(lastDraft);
              // A parent contributing text before and after a child block
              // cannot safely be flattened into one earlier paragraph.
              if (closedDrafts.has(frame.draft)) complete = false;
              lastDraft = frame.draft;
            }
            // Blocks enter the output when their first content is encountered,
            // not when a possibly empty enclosing structure node is visited.
            if (!frame.draft.fragments.length) drafts.push(frame.draft);
            frame.draft.fragments.push(...values);
          }
        }
        continue;
      }
      if (typeof node.role !== "string" || !Array.isArray(node.children)) return undefined;
      const role = node.role;
      const artifact = frame.artifact || role === "Artifact";
      const inTable = frame.table || /^(?:Table|TR|TH|TD|THead|TBody|TFoot)$/u.test(role);
      let draft = frame.draft;
      let inList = frame.inList;
      let kind: PdfSourceBlock["kind"] | undefined;
      if (!artifact && !inTable) {
        if (role === "H" || role === "H1") kind = "heading";
        else if (/^H[2-6]$/u.test(role)) kind = "subheading";
        else if (role === "LI") {
          // A nested LI with text following its nested list needs richer block
          // ownership. Fall back rather than moving that text before the list.
          if (inList) return undefined;
          kind = "bullet";
          inList = true;
        } else if (/^(?:P|BlockQuote|Caption|Note|Code)$/u.test(role) && !inList) {
          if (draft?.kind === "heading" || draft?.kind === "subheading") return undefined;
          kind = "paragraph";
        } else if ((role === "Lbl" || role === "LBody") && !inList) return undefined;
      }
      if (kind) {
        draft = { kind, fragments: [] };
      }
      if (node.children.length > MAX_TREE_NODES - nodes - pending.length) return undefined;
      for (let index = node.children.length - 1; index >= 0; index--) {
        pending.push({ node: node.children[index], depth: frame.depth + 1, draft, inList, artifact, table: inTable });
      }
    }
    if (usedIds.size !== byId.size) complete = false;
    return { drafts, artifacts, table, complete };
  } catch {
    // PDF structure is untrusted, including property access and malformed trees.
    // Geometry still receives every non-artifact fragment if this fails.
    return undefined;
  }
}

function weightedHeight(values: { height: number; text: string }[]) {
  let remaining = values.reduce((sum, value) => sum + value.text.length, 0) / 2;
  for (const value of [...values].sort((a, b) => a.height - b.height)) {
    remaining -= value.text.length;
    if (remaining <= 0) return value.height;
  }
  return 12;
}

function boldFont(item: PdfItem, styles?: PdfStructureOptions["styles"]) {
  if (typeof item.fontName !== "string" || item.fontName.length > 512) return false;
  try {
    const family = styles?.[item.fontName]?.fontFamily;
    const name = `${item.fontName} ${typeof family === "string" && family.length <= 512 ? family : ""}`;
    return /(?:bold|semibold|demi)/iu.test(name);
  } catch { return false; }
}

function readingLine(line: PdfLine): PdfReadingLine {
  // A short superscript or bullet glyph must not determine the line's font size.
  const height = weightedHeight(line.parts);
  const fragments: string[] = [];
  let previousEnd = -Infinity;
  let previousPart: PdfPart | undefined;
  for (const part of line.parts) {
    const explicitSpace = !!previousPart && (part.spaceNeighbor === previousPart.index || previousPart.spaceNeighbor === part.index);
    if (fragments.length && (explicitSpace || part.x - previousEnd > height * 0.24)) fragments.push(" ");
    fragments.push(part.text);
    previousEnd = Math.max(previousEnd, part.x + part.width);
    previousPart = part;
  }
  const text = fragments.join("").replace(/\s+/gu, " ").trim().replace(BULLET_GLYPHS, "- ");
  const marker = text.match(BULLET_MARKER);
  const x = line.parts[0].x;
  const firstPartIsMarker = MARKER_ONLY.test(line.parts[0].text);
  const contentX = firstPartIsMarker && line.parts.length > 1 ? line.parts[1].x
    : x + (marker?.[0].length ?? 0) * height * 0.45;
  const boldChars = line.parts.reduce((sum, part) => sum + (part.bold ? part.text.length : 0), 0);
  const paragraphIds = new Set(line.parts.map((part) => part.paragraphId).filter((id) => id !== undefined));
  if (paragraphIds.size > 1) ambiguousPdf();
  return { y: line.y, x, end: previousEnd, height, text, bullet: !!marker, contentX,
    bold: boldChars >= line.parts.reduce((sum, part) => sum + part.text.length, 0) * 0.85, parts: line.parts,
    paragraphId: paragraphIds.values().next().value };
}

// Only a persistent empty gutter supports column order. Full-width headings and
// paragraphs divide vertical bands; each band's left column precedes its right.
function columnGutter(rows: PdfLine[], runs: PdfReadingLine[][], span: number, bodyHeight: number): number | undefined {
  if (runs.filter((row) => row.length > 2).length >= 2) ambiguousPdf();
  // An aligned series of short labels and numeric values is table evidence,
  // rather than two prose columns. Do not turn its cells into paragraphs.
  const numericRows = runs.filter((row) => row.length === 2 && row.every((line) => line.text.length <= 60)
    && /^[-+\d$€£¥%.,\s/():]+$/u.test(row[1].text));
  if (numericRows.length >= 3 && numericRows.length >= rows.length * 0.6) ambiguousPdf();
  const gaps = runs.flatMap((row) => row.length === 2
    ? [{ left: row[0].end + row[0].height * 0.5, right: row[1].x - row[1].height * 0.5 }] : []);
  const events = gaps.flatMap((gap) => gap.right > gap.left ? [{ x: gap.left, delta: 1 }, { x: gap.right, delta: -1 }] : [])
    .sort((a, b) => a.x - b.x);
  const support = Math.max(2, Math.ceil(rows.length * 0.25));
  const regions: { left: number; right: number }[] = [];
  let count = 0;
  for (let index = 0; index < events.length;) {
    const x = events[index].x;
    while (index < events.length && events[index].x === x) count += events[index++].delta;
    const next = events[index]?.x;
    if (next !== undefined && next > x && count >= support) {
      const previous = regions[regions.length - 1];
      if (previous?.right === x) previous.right = next;
      else regions.push({ left: x, right: next });
    }
  }
  if (regions.length > 1) ambiguousPdf();
  if (regions.length) return (regions[0].left + regions[0].right) / 2;
  // Staggered baselines may never put both columns in the same row. In that
  // case require a global empty gutter with at least two lines on either side.
  const narrow = runs.flat().filter((line) => line.end - line.x < span * 0.65 && line.height < bodyHeight * 1.2)
    .sort((a, b) => a.x - b.x);
  const occupied: { left: number; right: number; count: number }[] = [];
  for (const line of narrow) {
    const previous = occupied[occupied.length - 1];
    if (previous && line.x <= previous.right) {
      previous.right = Math.max(previous.right, line.end);
      previous.count++;
    } else occupied.push({ left: line.x, right: line.end, count: 1 });
  }
  let leftCount = 0;
  const candidates: number[] = [];
  for (let index = 0; index < occupied.length - 1; index++) {
    leftCount += occupied[index].count;
    const gap = occupied[index + 1].left - occupied[index].right;
    if (leftCount >= 2 && narrow.length - leftCount >= 2 && gap > Math.max(bodyHeight * 1.25, span * 0.025)) {
      candidates.push((occupied[index + 1].left + occupied[index].right) / 2);
    }
  }
  if (candidates.length > 1) ambiguousPdf();
  return candidates[0];
}

function appendLine(parts: string[], text: string) {
  const last = parts.length - 1;
  if (parts[last].endsWith("-") && /^[\p{Ll}\p{M}]/u.test(text)) {
    parts[last] = parts[last].slice(0, -1);
    parts.push(text);
  } else parts.push(` ${text}`);
}

function renderPdfLines(ordered: PdfReadingLine[], bodyHeight: number, mainHeadingHeight: number): PdfSourceBlock[] {
  // Bucket comparable fonts once; adversarial unique font sizes stay bounded.
  const fontBucket = (height: number) => Math.round(Math.log(height) / Math.log(1.15));
  const spacing = new Map<number, number[]>();
  for (let index = 1; index < ordered.length; index++) {
    const line = ordered[index];
    const previous = ordered[index - 1];
    if (Math.max(previous.height, line.height) / Math.min(previous.height, line.height) > 1.15) continue;
    const gap = previous.y - line.y;
    if (gap >= line.height * 0.5 && gap <= line.height * 4) {
      const key = fontBucket(line.height);
      const values = spacing.get(key) ?? [];
      values.push(gap);
      spacing.set(key, values);
    }
  }
  const leading = new Map([...spacing].map(([key, gaps]) => {
    gaps.sort((a, b) => a - b);
    return [key, gaps[Math.floor((gaps.length - 1) * 0.35)]];
  }));
  const leadingFor = (height: number) => leading.get(fontBucket(height)) ?? height * 1.5;
  const blocks: { parts: string[]; kind: PdfSourceBlock["kind"]; heading: boolean; bullet: boolean; contentX: number }[] = [];
  ordered.forEach((line, index) => {
    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    const block = blocks[blocks.length - 1];
    const baseline = previous ? Math.max(leadingFor(previous.height), leadingFor(line.height)) : leadingFor(line.height);
    const paragraphGap = !!previous && previous.y - line.y > Math.max(baseline * 1.35, baseline + line.height * 0.4);
    const boldIsolatedTitle = line.bold && line.height >= bodyHeight * 0.95 && line.height <= bodyHeight * 1.15
      && !/[.!?;,]$/u.test(line.text) && (!!previous ? paragraphGap : true)
      && !!next && !next.bold && line.y - next.y > leadingFor(next.height) * 1.25;
    // Shortness alone never identifies a title. Require typography or a bold,
    // isolated line whose following body confirms a change in visual hierarchy.
    const numberedTitle = /^\d+(?:\.\d+)*[.)]\s+/u.test(line.text) && line.height >= bodyHeight * 1.2;
    const heading = (!line.bullet || numberedTitle) && line.text.length <= 180 && (line.height >= bodyHeight * 1.2 || boldIsolatedTitle);
    const kind: PdfSourceBlock["kind"] = heading
      ? (line.height >= bodyHeight * 1.5 && line.height >= mainHeadingHeight * 0.9 ? "heading" : "subheading")
      : line.bullet ? "bullet" : "paragraph";
    const fontChange = !!previous && Math.max(previous.height, line.height) / Math.min(previous.height, line.height) > 1.25;
    const indentation = !!previous && !block?.bullet && /[.!?]$/u.test(previous.text) && line.x - previous.x > line.height * 0.8;
    const listEnded = !!block?.bullet && line.x < block.contentX - line.height * 0.4;
    const knownParagraphChange = previous?.paragraphId !== undefined && line.paragraphId !== undefined && previous.paragraphId !== line.paragraphId;
    const headingContinuation = heading && block?.heading && block.kind === kind && !!previous && !paragraphGap && !knownParagraphChange
      && Math.max(previous.height, line.height) / Math.min(previous.height, line.height) <= 1.15;
    if (!block || ((heading || block.heading) && !headingContinuation) || line.bullet || paragraphGap || fontChange || indentation || listEnded || knownParagraphChange) {
      blocks.push({ parts: [line.text], kind, heading, bullet: kind === "bullet", contentX: line.contentX });
    } else appendLine(block.parts, line.text);
  });
  return blocks.map((block) => ({ kind: block.kind, text: block.parts.join("") }));
}

function serializedBlocks(blocks: PdfSourceBlock[]) {
  return blocks.map((block) => block.kind === "heading" ? `# ${block.text}` : block.kind === "subheading" ? `### ${block.text}`
    : block.kind === "bullet" && !BULLET_MARKER.test(block.text) ? `- ${block.text}` : block.text).join("\n\n");
}

function geometry(fragments: SourceFragment[], options: PdfStructureOptions): GeometryResult {
  const parts: PdfPart[] = [];
  let unpositioned = 0;
  let priorIndex: number | undefined;
  let priorTrailingSpace = false;
  let pendingWhitespace = false;
  for (const { item, text, index } of fragments) {
    if (!text) {
      pendingWhitespace ||= /\s/u.test(item.str);
      continue;
    }
    // PDF.js may emit a separate, very narrow space at a font change. Preserve
    // that explicit separator independently of the visual gap threshold. The
    // two source neighbors also work when extraction order is reversed.
    const spaceNeighbor = pendingWhitespace || priorTrailingSpace || /^\s/u.test(item.str) ? priorIndex : undefined;
    priorIndex = index;
    priorTrailingSpace = /\s$/u.test(item.str);
    pendingWhitespace = false;
    if (!item.transform) { unpositioned++; continue; }
    if (!Array.isArray(item.transform) || item.transform.length < 6
      || item.transform.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000)
      || (item.width !== undefined && (!Number.isFinite(item.width) || item.width < 0))
      || (item.height !== undefined && !Number.isFinite(item.height))
      || (item.paragraphId !== undefined && (!Number.isSafeInteger(item.paragraphId) || item.paragraphId < 0))) ambiguousPdf();
    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > Math.abs(a) * 0.1 || Math.abs(c) > Math.abs(d) * 0.1) ambiguousPdf();
    const height = Math.max(Math.abs(item.height ?? 0), Math.hypot(c, d), 1);
    const width = Math.max(item.width ?? text.length * height * 0.45, 0);
    if (height > MAX_DIMENSION || width > 1_000_000) ambiguousPdf();
    parts.push({ x, y, width, height, text, bold: boldFont(item, options.styles), index, paragraphId: item.paragraphId, spaceNeighbor });
  }
  if (!parts.length) {
    const text = fragments.map(({ item }) => item.str + (item.hasEOL ? "\n" : "")).join("").trim();
    checkTextSize(text.length);
    const blocks: PdfSourceBlock[] = text ? text.split(/\n\s*\n/u).filter((value) => value.trim())
      .map((value) => ({ kind: "paragraph", text: value.trim() })) : [];
    return { text, needsReview: !!text, blocks, orderedParts: [] };
  }
  if (unpositioned) ambiguousPdf();
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const part of parts) {
    let line = lines[lines.length - 1];
    if (!line || Math.abs(line.y - part.y) > Math.max(2, part.height * 0.35)) {
      line = { y: part.y, height: part.height, parts: [] };
      lines.push(line);
    }
    line.height = Math.max(line.height, part.height);
    line.parts.push(part);
  }
  for (const line of lines) line.parts.sort((a, b) => a.x - b.x);
  let minimumX = Infinity;
  let maximumX = -Infinity;
  for (const part of parts) {
    minimumX = Math.min(minimumX, part.x);
    maximumX = Math.max(maximumX, part.x + part.width);
  }
  const span = maximumX - minimumX;
  const runs = lines.map((line) => {
    const groups: PdfLine[] = [];
    let end = -Infinity;
    for (const part of line.parts) {
      let group = groups[groups.length - 1];
      const groupParagraphId = group?.parts[0]?.paragraphId;
      const paragraphChanged = groupParagraphId !== undefined && part.paragraphId !== undefined && groupParagraphId !== part.paragraphId;
      if (!group || paragraphChanged || part.x - end > Math.max(line.height * 1.25, span * 0.025)) {
        group = { y: line.y, height: line.height, parts: [] };
        groups.push(group);
      }
      group.parts.push(part);
      end = Math.max(end, part.x + part.width);
    }
    return groups.map(readingLine);
  });
  const bodyHeight = weightedHeight(runs.flat());
  const mainHeadingHeight = Math.max(bodyHeight, ...runs.flat().filter((line) => line.text.length <= 180
    && (!line.bullet || /^\d+(?:\.\d+)*[.)]\s+/u.test(line.text))).map((line) => line.height));
  const gutter = columnGutter(lines, runs, span, bodyHeight);
  const sections: PdfReadingLine[][] = [];
  if (gutter === undefined) sections.push(lines.map(readingLine));
  else {
    let left: PdfReadingLine[] = [];
    let right: PdfReadingLine[] = [];
    let wide: PdfReadingLine[] = [];
    const flushColumns = () => {
      if (left.length) sections.push(left);
      if (right.length) sections.push(right);
      left = []; right = [];
    };
    const flushWide = () => {
      if (wide.length) sections.push(wide);
      wide = [];
    };
    for (const row of runs) {
      const crossing = row.some((line) => line.x < gutter && line.end > gutter);
      if (crossing) {
        if (row.length > 1) ambiguousPdf();
        flushColumns();
        wide.push(row[0]);
      } else {
        flushWide();
        for (const line of row) (line.end <= gutter ? left : right).push(line);
      }
    }
    flushWide();
    flushColumns();
  }
  const blocks = sections.flatMap((section) => renderPdfLines(section, bodyHeight, mainHeadingHeight));
  const text = serializedBlocks(blocks);
  checkTextSize(text.length);
  return { text, needsReview: gutter !== undefined, blocks, orderedParts: sections.flatMap((section) => section.flatMap((line) => line.parts)) };
}

function taggedText(fragments: SourceFragment[], partMap: Map<number, PdfPart>, rank: Map<number, number>, kind: PdfSourceBlock["kind"]) {
  if (!partMap.size) {
    const text = fragments.map(({ item }, index) => (kind === "bullet" && index === 1 && MARKER_ONLY.test(fragments[0].text) ? " " : "")
      + item.str + (item.hasEOL ? "\n" : "")).join("");
    return text.replace(/\s+/gu, " ").trim().replace(BULLET_GLYPHS, "- ");
  }
  // References already follow logical tree order. Geometry may order fragments
  // inside one MCID, but must never reorder separate references in a paragraph.
  const groups: SourceFragment[][] = [];
  for (const fragment of fragments) {
    const group = groups[groups.length - 1];
    if (!group || group[0].id !== fragment.id) groups.push([fragment]);
    else group.push(fragment);
  }
  const parts = groups.flatMap((group) => group.filter((fragment) => fragment.text).map((fragment) => partMap.get(fragment.index)!)
    .sort((a, b) => rank.get(a.index)! - rank.get(b.index)!));
  const texts: string[] = [];
  let previous: PdfPart | undefined;
  for (const part of parts) {
    if (!previous) texts.push(part.text);
    else {
      const sameLine = Math.abs(previous.y - part.y) <= Math.max(2, part.height * 0.35) && part.x >= previous.x;
      if (!sameLine) appendLine(texts, part.text);
      else {
        const gap = part.x - (previous.x + previous.width);
        const labelBoundary = kind === "bullet" && texts.length === 1 && MARKER_ONLY.test(previous.text);
        const explicitSpace = part.spaceNeighbor === previous.index || previous.spaceNeighbor === part.index;
        texts.push(`${labelBoundary || explicitSpace || gap > Math.max(previous.height, part.height) * 0.24 ? " " : ""}${part.text}`);
      }
    }
    previous = part;
  }
  return texts.join("").replace(/\s+/gu, " ").trim().replace(BULLET_GLYPHS, "- ");
}

export function reconstructPdfPage(items: unknown[], options: PdfStructureOptions = {}): PdfStructureResult {
  const { fragments, validMarking } = readFragments(items);
  const plan = taggedPlan(options.structure, fragments, validMarking);
  if (plan?.table) ambiguousPdf();
  const trustedPlan = plan?.complete ? plan : undefined;
  const useful = trustedPlan ? fragments.filter((fragment) => !trustedPlan.artifacts.has(fragment.index)) : fragments;
  // Tags do not bypass the existing rotated, mixed-position or column guards.
  const result = geometry(useful, options);
  if (!trustedPlan) return { text: result.text, blocks: result.blocks, usedTags: false,
    needsReview: result.needsReview || (options.structure !== undefined && options.structure !== null) || !validMarking };
  const partMap = new Map(result.orderedParts.map((part) => [part.index, part]));
  const rank = new Map(result.orderedParts.map((part, index) => [part.index, index]));
  const blocks = trustedPlan.drafts.filter((draft) => draft.fragments.some((fragment) => fragment.text)).map((draft) => ({
    kind: draft.kind, text: taggedText(draft.fragments, partMap, rank, draft.kind),
  })).filter((block) => block.text);
  const text = serializedBlocks(blocks);
  checkTextSize(text.length);
  return { text, blocks, usedTags: true, needsReview: useful.some((fragment) => !fragment.item.transform) };
}
