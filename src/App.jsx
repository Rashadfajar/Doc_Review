import React, { act, useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// === PDF.js WebViewer (agar teks selectable & layout identik) ===
import "pdfjs-dist/web/pdf_viewer.css";
import {
  EventBus,
  PDFViewer,
  PDFLinkService,
} from "pdfjs-dist/web/pdf_viewer";

import * as XLSX from "xlsx";

// Worker
GlobalWorkerOptions.workerSrc = workerSrc;

/**
 * DocReview – WebViewer edition (React + Tailwind)
 * - Login lokal (localStorage)
 * - Upload PDF & Library
 * - PDF.js WebViewer => teks selectable, zoom native, layout identik
 * - Overlay per halaman untuk klik line/region (komentar)
 * - Outline (atau fallback heading) jadi "Sections"
 * - Export komentar ke Excel
 */

/****************************** Utility ******************************/
const LS_KEY = "docreview_state_v1";
function loadState() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveState(state) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
function nowISO() {
  return new Date().toISOString();
}

/****************************** Auth ******************************/
function useAuth() {
  const [user, setUser] = useState(() => loadState().user || null);
  const login = (email) => {
    const u = { id: uid("u"), name: email.split("@")[0], email };
    const st = loadState();
    st.user = u;
    saveState(st);
    setUser(u);
  };
  const logout = () => {
    const st = loadState();
    delete st.user;
    saveState(st);
    setUser(null);
  };
  return { user, login, logout };
}

/****************************** Library ******************************/
function useLibrary() {
  const [files, setFiles] = useState(() => loadState().files || []);
  useEffect(() => {
    const st = loadState();
    setFiles(st.files || []);
  }, []);

  const addFile = (fileMeta) => {
    const st = loadState();
    st.files = st.files || [];
    st.files.push(fileMeta);
    saveState(st);
    setFiles(st.files);
  };

  const removeFile = (fileId) => {
    const st = loadState();
    st.files = (st.files || []).filter((f) => f.id !== fileId);
    saveState(st);
    setFiles(st.files);
  };

  return { files, addFile, removeFile };
}

/****************************** PDF helpers (indexing line) ******************************/
function px(val) {
  return `${val}px`;
}

// Cluster teks by X untuk dukung multi kolom sederhana
function clusterColumns(items, tolX = 24) {
  const its = items.slice().sort((a, b) => a.x - b.x);
  const cols = [];
  for (const it of its) {
    const hit = cols.find((c) => Math.abs(it.x - c.cx) <= tolX);
    if (hit) {
      hit.items.push(it);
      hit.cx = (hit.cx * (hit.items.length - 1) + it.x) / hit.items.length;
    } else {
      cols.push({ cx: it.x, items: [it] });
    }
  }
  return cols.sort((a, b) => a.cx - b.cx).map((c, i) => ({ ...c, index: i }));
}

function groupLinesByY(items, tolY = 2.0) {
  const arr = items.slice().sort((A, B) => B.y - A.y);
  const lines = [];
  let cur = [];
  let curY = null;
  for (const it of arr) {
    if (curY === null || Math.abs(it.y - curY) <= tolY) {
      cur.push(it);
      if (curY === null) curY = it.y;
    } else {
      lines.push(cur);
      cur = [it];
      curY = it.y;
    }
  }
  if (cur.length) lines.push(cur);
  return lines.map((ln, i) => {
    const ys = ln.map((t) => t.y);
    const yMin = Math.min(...ys),
      yMax = Math.max(...ys);
    const xs = ln.map((t) => t.x);
    const xMin = Math.min(...xs),
      xMax = Math.max(...xs);
    const hts = ln.map((t) => t.height).slice().sort((a, b) => a - b);
    const hMed = hts[Math.floor(hts.length / 2)] || 12;
    const fontHeights = hts;
    return {
      idx: i,
      y_min: yMin,
      y_max: yMax,
      x_min: xMin,
      x_max: xMax,
      height: hMed,
      items: ln,
      fontHeights,
    };
  });
}

function insertVirtualLines(lines) {
  if (lines.length < 2) return lines.map((l, i) => ({ ...l, line_no: i + 1 }));
  const centers = lines.map((l) => (l.y_min + l.y_max) / 2);
  const gaps = centers.slice(1).map((c, i) => centers[i] - c); // desc y
  const medGap = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 0;
  const out = [];
  let nextNo = 0;
  out.push({ ...lines[0], line_no: ++nextNo });
  for (let i = 1; i < lines.length; i++) {
    const gap = gaps[i - 1];
    let toInsert = 0;
    if (medGap > 0 && gap > 1.6 * medGap) toInsert = Math.max(1, Math.round(gap / medGap) - 1);
    for (let k = 0; k < toInsert; k++) {
      const prev = out[out.length - 1];
      const virtCenter = (prev.y_min + prev.y_max) / 2 - medGap * (k + 1);
      out.push({
        idx: -1,
        y_min: virtCenter - prev.height / 2,
        y_max: virtCenter + prev.height / 2,
        x_min: 0,
        x_max: 99999,
        height: prev.height,
        items: [],
        fontHeights: [],
        is_virtual: true,
        line_no: ++nextNo,
      });
    }
    out.push({ ...lines[i], line_no: ++nextNo });
  }
  return out;
}

function buildPageLineIndex(textItems /* in viewport coords */) {
  const cols = clusterColumns(textItems);
  const perCol = cols.flatMap((col) => {
    const lines = groupLinesByY(col.items);
    return lines.map((l) => ({ ...l, column_index: col.index }));
  });
  // global order: top→bottom (ingat y viewport = dari atas), lalu kiri→kanan
  perCol.sort((a, b) => a.y_min - b.y_min || a.x_min - b.x_min);
  const withVirtual = insertVirtualLines(perCol);
  return withVirtual.map((l, i) => ({ ...l, line_no: i + 1 }));
}

function pickNearestLine(lineIndex, y, radius = 8) {
  let best = null;
  for (const li of lineIndex) {
    const mid = (li.y_min + li.y_max) / 2;
    const dist = Math.abs(y - mid);
    if (dist <= radius && (!best || dist < best.dist)) best = { li, dist };
  }
  return best?.li || null;
}

/****************************** UI Components ******************************/
function LoginView({ onLogin }) {
  const [email, setEmail] = useState("");
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow p-6 space-y-4">
        <h1 className="text-2xl font-bold">DocReview Login</h1>
        <input
          className="w-full border rounded-lg p-2"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="w-full py-2 rounded-xl bg-black text-white" onClick={() => email && onLogin(email)}>
          Login
        </button>
      </div>
    </div>
  );
}

function LibraryView({ user, files, onOpen, onDelete }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto py-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Library</h2>
          {/* Upload dipindahkan ke header utama */}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {files.map((f) => (
            <div key={f.id} className="bg-white rounded-xl p-4 shadow flex items-center justify-between">
              <div>
                <div className="font-medium">{f.name}</div>
                <div className="text-xs text-gray-500">{new Date(f.created_at).toLocaleString()}</div>
              </div>
              <div className="flex gap-2">
                <button className="px-3 py-1 rounded-lg border" onClick={() => onOpen(f)}>
                  Open
                </button>
                <button className="px-3 py-1 rounded-lg border text-red-600" onClick={() => onDelete(f.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {files.length === 0 && <div className="text-gray-500">Belum ada file. Gunakan tombol “Upload PDF” di kanan atas.</div>}
        </div>
      </div>
    </div>
  );
}


function SectionList({ sections, onJump, activeId, getDisplayLabel }) {
  return (
    <div className="w-56 border-r overflow-auto p-2" style={{ height: "calc(100vh - 64px)" }}>
      <div className="font-semibold mb-2">Sections</div>
      {sections.map((s) => (
        <button
          key={s.id}
          className={`block w-full text-left px-2 py-1 rounded-lg hover:bg-gray-50 ${
            activeId === s.id ? "bg-gray-100" : ""
          }`}
          onClick={() => onJump(s)}
          title={s.title}
        >
          {"\u00A0".repeat(2 * Math.max(0, (s.level || 1) - 1))}
          {s.title}
          <span className="text-[11px] text-gray-500 ml-1">[{getDisplayLabel(s.page)}]</span>
        </button>
      ))}
      {sections.length === 0 && (
        <div className="text-gray-500 text-sm">(Tidak ada outline; menggunakan deteksi heading fallback)</div>
      )}
    </div>
  );
}

function CommentPanel({
  user,
  file,
  sections,
  page,
  onAdd,
  comments,
  onExport,
  pickMode,
  setPickMode,
  activeSectionId,
  onRequestJumpSection,
  getDisplayLabel,
}) {
  const [sectionId, setSectionId] = useState("");
  const [line, setLine] = useState("");
  const [text, setText] = useState("");
  useEffect(() => {
    setSectionId(activeSectionId ?? "");
  }, [activeSectionId]);
  useEffect(() => {
    setLine("");
  }, [page]);

  const submit = () => {
    if (!text.trim()) return;
    onAdd({
      section_id: sectionId || null,
      page,
      line_no: null,
      body: text,
      comment_type: "region",
      region_bbox: null,
    });
    setText("");
  };


  const onChangeSection = (e) => {
    const val = e.target.value;
    setSectionId(val);
    if (!val) return;
    const sec = sections.find((s) => s.id === val);
    if (sec && onRequestJumpSection) onRequestJumpSection(sec);
  };

  return (
    <div className="w-70 border-l gap-2" style={{ height: "calc(100vh - 64px)" }}>
      <div className="h-full flex flex-col">
        <div className="p-3 border-b">
          <div className="font-semibold mb-2">Komentar</div>
          {/* <div className="flex gap-2 mb-2">
            <button
              className={`px-2 py-1 rounded border ${pickMode === "text" ? "bg-black text-white" : ""}`}
              onClick={() => setPickMode("text")}
            >
              Text-Line
            </button>
            <button
              className={`px-2 py-1 rounded border ${pickMode === "region" ? "bg-black text-white" : ""}`}
              onClick={() => setPickMode("region")}
            >
              Region
            </button>
          </div> */}
          <div className="grid grid-cols-2 gap-2 mb-2 text-sm">
            <div>
              <label className="block text-xs text-gray-500">Section</label>
              <select className="w-full border rounded p-1" value={sectionId} onChange={onChangeSection}>
                <option value="">(none)</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500">Page</label>
              <input className="w-full border rounded p-1" value={getDisplayLabel(page) || ""} readOnly />
            </div>
            {/* {pickMode === "text" && (
              <div className="col-span-2">
                <label className="block text-xs text-gray-500">Line</label>
                <input
                  id="line-input"
                  className="w-full border rounded p-1"
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                  placeholder="Tulis Line..."
                />
              </div>
            )} */}
          </div>
          <textarea
            className="w-full border rounded p-2 text-sm"
            rows={3}
            placeholder="Tulis komentar..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-between items-center mt-2">
            <button className="px-3 py-1 bg-black text-white rounded-lg" onClick={submit}>
              Tambah
            </button>
            <button className="px-3 py-1 border rounded-lg" onClick={onExport}>
              Export Excel
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          <div className="font-medium mb-2">Riwayat</div>
          <div className="space-y-2">
            {comments
              .slice()
              .reverse()
              .map((c) => (
                <div key={c.id} className="border rounded-lg p-2 text-sm">
                  <div className="text-[10px] text-gray-500 flex gap-2">
                    <span>{new Date(c.created_at).toLocaleString()}</span>
                    <span>• {c.user_name}</span>
                    <span>
                      • Pg {c.page}
                      {c.line_no != null ? `, Ln ${c.line_no}` : ""}
                    </span>
                  </div>
                  {c.section_title && <div className="text-[10px] text-gray-600">Section: {c.section_title}</div>}
                  <div className="mt-1">{c.body}</div>
                </div>
              ))}
            {comments.length === 0 && <div className="text-gray-500 text-sm">Belum ada komentar.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/****************************** Outline resolvers ******************************/
async function resolveDestToLocation(pdf, dest) {
  // dest bisa string (namedDest) atau array
  const explicitDest = Array.isArray(dest) ? dest : await pdf.getDestination(dest);
  if (!explicitDest) return null;

  // explicitDest biasanya: [ref, mode, x, y, zoom]
  const [ref, mode, x, y, zoom] = explicitDest;
  const pageIndex = await pdf.getPageIndex(ref);
  const pageNum = pageIndex + 1;

  const pdfX = typeof x === "number" ? x : 0;
  const pdfY = typeof y === "number" ? y : 0;

  // return both computed coordinates and the explicitDest array so we can later
  // pass the exact destination back to PDF.js (goToDestination / scrollPageIntoView)
  return { pageNum, pdfX, pdfY, zoom: typeof zoom === "number" ? zoom : null, explicitDest };
}

async function flattenOutlineRecursive(pdf, items, level = 1) {
  const out = [];
  if (!items) return out;
  for (const it of items) {
    // try resolve dest (may be null)
    let loc = null;
    try {
      if (it.dest) loc = await resolveDestToLocation(pdf, it.dest);
    } catch (err) {
      loc = null;
    }
    out.push({
      id: uid("sec"),
      title: it.title || "Untitled",
      level,
      loc: loc ? { pageNum: loc.pageNum, pdfX: loc.pdfX, pdfY: loc.pdfY, zoom: loc.zoom } : null,
      explicitDest: loc ? loc.explicitDest : null,
    });
    if (it.items && it.items.length) {
      const kids = await flattenOutlineRecursive(pdf, it.items, level + 1);
      out.push(...kids);
    }
  }
  return out;
}

function SmallSectionToggle({ onOpen }) {
  return (
    <button
      className="pdf-floating fixed z-40 top-20 left-4 px-2.5 py-1.5 text-xs rounded-lg border bg-white/90 backdrop-blur shadow hover:bg-white pointer-events-auto"
      onClick={onOpen}
      title="Buka Sections"
      aria-label="Buka Sections"
    >
      ☰
    </button>
  );
}


function SlideOverSections({ open, onClose, children }) {
  return (
    <div className="fixed z-50 top-16 left-0 bottom-0 transition-transform pointer-events-none">
      <div
        className={`h-full w-[15rem] max-w-[90vw] bg-white/90 backdrop-blur border-r shadow-2xl rounded-r-xl
        ${open ? "translate-x-0" : "-translate-x-full"} pointer-events-auto transition-transform duration-300`}
        role="dialog" aria-modal="false"
      >
        <div className="h-9 flex items-center justify-between px-3 border-b">
          <div className="font-medium text-sm">Sections</div>
          <button className="text-xs px-2 py-1 rounded border" onClick={onClose}>Tutup</button>
        </div>
        <div className="h-[calc(100%-2.25rem)] overflow-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

function MinimalSectionBox({ sections, activeId, onJump, getDisplayLabel, onClose }) {
  const safe = Array.isArray(sections) ? sections : [];
  return (
    <div className="p-2">
      <div className="space-y-1">
        {safe.length ? safe.map((s) => (
          <button
            key={s.id}
            className={`w-full text-left px-2 py-1 rounded hover:bg-gray-50 text-sm
              ${activeId === s.id ? "bg-gray-100 font-medium" : ""}`}
            title={s.title}
            onClick={() => { onJump?.(s); }}
          >
            {s.title}
            <span className="text-[11px] text-gray-500 ml-1">[{getDisplayLabel(s.page)}]</span>
          </button>
        )) : (
          <div className="text-xs text-gray-500 px-2">Tidak ada outline.</div>
        )}
      </div>
    </div>
  );
}



function SlideOverComments({ open, onClose, children }) {
  if (!open) return null; // jangan render apa pun saat tertutup

  return (
    <div
      className="fixed z-50 bottom-4 right-4
                 w-60 max-w-[90vw] max-h-[75vh]
                 bg-white/80 backdrop-blur-md border shadow-2xl rounded-xl
                 flex flex-col overflow-hidden
                 transition-all duration-200"
      role="dialog"
      aria-modal="false"
    >
      {/* konten scrollable */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}



function MinimalCommentDock({ onExpand, comments, pageLabel }) {
  const safeComments = Array.isArray(comments) ? comments : [];
  const last = safeComments.slice(-1);

  return (
    <div className="pdf-floating absolute bottom-4 right-4 z-40">
      <div className="bg-white/70 backdrop-blur-md border shadow-xl rounded-xl w-40 max-w-[80vw]">
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <div className="text-sm font-medium">Komentar</div>
          <button className="text-xs px-2 py-1 border rounded" onClick={onExpand}>Buka</button>
        </div>
        <div className="p-3 text-xs text-gray-600">
          {last.length ? (
            <>
              <div className="font-medium mb-1">Terbaru</div>
              <div className="line-clamp-2">{last[0].body}</div>
            </>
          ) : (
            <div>Belum ada komentar.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function MinimalCommentBox({
  sections,
  page,
  onAdd,
  pickMode,
  setPickMode,
  getDisplayLabel,
  onClose,
  activeSectionId,
  onRequestJumpSection
}) {
  const [sectionId, setSectionId] = React.useState("");
  const [line, setLine] = React.useState("");
  const [text, setText] = React.useState("");

  React.useEffect(() => { setLine(""); }, [page]);
  React.useEffect(() => {
    if (activeSectionId) setSectionId(activeSectionId);
  }, [activeSectionId]);

  const submit = () => {
    if (!text.trim()) return;
    onAdd({
      section_id: sectionId || null,
      page,
      line_no: null,
      body: text,
      comment_type: "region",
      region_bbox: null,
    });
    setText("");
    setLine("");
  };

  return (
    <div className="h-full flex flex-col">
      <div className="h-10 flex items-center justify-between px-3 border-b sticky top-0 bg-white/80 backdrop-blur-md">
        <div className="font-medium text-sm">Tambah Komentar</div>
        <button className="text-sm px-2 py-1 rounded border" onClick={onClose}>Tutup</button>
      </div>

      <div className="p-3 space-y-2 text-sm overflow-auto">
        {/* <div className="flex gap-2">
          <button
            className={`px-2 py-1 rounded border ${pickMode === "text" ? "bg-black text-white" : ""}`}
            onClick={() => setPickMode("text")}
          >
            Text-Line
          </button>
          <button
            className={`px-2 py-1 rounded border ${pickMode === "region" ? "bg-black text-white" : ""}`}
            onClick={() => setPickMode("region")}
          >
            Region
          </button>
        </div> */}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500">Section</label>
            <select
              className="w-full border rounded p-1"
              value={sectionId}
              onChange={(e) => {
                const val = e.target.value;
                setSectionId(val);
                if (!val) return;
                const sec = (sections || []).find(s => s.id === val);
                if (sec && onRequestJumpSection) onRequestJumpSection(sec)
              }}
            >
              <option value="">(none)</option>
              {(Array.isArray(sections) ? sections : []).map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500">Page</label>
            <input className="w-full border rounded p-1" value={getDisplayLabel(page) || ""} readOnly />
          </div>
          {/* {pickMode === "text" && (
            <div className="col-span-2">
              <label className="block text-xs text-gray-500">Line</label>
              <input
                className="w-full border rounded p-1"
                value={line}
                onChange={(e) => setLine(e.target.value)}
                placeholder="Klik teks di PDF atau isi nomor line"
              />
            </div>
          )} */}
        </div>

        <div>
          <label className="block text-xs text-gray-500">Komentar</label>
          <textarea
            className="w-full border rounded p-2 text-sm"
            rows={4}
            placeholder="Tulis komentar…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <button className="px-3 py-1 bg-black text-white rounded-lg" onClick={submit}>
            Tambah
          </button>
        </div>
      </div>
    </div>
  );
}

function PageInfoChip({ pageNumber, pageLabel }) {
  return (
    <div className="fixed z-40 top-20 right-8 px-2.5 py-1.5 text-xs rounded-lg border bg-white/90 backdrop-blur shadow pointer-events-none">
      <div className="flex items-center gap-1">
        <span className="font-medium">Page</span>
        <span>: <b>{pageNumber}</b></span>
      </div>
    </div>
  );
}


/****************************** Workspace (WebViewer) ******************************/
function PdfWorkspace({ user, file, onBack }) {
  const viewerContainerRef = useRef(null);
  const viewerRef = useRef(null);
  const eventBusRef = useRef(null);
  const linkServiceRef = useRef(null);

  const [pdf, setPdf] = useState(null);
  const [sections, setSections] = useState([]);
  const [activeSection, setActiveSection] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [comments, setComments] = useState(
    () => (loadState().comments || []).filter((c) => c.file_id === file.id)
  );
  const [pageLabels, setPageLabels] = useState(null);
  const pagesReadyRef = useRef(false);
  const pendingJumpRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const sectionAnchorsRef = useRef([]);
  const [pickMode, setPickMode] = useState("text");
  const pdfRef = useRef(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);



  // useEffect(() => { pickModeRef.current = pickMode }, [pickMode]);


  const fmtRoman = (num, upper = false) => {
    const map = [
      [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
      [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
      [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
    ];
    let n = Math.max(1, Math.floor(num)), out = "";
    for (const [v, s] of map) { while (n >= v) { out += s; n -= v; } }
    return upper ? out : out.toLowerCase();
  };

  const getDisplayLabel = (pageNum) => {
    if (pageLabels && pageLabels[pageNum - 1]) return pageLabels[pageNum - 1];
    return String(pageNum);
  };

  // Init PDF + PDFViewer
  useEffect(() => {
    let canceled = false;
    (async () => {
      setLoading(true);
      try {
        const loadingTask = getDocument({ url: file.url, useSystemFonts: true });
        const _pdf = await loadingTask.promise;
        pdfRef.current = _pdf;
        if (canceled) return;

        const eventBus = new EventBus();
        eventBusRef.current = eventBus;
        const linkService = new PDFLinkService({ eventBus });
        const viewer = new PDFViewer({
          container: viewerContainerRef.current,
          eventBus,
          linkService,
          textLayerMode: 2,
          // annotationMode: 2,
        });
        linkService.setViewer(viewer);
        viewerRef.current = viewer;
        linkServiceRef.current = linkService;

        viewer.setDocument(_pdf);
        linkService.setDocument(_pdf);

        eventBus.on("pagesinit", () => {
          pagesReadyRef.current = true;
          viewerRef.current.currentScaleValue = "page-width";
          refreshSectionAnchors();
          if (pendingJumpRef.current) {
            jumpToSection(pendingJumpRef.current);
            pendingJumpRef.current = null;
          }
        });

        // setelah: const eventBus = new EventBus();
        eventBus.on("pagechanging", (e) => {
          // e.pageNumber = halaman yang sedang aktif di viewer saat user scroll
          if (e?.pageNumber) setCurrentPage(e.pageNumber);
        });

        eventBus.on("updateviewarea", (e) => {
          // e.location.pageNumber = halaman aktif di viewport saat ini
          const p = e?.location?.pageNumber ?? viewerRef.current?.currentPageNumber;
          if (p) setCurrentPage(p);
        });


        // Scroll sync: update activeSection sesuai posisi
        eventBus.on("pagerendered", async (e) => {
          const pageNumber = e.pageNumber;
          const v = viewerRef.current;
          const pageView = v?._pages?.[pageNumber - 1];
          if (!pageView) return;
        });

        

        // Page labels (opsional)
        try {
          const labels = await _pdf.getPageLabels();
          if (!canceled) setPageLabels(labels || null);
        } catch {
          if (!canceled) setPageLabels(null);
        }

        // Outline -> sections
        let secs = [];
        const outline = await _pdf.getOutline();
        if (outline && outline.length) {
          const flat = await flattenOutlineRecursive(_pdf, outline, 1);
          secs = flat.map((s) => ({
            id: s.id,
            title: s.title,
            level: s.level,
            page: s.loc?.pageNum || 1,
            pdfX: s.loc?.pdfX ?? null,
            pdfY: s.loc?.pdfY ?? null,
            dest: s.explicitDest || null,
          }));
        }
        if (!canceled) setSections(secs);
      } catch (err) {
        console.error("Gagal memuat PDF:", err);
        // (opsional) tampilkan toast/pesan error di UI
      } finally {
        if (!canceled) setLoading(false); // ⬅️ pastikan overlay ditutup apa pun hasilnya
      }
    })();

    // cleanup
    return () => {
      canceled = true;
      try {
        viewerRef.current?.setDocument(null);
        linkServiceRef.current?.setDocument(null);
      } catch {}
    };
  }, [file.url]);

  useEffect(() => {
    const container = viewerContainerRef.current;
    if (!container) return;

    let raf = null;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const center = container.scrollTop + container.clientHeight / 2;

        const anchors = sectionAnchorsRef.current;
        if (!anchors.length) return;

        // cari anchor terakhir yang berada <= center (closest from above)
        let active = anchors[0];
        for (const a of anchors) {
          if (a.absY <= center) active = a;
          else break;
        }
        if (active && active.id !== activeSection) {
          setActiveSection(active.id);
        }
      });
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [activeSection]);


  // Hitung ulang posisi anchor semua section → simpan ke sectionAnchorsRef
  const refreshSectionAnchors = React.useCallback(() => {
    const v = viewerRef.current;
    const container = viewerContainerRef.current;
    if (!v || !container || !sections.length) return;

    const anchors = [];
    for (const s of sections) {
      const pageView = v._pages?.[s.page - 1];
      if (!pageView) continue;

      // offset atas halaman relatif container (bukan getBoundingClientRect)
      const pageTop = pageView.div.offsetTop;

      // default anchor = top halaman, kalau tidak ada koordinat
      let vy = 0;

      // kalau punya koordinat heading (dari outline)
      if (typeof s.pdfY === "number") {
        const [vx, vy0] = pageView.viewport.convertToViewportPoint(s.pdfX || 0, s.pdfY);
        vy = vy0;
      }

      const absY = pageTop + vy; // posisi anchor absolut dalam scroll area
      anchors.push({ id: s.id, page: s.page, absY });
    }

    // urutkan naik
    anchors.sort((a, b) => a.absY - b.absY);
    sectionAnchorsRef.current = anchors;
  }, [sections]);



  const addComment = ({ section_id, page, line_no, body, comment_type, region_bbox }) => {
    const st = loadState(); st.comments = st.comments || [];
    const section_title = section_id ? sections.find((s) => s.id === section_id)?.title || null : null;
    const c = {
      id: uid("c"), file_id: file.id,
      section_id: section_id || null, section_title,
      page, line_no: line_no || null, body,
      user_id: user.id, user_name: user.name,
      created_at: nowISO(),
      comment_type: comment_type || null,
      region_bbox: region_bbox || null,
    };
    st.comments.push(c); saveState(st);
    setComments(st.comments.filter((x) => x.file_id === file.id));
  };

  const exportExcel = () => {
    const rows = comments.map((c) => ({
      Section: c.section_title || "",
      "Hal (PDF)": c.page,
      "Hal (Label)": getDisplayLabel(c.page),
      Line: c.line_no || "-",
      Komentar: c.body,
      User: c.user_name,
      Waktu: new Date(c.created_at).toLocaleString(),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Comments");
    XLSX.writeFile(wb, `${file.name.replace(/\.pdf$/i, "")}_comments.xlsx`);
  };

  const jumpToSection = (s) => {
    if (!pagesReadyRef.current) {
      pendingJumpRef.current = s;
      return;
    }

    const v = viewerRef.current;
    const container = viewerContainerRef.current;
    if (!v || !container) return;

    const pageView = v._pages?.[s.page - 1];
    if (!pageView) {
      linkServiceRef.current?.goToPage(s.page);
      return;
    }

    // Pastikan anchor sudah dihitung
    refreshSectionAnchors();
    const anchors = sectionAnchorsRef.current;
    const found = anchors.find(a => a.id === s.id);

    if (found) {
      const offsetFactor = 0.35;
      const target = Math.max(0, found.absY - container.clientHeight * offsetFactor);
      container.scrollTo({ top: target, behavior: "smooth" });
    } else if (s.dest && v.scrollPageIntoView) {
      // fallback ke dest asli
      v.scrollPageIntoView({ pageNumber: s.page, destArray: s.dest });
    } else {
      linkServiceRef.current?.goToPage(s.page);
    }

    setActiveSection(s.id);
    setCurrentPage(s.page);
  };

  // di dalam PdfWorkspace
  const refreshTimerRef = useRef(null);
  const scheduleAnchorRefresh = React.useCallback(() => {
    if (refreshTimerRef.current) cancelAnimationFrame(refreshTimerRef.current);
    // 1) segera setelah layout berubah
    refreshTimerRef.current = requestAnimationFrame(() => {
      refreshSectionAnchors();
      // 2) sedikit sesudah render layer selesai (amat membantu saat zoom besar)
      setTimeout(() => refreshSectionAnchors(), 120);
    });
  }, [refreshSectionAnchors]);

  useEffect(() => {
    const bus = eventBusRef.current;
    if (!bus) return;

    const onScaleChange = () => scheduleAnchorRefresh();
    const onPageRendered = () => scheduleAnchorRefresh();

    bus.on("scalechanging", onScaleChange);
    bus.on("scalechange", onScaleChange);     
    bus.on("pagerendered", onPageRendered);    

    return () => {
      bus.off?.("scalechanging", onScaleChange);
      bus.off?.("scalechange", onScaleChange);
      bus.off?.("pagerendered", onPageRendered);
    };
  }, [scheduleAnchorRefresh]);



  useEffect(() => {
    if (!viewerRef.current) return;

    // Pastikan PDF.js ngeh kalau container melebar/menyempit
    requestAnimationFrame(() => {
      try { eventBusRef.current?.dispatch?.("resize", { source: window }); } catch {}
      try { window.dispatchEvent(new Event("resize")); } catch {}

      const v = viewerRef.current;
      const prev = v.currentScaleValue;
      if (prev) v.currentScaleValue = prev; else v.currentScale = v.currentScale;

      // layout berubah → rebuild index garis & anchor
      pageLineIndexRef.current.clear();
      scheduleAnchorRefresh();
    });
  }, [isFullscreen, scheduleAnchorRefresh]);





  // Zoom controls
  const rebuildLinesSoon = () => {
    pageLineIndexRef.current?.clear?.();
    scheduleAnchorRefresh();
  };

  const zoomIn  = () => { if (!viewerRef.current) return;
    viewerRef.current.currentScale *= 1.1;
    rebuildLinesSoon();
  };
  const zoomOut = () => { if (!viewerRef.current) return;
    viewerRef.current.currentScale /= 1.1;
    rebuildLinesSoon();
  };
  const fitWidth = () => { if (!viewerRef.current) return;
    viewerRef.current.currentScaleValue = "page-width";
    rebuildLinesSoon();
  };
  const fitPage  = () => { if (!viewerRef.current) return;
    viewerRef.current.currentScaleValue = "page-fit";
    rebuildLinesSoon();
  };


  return (
    <div className="min-h-screen flex flex-col">
      {/* Header with Zoom */}
      <div className="h-16 border-b flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <button className="px-3 py-1 border rounded-lg" onClick={onBack}>← Library</button>
          <div className="font-semibold">{file.name}</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button className="px-2 border rounded" onClick={zoomOut}>-</button>
          <button className="px-2 border rounded" onClick={zoomIn}>+</button>
          <button className="px-2 border rounded" onClick={fitWidth}>Fit W</button>
          <button className="px-2 border rounded" onClick={fitPage}>Fit P</button>

          {/* NEW: toggle fullscreen */}
          <button
            className="px-2 border rounded"
            onClick={() => setIsFullscreen(v => {
              const next = !v;
              if (!next) {setCommentsOpen(false); setSectionsOpen(false);} // keluar fullscreen → pop-up mati
              return next;
            })}
            title="Toggle Fullscreen PDF"
          >
            {isFullscreen ? "Exit Full" : "Full PDF"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <div className={`flex h-[calc(100vh-64px)]`}>
          {/* Left: Sections (disembunyikan saat fullscreen) */}
          <div className={isFullscreen ? "hidden" : ""}>
            <SectionList
              sections={sections}
              onJump={jumpToSection}
              activeId={activeSection}
              getDisplayLabel={getDisplayLabel}
            />
          </div>

          {/* Middle: PDF Viewer (melebar penuh saat fullscreen) */}
          <div className={`relative ${isFullscreen ? "flex-1" : "flex-1"}`}>
            <div
              ref={viewerContainerRef}
              className={`absolute inset-0 overflow-auto bg-neutral-500`}
            >
              <div className="pdfViewer"></div>
              {loading && (
                <div className="pdf-floating absolute inset-0 flex items-center justify-center bg-black/30 text-white text-lg font-semibold">
                  Loading PDF...
                </div>
              )}
            </div>
            {!isFullscreen && (
              <div className="pdf-floating pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-30">
                <div className="rounded-full border bg-white/90 backdrop-blur px-3 py-1 text-xs shadow">
                  <b>Page</b>:<b>{currentPage}</b>
                </div>
              </div>
            )}
            {/* Info page: PDF vs Label */}
            {isFullscreen && (
              <PageInfoChip
                pageNumber={currentPage}
              />
            )}
            {/* Tombol kecil kiri-atas untuk buka Sections (saat fullscreen) */}
            {isFullscreen && (
              <SmallSectionToggle onOpen={() => setSectionsOpen(true)} />
            )}
            {/* NEW: mini dock saat fullscreen */}
            {isFullscreen && (
              <MinimalCommentDock
                onExpand={() => setCommentsOpen(true)}
                comments={comments}
                pageLabel={getDisplayLabel(currentPage)}
              />
            )}
          </div>

          {/* Right: Comments panel original (tetap ada; tidak diubah) */}
          {!isFullscreen && (
            <CommentPanel
              user={user}
              file={file}
              sections={sections}
              page={currentPage}
              onAdd={addComment}
              comments={comments}
              onExport={exportExcel}
              activeSectionId={activeSection}
              onRequestJumpSection={jumpToSection}
              getDisplayLabel={getDisplayLabel}
              // pickMode={pickMode}
              // setPickMode={setPickMode}
            />
          )}
        </div>
      </div>
      {isFullscreen && (
        <SlideOverSections
          open={sectionsOpen}
          onClose={() => setSectionsOpen(false)}
        >
          <MinimalSectionBox
            sections={sections}
            activeId={activeSection}
            onJump={(s) => {
              setSectionsOpen(false);   // tutup setelah klik (opsional)
              jumpToSection(s);
            }}
            getDisplayLabel={getDisplayLabel}
            onClose={() => setSectionsOpen(false)}
          />
        </SlideOverSections>
      )}


      {/* NEW: Pop-up di kanan; tanpa backdrop; PDF di belakang tetap scroll/click */}
      {isFullscreen && (
        <SlideOverComments
          open={commentsOpen}
          onClose={() => setCommentsOpen(false)}
        >
          <MinimalCommentBox
            sections={Array.isArray(sections) ? sections : []}
            page={currentPage}
            onAdd={addComment}
            // pickMode={pickMode}
            // setPickMode={setPickMode}
            getDisplayLabel={getDisplayLabel}
            onClose={() => setCommentsOpen(false)}
            activeSectionId={activeSection}
            onRequestJumpSection={jumpToSection}
          />
        </SlideOverComments>
      )}
    </div>
  );
}

/****************************** App ******************************/
function App() {
  const { user, login, logout } = useAuth();
  const { files, addFile, removeFile } = useLibrary();
  const [openFile, setOpenFile] = useState(null);

  // === Upload handler dipindah ke header ===
  const fileInput = useRef(null);
  const handlePick = () => fileInput.current?.click();
  const handleFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f || !user) return;
    const url = URL.createObjectURL(f);
    const meta = { id: uid("f"), owner_id: user.id, name: f.name, mime: f.type, url, created_at: nowISO() };
    addFile(meta);
    // reset input supaya bisa pilih file yg sama lagi
    e.target.value = "";
  };

  if (!user) return <LoginView onLogin={login} />;
  if (openFile) return <PdfWorkspace user={user} file={openFile} onBack={() => setOpenFile(null)} />;

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <img
            src="GHI.png"            // ganti sesuai nama file di public
            alt="DocReview"
            className="h-6 w-auto"     // atur tinggi logo
            loading="eager"
            onError={(e) => { e.currentTarget.style.display = 'none'; }} // fallback: sembunyikan jika gagal load
          />
          {/* Opsional fallback teks untuk aksesibilitas */}
          <span className="sr-only">DocReview</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {/* Upload pindah ke sini */}
          <input
            type="file"
            accept="application/pdf"
            ref={fileInput}
            className="hidden"
            onChange={handleFile}
          />
          <span>{user.email}</span>
          <button className="px-3 py-1 border rounded-lg" onClick={logout}>
            Logout
          </button>
          <button className="px-3 py-1 border rounded-lg" onClick={handlePick}>
            Upload PDF
          </button>
        </div>
      </div>

      <LibraryView
        user={user}
        files={files}
        onOpen={setOpenFile}
        onDelete={removeFile}
        /* onUpload dihapus karena sudah di header */
      />
    </div>
  );
}


export default App;
