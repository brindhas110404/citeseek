// CiteSeek frontend · upload.js: Picking a file, reading it (PDFs via pdf-reader.js), the basketball court, uploading.
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Upload ----------------
let extracting = null; // text extraction starts as soon as a file is picked

function setUploadStatus(text) {
  els.uploadBtn.textContent = text;
  if (selectedFile) els.dzSub.textContent = text;
}

function pickFile(file, origin) {
  if (!file || !els.auth.hidden) return;
  if (!/\.(pdf|txt|md|text)$/i.test(file.name)) return toast("Please choose a PDF, TXT or Markdown file", "error");
  selectedFile = file;
  els.dropZone.classList.add("has-file");
  els.dzMain.innerHTML = `<strong>${escapeHtml(file.name)}</strong>`;
  els.dzSub.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · click to change`;
  els.paperTitle.value = "";
  if (ownCopy && Date.now() - ownCopy.at < 10 * 60_000) els.paperTitle.value = ownCopy.title; // from the globe's "Upload the PDF"
  ownCopy = null;
  // Read the file in the background while the user lines up their shot.
  extracting = readPaper(file);
  extracting.catch(() => {});

  if (!origin) {
    const r = els.dropZone.getBoundingClientRect();
    origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  const opened = window.Court?.open(file, origin, {
    onScore: () => startUpload(),
    onSkip: () => startUpload(),
    onCancel: () => resetUpload(),
  });
  if (!opened) {
    // Reduced-motion users get the plain form.
    els.uploadRow.hidden = false;
    els.uploadBtn.focus();
  }
}
function resetUpload() {
  selectedFile = null;
  extracting = null;
  els.fileInput.value = "";
  els.dropZone.classList.remove("has-file");
  els.dzMain.innerHTML = "<strong>Add a paper</strong>: drop or browse";
  els.dzSub.textContent = "PDF, TXT or Markdown";
  els.uploadRow.hidden = true;
  els.uploadBtn.disabled = false;
  els.uploadBtn.textContent = "Index paper";
}

els.fileInput.addEventListener("change", (e) => pickFile(e.target.files[0]));
els.paperTitle.addEventListener("keydown", (e) => { if (e.key === "Enter") els.uploadBtn.click(); });

// Drop a file anywhere on the page; the ball appears where it landed.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add("drop-anywhere");
});
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("drop-anywhere"); }
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("drop-anywhere");
  if (window.Court?.isOpen) return;
  pickFile(e.dataTransfer.files[0], { x: e.clientX, y: e.clientY });
});

async function readPaper(file) {
  if (/\.pdf$/i.test(file.name)) return extractPdfText(file);
  return { text: await file.text(), metaTitle: "" };
}

/** Column-aware PDF text extraction with OCR for scans (static/pdf-reader.js). */
async function extractPdfText(file) {
  const r = await window.PdfReader.extract(file, (msg) => { if (els.uploadBtn.disabled || /Scanned/.test(msg)) setUploadStatus(msg); });
  if (r.ocr) toast("This PDF is a scan, so its text was recognized from the page images. Check answers against the original.", "warn");
  return { text: r.text, metaTitle: r.metaTitle };
}

els.uploadBtn.addEventListener("click", () => startUpload());

let skipPaperCheck = false; // globe papers are known to be papers
async function startUpload(force = false) {
  if (!selectedFile || els.uploadBtn.disabled) return false;
  const file = selectedFile;
  const forced = force || skipPaperCheck;
  skipPaperCheck = false;
  els.uploadBtn.disabled = true;
  try {
    setUploadStatus(/\.pdf$/i.test(file.name) ? "Reading PDF…" : "Reading file…");
    const { text, metaTitle } = await (extracting || readPaper(file));
    if (!text || text.trim().length < 200) throw new Error("Couldn't find enough text. Is this a scanned PDF?");

    setUploadStatus("Uploading…");
    const form = new FormData();
    form.append("text", text);
    // Blank title = let CiteSeek detect it from the paper.
    form.append("title", els.paperTitle.value.trim());
    if (metaTitle) form.append("titleHint", metaTitle);
    form.append("filename", file.name);
    if (forced) form.append("force", "1");
    setUploadStatus(forced ? "Uploading…" : "Checking it's a paper…");
    const res = await fetch("/api/papers", { method: "POST", body: form });
    const data = await res.json();
    if (data.code === "not_paper") {
      // Keep the file so "Add anyway" can send it again without re-reading it.
      const title = els.paperTitle.value;
      resetUpload();
      toast(`${data.error}${data.reason ? ` ${data.reason}` : ""} CiteSeek works best with papers.`, "warn", {
        label: "Add anyway",
        ms: 12000,
        onClick: () => {
          selectedFile = file;
          extracting = Promise.resolve({ text, metaTitle });
          els.paperTitle.value = title;
          startUpload(true);
        },
      });
      return false;
    }
    if (!data.success) throw new Error(data.error || "Upload failed");

    papers.unshift(data.paper);
    resetUpload();
    startChat({ paperId: data.paper.id }); // a new paper gets its own conversation
    pollPaper(data.paper.id);
    toast("Uploaded. Indexing now…", "success");
    return true;
  } catch (err) {
    toast(err.message || "Upload failed", "error");
    resetUpload();
    return false;
  }
}
