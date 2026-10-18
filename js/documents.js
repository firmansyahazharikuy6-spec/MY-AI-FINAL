function cleanAnswer(content) {
  const text = String(content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : text;
}

function plainText(value) {
  const html = globalThis.marked?.parse ? globalThis.marked.parse(value || "") : String(value || "");
  const safeHtml = globalThis.DOMPurify ? globalThis.DOMPurify.sanitize(html) : html;
  const container = document.createElement("div");
  container.innerHTML = safeHtml;
  return (container.textContent || "").trim();
}

function blocksFromMarkdown(markdown) {
  const tokens = globalThis.marked?.lexer ? globalThis.marked.lexer(markdown) : [{ type: "paragraph", text: markdown }];
  const blocks = [];
  for (const token of tokens) {
    if (token.type === "heading") {
      blocks.push({ type: "heading", level: token.depth, text: plainText(token.text) });
    } else if (token.type === "paragraph" || token.type === "blockquote") {
      const text = plainText(token.text);
      if (text) blocks.push({ type: token.type, text });
    } else if (token.type === "list") {
      token.items.forEach((item, index) => {
        const text = plainText(item.text);
        if (text) blocks.push({ type: "list", text, ordered: Boolean(token.ordered), index: index + 1 });
      });
    } else if (token.type === "code") {
      if (token.text) blocks.push({ type: "code", text: token.text.trim() });
    } else if (token.type === "table") {
      const headers = token.header.map((cell) => plainText(cell.text));
      const rows = token.rows.map((row) => row.map((cell) => plainText(cell.text)));
      blocks.push({ type: "table", headers, rows });
    }
  }
  return blocks;
}

function safeFilename(title, extension) {
  const base = String(title || "dokumen-myai")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "dokumen-myai";
  return `${base}.${extension}`;
}

function answerTitle(title, blocks) {
  const heading = blocks.find((block) => block.type === "heading");
  return heading?.text || (title && title !== "Chat baru" ? title : "Dokumen MyAI");
}

function withSources(blocks, citations = []) {
  const valid = citations.filter((item) => /^https?:\/\//i.test(item.url));
  if (!valid.length) return blocks;
  return [...blocks, { type: "heading", level: 2, text: "Sumber" }, ...valid.map((item) => ({
    type: "paragraph",
    text: `${item.title || item.url} - ${item.url}`,
  }))];
}

async function exportWord(title, blocks) {
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } = await import("https://cdn.jsdelivr.net/npm/docx@9.5.1/+esm");
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const block of blocks) {
    if (block.type === "heading") {
      const heading = block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2;
      children.push(new Paragraph({ text: block.text, heading }));
    } else if (block.type === "list") {
      const text = block.ordered ? `${block.index}. ${block.text}` : block.text;
      children.push(new Paragraph({ text, bullet: block.ordered ? undefined : { level: 0 } }));
    } else if (block.type === "table") {
      const rows = [block.headers, ...block.rows].map((row) => new TableRow({
        children: row.map((text) => new TableCell({ children: [new Paragraph({ text })] })),
      }));
      children.push(new Table({ rows }));
    } else if (block.text) {
      children.push(new Paragraph({ text: block.text }));
    }
  }
  const blob = await Packer.toBlob(new Document({ sections: [{ children }] }));
  saveBlob(blob, safeFilename(title, "docx"));
}

function presentationSections(blocks) {
  const firstHeading = blocks.findIndex((block) => block.type === "heading");
  const sections = [];
  let current = { title: "Ringkasan", points: [] };
  blocks.forEach((block, index) => {
    if (block.type === "heading") {
      if (index === firstHeading) return;
      if (current.points.length) sections.push(current);
      current = { title: block.text, points: [] };
    } else if (block.type === "table") {
      current.points.push(block.headers.join(" | "));
      for (const row of block.rows) current.points.push(row.join(" | "));
    } else if (block.text) {
      current.points.push(block.text);
    }
  });
  if (current.points.length) sections.push(current);
  if (!sections.length) sections.push({ title: "Ringkasan", points: ["Tidak ada isi jawaban untuk ditampilkan."] });
  return sections.flatMap((section) => {
    const slides = [];
    for (let index = 0; index < section.points.length; index += 5) {
      slides.push({
        title: index ? `${section.title} (lanjutan)` : section.title,
        points: section.points.slice(index, index + 5),
      });
    }
    return slides;
  }).slice(0, 24);
}

async function exportPowerPoint(title, blocks) {
  const imported = await import("https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/+esm");
  const PptxGenJS = imported.default || imported;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "MyAI";
  pptx.subject = "Dokumen dibuat dari jawaban MyAI";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "id-ID" };

  const cover = pptx.addSlide();
  cover.background = { color: "F2F6F4" };
  cover.addText(title, { x: 0.8, y: 1.7, w: 11.7, h: 1.5, fontFace: "Aptos Display", fontSize: 32, bold: true, color: "183B35", breakLine: false, fit: "shrink", margin: 0.05, valign: "mid" });
  cover.addText("Disusun dengan MyAI", { x: 0.85, y: 3.45, w: 11.5, h: 0.4, fontFace: "Aptos", fontSize: 14, color: "52665F", margin: 0 });

  const sections = presentationSections(blocks);
  const totalSlides = sections.length + 1;
  sections.forEach((section, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(section.title, { x: 0.65, y: 0.38, w: 12, h: 0.7, fontFace: "Aptos Display", fontSize: 25, bold: true, color: "183B35", fit: "shrink", margin: 0 });
    section.points.forEach((point, pointIndex) => {
      slide.addText(point, {
        x: 0.9,
        y: 1.35 + pointIndex * 0.92,
        w: 11.5,
        h: 0.72,
        fontFace: "Aptos",
        fontSize: 17,
        color: "293631",
        bullet: { indent: 18 },
        breakLine: false,
        fit: "shrink",
        margin: 0.04,
        valign: "mid",
      });
    });
    slide.addText(`${index + 2} / ${totalSlides}`, { x: 11.8, y: 7.05, w: 0.8, h: 0.2, fontFace: "Aptos", fontSize: 9, color: "78857F", align: "right", margin: 0 });
  });
  await pptx.writeFile({ fileName: safeFilename(title, "pptx") });
}

function spreadsheetValue(text) {
  const raw = String(text ?? "").trim();
  const value = raw.replace(/^(?:rp\.?|\$|€|£)\s*/i, "").replace(/\s+/g, "");
  if (!value || /^0\d/.test(value)) return raw;
  let normalized = "";
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(value)) normalized = value.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) normalized = value.replace(/,/g, "");
  else if (/^-?\d+(?:[.,]\d+)?$/.test(value)) normalized = value.replace(",", ".");
  const number = normalized ? Number(normalized) : NaN;
  return Number.isFinite(number) ? number : raw;
}

function fitColumns(sheet, rows) {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  sheet["!cols"] = Array.from({ length: columnCount }, (_, column) => ({
    wch: Math.min(48, Math.max(12, ...rows.map((row) => String(row[column] ?? "").length + 2))),
  }));
}

async function exportSpreadsheet(title, blocks) {
  const imported = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const XLSX = imported.utils ? imported : imported.default;
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set();
  const sheetName = (name, fallback) => {
    const base = String(name || fallback).replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || fallback;
    let candidate = base;
    for (let index = 2; usedNames.has(candidate.toLowerCase()); index++) candidate = `${base.slice(0, 25)} ${index}`;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };

  const tables = [];
  const notes = [];
  const plainNotes = [];
  let lastHeading = "";
  for (const block of blocks) {
    if (block.type === "heading") lastHeading = block.text;
    if (block.type === "table") tables.push({ name: lastHeading, block });
    else if (block.text) {
      notes.push([block.text]);
      if (block.type !== "heading") plainNotes.push([block.text]);
    }
  }

  tables.forEach(({ name, block }, index) => {
    const rows = [block.headers, ...block.rows.map((row) => row.map(spreadsheetValue))];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    fitColumns(sheet, rows);
    if (block.headers.length && block.rows.length) {
      sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: block.rows.length, c: block.headers.length - 1 } }) };
    }
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName(tables.length === 1 && name === title ? "Data" : name, `Tabel ${index + 1}`));
  });

  const noteRows = tables.length ? plainNotes : notes;
  if (!tables.length || noteRows.length) {
    const rows = noteRows.length ? noteRows : [["Isi jawaban"], ["Tidak ada isi jawaban."]];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    fitColumns(sheet, rows);
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName(tables.length ? "Catatan" : "Jawaban MyAI", "Catatan"));
  }
  XLSX.writeFile(workbook, safeFilename(title, "xlsx"));
}

async function exportPdf(title, blocks) {
  const imported = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm");
  const JsPDF = imported.jsPDF || imported.default?.jsPDF || imported.default;
  const pdf = new JsPDF({ unit: "mm", format: "a4" });
  const margin = 18;
  const maxWidth = 210 - margin * 2;
  let y = 24;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(19);
  const titleLines = pdf.splitTextToSize(title, maxWidth);
  pdf.text(titleLines, margin, y);
  y += titleLines.length * 8 + 8;

  for (const block of blocks) {
    const text = block.type === "table" ? [block.headers, ...block.rows].map((row) => row.join(" | ")).join("\n") : block.text;
    if (!text) continue;
    const heading = block.type === "heading";
    pdf.setFont("helvetica", heading ? "bold" : "normal");
    pdf.setFontSize(heading ? 13 : 10.5);
    const lines = pdf.splitTextToSize(text, maxWidth);
    const lineHeight = heading ? 6.5 : 5.2;
    if (y + lines.length * lineHeight > 278) {
      pdf.addPage();
      y = 20;
    }
    pdf.text(lines, margin, y);
    y += lines.length * lineHeight + (heading ? 3 : 2);
  }
  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    pdf.setPage(page);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(120);
    pdf.text(`MyAI  |  ${page} / ${pageCount}`, 210 - margin, 289, { align: "right" });
  }
  pdf.save(safeFilename(title, "pdf"));
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportAssistantDocument({ content, title, citations = [] }, format) {
  const markdown = cleanAnswer(content);
  const blocks = withSources(blocksFromMarkdown(markdown), citations);
  const documentTitle = answerTitle(title, blocks);
  if (format === "docx") return exportWord(documentTitle, blocks);
  if (format === "pptx") return exportPowerPoint(documentTitle, blocks);
  if (format === "xlsx") return exportSpreadsheet(documentTitle, blocks);
  if (format === "pdf") return exportPdf(documentTitle, blocks);
  throw new Error("Format dokumen tidak didukung.");
}