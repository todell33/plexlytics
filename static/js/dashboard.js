// ---------------------------------------------------------------------------
// Sanity check: make sure the local Chart.js file actually loaded. If it
// didn't, warn on-page but keep going -- everything else (tabs, live
// sessions, history table, syncing) should keep working regardless.
// ---------------------------------------------------------------------------
const CHART_JS_AVAILABLE = typeof Chart !== "undefined";
if (!CHART_JS_AVAILABLE) {
  const warning = document.createElement("div");
  warning.style.cssText =
    "background:#4a2a2a;color:#f5b5b5;padding:14px 20px;margin:16px 28px;border-radius:8px;font-size:13px;";
  warning.textContent =
    "Charts can't load: static/js/vendor/chart.umd.min.js is missing. See the README's " +
    "troubleshooting section for the one-line command to download it. Everything else on " +
    "this page will still work normally.";
  document.querySelector("main").prepend(warning);
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
const VALID_TOP_LEVEL_TABS = ["live", "analytics", "libraries", "users", "history"];

function activateTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tabName}`));
}

// ---------------------------------------------------------------------------
// Breadcrumbs -- replaces a single "Back" button on drilldown pages with a
// full trail (e.g. Users / todell33 / Alien), so any earlier step is one
// click away, not just the immediately previous page.
//
// The trail is built incrementally as you click through the app (each
// open*Detail() call appends to whatever trail already exists), and resets
// to a single root entry whenever you click a top-level nav tab. Clicking a
// breadcrumb link truncates the trail back to that point.
//
// This can't be perfectly reconstructed from the URL alone on a hard reload
// or via the browser's own back/forward buttons (the hash only encodes the
// *current* page, not the path taken to reach it) -- for those cases each
// drilldown page falls back to a sensible minimal trail (its natural parent
// tab + itself) via ensureBreadcrumbTrailFor(), rather than guessing wrong.
// ---------------------------------------------------------------------------
let breadcrumbTrail = [{ label: "Streaming", hash: "live" }];

function renderBreadcrumbs(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = breadcrumbTrail
    .map((crumb, i) => {
      if (i === breadcrumbTrail.length - 1) {
        return `<span class="breadcrumb-current">${escapeHtml(crumb.label)}</span>`;
      }
      return `<button class="breadcrumb-link" data-index="${i}">${escapeHtml(crumb.label)}</button><span class="breadcrumb-sep">/</span>`;
    })
    .join(" ");
}

function ensureBreadcrumbTrailFor(hash, fallbackTrail) {
  const current = breadcrumbTrail[breadcrumbTrail.length - 1];
  if (current && current.hash === hash) return; // trail already correct (a fresh click got us here)
  breadcrumbTrail = fallbackTrail;
}

document.addEventListener("click", (e) => {
  const crumb = e.target.closest(".breadcrumb-link");
  if (crumb) {
    const idx = parseInt(crumb.dataset.index, 10);
    const target = breadcrumbTrail[idx];
    breadcrumbTrail = breadcrumbTrail.slice(0, idx + 1);
    navigateTo(target.hash);
  }
});

// ---------------------------------------------------------------------------
// URL routing -- the URL hash reflects whichever page/drilldown is showing,
// so the browser's back/forward buttons and reloading both work correctly.
// navigateTo() is the only thing that should ever change the URL; applyHash()
// is the "given this URL, show the right thing" side, used both for normal
// navigation and for restoring state on load/back/forward.
// ---------------------------------------------------------------------------
function navigateTo(hash) {
  history.pushState(null, "", `#${hash}`);
  applyHash(hash);
}

function activateRootTab(tabName) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  breadcrumbTrail = [{ label: btn ? btn.textContent.trim() : tabName, hash: tabName }];
  activateTab(tabName);
}

async function applyHash(hash) {
  if (!hash) {
    activateRootTab("live");
    return;
  }
  const [page, ...rest] = hash.split("/");

  if (page === "user-detail" && rest[0]) {
    const username = decodeURIComponent(rest[0]);
    if (Object.keys(usersSummaryCache).length === 0) {
      await refreshUsersTable();
    }
    showUserDetailPage(username);
    return;
  }

  if (page === "media-detail" && rest[0] && rest[1]) {
    showMediaDetailPage(decodeURIComponent(rest[0]), rest[1]);
    return;
  }

  if (page === "library-detail" && rest[0]) {
    showLibraryDetailPage(decodeURIComponent(rest[0]), rest[1] || "overview");
    return;
  }

  if (page === "settings") {
    breadcrumbTrail = [{ label: "Settings", hash: "settings" }];
    activateTab("settings");
    return;
  }

  if (page === "analytics") {
    activateRootTab("analytics");
    if (rest[0]) currentAnalyticsPageId = decodeURIComponent(rest[0]);
    // If the layout fetch hasn't resolved yet, initAnalyticsWidgets() picks
    // up currentAnalyticsPageId (already set above) once it does and
    // renders then instead.
    if (analyticsLoaded) {
      if (!currentAnalyticsPageId || !currentAnalyticsPage()) {
        currentAnalyticsPageId = analyticsPages.length ? analyticsPages[0].id : null;
      }
      renderAnalyticsPageTabs();
      renderAnalyticsSections();
    }
    return;
  }

  activateRootTab(VALID_TOP_LEVEL_TABS.includes(page) ? page : "live");
}

window.addEventListener("popstate", () => {
  applyHash(location.hash.replace(/^#/, ""));
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    breadcrumbTrail = [{ label: btn.textContent.trim(), hash: btn.dataset.tab }];
    navigateTo(btn.dataset.tab);
  });
});

// Settings > General > Display Settings -- theme, date format, and time
// format. Loaded from the server at startup (loadDisplaySettings, called
// from Init at the bottom of this file); the fmt* helpers below always read
// the current value of this object, so changing it and re-rendering is all
// that's needed to apply a new format anywhere already on screen.
let appDisplaySettings = { theme: "dark", date_format: "mdy", time_format: "12h" };
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Chart X-axis labels for the "day" and "hour_of_day" dimensions now follow
// the same Settings > General date/time format preference as everywhere
// else in the app, rather than a fixed style -- reuses the exact same
// formatDateYMD/formatTimePart helpers tables and detail pages already use,
// so there's one definition of "what MM/DD/YYYY or 12h/24h means" rather
// than a second one just for charts.
function formatChartDayLabel(dayStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayStr);
  if (!m) return dayStr;
  return formatDateYMD(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
}
function formatChartHourLabel(hour) {
  const h = parseInt(hour, 10);
  if (isNaN(h)) return String(hour);
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return formatTimePart(d);
}

function formatDateYMD(year, month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  switch (appDisplaySettings.date_format) {
    case "dmy":
      return `${dd}/${mm}/${year}`;
    case "iso":
      return `${year}-${mm}-${dd}`;
    case "month_name":
      return `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
    case "mdy":
    default:
      return `${mm}/${dd}/${year}`;
  }
}
const formatDatePart = (d) => formatDateYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
function formatTimePart(d) {
  const h24 = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  if (appDisplaySettings.time_format === "24h") return `${String(h24).padStart(2, "0")}:${min}`;
  const h12 = h24 % 12 || 12;
  return `${h12}:${min} ${h24 < 12 ? "AM" : "PM"}`;
}
// "Loaded at ..." / "Synced at ..." style status timestamps share the same
// time-format preference as everything else.
const fmtTimeNow = () => formatTimePart(new Date());

const fmtHours = (h) => (h || 0).toFixed(1);
const fmtDuration = (ms) => {
  if (!ms) return "—";
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const fmtDateTime = (iso) => {
  if (!iso) return "—";
  // viewed_at is stored as a naive UTC ISO string with no "Z" suffix -- add
  // one so the browser parses it as UTC and converts to the viewer's local
  // time, rather than misreading it as already-local.
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return iso;
  return `${formatDatePart(d)} ${formatTimePart(d)}`;
};
// Plex's "added at" timestamp comes back as a naive LOCAL datetime (already
// in the server's timezone, unlike viewed_at elsewhere), so this
// deliberately does no timezone math at all -- just reads the date straight
// off the ISO string, rather than risking a shift by treating it as UTC the
// way fmtDateOnly (below) correctly does for viewed_at.
const fmtDateRaw = (iso) => {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return formatDateYMD(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
};
const fmtTimeOnly = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return iso;
  return formatTimePart(d);
};
const fmtDateOnly = (iso) => {
  // Unlike fmtDate (for pure calendar dates like release dates), this
  // converts a UTC timestamp to the viewer's local time first -- a stream
  // watched late at night in UTC could otherwise show the wrong date.
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return iso;
  return formatDatePart(d);
};
const fmtDate = (dateStr) => {
  // dateStr comes from the backend as a date, but Plex sometimes returns a
  // full timestamp (e.g. "2026-05-27T00:00:00") rather than a plain
  // "YYYY-MM-DD" -- strip any time component before splitting.
  if (!dateStr) return null;
  const datePart = dateStr.split("T")[0];
  const parts = datePart.split("-");
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  return formatDateYMD(parseInt(y, 10), parseInt(m, 10), parseInt(d, 10));
};

// ---------------------------------------------------------------------------
// Live Now
// ---------------------------------------------------------------------------
async function refreshLive() {
  try {
    const res = await fetch("/api/live");
    const data = await res.json();
    const container = document.getElementById("liveCards");
    const pulse = document.getElementById("pulseDot");
    const countText = document.getElementById("liveCountText");

    if (!data.ok) {
      countText.textContent = "Connection error";
      pulse.classList.remove("on");
      container.innerHTML = `<p class="empty-state">Couldn't reach Plex: ${data.error || "unknown error"}</p>`;
      return;
    }

    countText.textContent = `${data.count} active stream${data.count === 1 ? "" : "s"}`;
    pulse.classList.toggle("on", data.count > 0);

    if (data.count === 0) {
      container.innerHTML = `<p class="empty-state">Nothing playing right now.</p>`;
      return;
    }

    container.innerHTML = data.sessions
      .map((s) => {
        const badgeClass = s.is_transcode ? "transcode" : "direct";
        const badgeText = s.is_transcode ? "Transcode" : "Direct Play";
        const posterHtml = s.thumb
          ? `<img class="session-poster" data-fallback="1" alt="" src="/api/poster?path=${encodeURIComponent(s.thumb)}" />`
          : `<div class="session-poster session-poster-placeholder"></div>`;
        return `
          <div class="session-card">
            <div class="session-card-inner">
              ${posterHtml}
              <div class="session-details">
                <div class="row1">
                  <span class="title">${escapeHtml(s.full_title)}</span>
                  <span class="badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="user">${escapeHtml(s.user)}</div>
                <div class="meta">
                  ${escapeHtml(s.player)} · ${escapeHtml(s.player_platform)}<br/>
                  ${escapeHtml(s.state)} · ${s.bandwidth_kbps ? (s.bandwidth_kbps / 1000).toFixed(1) + " Mbps" : ""}
                </div>
                <div class="progress-bar"><div style="width:${s.progress_percent}%"></div></div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    // If a poster fails to load, swap it for the plain placeholder box
    // instead of leaving a broken image icon.
    container.querySelectorAll('img.session-poster[data-fallback="1"]').forEach((img) => {
      img.addEventListener("error", () => {
        const placeholder = document.createElement("div");
        placeholder.className = "session-poster session-poster-placeholder";
        img.replaceWith(placeholder);
      });
    });
  } catch (e) {
    console.error(e);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

refreshLive();
setInterval(refreshLive, 10000);

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------
let trendChart;

function setChartEmptyState(canvasId, isEmpty, message) {
  const canvas = document.getElementById(canvasId);
  const box = canvas.closest(".chart-box");
  let note = box.querySelector(".chart-empty-note");
  if (isEmpty) {
    canvas.style.display = "none";
    if (!note) {
      note = document.createElement("p");
      note.className = "empty-state chart-empty-note";
      box.appendChild(note);
    }
    note.textContent = message;
  } else {
    canvas.style.display = "block";
    if (note) note.remove();
  }
}

async function refreshTrend() {
  const hours = document.getElementById("trendRange").value;
  const res = await fetch(`/api/bandwidth-trend?hours=${hours}`);
  const data = await res.json();

  if (!data.points || data.points.length === 0) {
    setChartEmptyState(
      "trendChart",
      true,
      "No streaming activity captured yet for this range. This chart fills in from the moment the app starts running — leave it running while something streams, then check back."
    );
    document.getElementById("trendCurrentStreams").textContent = "—";
    document.getElementById("trendCurrentMbps").textContent = "—";
    return;
  }
  setChartEmptyState("trendChart", false, "");

  const labels = data.points.map((p) =>
    formatTimePart(new Date(p.captured_at + "Z"))
  );
  const streams = data.points.map((p) => p.streams);
  const mbps = data.points.map((p) => (p.total_kbps || 0) / 1000);

  // The chart always advances to right now (even a quiet moment gets its
  // own zero-value point -- see poll_live_sessions), so the last point in
  // the series IS the current reading, not just "whatever the most recent
  // stream happened to be."
  document.getElementById("trendCurrentStreams").textContent = streams[streams.length - 1];
  document.getElementById("trendCurrentMbps").textContent = mbps[mbps.length - 1].toFixed(1);

  const ctx = document.getElementById("trendChart");
  if (!CHART_JS_AVAILABLE) {
    setChartEmptyState("trendChart", true, "Chart library isn't loaded — see the README's troubleshooting section.");
    return;
  }

  if (trendChart) {
    // This runs on a 10s auto-refresh -- updating the existing chart's data
    // in place (rather than destroying and recreating the whole Chart
    // object every time) means there's no chart to re-animate in the first
    // place. animation: false below covers the rest (e.g. the very first
    // render, and Chart.js's own default transition animation on update()).
    trendChart.data.labels = labels;
    trendChart.data.datasets[0].data = streams;
    trendChart.data.datasets[1].data = mbps;
    trendChart.update();
    return;
  }

  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Concurrent Streams",
          data: streams,
          borderColor: "#e5a00d",
          backgroundColor: "rgba(229,160,13,0.15)",
          fill: true,
          tension: 0.3,
          yAxisID: "y",
        },
        {
          label: "Total Mbps",
          data: mbps,
          borderColor: "#4caf7d",
          backgroundColor: "rgba(76,175,125,0.1)",
          fill: true,
          tension: 0.3,
          yAxisID: "y1",
        },
      ],
    },
    options: { ...chartOptions({ dual: true, beginAtZero: true }), animation: false },
  });
}

document.getElementById("trendRange").addEventListener("change", refreshTrend);

function chartOptions({ dual = false, beginAtZero = false } = {}) {
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: "#8b909c", font: { size: 11 } } },
    },
    scales: {
      x: { ticks: { color: "#8b909c", font: { size: 10 } }, grid: { color: "#2c313a" } },
      y: { beginAtZero, ticks: { color: "#8b909c", font: { size: 10 } }, grid: { color: "#2c313a" } },
    },
  };
  if (dual) {
    opts.scales.y1 = {
      beginAtZero,
      position: "right",
      ticks: { color: "#8b909c", font: { size: 10 } },
      grid: { drawOnChartArea: false },
    };
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Analytics widgets -- content is organized into pages (independently
// named, reorderable sub-tabs under the Analytics tab). Each page owns its
// own list of sections; each section has a title and its own date-range
// dropdown, which overrides whatever period each widget inside it was
// configured with. A widget itself is a dimension (X axis) + measure
// (Y axis) + optional filters + a chart type and orientation + a size.
// Everything is saved server-side.
// ---------------------------------------------------------------------------
const WIDGET_COLORS = [
  "#e5a00d", "#4caf7d", "#6a8caf", "#c76b6b", "#9b7fd4",
  "#d68f4c", "#5fb8b0", "#c99fd6", "#8a8f99", "#e0c14a",
];

let analyticsPages = [];
let currentAnalyticsPageId = null;
let analyticsLoaded = false;
let analyticsCatalog = { dimensions: {}, measures: {}, genre_safe_measures: [], special_sources: {}, chart_types: [] };
let filterOptionsCache = null;
let analyticsEditMode = false;
let editingWidgetId = null;
let editingWidgetSectionId = null;
let editingSectionId = null;
let editingPageId = null;
let editingSectionFilterSectionId = null;
const analyticsChartRefs = {};

function currentAnalyticsPage() {
  return analyticsPages.find((p) => p.id === currentAnalyticsPageId) || null;
}

async function initAnalyticsWidgets() {
  try {
    const [catalogRes, layoutRes] = await Promise.all([
      fetch("/api/analytics/catalog"),
      fetch("/api/analytics/layout"),
    ]);
    analyticsCatalog = await catalogRes.json();
    const layoutData = await layoutRes.json();
    analyticsPages = layoutData.pages || [];
    // A hash-based deep link (applyHash) may have already set this to a
    // specific page id before the fetch above resolved -- only fall back to
    // the first page if that id turned out to be missing or invalid.
    if (!currentAnalyticsPageId || !currentAnalyticsPage()) {
      currentAnalyticsPageId = analyticsPages.length ? analyticsPages[0].id : null;
    }
    analyticsLoaded = true;
    renderAnalyticsPageTabs();
    renderAnalyticsSections();
  } catch (e) {
    console.error(e);
    document.getElementById("analyticsSectionsContainer").innerHTML = `<p class="empty-state">Couldn't load the Analytics layout.</p>`;
  }
}

async function getFilterOptions() {
  if (filterOptionsCache) return filterOptionsCache;
  const res = await fetch("/api/analytics/filter-options");
  filterOptionsCache = await res.json();
  return filterOptionsCache;
}

function widgetDefaultTitle(w) {
  if (w.mode === "special") {
    return (analyticsCatalog.special_sources[w.source] && analyticsCatalog.special_sources[w.source].label) || w.source;
  }
  const dim = analyticsCatalog.dimensions[w.dimension];
  const meas = analyticsCatalog.measures[w.measure];
  if (dim && meas) return `${meas.label} by ${dim.label}`;
  return w.dimension || "Widget";
}

// ---------------------------------------------------------------------------
// Rendering: the page tab strip, then sections (each containing its own
// widget grid) for whichever page is currently selected
// ---------------------------------------------------------------------------
function renderAnalyticsPageTabs() {
  const container = document.getElementById("analyticsPageTabs");
  if (!container) return;

  const tabs = analyticsPages
    .map((p, i) => {
      const active = p.id === currentAnalyticsPageId ? "active" : "";
      const controls = analyticsEditMode
        ? `<span class="analytics-page-tab-controls">
             <button data-page-action="up" ${i === 0 ? "disabled" : ""} aria-label="Move page left" title="Move left">&larr;</button>
             <button data-page-action="down" ${i === analyticsPages.length - 1 ? "disabled" : ""} aria-label="Move page right" title="Move right">&rarr;</button>
             <button data-page-action="edit" aria-label="Rename page" title="Rename">&#9998;</button>
             <button data-page-action="remove" aria-label="Delete page" title="Delete">&times;</button>
           </span>`
        : "";
      return `<span class="analytics-page-tab-wrap" data-page-id="${p.id}">
        <button class="subtab-btn ${active}" data-page-id="${p.id}">${escapeHtml(p.name || "Untitled Page")}</button>
        ${controls}
      </span>`;
    })
    .join("");

  const addBtn = analyticsEditMode ? `<button class="subtab-btn analytics-add-page-btn" id="analyticsAddPageBtn">+ Add Page</button>` : "";
  container.innerHTML = tabs + addBtn;
}

// Section-level filter fields a section can add, in addition to the date
// range dropdown that's always present. Mirrors the same filter fields a
// widget can set for itself -- adding one here to the section overrides
// every widget in the section for that field, the same relationship the
// date range dropdown already has with each widget's period.
const SECTION_FILTER_FIELDS = {
  media_type: "Media Type",
  user: "User",
  library: "Library",
  platform: "Platform",
  video_decision: "Playback Decision",
};

function sectionFiltersHtml(sec) {
  const active = Object.keys(sec.filters || {});
  const periodChip = `
      <span class="trends-section-filter">
        <label>Date Range</label>
        <select class="trends-section-period" data-section-period-id="${sec.id}">
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="all">All time</option>
        </select>
      </span>`;
  const chips = active
    .map(
      (field) => `
      <span class="trends-section-filter">
        <label>${escapeHtml(SECTION_FILTER_FIELDS[field] || field)}</label>
        <select class="trends-section-filter-select" data-section-id="${sec.id}" data-filter-field="${field}"></select>
        <button class="trends-section-filter-remove" data-section-id="${sec.id}" data-filter-field="${field}" aria-label="Remove ${escapeHtml(SECTION_FILTER_FIELDS[field] || field)} filter">&times;</button>
      </span>`
    )
    .join("");
  return `<div class="trends-section-filters">${periodChip}${chips}<button class="trends-section-add-filter" data-section-id="${sec.id}">+ Add Filter</button></div>`;
}

async function populateSectionFilterSelects(sectionId) {
  const section = findSection(sectionId);
  if (!section || !section.filters) return;
  const opts = await getFilterOptions();
  if (!opts.ok) return;
  const fieldOptions = {
    media_type: opts.media_types || ["movie", "episode"],
    video_decision: opts.video_decisions || [],
    user: opts.users || [],
    library: opts.libraries || [],
    platform: opts.platforms || [],
  };
  Object.entries(section.filters).forEach(([field, value]) => {
    const sel = document.querySelector(
      `.trends-section-filter-select[data-section-id="${sectionId}"][data-filter-field="${field}"]`
    );
    if (!sel) return;
    const values = fieldOptions[field] || [];
    sel.innerHTML = `<option value="">All</option>${values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}`;
    sel.value = value || "";
  });
}

function renderAnalyticsSections() {
  const container = document.getElementById("analyticsSectionsContainer");
  container.classList.toggle("trends-edit-mode", analyticsEditMode);
  const page = currentAnalyticsPage();

  if (!page) {
    container.innerHTML = analyticsPages.length === 0
      ? `<div class="widget-empty-add-card">No analytics pages yet. Click "Edit Layout", then "+ Add Page" to create one.</div>`
      : "";
    return;
  }

  const sections = page.sections || [];
  if (sections.length === 0) {
    container.innerHTML = `<div class="widget-empty-add-card">No sections yet. Click "Edit Layout", then "+ Add Section" to start building this page.</div>`;
    return;
  }

  container.innerHTML = sections
    .map((sec, i) => {
      const widgetsHtml =
        (sec.widgets || []).length === 0
          ? `<div class="trends-section-empty">No widgets in this section yet.</div>`
          : `<div class="widget-grid" id="sectionGrid-${sec.id}">${sec.widgets
              .map((w) => widgetCardHtml(w))
              .join("")}</div>`;
      return `
      <div class="trends-section" data-section-id="${sec.id}">
        <div class="trends-section-header">
          <div class="trends-section-title-row">
            <h3 class="trends-section-title">${escapeHtml(sec.title || "Untitled Section")}</h3>
          </div>
          <div class="trends-section-controls">
            <button data-section-action="up" ${i === 0 ? "disabled" : ""} aria-label="Move section up">&uarr;</button>
            <button data-section-action="down" ${i === sections.length - 1 ? "disabled" : ""} aria-label="Move section down">&darr;</button>
            <button data-section-action="add-widget" class="icon-btn" aria-label="Add widget to this section">+</button>
            <button data-section-action="edit" class="icon-btn" aria-label="Edit section">&#9998;</button>
            <button data-section-action="remove" class="icon-btn" aria-label="Remove section">&times;</button>
          </div>
        </div>
        ${sectionFiltersHtml(sec)}
        ${widgetsHtml}
      </div>`;
    })
    .join("");

  sections.forEach((sec) => {
    const periodSel = document.querySelector(`[data-section-period-id="${sec.id}"]`);
    if (periodSel) periodSel.value = sec.period || "30d";
    populateSectionFilterSelects(sec.id);
    (sec.widgets || []).forEach((w) => loadWidgetData(w, sec.period || "30d", sec.filters));
    wireWidgetDragAndDrop(sec.id);
    wireWidgetResize(sec.id);
  });
}

function findSection(sectionId) {
  const page = currentAnalyticsPage();
  if (!page) return null;
  return (page.sections || []).find((s) => s.id === sectionId);
}

function renderSectionWidgets(sectionId) {
  const section = findSection(sectionId);
  if (!section) return;
  const sectionEl = document.querySelector(`.trends-section[data-section-id="${sectionId}"]`);
  if (!sectionEl) return;

  const widgetsContainer = sectionEl.querySelector(".widget-grid, .trends-section-empty");
  const widgetsHtml =
    (section.widgets || []).length === 0
      ? `<div class="trends-section-empty">No widgets in this section yet.</div>`
      : `<div class="widget-grid" id="sectionGrid-${section.id}">${section.widgets
          .map((w) => widgetCardHtml(w))
          .join("")}</div>`;
  widgetsContainer.outerHTML = widgetsHtml;

  (section.widgets || []).forEach((w) => loadWidgetData(w, section.period || "30d", section.filters));
  wireWidgetDragAndDrop(sectionId);
  wireWidgetResize(sectionId);
}

// Rebuilds just a section's filter row (add/remove a filter type) without
// touching its widgets, mirroring how renderSectionWidgets patches just the
// widget grid.
function renderSectionFilters(sectionId) {
  const section = findSection(sectionId);
  if (!section) return;
  const sectionEl = document.querySelector(`.trends-section[data-section-id="${sectionId}"]`);
  if (!sectionEl) return;
  const filtersEl = sectionEl.querySelector(".trends-section-filters");
  if (filtersEl) filtersEl.outerHTML = sectionFiltersHtml(section);
  const periodSel = document.querySelector(`[data-section-period-id="${sectionId}"]`);
  if (periodSel) periodSel.value = section.period || "30d";
  populateSectionFilterSelects(sectionId);
}

// Old widgets have a size string (small/medium/large) instead of a span
// number -- this maps 1:1 onto the new 6-column grid at the same relative
// widths the old 12-column grid used (small 4/12 == 2/6, medium 6/12 ==
// 3/6, large 12/12 == 6/6), so nobody's existing dashboard silently
// reflows to different proportions just from this change landing.
function widgetSpan(w) {
  if (w.span) return w.span;
  if (w.size === "small") return 2;
  if (w.size === "large") return 6;
  return 3; // "medium" or unset
}

function widgetCardHtml(w) {
  const label = w.title || widgetDefaultTitle(w);
  const span = widgetSpan(w);
  return `
    <div class="widget-card" data-widget-id="${w.id}" data-span="${span}" style="grid-column: span ${span};" draggable="true">
      <div class="widget-card-header">
        <span class="widget-drag-handle" aria-hidden="true" title="Drag to reorder">&#8942;&#8942;</span>
        <h3 class="widget-card-title">${escapeHtml(label)}</h3>
        <div class="widget-card-controls">
          <button data-action="edit" aria-label="Edit widget">&#9998;</button>
          <button data-action="remove" aria-label="Remove widget">&times;</button>
        </div>
      </div>
      <div class="widget-card-body" id="widgetBody-${w.id}"><p class="empty-state">Loading…</p></div>
      <div class="widget-resize-handle" aria-hidden="true" title="Drag to resize"></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Drag to reorder, drag to resize -- a 6-column CSS grid with each card
// spanning 1-6 columns and native browser grid auto-placement handling the
// actual packing/wrapping, so neither of these needs to compute a 2D
// layout by hand -- just the DOM order (for reordering) and each card's
// own span (for resizing).
// ---------------------------------------------------------------------------
let draggedWidgetId = null;

function wireWidgetDragAndDrop(sectionId) {
  const grid = document.getElementById(`sectionGrid-${sectionId}`);
  if (!grid) return;

  grid.querySelectorAll(".widget-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      if (!analyticsEditMode) {
        e.preventDefault();
        return;
      }
      draggedWidgetId = card.dataset.widgetId;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      draggedWidgetId = null;
      commitWidgetOrder(sectionId);
    });
    card.addEventListener("dragover", (e) => {
      if (!draggedWidgetId || card.dataset.widgetId === draggedWidgetId) return;
      e.preventDefault();
      const draggedEl = grid.querySelector(`.widget-card[data-widget-id="${draggedWidgetId}"]`);
      if (!draggedEl) return;
      const rect = card.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      grid.insertBefore(draggedEl, before ? card : card.nextSibling);
    });
  });
}

function commitWidgetOrder(sectionId) {
  const section = findSection(sectionId);
  const grid = document.getElementById(`sectionGrid-${sectionId}`);
  if (!section || !grid) return;
  const orderedIds = Array.from(grid.querySelectorAll(".widget-card")).map((el) => el.dataset.widgetId);
  section.widgets.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
  saveAnalyticsLayout();
}

function wireWidgetResize(sectionId) {
  const grid = document.getElementById(`sectionGrid-${sectionId}`);
  if (!grid) return;

  grid.querySelectorAll(".widget-resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      if (!analyticsEditMode) return;
      e.preventDefault();
      e.stopPropagation();

      const card = handle.closest(".widget-card");
      const startX = e.clientX;
      const startSpan = parseInt(card.dataset.span, 10) || 3;
      const gridRect = grid.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(grid).columnGap || "16");
      const colWidth = (gridRect.width - gap * 5) / 6; // 6 columns, 5 gaps between them

      function onMove(moveEvent) {
        const deltaCols = Math.round((moveEvent.clientX - startX) / (colWidth + gap));
        const newSpan = Math.max(1, Math.min(6, startSpan + deltaCols));
        card.style.gridColumn = `span ${newSpan}`;
        card.dataset.span = String(newSpan);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const section = findSection(sectionId);
        const widget = section && section.widgets.find((w) => w.id === card.dataset.widgetId);
        if (widget) {
          widget.span = parseInt(card.dataset.span, 10) || startSpan;
          saveAnalyticsLayout();
        }
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// ---------------------------------------------------------------------------
// Widget data fetching + chart rendering (unchanged from before, except the
// period now always comes from the parent section, not the widget itself)
// ---------------------------------------------------------------------------
function buildWidgetQueryParams(widget, periodOverride, sectionFilters) {
  if (widget.mode === "special") {
    return new URLSearchParams({ mode: "special", source: widget.source });
  }
  const params = new URLSearchParams({
    mode: "query",
    dimension: widget.dimension,
    measure: widget.measure,
    period: periodOverride || "30d",
    limit: widget.limit || 10,
    sort: widget.sort || "desc",
    sort_by: widget.sort_by || "value",
  });
  // A filter the section has added overrides the widget's own filter for
  // that same field entirely -- same relationship as the section's date
  // range overriding each widget's period -- even when left at "All"
  // (empty), since adding the filter to the section is itself the
  // decision to control that field at the section level.
  const f = { ...(widget.filters || {}), ...(sectionFilters || {}) };
  if (f.media_type) params.set("f_media_type", f.media_type);
  if (f.user) params.set("f_user", f.user);
  if (f.library) params.set("f_library", f.library);
  if (f.platform) params.set("f_platform", f.platform);
  if (f.video_decision) params.set("f_video_decision", f.video_decision);
  if ((widget.chart_type === "line" || widget.chart_type === "area") && widget.series_by) {
    params.set("series_by", widget.series_by);
  }
  if ((widget.chart_type === "line" || widget.chart_type === "area") && widget.measure2) {
    params.set("measure2", widget.measure2);
  }
  if (widget.chart_type === "table" && widget.extra_measures && widget.extra_measures.length) {
    params.set("extra_measures", widget.extra_measures.join(","));
  }
  return params;
}

async function loadWidgetData(widget, sectionPeriod, sectionFilters) {
  const bodyEl = document.getElementById(`widgetBody-${widget.id}`);
  if (!bodyEl) return;

  let data;
  try {
    const res = await fetch(`/api/analytics/widget-data?${buildWidgetQueryParams(widget, sectionPeriod, sectionFilters)}`);
    data = await res.json();
  } catch (e) {
    console.error(e);
    bodyEl.innerHTML = `<p class="empty-state">Couldn't load this widget's data.</p>`;
    return;
  }

  if (!data.ok) {
    bodyEl.innerHTML = `<p class="empty-state">${escapeHtml(data.error || "Couldn't load this widget's data.")}</p>`;
    return;
  }

  if (data.dimension === "day" && Array.isArray(data.labels)) {
    data.labels = data.labels.map(formatChartDayLabel);
  } else if (data.dimension === "hour_of_day" && Array.isArray(data.labels)) {
    data.labels = data.labels.map(formatChartHourLabel);
  }

  if (widget.mode === "special") {
    if (!data.labels || data.labels.length === 0) {
      bodyEl.innerHTML = `<p class="empty-state">No recent activity to show yet.</p>`;
      return;
    }
    bodyEl.innerHTML = `<canvas id="widgetCanvas-${widget.id}"></canvas>`;
    renderBandwidthWidget(widget, data);
    return;
  }

  if (!data.labels || data.labels.length === 0) {
    bodyEl.innerHTML = `<p class="empty-state">No data yet for this range.</p>`;
    return;
  }

  const chartType = widget.chart_type;
  if (chartType === "bar") {
    bodyEl.innerHTML = `<canvas id="widgetCanvas-${widget.id}"></canvas>`;
    renderBarWidget(widget, data);
  } else if (chartType === "line" || chartType === "area") {
    bodyEl.innerHTML = `<canvas id="widgetCanvas-${widget.id}"></canvas>`;
    renderLineOrAreaWidget(widget, data, chartType === "area");
  } else if (chartType === "donut" || chartType === "pie") {
    bodyEl.innerHTML = `<canvas id="widgetCanvas-${widget.id}"></canvas>`;
    renderDonutOrPieWidget(widget, data, chartType === "pie");
  } else if (chartType === "table") {
    renderTableWidget(widget, data, bodyEl);
  } else if (chartType === "number") {
    renderNumberWidget(widget, data, bodyEl);
  } else {
    bodyEl.innerHTML = `<p class="empty-state">Unknown visual type.</p>`;
  }
}

function destroyWidgetChart(widgetId) {
  if (analyticsChartRefs[widgetId]) {
    analyticsChartRefs[widgetId].destroy();
    delete analyticsChartRefs[widgetId];
  }
}

function renderBarWidget(widget, data) {
  const ctx = document.getElementById(`widgetCanvas-${widget.id}`);
  destroyWidgetChart(widget.id);
  if (!CHART_JS_AVAILABLE) {
    ctx.parentElement.innerHTML = `<p class="empty-state">Chart library isn't loaded — see the README's troubleshooting section.</p>`;
    return;
  }
  analyticsChartRefs[widget.id] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.labels,
      datasets: [{ label: data.value_label || "Value", data: data.values, backgroundColor: "#e5a00d" }],
    },
    options: { ...chartOptions({}), indexAxis: widget.orientation === "horizontal" ? "y" : "x" },
  });
}

function renderLineOrAreaWidget(widget, data, filled) {
  const ctx = document.getElementById(`widgetCanvas-${widget.id}`);
  destroyWidgetChart(widget.id);
  if (!CHART_JS_AVAILABLE) {
    ctx.parentElement.innerHTML = `<p class="empty-state">Chart library isn't loaded — see the README's troubleshooting section.</p>`;
    return;
  }

  // A widget with "Split into multiple lines by" set, OR a second measure,
  // comes back as {series: [{label, values}, ...]} instead of a single
  // {values} array -- one dataset per line. dual_measure specifically means
  // the two series are different, independently-scaled measures (e.g. Play
  // Count vs. Play Hours) rather than N values of one dimension, so those
  // get their own Y axis each rather than sharing one.
  const datasets = data.series
    ? data.series.map((s, i) => {
        const color = WIDGET_COLORS[i % WIDGET_COLORS.length];
        return {
          label: s.label,
          data: s.values,
          borderColor: color,
          backgroundColor: filled ? `${color}26` : color, // ~15% alpha fill
          fill: filled,
          tension: 0.3,
          ...(data.dual_measure ? { yAxisID: i === 0 ? "y" : "y1" } : {}),
        };
      })
    : [
        {
          label: data.value_label || "Value",
          data: data.values,
          borderColor: "#e5a00d",
          backgroundColor: "rgba(229,160,13,0.15)",
          fill: filled,
          tension: 0.3,
        },
      ];

  analyticsChartRefs[widget.id] = new Chart(ctx, {
    type: "line",
    data: { labels: data.labels, datasets },
    options: chartOptions({ beginAtZero: true, dual: !!data.dual_measure }),
  });
}

function renderDonutOrPieWidget(widget, data, isPie) {
  const ctx = document.getElementById(`widgetCanvas-${widget.id}`);
  destroyWidgetChart(widget.id);
  if (!CHART_JS_AVAILABLE) {
    ctx.parentElement.innerHTML = `<p class="empty-state">Chart library isn't loaded — see the README's troubleshooting section.</p>`;
    return;
  }
  analyticsChartRefs[widget.id] = new Chart(ctx, {
    type: isPie ? "pie" : "doughnut",
    data: {
      labels: data.labels,
      datasets: [
        {
          data: data.values,
          backgroundColor: data.labels.map((_, i) => WIDGET_COLORS[i % WIDGET_COLORS.length]),
          borderColor: "#1c1f25",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#8b909c", font: { size: 11 }, boxWidth: 12, padding: 10 } },
      },
    },
  });
}

function renderBandwidthWidget(widget, data) {
  const ctx = document.getElementById(`widgetCanvas-${widget.id}`);
  destroyWidgetChart(widget.id);
  if (!CHART_JS_AVAILABLE) {
    ctx.parentElement.innerHTML = `<p class="empty-state">Chart library isn't loaded — see the README's troubleshooting section.</p>`;
    return;
  }
  analyticsChartRefs[widget.id] = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.labels.map((l) => fmtTimeOnly(l)),
      datasets: [
        {
          label: "Streams",
          data: data.streams,
          borderColor: "#e5a00d",
          backgroundColor: "rgba(229,160,13,0.1)",
          fill: widget.chart_type === "area",
          tension: 0.3,
          yAxisID: "y",
        },
        {
          label: "Bandwidth (Mbps)",
          data: data.bandwidth_mbps,
          borderColor: "#4caf7d",
          backgroundColor: "rgba(76,175,125,0.1)",
          fill: widget.chart_type === "area",
          tension: 0.3,
          yAxisID: "y1",
        },
      ],
    },
    options: chartOptions({ dual: true, beginAtZero: true }),
  });
}

function renderTableWidget(widget, data, bodyEl) {
  const columnLabel = data.dimension_label || "Item";
  const extraCols = data.extra_columns || [];
  const fmtCell = (v) => {
    const displayValue = typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : v;
    return escapeHtml(String(displayValue));
  };
  const rows = data.labels
    .map((label, i) => {
      let cell = escapeHtml(String(label));
      if (data.clickable === "media" && data.media_keys && data.media_keys[i]) {
        cell = `<button class="media-link" data-media-key="${escapeHtml(data.media_keys[i])}" data-media-type="${escapeHtml((data.media_types && data.media_types[i]) || "")}">${escapeHtml(String(label))}</button>`;
      } else if (data.clickable === "user") {
        cell = `<button class="user-link" data-user="${escapeHtml(String(label))}">${escapeHtml(String(label))}</button>`;
      }
      const extraCells = extraCols.map((col) => `<td>${fmtCell(col.values[i])}</td>`).join("");
      return `<tr><td>${cell}</td><td>${fmtCell(data.values[i])}</td>${extraCells}</tr>`;
    })
    .join("");
  const extraHeaders = extraCols.map((col) => `<th>${escapeHtml(col.label)}</th>`).join("");
  bodyEl.innerHTML = `
    <table class="data-table">
      <thead><tr><th>${escapeHtml(columnLabel)}</th><th>${escapeHtml(data.value_label || "Value")}</th>${extraHeaders}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderNumberWidget(widget, data, bodyEl) {
  const topLabel = data.labels[0];
  const rawValue = data.values[0];
  const displayValue = typeof rawValue === "number" && !Number.isInteger(rawValue) ? rawValue.toFixed(2) : rawValue;
  bodyEl.innerHTML = `
    <div class="widget-number-display">
      <div class="widget-number-value">${escapeHtml(String(displayValue))}</div>
      <div class="widget-number-label">${escapeHtml(String(topLabel))}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Edit mode toggle -- covers reordering/renaming/deleting both pages and
// sections, plus revealing the "+ Add Page" / "+ Add Section" buttons and
// each widget card's own up/down/edit/remove controls.
// ---------------------------------------------------------------------------
document.getElementById("analyticsEditToggleBtn").addEventListener("click", () => {
  analyticsEditMode = !analyticsEditMode;
  document.getElementById("analyticsSectionsContainer").classList.toggle("trends-edit-mode", analyticsEditMode);
  document.getElementById("analyticsAddSectionBtn").style.display = analyticsEditMode ? "" : "none";
  document.getElementById("analyticsEditHint").style.display = analyticsEditMode ? "" : "none";
  document.getElementById("analyticsEditToggleBtn").textContent = analyticsEditMode ? "Done Editing" : "Edit Layout";
  renderAnalyticsPageTabs();
});

async function saveAnalyticsLayout() {
  try {
    await fetch("/api/analytics/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages: analyticsPages }),
    });
  } catch (e) {
    console.error(e);
  }
}

function selectAnalyticsPage(pageId) {
  if (!pageId) return;
  navigateTo(`analytics/${encodeURIComponent(pageId)}`);
}

// ---------------------------------------------------------------------------
// Page tabs: switch page, or (in edit mode) reorder/rename/delete a page,
// or add a new one
// ---------------------------------------------------------------------------
document.getElementById("analyticsPageTabs").addEventListener("click", (e) => {
  if (e.target.id === "analyticsAddPageBtn") {
    openPageModal(null);
    return;
  }

  const actionBtn = e.target.closest("[data-page-action]");
  if (actionBtn) {
    const wrap = actionBtn.closest(".analytics-page-tab-wrap");
    const pageId = wrap.dataset.pageId;
    const idx = analyticsPages.findIndex((p) => p.id === pageId);
    if (idx === -1) return;
    const action = actionBtn.dataset.pageAction;

    if (action === "up" && idx > 0) {
      [analyticsPages[idx - 1], analyticsPages[idx]] = [analyticsPages[idx], analyticsPages[idx - 1]];
      renderAnalyticsPageTabs();
      saveAnalyticsLayout();
    } else if (action === "down" && idx < analyticsPages.length - 1) {
      [analyticsPages[idx + 1], analyticsPages[idx]] = [analyticsPages[idx], analyticsPages[idx + 1]];
      renderAnalyticsPageTabs();
      saveAnalyticsLayout();
    } else if (action === "edit") {
      openPageModal(analyticsPages[idx]);
    } else if (action === "remove") {
      const page = analyticsPages[idx];
      showConfirmModal(
        "Delete page?",
        `This removes "${page.name || "this page"}" and all of its sections and widgets. This can't be undone.`,
        () => {
          analyticsPages.splice(idx, 1);
          if (currentAnalyticsPageId === pageId) {
            currentAnalyticsPageId = analyticsPages.length ? analyticsPages[0].id : null;
          }
          renderAnalyticsPageTabs();
          renderAnalyticsSections();
          saveAnalyticsLayout();
          history.replaceState(
            null,
            "",
            currentAnalyticsPageId ? `#analytics/${encodeURIComponent(currentAnalyticsPageId)}` : "#analytics"
          );
        }
      );
    }
    return;
  }

  const tabBtn = e.target.closest(".subtab-btn[data-page-id]");
  if (tabBtn) selectAnalyticsPage(tabBtn.dataset.pageId);
});

// ---------------------------------------------------------------------------
// Add/Rename Page modal
// ---------------------------------------------------------------------------
function openPageModal(page) {
  editingPageId = page ? page.id : null;
  document.getElementById("pageModalTitle").textContent = page ? "Rename Page" : "Add Page";
  document.getElementById("pageTitleInput").value = page ? page.name || "" : "";
  document.getElementById("pageModalOverlay").classList.add("open");
}
function closePageModal() {
  document.getElementById("pageModalOverlay").classList.remove("open");
}
document.getElementById("pageModalClose").addEventListener("click", closePageModal);
document.getElementById("pageModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "pageModalOverlay") closePageModal();
});
document.getElementById("pageSaveBtn").addEventListener("click", () => {
  const name = document.getElementById("pageTitleInput").value.trim() || "Untitled Page";

  if (editingPageId) {
    const page = analyticsPages.find((p) => p.id === editingPageId);
    if (page) page.name = name;
  } else {
    const newPage = { id: `page${Date.now()}`, name, sections: [] };
    analyticsPages.push(newPage);
    currentAnalyticsPageId = newPage.id;
  }
  closePageModal();
  renderAnalyticsPageTabs();
  renderAnalyticsSections();
  saveAnalyticsLayout();
  if (currentAnalyticsPageId) {
    history.replaceState(null, "", `#analytics/${encodeURIComponent(currentAnalyticsPageId)}`);
  }
});

// ---------------------------------------------------------------------------
// Section-level date range dropdown -- overrides every widget in that
// section. Changing it live-refreshes just that section and persists.
// ---------------------------------------------------------------------------
document.getElementById("analyticsSectionsContainer").addEventListener("change", (e) => {
  const periodSel = e.target.closest(".trends-section-period");
  if (periodSel) {
    const sectionId = periodSel.dataset.sectionPeriodId;
    const section = findSection(sectionId);
    if (!section) return;
    section.period = periodSel.value;
    renderSectionWidgets(sectionId);
    saveAnalyticsLayout();
    return;
  }

  const filterSel = e.target.closest(".trends-section-filter-select");
  if (filterSel) {
    const sectionId = filterSel.dataset.sectionId;
    const section = findSection(sectionId);
    if (!section || !section.filters) return;
    section.filters[filterSel.dataset.filterField] = filterSel.value;
    renderSectionWidgets(sectionId);
    saveAnalyticsLayout();
  }
});

// ---------------------------------------------------------------------------
// Section controls: reorder, add-widget, edit, remove
// ---------------------------------------------------------------------------
document.getElementById("analyticsSectionsContainer").addEventListener("click", (e) => {
  const removeFilterBtn = e.target.closest(".trends-section-filter-remove");
  if (removeFilterBtn) {
    const sectionId = removeFilterBtn.dataset.sectionId;
    const section = findSection(sectionId);
    if (!section || !section.filters) return;
    delete section.filters[removeFilterBtn.dataset.filterField];
    renderSectionFilters(sectionId);
    renderSectionWidgets(sectionId);
    saveAnalyticsLayout();
    return;
  }

  const addFilterBtn = e.target.closest(".trends-section-add-filter");
  if (addFilterBtn) {
    openSectionFilterModal(addFilterBtn.dataset.sectionId);
    return;
  }

  const sectionBtn = e.target.closest("[data-section-action]");
  if (sectionBtn) {
    const page = currentAnalyticsPage();
    if (!page) return;
    const sections = page.sections || (page.sections = []);
    const sectionId = sectionBtn.closest(".trends-section").dataset.sectionId;
    const idx = sections.findIndex((s) => s.id === sectionId);
    if (idx === -1) return;
    const action = sectionBtn.dataset.sectionAction;

    if (action === "up" && idx > 0) {
      [sections[idx - 1], sections[idx]] = [sections[idx], sections[idx - 1]];
      renderAnalyticsSections();
      saveAnalyticsLayout();
    } else if (action === "down" && idx < sections.length - 1) {
      [sections[idx + 1], sections[idx]] = [sections[idx], sections[idx + 1]];
      renderAnalyticsSections();
      saveAnalyticsLayout();
    } else if (action === "remove") {
      sections.splice(idx, 1);
      renderAnalyticsSections();
      saveAnalyticsLayout();
    } else if (action === "edit") {
      openSectionModal(sections[idx]);
    } else if (action === "add-widget") {
      openWidgetModal(sectionId, null);
    }
    return;
  }

  const widgetBtn = e.target.closest("[data-action]");
  if (widgetBtn) {
    const sectionId = widgetBtn.closest(".trends-section").dataset.sectionId;
    const section = findSection(sectionId);
    if (!section) return;
    const widgetId = widgetBtn.closest(".widget-card").dataset.widgetId;
    const idx = section.widgets.findIndex((w) => w.id === widgetId);
    if (idx === -1) return;
    const action = widgetBtn.dataset.action;

    if (action === "remove") {
      section.widgets.splice(idx, 1);
      renderSectionWidgets(sectionId);
      saveAnalyticsLayout();
    } else if (action === "edit") {
      openWidgetModal(sectionId, section.widgets[idx]);
    }
  }
});

// ---------------------------------------------------------------------------
// Add/Edit Section modal
// ---------------------------------------------------------------------------
function openSectionModal(section) {
  editingSectionId = section ? section.id : null;
  document.getElementById("sectionModalTitle").textContent = section ? "Edit Section" : "Add Section";
  document.getElementById("sectionTitleInput").value = section ? section.title || "" : "";
  document.getElementById("sectionPeriodInput").value = section ? section.period || "30d" : "30d";
  document.getElementById("sectionModalOverlay").classList.add("open");
}
function closeSectionModal() {
  document.getElementById("sectionModalOverlay").classList.remove("open");
}
document.getElementById("sectionModalClose").addEventListener("click", closeSectionModal);
document.getElementById("sectionModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "sectionModalOverlay") closeSectionModal();
});
document.getElementById("analyticsAddSectionBtn").addEventListener("click", () => openSectionModal(null));

document.getElementById("sectionSaveBtn").addEventListener("click", () => {
  const title = document.getElementById("sectionTitleInput").value.trim() || "Untitled Section";
  const period = document.getElementById("sectionPeriodInput").value;

  if (editingSectionId) {
    const section = findSection(editingSectionId);
    if (section) {
      section.title = title;
      section.period = period;
    }
  } else {
    const page = currentAnalyticsPage();
    if (page) {
      const sections = page.sections || (page.sections = []);
      sections.push({ id: `sec${Date.now()}`, title, period, widgets: [], filters: {} });
    }
  }
  closeSectionModal();
  renderAnalyticsSections();
  saveAnalyticsLayout();
});

// ---------------------------------------------------------------------------
// Add Filter modal -- picks which filter field a section adds. The actual
// value dropdown then lives inline in the section header, right alongside
// the date range dropdown it behaves the same way as.
// ---------------------------------------------------------------------------
function openSectionFilterModal(sectionId) {
  const section = findSection(sectionId);
  if (!section) return;
  editingSectionFilterSectionId = sectionId;
  const active = Object.keys(section.filters || {});
  const available = Object.entries(SECTION_FILTER_FIELDS).filter(([field]) => !active.includes(field));
  const sel = document.getElementById("sectionFilterTypeInput");
  const addBtn = document.getElementById("sectionFilterAddBtn");
  if (available.length === 0) {
    sel.innerHTML = `<option value="">All filters already added</option>`;
    sel.disabled = true;
    addBtn.disabled = true;
  } else {
    sel.disabled = false;
    addBtn.disabled = false;
    sel.innerHTML = available.map(([field, label]) => `<option value="${field}">${escapeHtml(label)}</option>`).join("");
  }
  document.getElementById("sectionFilterModalOverlay").classList.add("open");
}
function closeSectionFilterModal() {
  document.getElementById("sectionFilterModalOverlay").classList.remove("open");
}
document.getElementById("sectionFilterModalClose").addEventListener("click", closeSectionFilterModal);
document.getElementById("sectionFilterModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "sectionFilterModalOverlay") closeSectionFilterModal();
});
document.getElementById("sectionFilterAddBtn").addEventListener("click", () => {
  const field = document.getElementById("sectionFilterTypeInput").value;
  if (!field || !editingSectionFilterSectionId) return;
  const section = findSection(editingSectionFilterSectionId);
  if (!section) return;
  section.filters = section.filters || {};
  section.filters[field] = "";
  const sectionId = editingSectionFilterSectionId;
  closeSectionFilterModal();
  renderSectionFilters(sectionId);
  renderSectionWidgets(sectionId);
  saveAnalyticsLayout();
});

// ---------------------------------------------------------------------------
// Add/Edit Widget modal
// ---------------------------------------------------------------------------
async function openWidgetModal(sectionId, widget) {
  editingWidgetSectionId = sectionId;
  editingWidgetId = widget ? widget.id : null;
  document.getElementById("widgetModalTitle").textContent = widget ? "Edit Widget" : "Add Widget";
  document.getElementById("widgetTitleInput").value = widget ? widget.title || "" : "";

  await populateWidgetSourceDropdown();
  await populateWidgetFilterDropdowns();

  const sourceSel = document.getElementById("widgetSourceInput");
  sourceSel.value = widget ? (widget.mode === "special" ? `special:${widget.source}` : `dim:${widget.dimension}`) : sourceSel.options[0].value;

  // Rebuilds the chart-type/measure dropdown OPTIONS for the selected
  // source -- must run before setting any actual saved values below, since
  // rebuilding a <select>'s innerHTML resets its current selection.
  updateWidgetModalFields();

  if (widget) {
    if (widget.mode === "query" && widget.measure) document.getElementById("widgetMeasureInput").value = widget.measure;
    document.getElementById("widgetChartTypeInput").value = widget.chart_type;
    // Lightweight visibility-only check -- does NOT rebuild any dropdown
    // options, so it's safe to call after the values above are already set.
    toggleChartTypeDependentFields();
    document.getElementById("widgetOrientationInput").value = widget.orientation || "vertical";
    document.getElementById("widgetSeriesByInput").value = widget.series_by || "";
    document.getElementById("widgetMeasure2Input").value = widget.measure2 || "";
    if (widget.extra_measures && widget.extra_measures.length) {
      const extraColumnsEl = document.getElementById("widgetExtraColumnsList");
      const wanted = new Set(widget.extra_measures);
      Array.from(extraColumnsEl.querySelectorAll('input[type="checkbox"]')).forEach((cb) => {
        cb.checked = wanted.has(cb.value);
      });
    }
    document.getElementById("widgetLimitInput").value = widget.limit || 10;
    document.getElementById("widgetSortByInput").value = widget.sort_by || "value";
    updateOrderWording();
    document.getElementById("widgetSortInput").value = widget.sort || "desc";
    const f = widget.filters || {};
    document.getElementById("widgetFilterMediaType").value = f.media_type || "";
    document.getElementById("widgetFilterUser").value = f.user || "";
    document.getElementById("widgetFilterLibrary").value = f.library || "";
    document.getElementById("widgetFilterPlatform").value = f.platform || "";
    document.getElementById("widgetFilterDecision").value = f.video_decision || "";
  }

  document.getElementById("widgetModalOverlay").classList.add("open");
}

async function populateWidgetSourceDropdown() {
  const sel = document.getElementById("widgetSourceInput");
  const dimGroup = Object.entries(analyticsCatalog.dimensions)
    .map(([key, meta]) => `<option value="dim:${key}">${escapeHtml(meta.label)}</option>`)
    .join("");
  const specialGroup = Object.entries(analyticsCatalog.special_sources)
    .map(([key, meta]) => `<option value="special:${key}">${escapeHtml(meta.label)}</option>`)
    .join("");
  sel.innerHTML = `
    <optgroup label="Slice your data by...">${dimGroup}</optgroup>
    <optgroup label="Built-in visuals">${specialGroup}</optgroup>
  `;
}

async function populateWidgetFilterDropdowns() {
  const opts = await getFilterOptions();
  if (!opts.ok) return;

  const fill = (id, values) => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = `<option value="">Any</option>` + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    sel.value = current;
  };
  fill("widgetFilterMediaType", opts.media_types || ["movie", "episode"]);
  fill("widgetFilterUser", opts.users || []);
  fill("widgetFilterLibrary", opts.libraries || []);
  fill("widgetFilterPlatform", opts.platforms || []);
  fill("widgetFilterDecision", opts.video_decisions || []);
}

function updateWidgetModalFields() {
  const raw = document.getElementById("widgetSourceInput").value;
  const [kind, key] = raw.split(/:(.+)/); // split on first ':' only

  const isSpecial = kind === "special";
  document.getElementById("widgetMeasureLabel").style.display = isSpecial ? "none" : "";
  document.getElementById("widgetMeasureInput").style.display = isSpecial ? "none" : "";
  document.getElementById("widgetFiltersBox").style.display = isSpecial ? "none" : "";
  document.getElementById("widgetLimitSortRow").style.display = isSpecial ? "none" : "grid";
  document.getElementById("widgetSortLabel").style.display = isSpecial ? "none" : "";
  document.getElementById("widgetSortInput").style.display = isSpecial ? "none" : "";

  // Chart type options depend on whether this is a special built-in (fixed
  // set) or a normal dimension slice (the full palette).
  const chartTypeSel = document.getElementById("widgetChartTypeInput");
  const availableTypes = isSpecial
    ? analyticsCatalog.special_sources[key].chart_types
    : analyticsCatalog.chart_types;
  chartTypeSel.innerHTML = availableTypes
    .map((t) => `<option value="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</option>`)
    .join("");

  if (!isSpecial) {
    // Measure options: genre dimension only allows measures that compose
    // correctly through the extra SUM the genre breakdown needs.
    const measureSel = document.getElementById("widgetMeasureInput");
    const allowedMeasureKeys = key === "genre" ? analyticsCatalog.genre_safe_measures : Object.keys(analyticsCatalog.measures);
    measureSel.innerHTML = allowedMeasureKeys
      .map((mKey) => `<option value="${mKey}">${escapeHtml(analyticsCatalog.measures[mKey].label)}</option>`)
      .join("");

    updateSortByWording(key);
  }

  toggleChartTypeDependentFields();
}

function updateSortByWording(dimensionKey) {
  const isTimeSequence = (analyticsCatalog.time_sequence_dimensions || []).includes(dimensionKey);
  const sortBySel = document.getElementById("widgetSortByInput");
  sortBySel.options[1].textContent = isTimeSequence ? "Chronological" : "Label";
  updateOrderWording();
}

function updateOrderWording() {
  const sortBy = document.getElementById("widgetSortByInput").value;
  const raw = document.getElementById("widgetSourceInput").value;
  const [, key] = raw.split(/:(.+)/);
  const isTimeSequence = (analyticsCatalog.time_sequence_dimensions || []).includes(key);
  const orderSel = document.getElementById("widgetSortInput");

  if (sortBy === "label" && isTimeSequence) {
    orderSel.options[0].textContent = "Newest first";
    orderSel.options[1].textContent = "Oldest first";
  } else if (sortBy === "label") {
    orderSel.options[0].textContent = "Z to A";
    orderSel.options[1].textContent = "A to Z";
  } else {
    orderSel.options[0].textContent = "Highest first";
    orderSel.options[1].textContent = "Lowest first";
  }
}
document.getElementById("widgetSortByInput").addEventListener("change", updateOrderWording);

document.getElementById("widgetSourceInput").addEventListener("change", updateWidgetModalFields);
document.getElementById("widgetChartTypeInput").addEventListener("change", toggleChartTypeDependentFields);
document.getElementById("widgetMeasureInput").addEventListener("change", toggleChartTypeDependentFields);

function toggleChartTypeDependentFields() {
  const chartType = document.getElementById("widgetChartTypeInput").value;
  const isBar = chartType === "bar";
  document.getElementById("widgetOrientationLabel").style.display = isBar ? "" : "none";
  document.getElementById("widgetOrientationInput").style.display = isBar ? "" : "none";

  // "Split into multiple lines by" and "Second Measure" only make sense for
  // line/area widgets, against a normal dimension slice (not a special
  // built-in visual, and not the genre breakdown, which already groups
  // differently under the hood). The series-by option list excludes genre
  // and whatever dimension is already on the X axis, since splitting a line
  // by the same thing it's already grouped by doesn't mean anything.
  const raw = document.getElementById("widgetSourceInput").value;
  const [kind, key] = raw.split(/:(.+)/); // split on first ':' only
  const lineOrAreaEligible = (chartType === "line" || chartType === "area") && kind !== "special" && key !== "genre";

  document.getElementById("widgetSeriesByLabel").style.display = lineOrAreaEligible ? "" : "none";
  const seriesByEl = document.getElementById("widgetSeriesByInput");
  seriesByEl.style.display = lineOrAreaEligible ? "" : "none";

  if (lineOrAreaEligible) {
    const current = seriesByEl.value;
    const options = Object.entries(analyticsCatalog.dimensions)
      .filter(([dimKey]) => dimKey !== "genre" && dimKey !== key)
      .map(([dimKey, meta]) => `<option value="${dimKey}">${escapeHtml(meta.label)}</option>`)
      .join("");
    seriesByEl.innerHTML = `<option value="">None — single line</option>${options}`;
    seriesByEl.value = current;
  }

  document.getElementById("widgetMeasure2Label").style.display = lineOrAreaEligible ? "" : "none";
  document.getElementById("widgetMeasure2Hint").style.display = lineOrAreaEligible ? "" : "none";
  const measure2El = document.getElementById("widgetMeasure2Input");
  measure2El.style.display = lineOrAreaEligible ? "" : "none";

  if (lineOrAreaEligible) {
    const current = measure2El.value;
    const primaryMeasure = document.getElementById("widgetMeasureInput").value;
    const options = Object.entries(analyticsCatalog.measures)
      .filter(([measureKey]) => measureKey !== primaryMeasure)
      .map(([measureKey, meta]) => `<option value="${measureKey}">${escapeHtml(meta.label)}</option>`)
      .join("");
    measure2El.innerHTML = `<option value="">None</option>${options}`;
    measure2El.value = current;
  }

  // "Additional Columns" only makes sense for table widgets, against a
  // normal (non-genre) dimension slice -- same reasoning as above, just for
  // the one chart type where showing several measures side by side as
  // columns is straightforward rather than needing its own axis. A
  // checkbox list rather than a <select multiple> -- plain clicking each
  // one is a much more discoverable way to pick several than needing to
  // hold Cmd/Ctrl while clicking a native multi-select.
  const tableEligible = chartType === "table" && kind !== "special" && key !== "genre";
  document.getElementById("widgetExtraColumnsLabel").style.display = tableEligible ? "" : "none";
  const extraColumnsEl = document.getElementById("widgetExtraColumnsList");
  extraColumnsEl.style.display = tableEligible ? "" : "none";

  if (tableEligible) {
    const currentlyChecked = new Set(
      Array.from(extraColumnsEl.querySelectorAll("input:checked")).map((cb) => cb.value)
    );
    const primaryMeasure = document.getElementById("widgetMeasureInput").value;
    extraColumnsEl.innerHTML = Object.entries(analyticsCatalog.measures)
      .filter(([measureKey]) => measureKey !== primaryMeasure)
      .map(
        ([measureKey, meta]) => `
        <label class="column-checkbox-row">
          <input type="checkbox" value="${measureKey}" ${currentlyChecked.has(measureKey) ? "checked" : ""} />
          ${escapeHtml(meta.label)}
        </label>`
      )
      .join("");
  }

  // "Date" builds its own X axis from the section's date range (zero-filled
  // day by day) rather than picking the top N values by count/label like
  // every other dimension does -- "Show Top" doesn't mean anything for it,
  // so hide it entirely instead of leaving a control that has no effect.
  const isDateDimension = kind !== "special" && key === "day";
  document.getElementById("widgetLimitGroup").style.display = isDateDimension ? "none" : "";
}

function closeWidgetModal() {
  document.getElementById("widgetModalOverlay").classList.remove("open");
}
document.getElementById("widgetModalClose").addEventListener("click", closeWidgetModal);
document.getElementById("widgetModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "widgetModalOverlay") closeWidgetModal();
});

document.getElementById("widgetSaveBtn").addEventListener("click", () => {
  const section = findSection(editingWidgetSectionId);
  if (!section) return;

  const raw = document.getElementById("widgetSourceInput").value;
  const [kind, key] = raw.split(/:(.+)/);
  const chartType = document.getElementById("widgetChartTypeInput").value;
  const customTitle = document.getElementById("widgetTitleInput").value.trim();
  // Sizing now happens by dragging a widget's resize handle directly on the
  // grid, not a field in this modal -- an existing widget keeps whatever
  // span it already has; a brand new one defaults to half-width (3 of 6).
  const existingWidget = editingWidgetId ? section.widgets.find((w) => w.id === editingWidgetId) : null;
  const span = existingWidget ? existingWidget.span || 3 : 3;

  let newWidget;
  if (kind === "special") {
    newWidget = {
      id: editingWidgetId || `w${Date.now()}`,
      mode: "special",
      source: key,
      chart_type: chartType,
      span,
      title: customTitle,
    };
  } else {
    newWidget = {
      id: editingWidgetId || `w${Date.now()}`,
      mode: "query",
      dimension: key,
      measure: document.getElementById("widgetMeasureInput").value,
      chart_type: chartType,
      limit: parseInt(document.getElementById("widgetLimitInput").value, 10) || 10,
      sort: document.getElementById("widgetSortInput").value,
      sort_by: document.getElementById("widgetSortByInput").value,
      span,
      title: customTitle,
      filters: {
        media_type: document.getElementById("widgetFilterMediaType").value,
        user: document.getElementById("widgetFilterUser").value,
        library: document.getElementById("widgetFilterLibrary").value,
        platform: document.getElementById("widgetFilterPlatform").value,
        video_decision: document.getElementById("widgetFilterDecision").value,
      },
    };
    if (chartType === "bar") {
      newWidget.orientation = document.getElementById("widgetOrientationInput").value;
    }
    if (chartType === "line" || chartType === "area") {
      const seriesBy = document.getElementById("widgetSeriesByInput").value;
      if (seriesBy) newWidget.series_by = seriesBy;
      const measure2 = document.getElementById("widgetMeasure2Input").value;
      if (measure2) newWidget.measure2 = measure2;
    }
    if (chartType === "table") {
      const extraMeasures = Array.from(
        document.getElementById("widgetExtraColumnsList").querySelectorAll('input[type="checkbox"]:checked')
      ).map((cb) => cb.value);
      if (extraMeasures.length) newWidget.extra_measures = extraMeasures;
    }
  }

  if (editingWidgetId) {
    const idx = section.widgets.findIndex((w) => w.id === editingWidgetId);
    if (idx !== -1) section.widgets[idx] = newWidget;
  } else {
    section.widgets.push(newWidget);
  }
  closeWidgetModal();
  renderSectionWidgets(section.id);
  saveAnalyticsLayout();
});

// ---------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------
function fmtRelativeTime(iso) {
  if (!iso) return "Never";
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return "—";
  let seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 0) seconds = 0;
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, secs] of units) {
    const value = Math.floor(seconds / secs);
    if (value >= 1) {
      if (value === 1) return `${name === "hour" ? "an" : "a"} ${name} ago`;
      return `${value} ${name}s ago`;
    }
  }
  return "just now";
}

function fmtDurationRough(ms) {
  // A coarser formatter than fmtDuration, for totals large enough that
  // "Xh Ym" would be unwieldy (e.g. a whole library's total watch time).
  if (!ms) return "—";
  const mins = ms / 60000;
  const hours = mins / 60;
  const days = hours / 24;
  if (days >= 1) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  if (hours >= 1) return `${Math.round(hours)}h`;
  if (mins >= 1) return `${Math.round(mins)} min${Math.round(mins) === 1 ? "" : "s"}`;
  return "<1 min";
}

function libraryTypeIcon(type) {
  if (type === "show") {
    return `<svg class="library-type-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8M12 17v4"/></svg>`;
  }
  if (type === "artist") {
    return `<svg class="library-type-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  }
  return `<svg class="library-type-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9h18M8 5v4M16 5v4"/></svg>`;
}

function renderLastPlayed(lib) {
  if (!lib.last_played_title) return "—";
  let extra = "";
  if (lib.last_played_type === "episode" && lib.last_played_season != null && lib.last_played_episode != null) {
    extra = ` (S${lib.last_played_season} · E${lib.last_played_episode})`;
  }
  return `${escapeHtml(lib.last_played_title)}${escapeHtml(extra)}`;
}

const LIBRARIES_COLUMNS = [
  { key: "name", label: "Library Name", col: 2 },
  { key: "type", label: "Library Type", col: 3 },
  { key: "total_items", label: "Total Movies / TV Shows", col: 4 },
  { key: "total_seasons", label: "Total Seasons", col: 5 },
  { key: "total_episodes", label: "Total Episodes", col: 6 },
  { key: "last_streamed", label: "Last Streamed", col: 7 },
  { key: "last_played", label: "Last Played", col: 8 },
  { key: "total_plays", label: "Total Plays", col: 9 },
  { key: "total_duration_ms", label: "Total Play Duration", col: 10 },
];
const LIBRARIES_COLUMN_PREFS_KEY = "plexStatsLibrariesColumnPrefs";
const LIBRARIES_NUMERIC_SORT_KEYS = new Set([
  "total_items", "total_seasons", "total_episodes", "total_plays", "total_duration_ms", "last_streamed",
]);

let librariesData = [];
let librariesSortKey = "name";
let librariesSortDir = "asc";
let librariesColumnPrefs = {};
try {
  librariesColumnPrefs = JSON.parse(localStorage.getItem(LIBRARIES_COLUMN_PREFS_KEY) || "{}");
} catch (e) {
  librariesColumnPrefs = {};
}

function applyLibrariesColumnVisibility() {
  let css = "";
  LIBRARIES_COLUMNS.forEach((c) => {
    if (librariesColumnPrefs[c.key] === false) {
      css += `#librariesTable th:nth-child(${c.col}), #librariesTable td:nth-child(${c.col}) { display: none; }\n`;
    }
  });
  let styleEl = document.getElementById("librariesColumnStyle");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "librariesColumnStyle";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

function renderLibrariesColumnsModal() {
  const list = document.getElementById("librariesColumnsCheckboxList");
  list.innerHTML = LIBRARIES_COLUMNS.map((c) => {
    const checked = librariesColumnPrefs[c.key] !== false;
    return `
      <label class="column-checkbox-row">
        <input type="checkbox" data-col-key="${c.key}" ${checked ? "checked" : ""} />
        ${escapeHtml(c.label)}
      </label>`;
  }).join("");
}

document.getElementById("librariesColumnsBtn").addEventListener("click", () => {
  renderLibrariesColumnsModal();
  document.getElementById("librariesColumnsModalOverlay").classList.add("open");
});
function closeLibrariesColumnsModal() {
  document.getElementById("librariesColumnsModalOverlay").classList.remove("open");
}
document.getElementById("librariesColumnsModalClose").addEventListener("click", closeLibrariesColumnsModal);
document.getElementById("librariesColumnsDone").addEventListener("click", closeLibrariesColumnsModal);
document.getElementById("librariesColumnsModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "librariesColumnsModalOverlay") closeLibrariesColumnsModal();
});
document.getElementById("librariesColumnsShowAll").addEventListener("click", () => {
  librariesColumnPrefs = {};
  localStorage.setItem(LIBRARIES_COLUMN_PREFS_KEY, JSON.stringify(librariesColumnPrefs));
  applyLibrariesColumnVisibility();
  renderLibrariesColumnsModal();
});
document.getElementById("librariesColumnsCheckboxList").addEventListener("change", (e) => {
  const checkbox = e.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  librariesColumnPrefs[checkbox.dataset.colKey] = checkbox.checked;
  localStorage.setItem(LIBRARIES_COLUMN_PREFS_KEY, JSON.stringify(librariesColumnPrefs));
  applyLibrariesColumnVisibility();
});
applyLibrariesColumnVisibility();

function updateLibrariesSortIcons() {
  document.querySelectorAll("#librariesTable th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    const isActive = th.dataset.sortKey === librariesSortKey;
    th.classList.toggle("sorted", isActive);
    icon.textContent = isActive ? (librariesSortDir === "asc" ? "▲" : "▼") : "";
  });
}

document.querySelectorAll("#librariesTable th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sortKey;
    if (key === librariesSortKey) {
      librariesSortDir = librariesSortDir === "asc" ? "desc" : "asc";
    } else {
      librariesSortKey = key;
      librariesSortDir = LIBRARIES_NUMERIC_SORT_KEYS.has(key) ? "desc" : "asc";
    }
    updateLibrariesSortIcons();
    renderLibrariesTable();
  });
});
updateLibrariesSortIcons();

function renderLibrariesTable() {
  const search = document.getElementById("librariesSearch").value.trim().toLowerCase();
  let rows = librariesData.filter((l) => !search || l.name.toLowerCase().includes(search));

  rows = rows.slice().sort((a, b) => {
    let av = a[librariesSortKey];
    let bv = b[librariesSortKey];
    const missing = librariesSortDir === "asc" ? Infinity : -Infinity;
    if (av === null || av === undefined) av = missing;
    if (bv === null || bv === undefined) bv = missing;
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return librariesSortDir === "asc" ? -1 : 1;
    if (av > bv) return librariesSortDir === "asc" ? 1 : -1;
    return 0;
  });

  const tbody = document.querySelector("#librariesTable tbody");
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No libraries found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (lib) => `
      <tr>
        <td>${libraryTypeIcon(lib.type)}</td>
        <td><button class="library-link" data-library-name="${escapeHtml(lib.name)}">${escapeHtml(lib.name)}</button></td>
        <td>${lib.type === "show" ? "Show" : lib.type === "artist" ? "Music" : "Movie"}</td>
        <td>${lib.total_items ?? "—"}</td>
        <td>${lib.total_seasons ?? "—"}</td>
        <td>${lib.total_episodes ?? "—"}</td>
        <td>${fmtRelativeTime(lib.last_streamed)}</td>
        <td>${renderLastPlayed(lib)}</td>
        <td>${lib.total_plays || 0}</td>
        <td>${fmtDurationRough(lib.total_duration_ms)}</td>
      </tr>`
    )
    .join("");
}

async function refreshLibrariesTable() {
  const res = await fetch("/api/libraries");
  const data = await res.json();
  librariesData = data.libraries || [];
  renderLibrariesTable();
  const now = fmtTimeNow();
  document.getElementById("librariesSyncStatus").textContent = `Loaded at ${now}`;
}

document.getElementById("librariesSearch").addEventListener("input", renderLibrariesTable);

document.getElementById("librariesRefreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("librariesRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    await fetch("/api/libraries/sync", { method: "POST" });
    await refreshLibrariesTable();
  } catch (e) {
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh Libraries";
  }
});

// ---------------------------------------------------------------------------
// Library Detail (drilldown page for a specific library)
// ---------------------------------------------------------------------------
function avatarColor(name) {
  const colors = [
    "#c0392b", "#8e44ad", "#2980b9", "#16a085", "#d35400",
    "#c2185b", "#7f8c8d", "#e67e22", "#27ae60", "#2c3e50",
  ];
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function openLibraryDetail(name) {
  if (!name) return;
  breadcrumbTrail.push({ label: name, hash: `library-detail/${encodeURIComponent(name)}` });
  navigateTo(`library-detail/${encodeURIComponent(name)}`);
}

function renderCarouselCard({ thumb, title, mediaKey, mediaType, meta, year }) {
  const posterHtml = thumb
    ? `<img class="carousel-card-poster" data-fallback="1" alt="" src="/api/poster?path=${encodeURIComponent(thumb)}" ${
        mediaKey ? `data-media-key="${escapeHtml(mediaKey)}" data-media-type="${escapeHtml(mediaType || "")}"` : ""
      } />`
    : `<div class="carousel-card-poster-placeholder"></div>`;
  const titleAttrs = mediaKey
    ? `data-media-key="${escapeHtml(mediaKey)}" data-media-type="${escapeHtml(mediaType || "")}"`
    : "";
  return `
    <div class="carousel-card">
      ${posterHtml}
      <div class="carousel-card-title" ${titleAttrs}>${escapeHtml(title || "Untitled")}</div>
      <div class="carousel-card-meta">${escapeHtml(meta || "")}${year ? ` · ${escapeHtml(String(year))}` : ""}</div>
    </div>`;
}

function attachCarouselPosterFallbacks(container) {
  container.querySelectorAll('img.carousel-card-poster[data-fallback="1"]').forEach((img) => {
    img.addEventListener("error", () => {
      const placeholder = document.createElement("div");
      placeholder.className = "carousel-card-poster-placeholder";
      img.replaceWith(placeholder);
    });
  });
}

let currentLibraryName = null;
let currentLibraryType = null;
let libraryHistoryPage = 1;
let libraryHistoryTotal = 0;
const LIBRARY_HISTORY_PAGE_SIZE = 25;

async function showLibraryDetailPage(name, subtab) {
  currentLibraryName = name;
  const hash = `library-detail/${encodeURIComponent(name)}`;
  ensureBreadcrumbTrailFor(hash, [{ label: "Libraries", hash: "libraries" }, { label: name, hash }]);
  renderBreadcrumbs("libraryDetailBreadcrumbs");
  activateTab("library-detail");
  document.getElementById("libraryDetailName").textContent = name;
  activateLibrarySubtab(subtab || "overview");
  await loadLibraryOverview(name);
}

document.querySelectorAll("#libraryDetailSubtabs .subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    // replaceState (not navigateTo/pushState) so switching between a
    // library's own sub-tabs doesn't pile up entries in the browser's back
    // history -- pressing Back should return to Libraries, not cycle subtabs.
    history.replaceState(null, "", `#library-detail/${encodeURIComponent(currentLibraryName)}/${btn.dataset.subtab}`);
    activateLibrarySubtab(btn.dataset.subtab);
  });
});

function activateLibrarySubtab(subtab) {
  document.querySelectorAll("#libraryDetailSubtabs .subtab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.subtab === subtab)
  );
  document.querySelectorAll("#tab-library-detail .subtab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `libSubtab-${subtab}`)
  );

  if (subtab === "history") {
    libraryHistoryPage = 1;
    loadLibraryHistoryUserFilter();
    refreshLibraryHistoryTable();
  } else if (subtab === "media") {
    libraryMediaPage = 1;
    populateLibraryMediaGenreFilter();
    refreshLibraryMedia();
  } else if (subtab === "collections") {
    refreshLibraryCollections();
  } else if (subtab === "playlists") {
    refreshLibraryPlaylists();
  }
}

async function loadLibraryOverview(name) {
  const periodEl = document.getElementById("libraryPeriodStats");
  const userEl = document.getElementById("libraryUserStats");
  const playedEl = document.getElementById("libraryRecentPlayed");
  const addedEl = document.getElementById("libraryRecentAdded");
  periodEl.innerHTML = "";
  userEl.innerHTML = "";
  playedEl.innerHTML = `<p class="empty-state">Loading…</p>`;
  addedEl.innerHTML = `<p class="empty-state">Loading…</p>`;

  let data;
  try {
    const res = await fetch(`/api/libraries/detail?name=${encodeURIComponent(name)}`);
    data = await res.json();
  } catch (e) {
    console.error(e);
    playedEl.innerHTML = `<p class="empty-state">Couldn't load this library.</p>`;
    addedEl.innerHTML = "";
    return;
  }
  if (!data.ok) {
    playedEl.innerHTML = `<p class="empty-state">Couldn't load this library.</p>`;
    addedEl.innerHTML = "";
    return;
  }
  currentLibraryType = data.type;

  const periodLabels = {
    last_24h: "Last 24 Hours",
    last_7d: "Last 7 Days",
    last_30d: "Last 30 Days",
    all_time: "All Time",
  };
  periodEl.innerHTML = Object.entries(periodLabels)
    .map(([key, label]) => {
      const stat = (data.period_stats && data.period_stats[key]) || { plays: 0, duration_ms: 0 };
      return `
        <div class="period-stat-card">
          <div class="period-stat-label">${escapeHtml(label)}</div>
          <div class="period-stat-value"><strong>${stat.plays}</strong> plays / ${fmtDurationRough(stat.duration_ms)}</div>
        </div>`;
    })
    .join("");

  if (!data.user_stats || data.user_stats.length === 0) {
    userEl.innerHTML = `<p class="empty-state">No watch history yet.</p>`;
  } else {
    userEl.innerHTML = data.user_stats
      .map(
        (u) => `
        <div class="library-user-item">
          <div class="library-user-avatar" style="background:${avatarColor(u.user)}">${escapeHtml(
            (u.user || "?").charAt(0).toUpperCase()
          )}</div>
          <div>
            <span class="library-user-name">${escapeHtml(u.user)}</span><br/>
            <span class="library-user-plays">${u.plays}</span><span class="library-user-plays-label">plays</span>
          </div>
        </div>`
      )
      .join("");
  }

  if (!data.recent_plays || data.recent_plays.length === 0) {
    playedEl.innerHTML = `<p class="empty-state">Nothing played yet.</p>`;
  } else {
    playedEl.innerHTML = data.recent_plays
      .map((p) =>
        renderCarouselCard({
          thumb: p.thumb,
          title: p.full_title,
          mediaKey: p.media_key,
          mediaType: p.media_type,
          meta: `Watched ${fmtRelativeTime(p.viewed_at)}`,
        })
      )
      .join("");
    attachCarouselPosterFallbacks(playedEl);
  }

  if (!data.recently_added || data.recently_added.length === 0) {
    addedEl.innerHTML = `<p class="empty-state">Nothing recently added.</p>`;
  } else {
    addedEl.innerHTML = data.recently_added
      .map((a) =>
        renderCarouselCard({
          thumb: a.thumb,
          title: a.title,
          mediaKey: a.media_key,
          mediaType: a.media_type,
          meta: `Added ${fmtRelativeTime(a.added_at)}`,
          year: a.year,
        })
      )
      .join("");
    attachCarouselPosterFallbacks(addedEl);
  }
}

// ---------------------------------------------------------------------------
// Library Detail -- History sub-tab (reuses the main /api/history/table
// endpoint, scoped to this one library, with the same sort/filter/search
// capability as the main History page.)
// ---------------------------------------------------------------------------
let libraryHistoryDecisionFilter = "";
let libraryHistorySortKey = "date";
let libraryHistorySortDir = "desc";

async function loadLibraryHistoryUserFilter() {
  const res = await fetch("/api/users");
  const data = await res.json();
  const sel = document.getElementById("libraryHistoryUserFilter");
  const current = sel.value;
  sel.innerHTML = '<option value="">All users</option>';
  (data.users || []).forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u;
    opt.textContent = u;
    sel.appendChild(opt);
  });
  if ((data.users || []).includes(current)) sel.value = current;
}

function updateLibraryHistorySortIcons() {
  document.querySelectorAll("#libraryHistoryTable th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    const isActive = th.dataset.sortKey === libraryHistorySortKey;
    th.classList.toggle("sorted", isActive);
    icon.textContent = isActive ? (libraryHistorySortDir === "asc" ? "▲" : "▼") : "";
  });
}
document.querySelectorAll("#libraryHistoryTable th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sortKey;
    if (key === libraryHistorySortKey) {
      libraryHistorySortDir = libraryHistorySortDir === "asc" ? "desc" : "asc";
    } else {
      libraryHistorySortKey = key;
      libraryHistorySortDir = HISTORY_DEFAULT_DESC_KEYS.has(key) ? "desc" : "asc";
    }
    updateLibraryHistorySortIcons();
    libraryHistoryPage = 1;
    refreshLibraryHistoryTable();
  });
});
updateLibraryHistorySortIcons();

document.querySelectorAll("#libraryHistoryDecisionFilter .filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#libraryHistoryDecisionFilter .filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    libraryHistoryDecisionFilter = btn.dataset.value;
    libraryHistoryPage = 1;
    refreshLibraryHistoryTable();
  });
});

let libraryHistorySearchDebounce;
document.getElementById("libraryHistorySearch").addEventListener("input", () => {
  clearTimeout(libraryHistorySearchDebounce);
  libraryHistorySearchDebounce = setTimeout(() => {
    libraryHistoryPage = 1;
    refreshLibraryHistoryTable();
  }, 350);
});
document.getElementById("libraryHistoryUserFilter").addEventListener("change", () => {
  libraryHistoryPage = 1;
  refreshLibraryHistoryTable();
});

// ---------------------------------------------------------------------------
// Library History table: Show/Hide Columns -- same pattern as the main
// History table and the Libraries table (an injected <style> tag using
// nth-child selectors, prefs persisted per-browser via localStorage).
// ---------------------------------------------------------------------------
const LIBRARY_HISTORY_COLUMNS = [
  { key: "date", label: "Date", col: 1 },
  { key: "user", label: "User", col: 2 },
  { key: "ip", label: "IP Address", col: 3 },
  { key: "platform", label: "Platform", col: 4 },
  { key: "product", label: "Product", col: 5 },
  { key: "player", label: "Player", col: 6 },
  { key: "title", label: "Title", col: 7 },
  { key: "type", label: "Type", col: 8 },
  { key: "started", label: "Started", col: 9 },
  { key: "paused", label: "Paused", col: 10 },
  { key: "stopped", label: "Stopped", col: 11 },
  { key: "duration", label: "Duration", col: 12 },
];
const LIBRARY_HISTORY_COLUMN_PREFS_KEY = "plexStatsLibraryHistoryColumnPrefs";

let libraryHistoryColumnPrefs = {};
try {
  libraryHistoryColumnPrefs = JSON.parse(localStorage.getItem(LIBRARY_HISTORY_COLUMN_PREFS_KEY) || "{}");
} catch (e) {
  libraryHistoryColumnPrefs = {};
}

function applyLibraryHistoryColumnVisibility() {
  let css = "";
  LIBRARY_HISTORY_COLUMNS.forEach((c) => {
    if (libraryHistoryColumnPrefs[c.key] === false) {
      css += `#libraryHistoryTable th:nth-child(${c.col}), #libraryHistoryTable td:nth-child(${c.col}) { display: none; }\n`;
    }
  });
  let styleEl = document.getElementById("libraryHistoryColumnStyle");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "libraryHistoryColumnStyle";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

function renderLibraryHistoryColumnsModal() {
  const list = document.getElementById("libraryHistoryColumnsCheckboxList");
  list.innerHTML = LIBRARY_HISTORY_COLUMNS.map((c) => {
    const checked = libraryHistoryColumnPrefs[c.key] !== false;
    return `
      <label class="column-checkbox-row">
        <input type="checkbox" data-col-key="${c.key}" ${checked ? "checked" : ""} />
        ${escapeHtml(c.label)}
      </label>`;
  }).join("");
}

document.getElementById("libraryHistoryColumnsBtn").addEventListener("click", () => {
  renderLibraryHistoryColumnsModal();
  document.getElementById("libraryHistoryColumnsModalOverlay").classList.add("open");
});
function closeLibraryHistoryColumnsModal() {
  document.getElementById("libraryHistoryColumnsModalOverlay").classList.remove("open");
}
document.getElementById("libraryHistoryColumnsModalClose").addEventListener("click", closeLibraryHistoryColumnsModal);
document.getElementById("libraryHistoryColumnsDone").addEventListener("click", closeLibraryHistoryColumnsModal);
document.getElementById("libraryHistoryColumnsModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "libraryHistoryColumnsModalOverlay") closeLibraryHistoryColumnsModal();
});
document.getElementById("libraryHistoryColumnsShowAll").addEventListener("click", () => {
  libraryHistoryColumnPrefs = {};
  localStorage.setItem(LIBRARY_HISTORY_COLUMN_PREFS_KEY, JSON.stringify(libraryHistoryColumnPrefs));
  applyLibraryHistoryColumnVisibility();
  renderLibraryHistoryColumnsModal();
});
document.getElementById("libraryHistoryColumnsCheckboxList").addEventListener("change", (e) => {
  const checkbox = e.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  libraryHistoryColumnPrefs[checkbox.dataset.colKey] = checkbox.checked;
  localStorage.setItem(LIBRARY_HISTORY_COLUMN_PREFS_KEY, JSON.stringify(libraryHistoryColumnPrefs));
  applyLibraryHistoryColumnVisibility();
});
applyLibraryHistoryColumnVisibility();

async function refreshLibraryHistoryTable() {
  const search = document.getElementById("libraryHistorySearch").value.trim();
  const user = document.getElementById("libraryHistoryUserFilter").value;
  const params = new URLSearchParams({
    library: currentLibraryName,
    page: libraryHistoryPage,
    page_size: LIBRARY_HISTORY_PAGE_SIZE,
    search,
    user,
    decision: libraryHistoryDecisionFilter,
    sort: libraryHistorySortKey,
    dir: libraryHistorySortDir,
  });
  const res = await fetch(`/api/history/table?${params}`);
  const data = await res.json();
  libraryHistoryTotal = data.total;

  const tbody = document.querySelector("#libraryHistoryTable tbody");
  if (!data.rows || data.rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-state">No history matches these filters.</td></tr>`;
  } else {
    tbody.innerHTML = data.rows
      .map((r) => {
        const decisionIcon = r.video_decision
          ? `<span class="decision-icon ${r.video_decision}" title="${escapeHtml(DECISION_LABELS[r.video_decision] || r.video_decision)}"></span>`
          : "";
        return `
        <tr class="history-row" data-history-key="${escapeHtml(r.history_key)}">
          <td>${fmtDateOnly(r.viewed_at)}</td>
          <td><button class="user-link" data-user="${escapeHtml(r.user)}">${escapeHtml(r.user)}</button></td>
          <td>${escapeHtml(r.ip_address || "—")}</td>
          <td>${escapeHtml(r.platform || "—")}</td>
          <td>${escapeHtml(r.product || "—")}</td>
          <td>${decisionIcon}${escapeHtml(r.device || "—")}</td>
          <td>${
            r.media_key
              ? `<button class="media-link" data-media-key="${escapeHtml(r.media_key)}" data-media-type="${escapeHtml(r.media_type)}">${escapeHtml(r.full_title)}</button>`
              : escapeHtml(r.full_title)
          }</td>
          <td>${escapeHtml(r.media_type)}</td>
          <td>${fmtTimeOnly(r.start_time)}</td>
          <td>${fmtDuration(r.paused_duration_ms)}</td>
          <td>${fmtTimeOnly(r.stopped_time)}</td>
          <td>${fmtDuration(r.duration_ms)}</td>
          <td><button class="delete-row-btn" data-history-key="${escapeHtml(r.history_key)}" aria-label="Delete this entry" title="Delete this entry">&times;</button></td>
        </tr>`;
      })
      .join("");
  }

  const totalPages = Math.max(Math.ceil(libraryHistoryTotal / LIBRARY_HISTORY_PAGE_SIZE), 1);
  document.getElementById("libraryHistoryPageInfo").textContent = `Page ${libraryHistoryPage} of ${totalPages}`;
  document.getElementById("libraryHistoryPrev").disabled = libraryHistoryPage <= 1;
  document.getElementById("libraryHistoryNext").disabled = libraryHistoryPage >= totalPages;
}
document.getElementById("libraryHistoryPrev").addEventListener("click", () => {
  if (libraryHistoryPage > 1) {
    libraryHistoryPage--;
    refreshLibraryHistoryTable();
  }
});
document.getElementById("libraryHistoryNext").addEventListener("click", () => {
  libraryHistoryPage++;
  refreshLibraryHistoryTable();
});

document.querySelector("#libraryHistoryTable tbody").addEventListener("click", (e) => {
  const deleteBtn = e.target.closest(".delete-row-btn");
  if (!deleteBtn) return;
  const historyKey = deleteBtn.dataset.historyKey;
  const row = deleteBtn.closest(".history-row");
  const titleCell = row.querySelector(".media-link, td:nth-child(7)");
  const titleText = titleCell ? titleCell.textContent.trim() : "this entry";
  showConfirmModal(
    "Delete this history entry?",
    `This permanently removes "${titleText}" from watch history. This can't be undone.`,
    async () => {
      try {
        const res = await fetch(`/api/history/entry/${encodeURIComponent(historyKey)}`, { method: "DELETE" });
        const data = await res.json();
        if (data.ok) {
          refreshLibraryHistoryTable();
        } else {
          alert(`Couldn't delete this entry: ${data.error || "unknown error"}`);
        }
      } catch (err) {
        console.error(err);
        alert("Couldn't delete this entry — try again.");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Library Detail -- Media / Collections / Playlists sub-tabs
// ---------------------------------------------------------------------------
function renderMediaGridCard({ thumb, title, mediaKey, mediaType, meta }) {
  const posterHtml = thumb
    ? `<img class="carousel-card-poster" data-fallback="1" alt="" src="/api/poster?path=${encodeURIComponent(thumb)}" ${
        mediaKey ? `data-media-key="${escapeHtml(mediaKey)}" data-media-type="${escapeHtml(mediaType || "")}"` : ""
      } />`
    : `<div class="carousel-card-poster-placeholder"></div>`;
  const titleAttrs = mediaKey
    ? `data-media-key="${escapeHtml(mediaKey)}" data-media-type="${escapeHtml(mediaType || "")}"`
    : "";
  return `
    <div class="media-grid-card">
      ${posterHtml}
      <div class="carousel-card-title" ${titleAttrs}>${escapeHtml(title || "Untitled")}</div>
      <div class="carousel-card-meta">${escapeHtml(meta || "")}</div>
    </div>`;
}

let libraryMediaData = [];
let libraryMediaSortKey = "title";
let libraryMediaSortDir = "asc";
let libraryMediaPage = 1;
let libraryMediaPageSize = 50;
let libraryMediaHasNext = false;
// Computed server-side from the library's cached total item count divided
// by page_size (see api_library_media) -- cheap since it's off a number
// the background library sync already keeps current, not a live count of
// this specific search/genre query.
let libraryMediaTotalPages = 1;
const LIBRARY_MEDIA_NUMERIC_SORT_KEYS = new Set(["year", "duration_ms", "total_plays"]);

async function populateLibraryMediaGenreFilter() {
  const res = await fetch(`/api/libraries/media-genres?name=${encodeURIComponent(currentLibraryName)}`);
  const data = await res.json();
  const sel = document.getElementById("libraryMediaGenreFilter");
  const current = sel.value;
  sel.innerHTML = '<option value="">All genres</option>';
  (data.genres || []).forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    sel.appendChild(opt);
  });
  if ((data.genres || []).includes(current)) sel.value = current;
}
document.getElementById("libraryMediaGenreFilter").addEventListener("change", () => {
  libraryMediaPage = 1;
  refreshLibraryMedia();
});
document.getElementById("libraryMediaPageSize").addEventListener("change", (e) => {
  libraryMediaPageSize = parseInt(e.target.value, 10) || 50;
  libraryMediaPage = 1;
  refreshLibraryMedia();
});

async function refreshLibraryMedia() {
  const search = document.getElementById("libraryMediaSearch").value.trim();
  const genre = document.getElementById("libraryMediaGenreFilter").value;
  const tbody = document.querySelector("#libraryMediaTable tbody");
  tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Loading…</td></tr>`;
  try {
    const params = new URLSearchParams({
      name: currentLibraryName,
      search,
      genre,
      page: libraryMediaPage,
      page_size: libraryMediaPageSize,
    });
    const res = await fetch(`/api/libraries/media?${params}`);
    const data = await res.json();
    if (!data.ok) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Couldn't load media from Plex.</td></tr>`;
      return;
    }
    libraryMediaData = data.items || [];
    libraryMediaHasNext = !!data.has_next;
    libraryMediaTotalPages = data.total_pages || 1;
    currentLibraryType = data.library_type;
    renderLibraryMediaTable();
    updateLibraryMediaPaginationControls();
  } catch (e) {
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Couldn't load media from Plex.</td></tr>`;
  }
}

function updateLibraryMediaPaginationControls() {
  document.getElementById("libraryMediaPrev").disabled = libraryMediaPage <= 1;
  document.getElementById("libraryMediaNext").disabled = !libraryMediaHasNext;

  const container = document.getElementById("libraryMediaPageNumbers");
  const maxVisible = 10;
  const pageBtn = (p) =>
    `<button class="${p === libraryMediaPage ? "active" : ""}" data-page="${p}" ${
      p === libraryMediaPage ? "disabled" : ""
    }>${p}</button>`;

  let html = "";
  const shown = Math.min(maxVisible, libraryMediaTotalPages);
  for (let p = 1; p <= shown; p++) html += pageBtn(p);
  if (libraryMediaTotalPages > maxVisible) {
    html += `<span class="pagination-ellipsis">…</span>`;
    html += pageBtn(libraryMediaTotalPages);
  }
  container.innerHTML = html;
}
document.getElementById("libraryMediaPageNumbers").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (!btn) return;
  const page = parseInt(btn.dataset.page, 10);
  if (page === libraryMediaPage) return;
  libraryMediaPage = page;
  refreshLibraryMedia();
});
document.getElementById("libraryMediaPrev").addEventListener("click", () => {
  if (libraryMediaPage > 1) {
    libraryMediaPage--;
    refreshLibraryMedia();
  }
});
document.getElementById("libraryMediaNext").addEventListener("click", () => {
  if (!libraryMediaHasNext) return;
  libraryMediaPage++;
  refreshLibraryMedia();
});

const EXPAND_ICON_SVG = `<svg class="expand-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.4" />
  <line x1="8" y1="4.5" x2="8" y2="11.5" stroke="currentColor" stroke-width="1.4" class="expand-icon-vline" />
  <line x1="4.5" y1="8" x2="11.5" y2="8" stroke="currentColor" stroke-width="1.4" />
</svg>`;
const LIBRARY_MEDIA_TYPE_LABELS = { movie: "Movie", show: "TV Show", artist: "Artist" };

function renderLibraryMediaTable() {
  const tbody = document.querySelector("#libraryMediaTable tbody");

  if (libraryMediaData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No matching titles.</td></tr>`;
    return;
  }

  const isNumeric = LIBRARY_MEDIA_NUMERIC_SORT_KEYS.has(libraryMediaSortKey);
  const rows = libraryMediaData.slice().sort((a, b) => {
    let av = a[libraryMediaSortKey];
    let bv = b[libraryMediaSortKey];
    const missing = isNumeric ? (libraryMediaSortDir === "asc" ? Infinity : -Infinity) : "";
    if (av === null || av === undefined) av = missing;
    if (bv === null || bv === undefined) bv = missing;
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return libraryMediaSortDir === "asc" ? -1 : 1;
    if (av > bv) return libraryMediaSortDir === "asc" ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = rows
    .map((item) => {
      const typeLabel = LIBRARY_MEDIA_TYPE_LABELS[item.plex_type] || item.plex_type || "—";
      const titleCell = item.rating_key
        ? `<button class="media-link" data-media-key="${escapeHtml(item.rating_key)}" data-media-type="${escapeHtml(item.media_type || "")}">${escapeHtml(item.title || "Untitled")}</button>`
        : escapeHtml(item.title || "Untitled");
      // Expanding to browse albums only makes sense for an artist row in a
      // Music-type library -- this app's watch history doesn't have
      // per-album/per-track play data to show either way (see
      // fetch_artist_albums), it's purely a browsable catalog drilldown.
      const isExpandable = item.plex_type === "artist" && item.rating_key;
      const expandCell = isExpandable
        ? `<button class="expand-toggle" data-expand-level="artist" aria-label="Show albums">${EXPAND_ICON_SVG}</button>`
        : "";
      return `
        <tr class="media-row" data-artist-key="${escapeHtml(item.rating_key || "")}">
          <td>${expandCell}</td>
          <td>${titleCell}</td>
          <td>${escapeHtml(typeLabel)}</td>
          <td>${item.year || "—"}</td>
          <td>${fmtDuration(item.duration_ms)}</td>
          <td>${escapeHtml(item.content_rating || "—")}</td>
          <td>${fmtDateRaw(item.added_at)}</td>
          <td>${item.total_plays || 0}</td>
          <td>${fmtDateOnly(item.last_played)}</td>
        </tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Media tab: expand an artist row to browse its albums, and an album row
// (nested inside) to browse that album's tracks. Mirrors the History
// table's own expand/collapse pattern (one open at a time, cached once
// fetched, a nested <table> inside a colspan'd detail row) -- just one
// level deeper, since albums themselves also expand.
// ---------------------------------------------------------------------------
const libraryMediaAlbumsCache = {};
const libraryMediaTracksCache = {};

document.querySelector("#libraryMediaTable tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest(".expand-toggle");
  if (!btn || btn.disabled) return;
  if (btn.dataset.expandLevel === "artist") {
    await toggleArtistAlbumsRow(btn);
  } else if (btn.dataset.expandLevel === "album") {
    await toggleAlbumTracksRow(btn);
  }
});

async function toggleArtistAlbumsRow(btn) {
  const row = btn.closest(".media-row");
  const artistKey = row.dataset.artistKey;
  const existingDetail = row.nextElementSibling;
  const isOpen = existingDetail && existingDetail.classList.contains("media-detail-row");

  if (isOpen) {
    existingDetail.remove();
    btn.classList.remove("open");
    return;
  }

  // Only one artist expanded at a time, matching the History table's
  // one-at-a-time pattern -- keeps the table from growing unmanageably
  // long and avoids juggling multiple nested album tables at once.
  document.querySelectorAll("#libraryMediaTable .media-detail-row").forEach((el) => el.remove());
  document.querySelectorAll("#libraryMediaTable .expand-toggle.open").forEach((el) => el.classList.remove("open"));
  btn.classList.add("open");

  let albums = libraryMediaAlbumsCache[artistKey];
  if (!albums) {
    const res = await fetch(`/api/libraries/media/albums?artist_key=${encodeURIComponent(artistKey)}`);
    const data = await res.json();
    albums = data.ok ? data.albums || [] : [];
    libraryMediaAlbumsCache[artistKey] = albums;
  }

  const detailRow = document.createElement("tr");
  detailRow.className = "media-detail-row";
  const colCount = row.children.length;
  if (albums.length === 0) {
    detailRow.innerHTML = `<td colspan="${colCount}">No albums found for this artist.</td>`;
  } else {
    const albumRows = albums
      .map((album) => {
        const expandCell = album.rating_key
          ? `<button class="expand-toggle" data-expand-level="album" aria-label="Show tracks">${EXPAND_ICON_SVG}</button>`
          : "";
        return `
        <tr class="album-row" data-album-key="${escapeHtml(album.rating_key || "")}">
          <td>${expandCell}</td>
          <td>${escapeHtml(album.title || "Untitled")}</td>
          <td>${album.year || "—"}</td>
          <td>${album.track_count ?? "—"}</td>
        </tr>`;
      })
      .join("");
    detailRow.innerHTML = `
      <td colspan="${colCount}">
        <table class="media-detail-table">
          <thead><tr><th></th><th>Album</th><th>Year</th><th>Tracks</th></tr></thead>
          <tbody>${albumRows}</tbody>
        </table>
      </td>`;
  }
  row.after(detailRow);
}

async function toggleAlbumTracksRow(btn) {
  const row = btn.closest(".album-row");
  const albumKey = row.dataset.albumKey;
  const existingDetail = row.nextElementSibling;
  const isOpen = existingDetail && existingDetail.classList.contains("track-detail-row");

  if (isOpen) {
    existingDetail.remove();
    btn.classList.remove("open");
    return;
  }

  // One album expanded at a time within this artist's own album table.
  const albumsTable = row.closest("table");
  albumsTable.querySelectorAll(".track-detail-row").forEach((el) => el.remove());
  albumsTable.querySelectorAll(".expand-toggle.open").forEach((el) => el.classList.remove("open"));
  btn.classList.add("open");

  let tracks = libraryMediaTracksCache[albumKey];
  if (!tracks) {
    const res = await fetch(`/api/libraries/media/tracks?album_key=${encodeURIComponent(albumKey)}`);
    const data = await res.json();
    tracks = data.ok ? data.tracks || [] : [];
    libraryMediaTracksCache[albumKey] = tracks;
  }

  const detailRow = document.createElement("tr");
  detailRow.className = "track-detail-row";
  const colCount = row.children.length;
  if (tracks.length === 0) {
    detailRow.innerHTML = `<td colspan="${colCount}">No tracks found for this album.</td>`;
  } else {
    const trackRows = tracks
      .map(
        (t) =>
          `<tr><td>${t.track_number ?? "—"}</td><td>${escapeHtml(t.title || "Untitled")}</td><td>${fmtDuration(t.duration_ms)}</td></tr>`
      )
      .join("");
    detailRow.innerHTML = `
      <td colspan="${colCount}">
        <table class="media-detail-table track-detail-table">
          <thead><tr><th>#</th><th>Track</th><th>Duration</th></tr></thead>
          <tbody>${trackRows}</tbody>
        </table>
      </td>`;
  }
  row.after(detailRow);
}

function updateLibraryMediaSortIcons() {
  document.querySelectorAll("#libraryMediaTable th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    const isActive = th.dataset.sortKey === libraryMediaSortKey;
    th.classList.toggle("sorted", isActive);
    icon.textContent = isActive ? (libraryMediaSortDir === "asc" ? "▲" : "▼") : "";
  });
}

document.querySelectorAll("#libraryMediaTable th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sortKey;
    if (key === libraryMediaSortKey) {
      libraryMediaSortDir = libraryMediaSortDir === "asc" ? "desc" : "asc";
    } else {
      libraryMediaSortKey = key;
      libraryMediaSortDir = LIBRARY_MEDIA_NUMERIC_SORT_KEYS.has(key) ? "desc" : "asc";
    }
    updateLibraryMediaSortIcons();
    renderLibraryMediaTable();
  });
});
updateLibraryMediaSortIcons();

let libraryMediaSearchDebounce;
document.getElementById("libraryMediaSearch").addEventListener("input", () => {
  clearTimeout(libraryMediaSearchDebounce);
  libraryMediaSearchDebounce = setTimeout(() => {
    libraryMediaPage = 1;
    refreshLibraryMedia();
  }, 350);
});

async function refreshLibraryCollections() {
  const grid = document.getElementById("libraryCollectionsGrid");
  grid.innerHTML = `<p class="empty-state">Loading…</p>`;
  try {
    const res = await fetch(`/api/libraries/collections?name=${encodeURIComponent(currentLibraryName)}`);
    const data = await res.json();
    if (!data.ok) {
      grid.innerHTML = `<p class="empty-state">Couldn't load collections from Plex.</p>`;
      return;
    }
    if (!data.collections || data.collections.length === 0) {
      grid.innerHTML = `<p class="empty-state">No collections in this library.</p>`;
      return;
    }
    // Collections group many titles rather than being one watchable thing
    // themselves, so these cards are informational only, not clickable.
    grid.innerHTML = data.collections
      .map((c) =>
        renderMediaGridCard({
          thumb: c.thumb,
          title: c.title,
          meta: c.child_count != null ? `${c.child_count} item${c.child_count === 1 ? "" : "s"}` : "",
        })
      )
      .join("");
    attachCarouselPosterFallbacks(grid);
  } catch (e) {
    console.error(e);
    grid.innerHTML = `<p class="empty-state">Couldn't load collections from Plex.</p>`;
  }
}

async function refreshLibraryPlaylists() {
  const grid = document.getElementById("libraryPlaylistsGrid");
  grid.innerHTML = `<p class="empty-state">Loading…</p>`;
  try {
    const res = await fetch(`/api/libraries/playlists?name=${encodeURIComponent(currentLibraryName)}`);
    const data = await res.json();
    if (!data.ok) {
      grid.innerHTML = `<p class="empty-state">Couldn't load playlists from Plex.</p>`;
      return;
    }
    if (!data.playlists || data.playlists.length === 0) {
      grid.innerHTML = `<p class="empty-state">No playlists for this library.</p>`;
      return;
    }
    grid.innerHTML = data.playlists
      .map((p) =>
        renderMediaGridCard({
          thumb: p.thumb,
          title: p.title,
          meta: p.item_count != null ? `${p.item_count} item${p.item_count === 1 ? "" : "s"}` : "",
        })
      )
      .join("");
    attachCarouselPosterFallbacks(grid);
  } catch (e) {
    console.error(e);
    grid.innerHTML = `<p class="empty-state">Couldn't load playlists from Plex.</p>`;
  }
}

function updateCarouselArrowState(container) {
  const wrap = container.closest(".carousel-wrap");
  if (!wrap) return;
  const left = wrap.querySelector(".carousel-arrow-left");
  const right = wrap.querySelector(".carousel-arrow-right");
  const maxScroll = container.scrollWidth - container.clientWidth;
  if (left) left.disabled = container.scrollLeft <= 2;
  if (right) right.disabled = container.scrollLeft >= maxScroll - 2;
}

document.querySelectorAll(".carousel-arrow").forEach((btn) => {
  const container = document.getElementById(btn.dataset.carousel);
  if (!container) return;
  btn.addEventListener("click", () => {
    const amount = container.clientWidth * 0.8;
    container.scrollBy({
      left: btn.classList.contains("carousel-arrow-left") ? -amount : amount,
      behavior: "smooth",
    });
  });
  container.addEventListener("scroll", () => updateCarouselArrowState(container));
  // Re-check arrow state whenever the carousel's content changes size (e.g.
  // once its cards actually load in), not just on scroll.
  new ResizeObserver(() => updateCarouselArrowState(container)).observe(container);
});

// ---------------------------------------------------------------------------
// Top Movies / Top TV Shows -- shared implementation still used by the User
// Detail page's own Top Movie/Top TV Show mini-sections, parameterized by
// media type and element ids.
// ---------------------------------------------------------------------------
function updateFeaturedPoster(featuredPrefix, item, mediaType) {
  const container = document.getElementById(`${featuredPrefix}Featured`);
  const img = document.getElementById(`${featuredPrefix}FeaturedImg`);
  const title = document.getElementById(`${featuredPrefix}FeaturedTitle`);
  if (!item) {
    img.removeAttribute("src");
    title.textContent = "No data yet";
    delete container.dataset.mediaKey;
    container.classList.remove("clickable");
    return;
  }
  title.textContent = item.full_title;
  if (item.thumb) {
    img.onerror = () => img.removeAttribute("src");
    img.src = `/api/poster?path=${encodeURIComponent(item.thumb)}`;
    img.alt = item.full_title;
  } else {
    img.removeAttribute("src");
  }
  if (item.media_key) {
    container.dataset.mediaKey = item.media_key;
    container.dataset.mediaType = mediaType || "movie";
    container.classList.add("clickable");
  } else {
    delete container.dataset.mediaKey;
    container.classList.remove("clickable");
  }
}

// Delegated click handling for anything that navigates to a drilldown page
// -- user links (.user-link), media links (.media-link), and featured
// posters (.featured-poster.clickable) -- across every section that shows
// them (Top Movies, Top TV Shows, per-user mini sections, the Users table,
// and the History table).
document.addEventListener("click", (e) => {
  const carouselItem = e.target.closest(".carousel-card-poster, .carousel-card-title");
  if (carouselItem && carouselItem.dataset.mediaKey) {
    const card = carouselItem.closest(".carousel-card, .media-grid-card");
    const titleEl = card ? card.querySelector(".carousel-card-title") : null;
    openMediaDetail(carouselItem.dataset.mediaKey, carouselItem.dataset.mediaType, titleEl ? titleEl.textContent.trim() : "");
    return;
  }
  const userLink = e.target.closest(".user-link");
  if (userLink) {
    openUserDetail(userLink.dataset.user);
    return;
  }
  const libraryLink = e.target.closest(".library-link");
  if (libraryLink) {
    openLibraryDetail(libraryLink.dataset.libraryName);
    return;
  }
  const poster = e.target.closest(".featured-poster.clickable");
  if (poster) {
    const titleEl = poster.querySelector(".featured-title");
    openMediaDetail(poster.dataset.mediaKey, poster.dataset.mediaType, titleEl ? titleEl.textContent.trim() : "");
    return;
  }
  const link = e.target.closest(".media-link");
  if (link) {
    openMediaDetail(link.dataset.mediaKey, link.dataset.mediaType, link.textContent.trim());
  }
});

// ---------------------------------------------------------------------------
// Poster hover tooltip -- hovering any .media-link (movie/show title)
// anywhere in the app shows its poster in a small floating tooltip. One
// delegated listener covers every place .media-link gets rendered (History,
// Library Media, Analytics table widgets, Users page, etc.) rather than
// wiring this up separately in each. Reuses /api/media/details, which is
// already cached server-side after the first fetch for a given key, and
// additionally caches the thumb path client-side so repeat hovers in the
// same session don't even need the network round trip.
// ---------------------------------------------------------------------------
const mediaThumbCache = {};
let posterTooltipTimer = null;
let posterTooltipEl = null;

function getPosterTooltipEl() {
  if (!posterTooltipEl) {
    posterTooltipEl = document.createElement("div");
    posterTooltipEl.className = "poster-tooltip";
    document.body.appendChild(posterTooltipEl);
  }
  return posterTooltipEl;
}

function positionPosterTooltip(el, x, y) {
  const margin = 16;
  const rect = el.getBoundingClientRect();
  let left = x + margin;
  let top = y + margin;
  if (left + rect.width > window.innerWidth) left = x - rect.width - margin;
  if (top + rect.height > window.innerHeight) top = y - rect.height - margin;
  el.style.left = `${Math.max(4, left)}px`;
  el.style.top = `${Math.max(4, top)}px`;
}

async function showPosterTooltip(link, x, y) {
  const key = link.dataset.mediaKey;
  if (!key) return;

  let thumb = mediaThumbCache[key];
  if (thumb === undefined) {
    try {
      const res = await fetch(`/api/media/details?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      thumb = data.ok && data.details ? data.details.thumb : null;
    } catch (e) {
      thumb = null;
    }
    mediaThumbCache[key] = thumb;
  }

  // The mouse may have already left this link (or moved to a different
  // one) by the time the fetch resolves -- only show if still relevant.
  if (!link.matches(":hover") || !thumb) return;

  const el = getPosterTooltipEl();
  el.innerHTML = `<img src="/api/poster?path=${encodeURIComponent(thumb)}" alt="" />`;
  el.classList.add("open");
  positionPosterTooltip(el, x, y);
}

function hidePosterTooltip() {
  clearTimeout(posterTooltipTimer);
  if (posterTooltipEl) posterTooltipEl.classList.remove("open");
}

document.body.addEventListener("mouseover", (e) => {
  const link = e.target.closest(".media-link");
  if (!link) return;
  clearTimeout(posterTooltipTimer);
  const x = e.clientX;
  const y = e.clientY;
  posterTooltipTimer = setTimeout(() => showPosterTooltip(link, x, y), 300);
});

document.body.addEventListener("mousemove", (e) => {
  if (posterTooltipEl && posterTooltipEl.classList.contains("open") && e.target.closest(".media-link")) {
    positionPosterTooltip(posterTooltipEl, e.clientX, e.clientY);
  }
});

document.body.addEventListener("mouseout", (e) => {
  const link = e.target.closest(".media-link");
  if (!link || link.contains(e.relatedTarget)) return;
  hidePosterTooltip();
});

async function refreshTopMediaByType(mediaType, ids) {
  const period = document.getElementById(ids.periodSelect).value;
  const sort = ids.sort; // "hours" (Most Watched) or "plays" (Most Popular)
  const res = await fetch(`/api/stats/top-media?type=${mediaType}&period=${period}&limit=10&sort=${sort}`);
  const data = await res.json();

  if (!data.items || data.items.length === 0) {
    setChartEmptyState(
      ids.canvas,
      true,
      "No watch history in this time range. Try a wider range from the dropdown above."
    );
    document.querySelector(`#${ids.table} tbody`).innerHTML = "";
    updateFeaturedPoster(ids.featuredPrefix, null, mediaType);
    return;
  }
  setChartEmptyState(ids.canvas, false, "");
  updateFeaturedPoster(ids.featuredPrefix, data.items[0], mediaType);

  const labels = data.items.map((i) => i.full_title);
  const values = data.items.map((i) => (sort === "hours" ? i.hours : i.plays));

  const ctx = document.getElementById(ids.canvas);
  if (ids.state.chart) ids.state.chart.destroy();
  if (CHART_JS_AVAILABLE) {
    ids.state.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: sort === "hours" ? "Hours watched" : "Plays",
            data: values,
            backgroundColor: ids.color,
          },
        ],
      },
      options: { ...chartOptions({}), indexAxis: "y" },
    });
  } else {
    setChartEmptyState(ids.canvas, true, "Chart library isn't loaded — table below is still current.");
  }

  const tbody = document.querySelector(`#${ids.table} tbody`);
  tbody.innerHTML = data.items
    .map((i) => {
      const titleCell = i.media_key
        ? `<button class="media-link" data-media-key="${escapeHtml(i.media_key)}" data-media-type="${mediaType}">${escapeHtml(i.full_title)}</button>`
        : escapeHtml(i.full_title);
      return `<tr><td>${titleCell}</td><td>${i.plays}</td><td>${i.hours ? fmtHours(i.hours) : "—"}</td></tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
let usersSummaryCache = {};
let usersTableData = [];
let usersSortKey = "user";
let usersSortDir = "asc";
const USERS_NUMERIC_SORT_KEYS = new Set([
  "total_plays",
  "total_movies",
  "total_episodes",
  "total_hours",
  "days_since_last_stream",
]);

const USERS_COLUMNS = [
  { key: "user", label: "User", col: 1 },
  { key: "total_plays", label: "Total Plays", col: 2 },
  { key: "total_movies", label: "Total Movies", col: 3 },
  { key: "total_episodes", label: "Total Episodes", col: 4 },
  { key: "total_hours", label: "Total Hours", col: 5 },
  { key: "days_since_last_stream", label: "Days Since Last Stream", col: 6 },
];
const USERS_COLUMN_PREFS_KEY = "plexStatsUsersColumnPrefs";

let usersColumnPrefs = {};
try {
  usersColumnPrefs = JSON.parse(localStorage.getItem(USERS_COLUMN_PREFS_KEY) || "{}");
} catch (e) {
  usersColumnPrefs = {};
}

function applyUsersColumnVisibility() {
  let css = "";
  USERS_COLUMNS.forEach((c) => {
    if (usersColumnPrefs[c.key] === false) {
      css += `#usersTable th:nth-child(${c.col}), #usersTable td:nth-child(${c.col}) { display: none; }\n`;
    }
  });
  let styleEl = document.getElementById("usersColumnStyle");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "usersColumnStyle";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

function renderUsersColumnsModal() {
  const list = document.getElementById("usersColumnsCheckboxList");
  list.innerHTML = USERS_COLUMNS.map((c) => {
    const checked = usersColumnPrefs[c.key] !== false;
    return `
      <label class="column-checkbox-row">
        <input type="checkbox" data-col-key="${c.key}" ${checked ? "checked" : ""} />
        ${escapeHtml(c.label)}
      </label>`;
  }).join("");
}

document.getElementById("usersColumnsBtn").addEventListener("click", () => {
  renderUsersColumnsModal();
  document.getElementById("usersColumnsModalOverlay").classList.add("open");
});
function closeUsersColumnsModal() {
  document.getElementById("usersColumnsModalOverlay").classList.remove("open");
}
document.getElementById("usersColumnsModalClose").addEventListener("click", closeUsersColumnsModal);
document.getElementById("usersColumnsDone").addEventListener("click", closeUsersColumnsModal);
document.getElementById("usersColumnsModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "usersColumnsModalOverlay") closeUsersColumnsModal();
});
document.getElementById("usersColumnsShowAll").addEventListener("click", () => {
  usersColumnPrefs = {};
  localStorage.setItem(USERS_COLUMN_PREFS_KEY, JSON.stringify(usersColumnPrefs));
  applyUsersColumnVisibility();
  renderUsersColumnsModal();
});
document.getElementById("usersColumnsCheckboxList").addEventListener("change", (e) => {
  const checkbox = e.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  usersColumnPrefs[checkbox.dataset.colKey] = checkbox.checked;
  localStorage.setItem(USERS_COLUMN_PREFS_KEY, JSON.stringify(usersColumnPrefs));
  applyUsersColumnVisibility();
});
applyUsersColumnVisibility();

async function refreshUsersTable() {
  const res = await fetch("/api/users/summary");
  const data = await res.json();

  usersSummaryCache = {};
  (data.items || []).forEach((u) => (usersSummaryCache[u.user] = u));
  usersTableData = data.items || [];

  renderUsersTable();
  document.getElementById("usersSyncStatus").textContent = `Loaded at ${fmtTimeNow()}`;
}

function renderUsersTable() {
  const tbody = document.querySelector("#usersTable tbody");
  const search = document.getElementById("usersSearch").value.trim().toLowerCase();
  const filtered = usersTableData.filter((u) => !search || u.user.toLowerCase().includes(search));

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${
      usersTableData.length === 0 ? "No users found." : "No users match this search."
    }</td></tr>`;
    return;
  }

  const rows = filtered.slice().sort((a, b) => {
    let av = a[usersSortKey];
    let bv = b[usersSortKey];
    const missing = usersSortDir === "asc" ? Infinity : -Infinity;
    if (av === null || av === undefined) av = missing;
    if (bv === null || bv === undefined) bv = missing;
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return usersSortDir === "asc" ? -1 : 1;
    if (av > bv) return usersSortDir === "asc" ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = rows
    .map((u) => {
      const days =
        u.days_since_last_stream === null || u.days_since_last_stream === undefined
          ? "—"
          : u.days_since_last_stream === 0
          ? "Today"
          : u.days_since_last_stream;
      return `
        <tr>
          <td><button class="user-link" data-user="${escapeHtml(u.user)}">${escapeHtml(u.user)}</button></td>
          <td>${u.total_plays}</td>
          <td>${u.total_movies}</td>
          <td>${u.total_episodes}</td>
          <td>${u.total_hours ? fmtHours(u.total_hours) : "—"}</td>
          <td>${days}</td>
        </tr>`;
    })
    .join("");
}

document.getElementById("usersSearch").addEventListener("input", renderUsersTable);

document.getElementById("usersRefreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("usersRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    // Re-pulls the current list of everyone with server access (not just
    // people with watch history) before reloading the table, the same
    // relationship Refresh Libraries has with /api/libraries/sync.
    await fetch("/api/users/sync", { method: "POST" });
    await refreshUsersTable();
  } catch (e) {
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh Users";
  }
});

function updateUsersSortIcons() {
  document.querySelectorAll("#usersTable th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    const isActive = th.dataset.sortKey === usersSortKey;
    th.classList.toggle("sorted", isActive);
    icon.textContent = isActive ? (usersSortDir === "asc" ? "▲" : "▼") : "";
  });
}

document.querySelectorAll("#usersTable th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sortKey;
    if (key === usersSortKey) {
      usersSortDir = usersSortDir === "asc" ? "desc" : "asc";
    } else {
      usersSortKey = key;
      usersSortDir = USERS_NUMERIC_SORT_KEYS.has(key) ? "desc" : "asc";
    }
    updateUsersSortIcons();
    renderUsersTable();
  });
});
updateUsersSortIcons();

// Note: .user-link clicks (including these rows) are handled by the single
// global click delegation set up earlier, alongside .media-link handling.

// ---------------------------------------------------------------------------
// User Detail (drilldown page)
// ---------------------------------------------------------------------------
let currentDrilldownUser = null;
const userMovieChartState = { chart: null };
const userTvChartState = { chart: null };

function openUserDetail(username) {
  if (!username) return;
  breadcrumbTrail.push({ label: username, hash: `user-detail/${encodeURIComponent(username)}` });
  navigateTo(`user-detail/${encodeURIComponent(username)}`);
}

function showUserDetailPage(username) {
  currentDrilldownUser = username;
  const hash = `user-detail/${encodeURIComponent(username)}`;
  ensureBreadcrumbTrailFor(hash, [{ label: "Users", hash: "users" }, { label: username, hash }]);
  renderBreadcrumbs("userDetailBreadcrumbs");
  activateTab("user-detail");

  document.getElementById("userDetailName").textContent = username;
  renderUserDetailStats(username);
  refreshUserTopMovies();
  refreshUserTopTv();
}

function renderUserDetailStats(username) {
  const u = usersSummaryCache[username];
  const el = document.getElementById("userDetailStats");
  if (!u) {
    el.innerHTML = "";
    return;
  }
  const days =
    u.days_since_last_stream === null || u.days_since_last_stream === undefined
      ? "—"
      : u.days_since_last_stream === 0
      ? "Today"
      : `${u.days_since_last_stream}d ago`;
  const cards = [
    { value: u.total_plays, label: "Total Plays" },
    { value: u.total_movies, label: "Movies" },
    { value: u.total_episodes, label: "Episodes" },
    { value: u.total_hours ? fmtHours(u.total_hours) : "0.0", label: "Total Hours" },
    { value: days, label: "Last Stream" },
  ];
  el.innerHTML = cards
    .map((c) => `<div class="stat-card"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`)
    .join("");
}
document.getElementById("userDetailPeriod").addEventListener("change", () => {
  refreshUserTopMovies();
  refreshUserTopTv();
});

async function refreshUserTopMediaByType(mediaType, ids) {
  if (!currentDrilldownUser) return;
  const period = document.getElementById("userDetailPeriod").value;
  const url = `/api/stats/top-media?type=${mediaType}&period=${period}&limit=5&user=${encodeURIComponent(currentDrilldownUser)}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.items || data.items.length === 0) {
    setChartEmptyState(
      ids.canvas,
      true,
      "No watch history in this time range. Try a wider range from the dropdown above."
    );
    document.querySelector(`#${ids.table} tbody`).innerHTML = "";
    updateFeaturedPoster(ids.featuredPrefix, null, mediaType);
    return;
  }
  setChartEmptyState(ids.canvas, false, "");
  updateFeaturedPoster(ids.featuredPrefix, data.items[0], mediaType);

  const labels = data.items.map((i) => i.full_title);
  const values = data.items.map((i) => i.plays);

  const ctx = document.getElementById(ids.canvas);
  if (ids.state.chart) ids.state.chart.destroy();
  if (CHART_JS_AVAILABLE) {
    ids.state.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Plays", data: values, backgroundColor: ids.color }],
      },
      options: { ...chartOptions({}), indexAxis: "y" },
    });
  } else {
    setChartEmptyState(ids.canvas, true, "Chart library isn't loaded — table below is still current.");
  }

  const tbody = document.querySelector(`#${ids.table} tbody`);
  tbody.innerHTML = data.items
    .map((i) => {
      const titleCell = i.media_key
        ? `<button class="media-link" data-media-key="${escapeHtml(i.media_key)}" data-media-type="${mediaType}">${escapeHtml(i.full_title)}</button>`
        : escapeHtml(i.full_title);
      return `<tr><td>${titleCell}</td><td>${i.plays}</td><td>${i.hours ? fmtHours(i.hours) : "—"}</td></tr>`;
    })
    .join("");
}

function refreshUserTopMovies() {
  return refreshUserTopMediaByType("movie", {
    canvas: "userTopMoviesChart",
    table: "userTopMoviesTable",
    featuredPrefix: "userMovie",
    state: userMovieChartState,
    color: "#e5a00d",
  });
}

function refreshUserTopTv() {
  return refreshUserTopMediaByType("episode", {
    canvas: "userTopTvChart",
    table: "userTopTvTable",
    featuredPrefix: "userTv",
    state: userTvChartState,
    color: "#4caf7d",
  });
}

// ---------------------------------------------------------------------------
// Media Detail (drilldown page for a specific movie or TV show)
// ---------------------------------------------------------------------------
let currentMediaKey = null;
let currentMediaType = null;
let mediaHistoryPage = 1;
let mediaHistoryTotal = 0;
const MEDIA_HISTORY_PAGE_SIZE = 25;

function openMediaDetail(mediaKey, mediaType, title) {
  if (!mediaKey) return;
  breadcrumbTrail.push({
    label: title || "Details",
    hash: `media-detail/${encodeURIComponent(mediaKey)}/${mediaType}`,
  });
  navigateTo(`media-detail/${encodeURIComponent(mediaKey)}/${mediaType}`);
}

function showMediaDetailPage(mediaKey, mediaType) {
  currentMediaKey = mediaKey;
  currentMediaType = mediaType;
  mediaHistoryPage = 1;

  const hash = `media-detail/${encodeURIComponent(mediaKey)}/${mediaType}`;
  // We don't know the title yet at this point on a cold load/back-forward
  // (only a fresh click already carries it) -- fetchAndRenderMediaDetails
  // fills in the real title once it loads.
  ensureBreadcrumbTrailFor(hash, [
    { label: "Analytics", hash: currentAnalyticsPageId ? `analytics/${encodeURIComponent(currentAnalyticsPageId)}` : "analytics" },
    { label: "Loading…", hash },
  ]);
  renderBreadcrumbs("mediaDetailBreadcrumbs");

  activateTab("media-detail");
  fetchAndRenderMediaDetails(mediaKey);
  fetchAndRenderMediaHistory(mediaKey, mediaType, 1);
  fetchAndRenderDiscography(mediaKey, mediaType);
}

async function fetchAndRenderDiscography(mediaKey, mediaType) {
  const headerEl = document.getElementById("mediaDetailDiscographyHeader");
  const gridEl = document.getElementById("mediaDetailDiscography");

  // Only an artist's page has a discography to show -- everything else
  // (movies, shows) hides this section entirely rather than showing it
  // empty.
  if (mediaType !== "track") {
    headerEl.style.display = "none";
    gridEl.style.display = "none";
    gridEl.innerHTML = "";
    return;
  }

  headerEl.style.display = "";
  gridEl.style.display = "";
  gridEl.innerHTML = `<p class="empty-state">Loading…</p>`;

  try {
    const res = await fetch(`/api/libraries/media/albums?artist_key=${encodeURIComponent(mediaKey)}`);
    const data = await res.json();
    if (!data.ok || !data.albums || data.albums.length === 0) {
      gridEl.innerHTML = `<p class="empty-state">No albums found for this artist.</p>`;
      return;
    }
    gridEl.innerHTML = data.albums
      .map((album) =>
        renderMediaGridCard({
          thumb: album.thumb,
          title: album.title,
          meta: album.year ? String(album.year) : "",
        })
      )
      .join("");
    attachCarouselPosterFallbacks(gridEl);
  } catch (e) {
    console.error(e);
    gridEl.innerHTML = `<p class="empty-state">Couldn't load albums from Plex.</p>`;
  }
}

async function fetchAndRenderMediaDetails(key) {
  const posterImg = document.getElementById("mediaDetailPoster");
  const titleEl = document.getElementById("mediaDetailTitle");
  const sublineEl = document.getElementById("mediaDetailSubline");
  const summaryEl = document.getElementById("mediaDetailSummary");
  const factsEl = document.getElementById("mediaDetailFacts");
  const castEl = document.getElementById("mediaDetailCast");

  titleEl.textContent = "Loading…";
  sublineEl.textContent = "";
  summaryEl.textContent = "";
  factsEl.innerHTML = "";
  castEl.innerHTML = "";
  posterImg.removeAttribute("src");

  const res = await fetch(`/api/media/details?key=${encodeURIComponent(key)}`);
  const data = await res.json();

  if (!data.ok || !data.details) {
    titleEl.textContent = "Details unavailable";
    summaryEl.textContent = data.error
      ? `Couldn't load details from Plex: ${data.error}`
      : "No details available for this title.";
    return;
  }

  const d = data.details;
  titleEl.textContent = d.title || "Untitled";

  // Now that we know the real title, swap it into the breadcrumb trail if
  // this page's entry is still showing the "Loading…" placeholder.
  const thisHash = `media-detail/${encodeURIComponent(key)}/${currentMediaType}`;
  const last = breadcrumbTrail[breadcrumbTrail.length - 1];
  if (last && last.hash === thisHash && last.label === "Loading…") {
    last.label = d.title || "Untitled";
    renderBreadcrumbs("mediaDetailBreadcrumbs");
  }

  if (d.thumb) {
    posterImg.onerror = () => posterImg.removeAttribute("src");
    posterImg.src = `/api/poster?path=${encodeURIComponent(d.thumb)}`;
    posterImg.alt = d.title || "";
  }

  const year = d.release_date ? d.release_date.slice(0, 4) : null;
  sublineEl.textContent = [year, d.content_rating, d.studio].filter(Boolean).join(" · ");
  summaryEl.textContent = d.summary || "No synopsis available.";

  const facts = [];
  if (d.directors && d.directors.length) facts.push(["Director", d.directors.join(", ")]);
  if (d.genres && d.genres.length) facts.push(["Genres", d.genres.join(", ")]);
  if (d.audience_rating) facts.push(["Rating", String(d.audience_rating)]);
  if (d.release_date) facts.push(["Release Date", fmtDate(d.release_date)]);
  factsEl.innerHTML = facts
    .map(
      ([label, value]) =>
        `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${escapeHtml(value)}</span></div>`
    )
    .join("");

  if (d.actors && d.actors.length) {
    const cardsHtml = d.actors
      .map((a) => {
        const hasPhoto = Boolean(a.thumb);
        const imgTag = hasPhoto
          ? `<img class="cast-photo" data-fallback="1" alt="${escapeHtml(a.name)}" src="/api/poster?path=${encodeURIComponent(a.thumb)}" />`
          : `<div class="cast-photo cast-photo-placeholder"></div>`;
        return `
          <div class="cast-member">
            ${imgTag}
            <p class="cast-name">${escapeHtml(a.name)}</p>
            ${a.role ? `<p class="cast-role">${escapeHtml(a.role)}</p>` : ""}
          </div>`;
      })
      .join("");
    castEl.innerHTML = `<p class="cast-label">Top Cast</p><div class="cast-grid">${cardsHtml}</div>`;
    // If a headshot fails to load, swap it for the plain placeholder circle
    // instead of leaving a broken image icon.
    castEl.querySelectorAll('img.cast-photo[data-fallback="1"]').forEach((img) => {
      img.addEventListener("error", () => {
        const placeholder = document.createElement("div");
        placeholder.className = "cast-photo cast-photo-placeholder";
        img.replaceWith(placeholder);
      });
    });
  }
}

async function fetchAndRenderMediaHistory(key, type, page) {
  const params = new URLSearchParams({ key, type, page, page_size: MEDIA_HISTORY_PAGE_SIZE });
  const res = await fetch(`/api/media/history?${params}`);
  const data = await res.json();
  mediaHistoryTotal = data.total || 0;

  const isTv = type === "episode";
  document.getElementById("mediaHistorySeasonHeader").style.display = isTv ? "" : "none";
  document.getElementById("mediaHistoryEpisodeNumHeader").style.display = isTv ? "" : "none";
  document.getElementById("mediaHistoryTitleHeader").style.display = isTv ? "" : "none";
  const colCount = isTv ? 6 : 3;

  const tbody = document.querySelector("#mediaHistoryTable tbody");
  if (!data.rows || data.rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">No one has watched this yet.</td></tr>`;
  } else {
    tbody.innerHTML = data.rows
      .map((r) => {
        const tvCells = isTv
          ? `<td>${r.season_number ?? "—"}</td><td>${r.episode_number ?? "—"}</td><td>${escapeHtml(r.title || "—")}</td>`
          : "";
        return `<tr><td>${escapeHtml(r.user)}</td>${tvCells}<td>${fmtDateTime(r.viewed_at)}</td><td>${fmtDuration(r.duration_ms)}</td></tr>`;
      })
      .join("");
  }

  const totalPages = Math.max(Math.ceil(mediaHistoryTotal / MEDIA_HISTORY_PAGE_SIZE), 1);
  document.getElementById("mediaHistoryPageInfo").textContent = `Page ${mediaHistoryPage} of ${totalPages}`;
  document.getElementById("mediaHistoryPrev").disabled = mediaHistoryPage <= 1;
  document.getElementById("mediaHistoryNext").disabled = mediaHistoryPage >= totalPages;
}

document.getElementById("mediaHistoryPrev").addEventListener("click", () => {
  if (mediaHistoryPage > 1) {
    mediaHistoryPage--;
    fetchAndRenderMediaHistory(currentMediaKey, currentMediaType, mediaHistoryPage);
  }
});
document.getElementById("mediaHistoryNext").addEventListener("click", () => {
  mediaHistoryPage++;
  fetchAndRenderMediaHistory(currentMediaKey, currentMediaType, mediaHistoryPage);
});

// ---------------------------------------------------------------------------
// History Table
// ---------------------------------------------------------------------------
let historyPage = 1;
let historyTotal = 0;
const HISTORY_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Show/Hide Columns -- column visibility is applied via an injected <style>
// tag using nth-child selectors, so it works regardless of when the table
// body is re-rendered (no need to touch individual cells after every fetch).
// Preferences persist per-browser via localStorage.
// ---------------------------------------------------------------------------
const HISTORY_COLUMNS = [
  { key: "date", label: "Date", col: 2 },
  { key: "user", label: "User", col: 3 },
  { key: "ip", label: "IP Address", col: 4 },
  { key: "platform", label: "Platform", col: 5 },
  { key: "product", label: "Product", col: 6 },
  { key: "player", label: "Player", col: 7 },
  { key: "title", label: "Title", col: 8 },
  { key: "type", label: "Type", col: 9 },
  { key: "started", label: "Started", col: 10 },
  { key: "paused", label: "Paused", col: 11 },
  { key: "stopped", label: "Stopped", col: 12 },
  { key: "duration", label: "Duration", col: 13 },
];
const HISTORY_COLUMN_PREFS_KEY = "plexStatsHistoryColumnPrefs";

function loadColumnPrefs() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_COLUMN_PREFS_KEY) || "{}");
  } catch (e) {
    return {};
  }
}
function saveColumnPrefs(prefs) {
  try {
    localStorage.setItem(HISTORY_COLUMN_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.error(e);
  }
}

let historyColumnPrefs = loadColumnPrefs();

function applyColumnVisibility() {
  let css = "";
  HISTORY_COLUMNS.forEach((c) => {
    if (historyColumnPrefs[c.key] === false) {
      css += `#historyTable th:nth-child(${c.col}), #historyTable td:nth-child(${c.col}) { display: none; }\n`;
    }
  });
  let styleEl = document.getElementById("historyColumnStyle");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "historyColumnStyle";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

function renderColumnsModal() {
  const list = document.getElementById("columnsCheckboxList");
  list.innerHTML = HISTORY_COLUMNS.map((c) => {
    const checked = historyColumnPrefs[c.key] !== false;
    return `
      <label class="column-checkbox-row">
        <input type="checkbox" data-col-key="${c.key}" ${checked ? "checked" : ""} />
        ${escapeHtml(c.label)}
      </label>`;
  }).join("");
}

document.getElementById("historyColumnsBtn").addEventListener("click", () => {
  renderColumnsModal();
  document.getElementById("columnsModalOverlay").classList.add("open");
});
function closeColumnsModal() {
  document.getElementById("columnsModalOverlay").classList.remove("open");
}
document.getElementById("columnsModalClose").addEventListener("click", closeColumnsModal);
document.getElementById("columnsDone").addEventListener("click", closeColumnsModal);
document.getElementById("columnsModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "columnsModalOverlay") closeColumnsModal();
});
document.getElementById("columnsShowAll").addEventListener("click", () => {
  historyColumnPrefs = {};
  saveColumnPrefs(historyColumnPrefs);
  applyColumnVisibility();
  renderColumnsModal();
});
document.getElementById("columnsCheckboxList").addEventListener("change", (e) => {
  const checkbox = e.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  historyColumnPrefs[checkbox.dataset.colKey] = checkbox.checked;
  saveColumnPrefs(historyColumnPrefs);
  applyColumnVisibility();
});

applyColumnVisibility();

async function loadUsersFilter() {
  const res = await fetch("/api/users");
  const data = await res.json();
  const sel = document.getElementById("historyUserFilter");
  const currentValue = sel.value;
  sel.innerHTML = '<option value="">All users</option>';
  data.users.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u;
    opt.textContent = u;
    sel.appendChild(opt);
  });
  if (data.users.includes(currentValue)) sel.value = currentValue;
}

const DECISION_LABELS = {
  direct_play: "Direct Play",
  direct_stream: "Direct Stream",
  transcode: "Transcode",
};

let historyTypeFilter = "";
let historyDecisionFilter = "";
const pauseSegmentsCache = {};

let historySortKey = "date";
let historySortDir = "desc";
// Date/time/duration-like columns feel right sorted newest/largest-first on
// first click; text columns feel right sorted A-Z first.
const HISTORY_DEFAULT_DESC_KEYS = new Set(["date", "started", "paused", "stopped", "duration"]);

function activeSessionMatchesHistoryFilters(s) {
  const search = document.getElementById("historySearch").value.trim().toLowerCase();
  const user = document.getElementById("historyUserFilter").value;
  if (search && !(s.full_title || "").toLowerCase().includes(search)) return false;
  if (user && s.user !== user) return false;
  if (historyTypeFilter && s.media_type !== historyTypeFilter) return false;
  if (historyDecisionFilter && s.video_decision !== historyDecisionFilter) return false;
  return true;
}

function renderActiveHistoryRow(s) {
  const decisionIcon = s.video_decision
    ? `<span class="decision-icon ${s.video_decision}" title="${escapeHtml(DECISION_LABELS[s.video_decision] || s.video_decision)}"></span>`
    : "";
  const titleCell = s.genre_key
    ? `<button class="media-link" data-media-key="${escapeHtml(s.genre_key)}" data-media-type="${escapeHtml(s.media_type)}">${escapeHtml(s.full_title)}</button>`
    : escapeHtml(s.full_title);
  const elapsedMs = s.start_time ? Date.now() - new Date(s.start_time.endsWith("Z") ? s.start_time : `${s.start_time}Z`).getTime() : null;
  return `
    <tr class="history-row active-history-row">
      <td><span class="live-row-dot" title="Currently playing"></span></td>
      <td>${fmtDateOnly(s.start_time)}</td>
      <td><button class="user-link" data-user="${escapeHtml(s.user)}">${escapeHtml(s.user)}</button></td>
      <td>${escapeHtml(s.ip_address || "—")}</td>
      <td>${escapeHtml(s.player_platform || "—")}</td>
      <td>${escapeHtml(s.product || "—")}</td>
      <td>${decisionIcon}${escapeHtml(s.player || "—")}</td>
      <td>${titleCell}</td>
      <td>${escapeHtml(s.media_type)}</td>
      <td>${fmtTimeOnly(s.start_time)}</td>
      <td>${fmtDuration(s.paused_duration_ms)}</td>
      <td><span class="now-playing-badge">Now Playing</span></td>
      <td>${elapsedMs !== null ? fmtDuration(elapsedMs) : "—"}</td>
      <td></td>
    </tr>`;
}

async function fetchActiveHistoryRowsHtml() {
  // Only pin currently-playing streams to the top of page 1 -- they'd
  // otherwise duplicate awkwardly across every page of history.
  if (historyPage !== 1) return "";
  try {
    const res = await fetch("/api/live");
    const data = await res.json();
    if (!data.ok || !data.sessions) return "";
    return data.sessions.filter(activeSessionMatchesHistoryFilters).map(renderActiveHistoryRow).join("");
  } catch (e) {
    console.error(e);
    return "";
  }
}

async function refreshHistoryTable() {
  const search = document.getElementById("historySearch").value.trim();
  const user = document.getElementById("historyUserFilter").value;
  const params = new URLSearchParams({
    page: historyPage,
    page_size: HISTORY_PAGE_SIZE,
    search,
    user,
    type: historyTypeFilter,
    decision: historyDecisionFilter,
    sort: historySortKey,
    dir: historySortDir,
  });
  const [res, activeRowsHtml] = await Promise.all([
    fetch(`/api/history/table?${params}`),
    fetchActiveHistoryRowsHtml(),
  ]);
  const data = await res.json();
  historyTotal = data.total;

  const tbody = document.querySelector("#historyTable tbody");
  const historicalRowsHtml =
    !data.rows || data.rows.length === 0
      ? activeRowsHtml
        ? ""
        : `<tr><td colspan="14" class="empty-state">No history matches these filters.</td></tr>`
      : data.rows
          .map((r) => {
            const hasPauses = r.paused_duration_ms && r.paused_duration_ms > 0;
            const decisionIcon = r.video_decision
              ? `<span class="decision-icon ${r.video_decision}" title="${escapeHtml(DECISION_LABELS[r.video_decision] || r.video_decision)}"></span>`
              : "";
            return `
            <tr class="history-row" data-history-key="${escapeHtml(r.history_key)}">
              <td><button class="expand-toggle" ${hasPauses ? "" : "disabled"} aria-label="Show pause detail">
                <svg class="expand-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.4" />
                  <line x1="8" y1="4.5" x2="8" y2="11.5" stroke="currentColor" stroke-width="1.4" class="expand-icon-vline" />
                  <line x1="4.5" y1="8" x2="11.5" y2="8" stroke="currentColor" stroke-width="1.4" />
                </svg>
              </button></td>
              <td>${fmtDateOnly(r.viewed_at)}</td>
              <td><button class="user-link" data-user="${escapeHtml(r.user)}">${escapeHtml(r.user)}</button></td>
              <td>${escapeHtml(r.ip_address || "—")}</td>
              <td>${escapeHtml(r.platform || "—")}</td>
              <td>${escapeHtml(r.product || "—")}</td>
              <td>${decisionIcon}${escapeHtml(r.device || "—")}</td>
              <td>${
                r.media_key
                  ? `<button class="media-link" data-media-key="${escapeHtml(r.media_key)}" data-media-type="${escapeHtml(r.media_type)}">${escapeHtml(r.full_title)}</button>`
                  : escapeHtml(r.full_title)
              }</td>
              <td>${escapeHtml(r.media_type)}</td>
              <td>${fmtTimeOnly(r.start_time)}</td>
              <td>${fmtDuration(r.paused_duration_ms)}</td>
              <td>${fmtTimeOnly(r.stopped_time)}</td>
              <td>${fmtDuration(r.duration_ms)}</td>
              <td><button class="delete-row-btn" data-history-key="${escapeHtml(r.history_key)}" aria-label="Delete this entry" title="Delete this entry">&times;</button></td>
            </tr>`;
          })
          .join("");

  tbody.innerHTML = activeRowsHtml + historicalRowsHtml;

  const totalPages = Math.max(Math.ceil(historyTotal / HISTORY_PAGE_SIZE), 1);
  document.getElementById("pageInfo").textContent = `Page ${historyPage} of ${totalPages}`;
  document.getElementById("prevPage").disabled = historyPage <= 1;
  document.getElementById("nextPage").disabled = historyPage >= totalPages;
}

// Delete and expand/collapse both delegated on the same listener so every
// row refreshHistoryTable ever renders is covered, without attaching a
// second listener to the same container.
document.querySelector("#historyTable tbody").addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest(".delete-row-btn");
  if (deleteBtn) {
    const historyKey = deleteBtn.dataset.historyKey;
    const row = deleteBtn.closest(".history-row");
    const titleCell = row.querySelector(".media-link, td:nth-child(8)");
    const titleText = titleCell ? titleCell.textContent.trim() : "this entry";
    showConfirmModal(
      "Delete this history entry?",
      `This permanently removes "${titleText}" from watch history. This can't be undone.`,
      async () => {
        try {
          const res = await fetch(`/api/history/entry/${encodeURIComponent(historyKey)}`, { method: "DELETE" });
          const data = await res.json();
          if (data.ok) {
            refreshHistoryTable();
          } else {
            alert(`Couldn't delete this entry: ${data.error || "unknown error"}`);
          }
        } catch (err) {
          console.error(err);
          alert("Couldn't delete this entry — try again.");
        }
      }
    );
    return;
  }

  const btn = e.target.closest(".expand-toggle");
  if (!btn || btn.disabled) return;

  const row = btn.closest(".history-row");
  const historyKey = row.dataset.historyKey;
  const existingDetail = row.nextElementSibling;
  const isOpen = existingDetail && existingDetail.classList.contains("pause-detail-row");

  if (isOpen) {
    existingDetail.remove();
    btn.classList.remove("open");
    return;
  }

  // Close any other open detail rows first, so only one is expanded at a time.
  document.querySelectorAll(".pause-detail-row").forEach((el) => el.remove());
  document.querySelectorAll(".expand-toggle.open").forEach((el) => el.classList.remove("open"));

  btn.classList.add("open");

  let segments = pauseSegmentsCache[historyKey];
  if (!segments) {
    const res = await fetch(`/api/history/pauses?key=${encodeURIComponent(historyKey)}`);
    const data = await res.json();
    segments = data.segments || [];
    pauseSegmentsCache[historyKey] = segments;
  }

  const detailRow = document.createElement("tr");
  detailRow.className = "pause-detail-row";
  const colCount = row.children.length;
  if (segments.length === 0) {
    detailRow.innerHTML = `<td colspan="${colCount}">No pause detail available for this entry.</td>`;
  } else {
    const segmentRows = segments
      .map((s, i) => {
        const durationMs =
          s.resumed_at && s.paused_at
            ? new Date(`${s.resumed_at}Z`) - new Date(`${s.paused_at}Z`)
            : null;
        return `<tr><td>${i + 1}</td><td>${fmtTimeOnly(s.paused_at)}</td><td>${fmtTimeOnly(s.resumed_at)}</td><td>${fmtDuration(durationMs)}</td></tr>`;
      })
      .join("");
    detailRow.innerHTML = `
      <td colspan="${colCount}">
        <table class="pause-detail-table">
          <thead><tr><th>#</th><th>Paused</th><th>Resumed</th><th>Duration</th></tr></thead>
          <tbody>${segmentRows}</tbody>
        </table>
      </td>`;
  }
  row.after(detailRow);
});

document.querySelectorAll("#historyTypeFilter .filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#historyTypeFilter .filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    historyTypeFilter = btn.dataset.value;
    historyPage = 1;
    refreshHistoryTable();
  });
});
document.querySelectorAll("#historyDecisionFilter .filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#historyDecisionFilter .filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    historyDecisionFilter = btn.dataset.value;
    historyPage = 1;
    refreshHistoryTable();
  });
});

function updateSortIcons() {
  document.querySelectorAll("#historyTable th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    const isActive = th.dataset.sortKey === historySortKey;
    th.classList.toggle("sorted", isActive);
    icon.textContent = isActive ? (historySortDir === "asc" ? "▲" : "▼") : "";
  });
}

document.querySelectorAll("#historyTable th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sortKey;
    if (key === historySortKey) {
      historySortDir = historySortDir === "asc" ? "desc" : "asc";
    } else {
      historySortKey = key;
      historySortDir = HISTORY_DEFAULT_DESC_KEYS.has(key) ? "desc" : "asc";
    }
    updateSortIcons();
    historyPage = 1;
    refreshHistoryTable();
  });
});
updateSortIcons();

document.getElementById("prevPage").addEventListener("click", () => {
  if (historyPage > 1) {
    historyPage--;
    refreshHistoryTable();
  }
});
document.getElementById("nextPage").addEventListener("click", () => {
  historyPage++;
  refreshHistoryTable();
});

let searchDebounce;
document.getElementById("historySearch").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    historyPage = 1;
    refreshHistoryTable();
  }, 350);
});
document.getElementById("historyUserFilter").addEventListener("change", () => {
  historyPage = 1;
  refreshHistoryTable();
});

// ---------------------------------------------------------------------------
// Automatic history sync -- pulls fresh watch history from Plex in the
// background and refreshes the table, so there's no button to remember to
// click. Runs on load, then every 60 seconds.
// ---------------------------------------------------------------------------
async function autoSyncHistory() {
  const status = document.getElementById("historySyncStatus");
  try {
    const res = await fetch("/api/history/sync", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      await refreshHistoryTable();
      await loadUsersFilter();
      const now = fmtTimeNow();
      status.textContent = `Synced with Plex at ${now}`;
    } else {
      status.textContent = "Couldn't reach Plex to sync — will retry";
      console.error(data.error);
    }
  } catch (e) {
    status.textContent = "Couldn't reach Plex to sync — will retry";
    console.error(e);
  }
}

setInterval(autoSyncHistory, 60000);

// ---------------------------------------------------------------------------
// Import from Tautulli
// ---------------------------------------------------------------------------
document.getElementById("tautulliImportBtn").addEventListener("click", () => {
  document.getElementById("tautulliImportModalOverlay").classList.add("open");
});
function closeTautulliImportModal() {
  document.getElementById("tautulliImportModalOverlay").classList.remove("open");
}
document.getElementById("tautulliImportModalClose").addEventListener("click", closeTautulliImportModal);
document.getElementById("tautulliImportModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "tautulliImportModalOverlay") closeTautulliImportModal();
});

function setTautulliStatus(text, kind) {
  const el = document.getElementById("tautulliImportStatus");
  el.textContent = text;
  el.className = "import-status" + (kind ? ` ${kind}` : "");
}

let tautulliPollTimer = null;

document.getElementById("tautulliImportStart").addEventListener("click", async () => {
  const baseUrl = document.getElementById("tautulliUrlInput").value.trim();
  const apiKey = document.getElementById("tautulliApiKeyInput").value.trim();
  if (!baseUrl || !apiKey) {
    setTautulliStatus("Please fill in both the URL and API key.", "error");
    return;
  }

  const startBtn = document.getElementById("tautulliImportStart");
  startBtn.disabled = true;
  setTautulliStatus("Starting import…");

  try {
    const res = await fetch("/api/import/tautulli", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
    });
    const data = await res.json();
    if (!data.ok) {
      setTautulliStatus(data.error || "Couldn't start the import.", "error");
      startBtn.disabled = false;
      return;
    }
    pollTautulliImportStatus();
  } catch (e) {
    console.error(e);
    setTautulliStatus("Couldn't reach the server to start the import.", "error");
    startBtn.disabled = false;
  }
});

function pollTautulliImportStatus() {
  clearInterval(tautulliPollTimer);
  tautulliPollTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/import/tautulli/status");
      const data = await res.json();
      const startBtn = document.getElementById("tautulliImportStart");

      if (data.status === "running") {
        setTautulliStatus("Importing… this can take a little while for a large history.");
        return;
      }
      clearInterval(tautulliPollTimer);
      startBtn.disabled = false;

      if (data.status === "done") {
        const r = data.result || {};
        setTautulliStatus(
          `Done — imported ${r.imported} viewing${r.imported === 1 ? "" : "s"}` +
            (r.skipped ? `, skipped ${r.skipped}` : "") +
            ".",
          "success"
        );
        // Refresh the visible history so the new data shows up right away.
        historyPage = 1;
        refreshHistoryTable();
        refreshLibrariesTable();
      } else if (data.status === "error") {
        setTautulliStatus(data.error || "Import failed.", "error");
      }
    } catch (e) {
      console.error(e);
      clearInterval(tautulliPollTimer);
      document.getElementById("tautulliImportStart").disabled = false;
      setTautulliStatus("Lost connection while checking import progress.", "error");
    }
  }, 2000);
}


// ---------------------------------------------------------------------------
// Clear Watch History
// ---------------------------------------------------------------------------
document.getElementById("clearHistoryBtn").addEventListener("click", () => {
  document.getElementById("clearHistoryStatus").textContent = "";
  document.getElementById("clearHistoryModalOverlay").classList.add("open");
});
function closeClearHistoryModal() {
  document.getElementById("clearHistoryModalOverlay").classList.remove("open");
}
document.getElementById("clearHistoryModalClose").addEventListener("click", closeClearHistoryModal);
document.getElementById("clearHistoryCancel").addEventListener("click", closeClearHistoryModal);
document.getElementById("clearHistoryModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "clearHistoryModalOverlay") closeClearHistoryModal();
});

document.getElementById("clearHistoryConfirm").addEventListener("click", async () => {
  const btn = document.getElementById("clearHistoryConfirm");
  const statusEl = document.getElementById("clearHistoryStatus");
  btn.disabled = true;
  statusEl.textContent = "Deleting…";
  statusEl.className = "import-status";

  try {
    const res = await fetch("/api/history/clear", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      statusEl.textContent = data.error || "Couldn't clear history.";
      statusEl.className = "import-status error";
      btn.disabled = false;
      return;
    }
    statusEl.textContent = `Deleted ${data.deleted} entr${data.deleted === 1 ? "y" : "ies"}.`;
    statusEl.className = "import-status success";
    historyPage = 1;
    await refreshHistoryTable();
    await refreshLibrariesTable();
    setTimeout(() => {
      closeClearHistoryModal();
      btn.disabled = false;
    }, 1200);
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Couldn't reach the server.";
    statusEl.className = "import-status error";
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Gear menu (Settings / Restart / Shutdown / Log Out)
// ---------------------------------------------------------------------------
document.getElementById("gearSettingsBtn").addEventListener("click", () => {
  navigateTo("settings");
});

// Click-to-toggle as a fallback for touch devices, alongside the CSS
// :hover behavior for mouse users. Closes on an outside click.
const gearMenuEl = document.querySelector(".gear-menu");
const gearDropdownEl = document.getElementById("gearDropdown");
document.getElementById("gearMenuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  gearDropdownEl.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (gearDropdownEl.classList.contains("open") && !gearMenuEl.contains(e.target)) {
    gearDropdownEl.classList.remove("open");
  }
});

// ---------------------------------------------------------------------------
// Generic confirmation modal (Restart / Shutdown reuse this)
// ---------------------------------------------------------------------------
function showConfirmModal(title, message, onConfirm) {
  document.getElementById("genericConfirmTitle").textContent = title;
  document.getElementById("genericConfirmMessage").textContent = message;
  document.getElementById("genericConfirmModalOverlay").classList.add("open");

  const okBtn = document.getElementById("genericConfirmOk");
  const handler = () => {
    okBtn.removeEventListener("click", handler);
    document.getElementById("genericConfirmModalOverlay").classList.remove("open");
    onConfirm();
  };
  okBtn.addEventListener("click", handler);
}
function closeGenericConfirmModal() {
  document.getElementById("genericConfirmModalOverlay").classList.remove("open");
}
document.getElementById("genericConfirmClose").addEventListener("click", closeGenericConfirmModal);
document.getElementById("genericConfirmCancel").addEventListener("click", closeGenericConfirmModal);
document.getElementById("genericConfirmModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "genericConfirmModalOverlay") closeGenericConfirmModal();
});

// ---------------------------------------------------------------------------
// Restart / Shutdown -- wired to both the gear dropdown and the Settings page
// ---------------------------------------------------------------------------
async function triggerSystemAction(endpoint, pendingMessage) {
  const statusEl = document.getElementById("systemActionStatus");
  if (statusEl) {
    statusEl.textContent = pendingMessage;
    statusEl.className = "import-status";
  }
  try {
    await fetch(endpoint, { method: "POST" });
    if (statusEl) {
      statusEl.textContent = "Command sent. The app may be unreachable for a few seconds.";
      statusEl.className = "import-status success";
    }
  } catch (e) {
    // A failed fetch here is actually expected once the server process
    // exits mid-response -- not necessarily a real error.
    console.error(e);
    if (statusEl) {
      statusEl.textContent = "Command sent (connection dropped, which is expected).";
      statusEl.className = "import-status success";
    }
  }
}

function confirmRestart() {
  showConfirmModal(
    "Restart the app?",
    "This restarts the background service. It should be back within a few seconds if it's running via launchd.",
    () => triggerSystemAction("/api/system/restart", "Restarting…")
  );
}
function confirmShutdown() {
  showConfirmModal(
    "Shut down the app?",
    "This stops the app and, if running via launchd, prevents it from restarting on its own. You'll need to start it again manually.",
    () => triggerSystemAction("/api/system/shutdown", "Shutting down…")
  );
}

document.getElementById("gearRestartBtn").addEventListener("click", () => {
  gearDropdownEl.classList.remove("open");
  confirmRestart();
});
document.getElementById("gearShutdownBtn").addEventListener("click", () => {
  gearDropdownEl.classList.remove("open");
  confirmShutdown();
});
document.getElementById("settingsRestartBtn").addEventListener("click", confirmRestart);
document.getElementById("settingsShutdownBtn").addEventListener("click", confirmShutdown);

document.getElementById("settingsSidebar").addEventListener("click", (e) => {
  const btn = e.target.closest(".settings-nav-btn");
  if (!btn) return;
  document.querySelectorAll(".settings-nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".settings-section").forEach((s) => s.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`settingsSection-${btn.dataset.settingsSection}`).classList.add("active");
});

// ---------------------------------------------------------------------------
// Settings > General > Display Settings
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  if (theme === "light" || theme === "plex") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  // Cached locally purely so the next page load can apply it before first
  // paint (see the inline script in <head>) -- the server copy fetched by
  // loadDisplaySettings() below is still the actual source of truth.
  try {
    localStorage.setItem("plexstats_theme", theme);
  } catch (e) {}
}

function populateDisplaySettingsForm() {
  document.getElementById("displayThemeInput").value = appDisplaySettings.theme;
  document.getElementById("displayDateFormatInput").value = appDisplaySettings.date_format;
  document.getElementById("displayTimeFormatInput").value = appDisplaySettings.time_format;
}

// ---------------------------------------------------------------------------
// Settings > Plex Media Server
// ---------------------------------------------------------------------------
function computePlexServerUrl() {
  const host = document.getElementById("plexServerHostInput").value.trim() || "127.0.0.1";
  const port = document.getElementById("plexServerPortInput").value.trim() || "32400";
  const scheme = document.getElementById("plexServerSecureInput").checked ? "https" : "http";
  document.getElementById("plexServerUrlDisplay").value = `${scheme}://${host}:${port}`;
}
["plexServerHostInput", "plexServerPortInput"].forEach((id) => {
  document.getElementById(id).addEventListener("input", computePlexServerUrl);
});
document.getElementById("plexServerSecureInput").addEventListener("change", computePlexServerUrl);

function currentPlexServerFields() {
  return {
    host: document.getElementById("plexServerHostInput").value.trim(),
    port: document.getElementById("plexServerPortInput").value.trim(),
    secure: document.getElementById("plexServerSecureInput").checked,
  };
}

async function loadPlexServerSettings() {
  try {
    const res = await fetch("/api/settings/plex-server");
    const data = await res.json();
    if (!data.ok) return;
    document.getElementById("plexServerHostInput").value = data.settings.host;
    document.getElementById("plexServerPortInput").value = data.settings.port;
    document.getElementById("plexServerSecureInput").checked = !!data.settings.secure;
    document.getElementById("plexServerUrlDisplay").value = data.settings.url;
    updatePlexAuthStatus(data.connected, data.username);
  } catch (e) {
    console.error(e);
  }
}

function updatePlexAuthStatus(connected, username) {
  const hint = document.getElementById("plexAuthStatusHint");
  hint.textContent = connected ? username || "Signed in" : "Not signed in yet.";
}

document.getElementById("plexServerVerifyBtn").addEventListener("click", async () => {
  const status = document.getElementById("plexServerStatus");
  status.textContent = "Checking…";
  try {
    const res = await fetch("/api/settings/plex-server/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentPlexServerFields()),
    });
    const data = await res.json();
    status.textContent = data.ok
      ? `Connected — ${data.server_name} (Plex ${data.version})`
      : `Couldn't connect: ${data.error || "unknown error"}`;
  } catch (e) {
    console.error(e);
    status.textContent = "Couldn't connect — try again.";
  }
});

document.getElementById("plexServerSaveBtn").addEventListener("click", async () => {
  const status = document.getElementById("plexServerStatus");
  status.textContent = "Saving…";
  try {
    const res = await fetch("/api/settings/plex-server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentPlexServerFields()),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("plexServerUrlDisplay").value = data.settings.url;
      status.textContent = "Saved.";
    } else {
      status.textContent = `Couldn't save: ${data.error || "unknown error"}`;
    }
  } catch (e) {
    console.error(e);
    status.textContent = "Couldn't save — try again.";
  }
});

// Re-authenticate reuses the exact same OAuth flow as the standalone
// /login page (start a Plex.tv PIN login, open it in a new tab, poll until
// it completes) -- just updating this section's own status in place
// afterward instead of redirecting.
let plexReauthPollTimer = null;
document.getElementById("plexReauthBtn").addEventListener("click", async () => {
  const btn = document.getElementById("plexReauthBtn");
  const status = document.getElementById("plexAuthStatus");
  btn.disabled = true;
  btn.textContent = "Waiting for Plex…";
  status.textContent = "";

  try {
    const res = await fetch("/login/start", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      status.textContent = "Couldn't start login. Try again.";
      btn.disabled = false;
      btn.textContent = "Re-authenticate with Plex";
      return;
    }
    window.open(data.url, "_blank", "noopener");
    status.textContent = "Complete sign-in in the new tab, then come back here.";

    clearInterval(plexReauthPollTimer);
    plexReauthPollTimer = setInterval(async () => {
      try {
        const pollRes = await fetch(`/login/poll?login_id=${encodeURIComponent(data.login_id)}`);
        const pollData = await pollRes.json();
        if (pollData.status === "success") {
          clearInterval(plexReauthPollTimer);
          status.textContent = "Signed in.";
          btn.disabled = false;
          btn.textContent = "Re-authenticate with Plex";
          loadPlexServerSettings();
        } else if (pollData.status === "expired" || pollData.status === "no_access" || pollData.status === "unknown") {
          clearInterval(plexReauthPollTimer);
          status.textContent = pollData.error || "That login link expired. Try again.";
          btn.disabled = false;
          btn.textContent = "Re-authenticate with Plex";
        }
        // "pending" -- keep polling
      } catch (e) {
        console.error(e);
      }
    }, 2000);
  } catch (e) {
    console.error(e);
    status.textContent = "Couldn't start login — try again.";
    btn.disabled = false;
    btn.textContent = "Re-authenticate with Plex";
  }
});

async function loadDisplaySettings() {
  try {
    const res = await fetch("/api/settings/display");
    const data = await res.json();
    if (data.ok && data.settings) {
      appDisplaySettings = data.settings;
      applyTheme(appDisplaySettings.theme);
      populateDisplaySettingsForm();
    }
  } catch (e) {
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Settings > Web Interface > Launch at System Startup
// ---------------------------------------------------------------------------
async function loadLaunchAtStartupSetting() {
  const sel = document.getElementById("launchAtStartupInput");
  const status = document.getElementById("launchAtStartupStatus");
  try {
    const res = await fetch("/api/settings/launch-at-startup");
    const data = await res.json();
    if (!data.ok) {
      sel.disabled = true;
      status.textContent = "Couldn't check this setting.";
      return;
    }
    if (!data.available) {
      sel.disabled = true;
      status.textContent = "Not available — this app isn't running as a background service (see the README's setup steps).";
      return;
    }
    sel.disabled = false;
    status.textContent = "";
    sel.value = data.enabled ? "enabled" : "disabled";
  } catch (e) {
    console.error(e);
    sel.disabled = true;
    status.textContent = "Couldn't check this setting.";
  }
}

document.getElementById("launchAtStartupInput").addEventListener("change", async (e) => {
  const status = document.getElementById("launchAtStartupStatus");
  status.textContent = "Saving…";
  try {
    const res = await fetch("/api/settings/launch-at-startup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: e.target.value === "enabled" }),
    });
    const data = await res.json();
    status.textContent = data.ok
      ? "Saved — takes effect next login/restart."
      : `Couldn't save: ${data.error || "unknown error"}`;
  } catch (err) {
    console.error(err);
    status.textContent = "Couldn't save — try again.";
  }
});

// ---------------------------------------------------------------------------
// Settings > Web Interface > Show Icon in Menu Bar
// ---------------------------------------------------------------------------
async function loadMenubarSettings() {
  const enabledSel = document.getElementById("menubarEnabledInput");
  const browserSel = document.getElementById("menubarOpenBrowserInput");
  const status = document.getElementById("menubarStatus");
  try {
    const res = await fetch("/api/settings/menubar");
    const data = await res.json();
    if (!data.ok) {
      status.textContent = "Couldn't load this setting.";
      return;
    }
    enabledSel.value = data.settings.enabled ? "enabled" : "disabled";
    browserSel.value = data.settings.open_browser_on_start ? "enabled" : "disabled";
    status.textContent = data.settings.plist_found
      ? ""
      : 'One-time setup needed first — see the README\'s "Menu Bar Icon" section.';
  } catch (e) {
    console.error(e);
    status.textContent = "Couldn't load this setting.";
  }
}

async function saveMenubarSetting(overrides) {
  const status = document.getElementById("menubarStatus");
  status.textContent = "Saving…";
  try {
    const res = await fetch("/api/settings/menubar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
    const data = await res.json();
    status.textContent = data.warning || (data.ok ? "Saved" : `Couldn't save: ${data.error || "unknown error"}`);
  } catch (e) {
    console.error(e);
    status.textContent = "Couldn't save — try again.";
  }
}

document.getElementById("menubarEnabledInput").addEventListener("change", (e) => {
  saveMenubarSetting({ enabled: e.target.value === "enabled" });
});
document.getElementById("menubarOpenBrowserInput").addEventListener("change", (e) => {
  saveMenubarSetting({ open_browser_on_start: e.target.value === "enabled" });
});

async function saveDisplaySettings(overrides) {
  const next = { ...appDisplaySettings, ...overrides };
  try {
    const res = await fetch("/api/settings/display", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const data = await res.json();
    if (data.ok && data.settings) appDisplaySettings = data.settings;
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

document.getElementById("displayThemeInput").addEventListener("change", async (e) => {
  applyTheme(e.target.value);
  const status = document.getElementById("displaySettingsStatus");
  status.textContent = "Saving…";
  status.textContent = (await saveDisplaySettings({ theme: e.target.value })) ? "Saved" : "Couldn't save — try again.";
});

// Date/time format changes reload the page after saving -- every table,
// widget, and detail page that shows a date or time reads appDisplaySettings
// only when it renders, so a reload is the simplest way to guarantee
// everything already on screen picks up the new format too, not just
// whatever gets rendered next.
async function saveAndReloadForFormat(overrides) {
  const status = document.getElementById("displaySettingsStatus");
  status.textContent = "Saving…";
  const ok = await saveDisplaySettings(overrides);
  if (ok) {
    status.textContent = "Saved — reloading to apply everywhere…";
    setTimeout(() => location.reload(), 500);
  } else {
    status.textContent = "Couldn't save — try again.";
  }
}
document.getElementById("displayDateFormatInput").addEventListener("change", (e) =>
  saveAndReloadForFormat({ date_format: e.target.value })
);
document.getElementById("displayTimeFormatInput").addEventListener("change", (e) =>
  saveAndReloadForFormat({ time_format: e.target.value })
);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadDisplaySettings();
loadPlexServerSettings();
loadLaunchAtStartupSetting();
loadMenubarSettings();
refreshTrend();
setInterval(refreshTrend, 10000);
refreshUsersTable();
refreshLibrariesTable();
autoSyncHistory();
initAnalyticsWidgets();

// Apply whatever page the URL points to -- either the tab you were last on
// (if you reload) or a direct link to a specific user/movie/show.
applyHash(location.hash.replace(/^#/, ""));
