/**
 * Minimal dependency-free PDF writer (text, rules, filled rectangles).
 * Uses the built-in Helvetica fonts, so no font files are embedded.
 * Limitation: standard fonts only cover Latin text. Anything else
 * (Telugu, Hindi, emoji...) is replaced with "?" - see sanitizePdfText().
 */

const W_REG =
  "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584"
    .split(" ")
    .map(Number);
const W_BOLD =
  "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584"
    .split(" ")
    .map(Number);

/** Strips accents and replaces anything outside printable ASCII with "?". */
export function sanitizePdfText(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?");
}

export function textWidth(str, size, bold = false) {
  const table = bold ? W_BOLD : W_REG;
  let total = 0;
  for (const ch of sanitizePdfText(str)) {
    total += table[ch.charCodeAt(0) - 32] ?? 556;
  }
  return (total * size) / 1000;
}

const escapePdf = (s) =>
  sanitizePdfText(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const num = (n) => Number(n).toFixed(2).replace(/\.?0+$/, "") || "0";

export class SimplePdf {
  constructor({ width = 595.28, height = 841.89, title = "Document" } = {}) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.pages = [];
    this.addPage();
  }

  addPage() {
    this.pages.push([]);
    return this;
  }

  get ops() {
    return this.pages[this.pages.length - 1];
  }

  /** y is measured from the TOP of the page, like a screen. */
  text(x, y, str, { size = 10, bold = false, align = "left", width = 0, color = [0, 0, 0] } = {}) {
    let px = x;
    if (align === "right") px = x + width - textWidth(str, size, bold);
    if (align === "center") px = x + (width - textWidth(str, size, bold)) / 2;
    const [r, g, b] = color;
    this.ops.push(
      `${num(r)} ${num(g)} ${num(b)} rg BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${num(px)} ${num(
        this.height - y,
      )} Td (${escapePdf(str)}) Tj ET`,
    );
    return this;
  }

  line(x1, y1, x2, y2, { width = 0.6, color = [0.75, 0.75, 0.75] } = {}) {
    const [r, g, b] = color;
    this.ops.push(
      `${num(r)} ${num(g)} ${num(b)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(
        x2,
      )} ${num(this.height - y2)} l S`,
    );
    return this;
  }

  rect(x, y, w, h, { fill = [0.95, 0.95, 0.95] } = {}) {
    const [r, g, b] = fill;
    this.ops.push(
      `${num(r)} ${num(g)} ${num(b)} rg ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`,
    );
    return this;
  }

  toBuffer() {
    // Object layout: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info,
    // then (page, content) pairs starting at 6.
    const objects = [];
    const pageObjIds = this.pages.map((_, i) => 6 + i * 2);

    objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${
      this.pages.length
    } >>`;
    objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
    objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
    objects[5] = `<< /Title (${escapePdf(this.title)}) /Producer (HBE) >>`;

    this.pages.forEach((ops, i) => {
      const pageId = 6 + i * 2;
      const contentId = pageId + 1;
      const stream = ops.join("\n");
      objects[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
      objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    });

    let out = "%PDF-1.4\n";
    const offsets = [];
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = Buffer.byteLength(out, "latin1");
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xrefAt = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) {
      out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}
