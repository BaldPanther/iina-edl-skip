/*
 * iina-edl-skip — skip recaps, intros and credits using Kodi-style `.edl`
 * sidecar files that sit next to the video.
 *
 * A sidecar looks like this (fields separated by tabs, seconds with three
 * decimals, `##` lines are markers):
 *
 *     ## Recap
 *     0.000	42.000	3
 *     ## Intro
 *     42.000	102.000	3
 *     ## Outro / Credits
 *     3300.000	3533.000	3
 *
 * Action 3 is Kodi's "commercial break": skip the segment once, but let the
 * viewer rewind back into it afterwards. This plugin follows that rule.
 */

const { core, event, mpv, menu, console, file, preferences, sidebar } = iina;

// Kodi EDL actions worth acting on: 3 = commercial break, 0 = cut. Actions
// 1 (mute) and 2 (scene marker) are not skips and are ignored.
const SKIP_ACTIONS = [0, 3];

// Never skip when less than this much of the segment is left: the jump would
// gain nothing, and a slightly imprecise landing could re-enter the segment.
const MIN_REMAINING = 0.5;

// A segment ending this close to the end of the file counts as running to the
// end of it — media-toolkit extends credits all the way to the duration.
const END_OF_FILE_SLACK = 5.0;

// How many ticks to keep looking for markup after the file changes, before
// concluding there is none. Chapters can take a moment to become readable.
const LOAD_RETRIES = 10;

const KIND_PREF = {
  recap: "skip_recap",
  intro: "skip_intro",
  credits: "skip_credits",
};

const KIND_LABEL = { recap: "Recap", intro: "Intro", credits: "Credits" };

// Segments of the file currently open: { start, end, kind, used }.
// `used` is what makes a segment skip only once per playback.
let segments = [];

// The URL those segments were read for. Advancing through a playlist does not
// reliably deliver iina.file-loaded to an already-running instance, which used
// to leave the previous episode's spent segments in place — so the file is
// verified on every tick rather than trusted to an event.
let loadedFor = "";

// Chapters are not always readable the instant the file changes, so a load
// that found nothing is retried for a few ticks before giving up.
let retriesLeft = 0;

// Where playback was when the last segment was skipped, for "Undo last skip".
// Null when there is nothing to undo — a fresh file, or an undo already used.
let lastSkip = null;

// The sidebar APIs only work once the window exists, so nothing is sent before
// "iina.window-loaded" has arrived and the page has reported itself ready.
let sidebarReady = false;

function pref(key, fallback) {
  const value = preferences.get(key);
  return value === undefined || value === null ? fallback : value;
}

// ---------------------------------------------------------------------------
// Locating the sidecar
// ---------------------------------------------------------------------------

// "file:///Users/me/Show%20S01E01.mkv" -> "/Users/me/Show S01E01.mkv".
// Anything that is not a local path yields "" so we never touch the disk.
function urlToPath(url) {
  if (!url) return "";
  if (url.indexOf("file://") === 0) {
    const raw = url.slice("file://".length);
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  }
  return url.charAt(0) === "/" ? url : "";
}

// Mirrors what media-toolkit does with pathlib's with_suffix(".edl"): replace
// the last extension, or append one when the name has none.
function edlPathFor(videoPath) {
  const slash = videoPath.lastIndexOf("/");
  const name = videoPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return videoPath.slice(0, slash + 1) + stem + ".edl";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Plain seconds ("102.000") as written by media-toolkit, plus Kodi's clock
// form ("00:01:42.000") so that hand-written sidecars keep working.
function parseTime(token) {
  if (token.indexOf(":") === -1) {
    const seconds = parseFloat(token);
    return isNaN(seconds) ? null : seconds;
  }
  const parts = token.split(":");
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parseFloat(parts[i]);
    if (isNaN(part)) return null;
    total = total * 60 + part;
  }
  return total;
}

function kindFromMarker(marker) {
  if (marker.indexOf("recap") !== -1) return "recap";
  if (marker.indexOf("intro") !== -1) return "intro";
  if (marker.indexOf("outro") !== -1) return "credits";
  if (marker.indexOf("credits") !== -1) return "credits";
  return null;
}

function parseEdl(text) {
  const found = [];
  const lines = text.split("\n");
  let marker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.indexOf("##") === 0) {
      marker = line.toLowerCase();
      continue;
    }

    const parts = line.split(/\s+/);
    const start = parts.length >= 3 ? parseTime(parts[0]) : null;
    const end = parts.length >= 3 ? parseTime(parts[1]) : null;
    const action = parts.length >= 3 ? parseInt(parts[2], 10) : NaN;

    if (
      start !== null &&
      end !== null &&
      end > start &&
      SKIP_ACTIONS.indexOf(action) !== -1
    ) {
      found.push({
        start: start,
        end: end,
        kind: kindFromMarker(marker),
        used: false,
      });
    }
    marker = "";
  }

  found.sort(function (a, b) {
    return a.start - b.start;
  });

  // Our own sidecars are always marked. Foreign ones usually are not, so fall
  // back to position: something starting at the very beginning is a recap, the
  // last segment is credits, anything in between is an intro.
  for (let i = 0; i < found.length; i++) {
    if (found[i].kind) continue;
    if (found[i].start < 1.0) found[i].kind = "recap";
    else if (i === found.length - 1) found[i].kind = "credits";
    else found[i].kind = "intro";
  }

  return found;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

// Matroska chapters, used only when no sidecar is there. media-toolkit writes
// the same boundaries as chapters named Cold Open / Recap / Intro / Episode /
// Credits, and unlike a sidecar they travel inside the file — surviving a move
// to a NAS or a copy that leaves the .edl behind.
function segmentsFromChapters() {
  let list;
  try {
    list = mpv.getNative("chapter-list");
  } catch (e) {
    return [];
  }
  if (!list || !list.length) return [];

  const duration = core.status.duration;
  const found = [];

  for (let i = 0; i < list.length; i++) {
    const title = list[i].title;
    if (!title) continue;

    const kind = kindFromMarker(String(title).toLowerCase());
    if (!kind) continue; // Cold Open and Episode are content, not skips

    const start = list[i].time;
    const end = i + 1 < list.length ? list[i + 1].time : duration;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (end <= start) continue;

    found.push({ start: start, end: end, kind: kind, used: false });
  }
  return found;
}

function loadSegments() {
  segments = [];
  lastSkip = null;
  loadedFor = core.status.url || "";

  if (core.status.isNetworkResource) return;

  const videoPath = urlToPath(core.status.url);
  if (!videoPath) return;

  const edlPath = edlPathFor(videoPath);
  if (file.exists(edlPath)) {
    let text = null;
    try {
      text = file.read(edlPath);
    } catch (e) {
      console.log("cannot read " + edlPath + ": " + e);
    }
    if (text !== null) {
      segments = parseEdl(text);
      if (segments.length) {
        console.log("loaded " + segments.length + " segment(s) from " + edlPath);
        return;
      }
    }
  }

  if (pref("use_chapters", true)) {
    segments = segmentsFromChapters();
    if (segments.length) {
      console.log("loaded " + segments.length + " segment(s) from chapters");
    }
  }
}

// Wraps loadSegments so every path that changes the segment list also updates
// the sidebar, rather than each caller having to remember.
function reloadSegments() {
  loadSegments();
  refreshSidebar();
}

// Absolute and frame-exact. core.seekTo() offers no precision control, and
// landing on a keyframe would leave a second or two of the intro on screen.
function seekExact(position) {
  mpv.command("seek", [String(position), "absolute+exact"]);
}

// Reports what it did: "seek" moved within the file and can be undone,
// "playlist" left for another file, "none" deliberately did nothing.
function consume(segment) {
  const duration = core.status.duration;
  const runsToEndOfFile =
    duration > 0 && segment.end >= duration - END_OF_FILE_SLACK;

  if (runsToEndOfFile) {
    const mode = pref("end_of_file", "skip");
    if (mode === "play") return "none";
    if (mode === "next") {
      // "weak" is a no-op at the end of the playlist, in which case the
      // credits simply play out — the segment is already marked as used.
      mpv.command("playlist-next", ["weak"]);
      return "playlist";
    }
  }

  seekExact(segment.end);
  return "seek";
}

function onPositionChanged() {
  if ((core.status.url || "") !== loadedFor) {
    retriesLeft = LOAD_RETRIES;
    reloadSegments();
  } else if (!segments.length && retriesLeft > 0) {
    // Nothing found yet. Chapters in particular can lag behind the file
    // change, so try again for a few ticks before settling on "no markup".
    retriesLeft--;
    reloadSegments();
  }

  if (!segments.length) return;
  if (!pref("enabled", true)) return;

  const position = core.status.position;
  if (typeof position !== "number") return;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.used) continue;
    if (position < segment.start) continue;
    if (position >= segment.end - MIN_REMAINING) continue;
    if (!pref(KIND_PREF[segment.kind], true)) continue;

    // Marked before seeking, not after: an imprecise landing must not be able
    // to trigger the same segment a second time.
    segment.used = true;

    const outcome = consume(segment);
    if (outcome === "none") return;

    // Only an in-file seek can be taken back; moving to the next episode
    // leaves nothing here to return to.
    lastSkip =
      outcome === "seek"
        ? { position: position, label: KIND_LABEL[segment.kind] }
        : null;

    refreshSidebar();
    if (pref("show_osd", true)) {
      core.osd(KIND_LABEL[segment.kind] + " skipped");
    }
    return;
  }
}

// Return to where playback was when the last segment was skipped. The segment
// stays marked as used, so it is not skipped straight out from under you.
function undoLastSkip() {
  if (!lastSkip) {
    core.osd("Nothing to undo");
    return;
  }
  const target = lastSkip;
  lastSkip = null;
  seekExact(target.position);
  core.osd("Back to " + target.label.toLowerCase());
}

// ---------------------------------------------------------------------------
// Sidebar tab
// ---------------------------------------------------------------------------

function sidebarPayload() {
  return {
    enabled: pref("enabled", true),
    segments: segments.map(function (s) {
      return {
        start: s.start,
        end: s.end,
        label: KIND_LABEL[s.kind],
        used: s.used,
        enabled: pref(KIND_PREF[s.kind], true),
      };
    }),
  };
}

function refreshSidebar() {
  if (!sidebarReady) return;
  sidebar.postMessage("segments", sidebarPayload());
}

event.on("iina.window-loaded", function () {
  // The page announces itself once loaded; until then there is nobody to
  // deliver to, so the first payload is sent from the "ready" handler.
  sidebar.onMessage("ready", function () {
    sidebarReady = true;
    refreshSidebar();
  });
  sidebar.onMessage("seek", function (data) {
    if (data && typeof data.time === "number") seekExact(data.time);
  });
  sidebar.loadFile("sidebar.html");
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

// `refresh` must stay false while the plugin is being loaded. At that point
// PlayerCore is still inside its own dispatch_once, and menu.forceUpdate()
// reaches back into it — IINA deadlocks on the main thread and never starts.
// Once a menu item is actually clicked, initialisation is long done.
function buildMenu(refresh) {
  menu.removeAllItems();
  menu.addItem(
    menu.item(
      "Skip by EDL",
      function () {
        const next = !pref("enabled", true);
        preferences.set("enabled", next);
        preferences.sync();
        buildMenu(true);
        core.osd("EDL skip " + (next ? "on" : "off"));
      },
      { selected: pref("enabled", true), keyBinding: "Meta+Shift+e" }
    )
  );
  // Always enabled, reporting "nothing to undo" when there is nothing. Keeping
  // its state fixed means the menu never has to be rebuilt mid-playback.
  menu.addItem(
    menu.item("Undo Last Skip", undoLastSkip, { keyBinding: "Meta+Shift+z" })
  );
  if (refresh) menu.forceUpdate();
}

buildMenu(false);

event.on("iina.file-loaded", reloadSegments);
event.on("mpv.time-pos.changed", onPositionChanged);
