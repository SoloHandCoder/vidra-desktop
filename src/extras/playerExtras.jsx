// Subtitle style + timing for the in-app players, and watch-time tracking for
// the stats. Every 2 s while a player is open, one script runs in every frame of
// the player webview (from the main process, so nested cross-origin player
// frames are reached too). It styles subtitles, shifts their timing and reports
// whether a video is playing.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trackWatchSecond } from "./libraryExtras.js";
import { traktScrobble } from "./trakt.js";
import { reportPlayer, setPartyPlayer } from "./party.js";

export const STYLE_KEY = "streambert_subtitleStyle"; // same key as the Android player
const OFFSET_PREFIX = "streambert_subOffset_";
const EVT = "streambert:subtitle-style-changed";
const TICK_MS = 2000;

export const SIZES = [["s", "Small", 0.85], ["m", "Medium", 1.05], ["l", "Large", 1.35], ["xl", "Extra large", 1.7]];
export const COLORS = [["#ffffff", "White"], ["#ffe14d", "Yellow"], ["#7ee3ff", "Cyan"], ["#9dff8a", "Green"]];
export const BGS = [["dark", "Dark box"], ["solid", "Black box"], ["none", "Outline"]];
export const POSITIONS = [["bottom", "Bottom"], ["higher", "Higher"], ["top", "Top"]];
const DEFAULT = { size: "m", color: "#ffffff", bg: "dark", position: "bottom" };

export function getSubStyle() {
  const d = { ...DEFAULT };
  try {
    const v = JSON.parse(localStorage.getItem(STYLE_KEY));
    if (v) for (const k of Object.keys(d)) if (v[k]) d[k] = v[k];
  } catch {}
  return d;
}
export function saveSubStyle(st) {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(st));
  } catch {}
  window.dispatchEvent(new Event(EVT));
}
const isDefault = (st) => Object.keys(DEFAULT).every((k) => st[k] === DEFAULT[k]);

export function getOffset(key) {
  try {
    return Number(JSON.parse(localStorage.getItem(OFFSET_PREFIX + key))) || 0;
  } catch {
    return 0;
  }
}
export function setOffset(key, v) {
  v = Math.round(v * 10) / 10;
  try {
    if (v) localStorage.setItem(OFFSET_PREFIX + key, JSON.stringify(v));
    else localStorage.removeItem(OFFSET_PREFIX + key);
  } catch {}
  window.dispatchEvent(new Event(EVT));
  return v;
}

function cueCss(st) {
  if (isDefault(st)) return "";
  const size = (SIZES.find((x) => x[0] === st.size) || SIZES[1])[2];
  const bg = st.bg === "none" ? "transparent" : st.bg === "solid" ? "rgba(0,0,0,0.92)" : "rgba(0,0,0,0.62)";
  const shadow = st.bg === "none" ? "0 0 3px #000,0 0 3px #000,1px 1px 2px #000,-1px -1px 2px #000" : "0 1px 2px rgba(0,0,0,.8)";
  const rule = `font-size:${size}em!important;color:${st.color}!important;background:${bg}!important;text-shadow:${shadow}!important;`;
  // native <track> cues plus the caption elements of common web players
  return (
    `video::cue{${rule}}` +
    `.jw-text-track-cue,.vjs-text-track-cue>div,.plyr__caption,.art-subtitle>div,.shaka-text-container span{${rule.replace(
      `font-size:${size}em`,
      `font-size:${Math.round(size * 100)}%`,
    )}}`
  );
}

function tickJs(st, offset, meta) {
  const css = cueCss(st);
  const pos = st.position;
  return `(() => {
    const css = ${JSON.stringify(css)}, pos = ${JSON.stringify(pos)}, off = ${Number(offset) || 0}, meta = ${JSON.stringify(meta || null)};
    let el = document.getElementById("sb-cue-style");
    if (css) {
      if (!el) { el = document.createElement("style"); el.id = "sb-cue-style"; (document.head || document.documentElement).appendChild(el); }
      if (el.textContent !== css) el.textContent = css;
    } else if (el) el.remove();
    const vids = document.querySelectorAll("video");
    if (!vids.length) return null;
    let playing = false, curT = 0, len = 0;
    for (const v of vids) {
      // short clips (ads, previews) don't count as watching
      if (!v.paused && !v.ended && v.readyState > 2 && v.duration > 120) playing = true;
      if (v.duration > 120) { curT = v.currentTime; len = v.duration; }
      for (const t of Array.from(v.textTracks || [])) {
        const cues = t.cues;
        if (!cues) continue;
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          if (c._sbS === undefined) { c._sbS = c.startTime; c._sbE = c.endTime; }
          const s = Math.max(0, c._sbS + off), e = Math.max(0, c._sbE + off);
          if (c.startTime !== s) c.startTime = s;
          if (c.endTime !== e) c.endTime = e;
          if (pos !== "bottom" || c._sbLine) {
            c._sbLine = true;
            c.snapToLines = true;
            c.line = pos === "top" ? 1 : pos === "higher" ? -4 : "auto";
          }
        }
      }
    }
    // media keys + the Windows media overlay show what's playing
    if (playing && meta && navigator.mediaSession && window.MediaMetadata) {
      const cur = navigator.mediaSession.metadata;
      if (!cur || cur.title !== meta.title) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({ title: meta.title, artist: meta.subtitle || "Vidra", artwork: meta.artwork ? [{ src: meta.artwork, sizes: "342x513", type: "image/jpeg" }] : [] });
        } catch (e) {}
      }
    }
    // frames with only short clips (ads, previews) are not the player
    return len ? { playing, t: curT, d: len } : null;
  })()`;
}

/**
 * Runs while the in-app player is open.
 *   webviewRef – the player <webview>
 *   info       – { id, media_type, title, poster_path, genres } for the stats
 *   offsetKey  – the subtitle timing is remembered per movie / episode
 */
export function usePlayerExtras({ webviewRef, active, info, offsetKey }) {
  const infoRef = useRef(info);
  infoRef.current = info;
  const keyRef = useRef(offsetKey);
  keyRef.current = offsetKey;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let last = Date.now();
    let ticking = false;
    const tick = async () => {
      // never overlap: a slow player page must not stack up checks
      if (ticking) return;
      ticking = true;
      try {
        await tickOnce();
      } finally {
        ticking = false;
      }
    };
    const tickOnce = async () => {
      const wv = webviewRef.current;
      const now = Date.now();
      const elapsed = Math.min(10, Math.round((now - last) / 1000));
      last = now;
      if (!wv || !window.electron?.playerTick) return;
      let id = null;
      try {
        id = wv.getWebContentsId();
      } catch {
        return; // not attached yet
      }
      const inf = infoRef.current;
      const meta = inf?.title
        ? {
            title: inf.title,
            subtitle: inf.episodeLabel || "Vidra",
            artwork: inf.poster_path ? `https://image.tmdb.org/t/p/w342${inf.poster_path}` : null,
          }
        : null;
      const js = tickJs(getSubStyle(), getOffset(keyRef.current || ""), meta);
      const r = await window.electron.playerTick(id, js).catch(() => null);
      if (stopped) return;
      if (r?.playing && infoRef.current?.id && elapsed > 0) trackWatchSecond(infoRef.current, elapsed);
      if (r && r.d > 0 && infoRef.current?.id) traktScrobble(infoRef.current, (r.t / r.d) * 100, !!r.playing);
      // where the player is (used by "Skip intro")
      const ps = r && r.d > 0 ? { t: r.t, d: r.d, playing: !!r.playing, at: Date.now() } : null;
      window.__sbPlayerState = () => (ps && Date.now() - ps.at < 3500 ? ps : null);
      const inf2 = infoRef.current;
      reportPlayer(
        inf2?.id ? { id: inf2.id, media_type: inf2.media_type, title: inf2.title, season: inf2.season, episode: inf2.episode } : null,
        r && r.d > 0 ? { playing: !!r.playing, t: r.t } : null,
      );
    };
    // jump to a time in whatever frame holds the video (used by "Skip intro")
    window.__sbSeekPlayer = (t) => {
      const wv = webviewRef.current;
      let id = null;
      try {
        id = wv.getWebContentsId();
      } catch {
        return;
      }
      window.electron.playerTick(
        id,
        `(() => { const v = [...document.querySelectorAll("video")].find((x) => x.duration > 120); if (v) v.currentTime = ${Number(t) || 0}; return null; })()`,
      );
    };
    // watch party: follow what the others do
    setPartyPlayer(({ playing, t }) => {
      const wv = webviewRef.current;
      let id = null;
      try {
        id = wv.getWebContentsId();
      } catch {
        return;
      }
      window.electron.playerTick(
        id,
        `(() => { const v = [...document.querySelectorAll("video")].find((x) => x.duration > 120); if (!v) return null;
          if (Math.abs(v.currentTime - ${Number(t) || 0}) > 2) v.currentTime = ${Number(t) || 0};
          ${playing ? "v.play().catch(() => {});" : "v.pause();"} return null; })()`,
      );
    });
    const t = setInterval(tick, 1000);
    const onChange = () => tick();
    window.addEventListener(EVT, onChange);
    return () => {
      stopped = true;
      clearInterval(t);
      window.removeEventListener(EVT, onChange);
    };
  }, [active, webviewRef]);
}

// ── UI ───────────────────────────────────────────────────────────────────────
function useSubStyle() {
  const [st, setSt] = useState(getSubStyle);
  useEffect(() => {
    const h = () => setSt(getSubStyle());
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, []);
  return st;
}

function Chips({ list, value, onPick }) {
  return (
    <div className="sbx-chips" style={{ marginBottom: 0 }}>
      {list.map(([v, label]) => (
        <button key={v} type="button" className={`sbx-chip${v === value ? " on" : ""}`} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Size / color / background / position. Used in the player panel and in Settings. */
export function SubtitleStylePicker() {
  const st = useSubStyle();
  const set = (k) => (v) => saveSubStyle({ ...st, [k]: v });
  const size = (SIZES.find((x) => x[0] === st.size) || SIZES[1])[2];
  const bg = st.bg === "none" ? "transparent" : st.bg === "solid" ? "rgba(0,0,0,0.92)" : "rgba(0,0,0,0.62)";
  const row = { display: "grid", gridTemplateColumns: "92px 1fr", alignItems: "center", gap: 10, marginBottom: 10 };
  const lbl = { fontSize: 13, color: "var(--text3)", fontWeight: 600 };
  return (
    <div>
      <div
        style={{
          height: 110,
          borderRadius: 10,
          marginBottom: 14,
          background: "linear-gradient(135deg,#2b3a4a,#11161c)",
          display: "flex",
          justifyContent: "center",
          alignItems: st.position === "top" ? "flex-start" : "flex-end",
          padding: st.position === "higher" ? "0 0 34px" : "12px 0",
        }}
      >
        <span
          style={{
            fontSize: `${16 * size}px`,
            color: st.color,
            background: bg,
            padding: "2px 8px",
            borderRadius: 3,
            textShadow: st.bg === "none" ? "0 0 3px #000,0 0 3px #000,1px 1px 2px #000" : "none",
          }}
        >
          This is how subtitles look
        </span>
      </div>
      <div style={row}><span style={lbl}>Size</span><Chips list={SIZES} value={st.size} onPick={set("size")} /></div>
      <div style={row}><span style={lbl}>Color</span><Chips list={COLORS} value={st.color} onPick={set("color")} /></div>
      <div style={row}><span style={lbl}>Background</span><Chips list={BGS} value={st.bg} onPick={set("bg")} /></div>
      <div style={row}><span style={lbl}>Position</span><Chips list={POSITIONS} value={st.position} onPick={set("position")} /></div>
      {!isDefault(st) && (
        <button className="btn btn-ghost" style={{ marginTop: 4 }} onClick={() => saveSubStyle({ ...DEFAULT })}>
          Reset to default
        </button>
      )}
    </div>
  );
}

function CcIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <path d="M10 10.2a2.5 2.5 0 1 0 0 3.6M17 10.2a2.5 2.5 0 1 0 0 3.6" />
    </svg>
  );
}

/** Player overlay button that opens subtitle style + timing. */
export function SubtitleButton({ offsetKey, className = "player-overlay-btn" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} title="Subtitle style & timing">
        <CcIcon />
      </button>
      {open && <SubtitlePanel offsetKey={offsetKey} onClose={() => setOpen(false)} />}
    </>
  );
}

function SubtitlePanel({ offsetKey, onClose }) {
  const [off, setOff] = useState(() => getOffset(offsetKey));
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const shift = (d) => setOff(setOffset(offsetKey, off + d));
  return createPortal(
    <div className="sbx-sheet-overlay" onClick={onClose}>
      <div className="sbx-sheet" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Subtitles">
        <div className="sbx-sheet-title">Subtitles</div>
        <SubtitleStylePicker />
        <div className="library-section-title" style={{ margin: "18px 0 8px" }}>Timing</div>
        <div className="sbx-muted" style={{ marginBottom: 10 }}>
          {off ? `Subtitles are shifted ${off > 0 ? "+" : ""}${off.toFixed(1)} s for this ${offsetKey?.includes("_s") ? "episode" : "movie"}.` : "Subtitles out of sync? Shift them here. It's remembered for this title."}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={() => shift(-0.5)}>Earlier −0.5 s</button>
          <button className="btn btn-secondary" onClick={() => shift(-0.1)}>−0.1</button>
          <button className="btn btn-secondary" onClick={() => shift(0.1)}>+0.1</button>
          <button className="btn btn-secondary" onClick={() => shift(0.5)}>Later +0.5 s</button>
          {off !== 0 && (
            <button className="btn btn-ghost" onClick={() => setOff(setOffset(offsetKey, 0))}>Reset</button>
          )}
        </div>
        <div className="sbx-muted" style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5 }}>
          Works with players that show standard subtitles. Some sources draw their own subtitles and keep their style.
        </div>
      </div>
    </div>,
    document.body,
  );
}
