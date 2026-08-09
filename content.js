(function () {
  "use strict";

  const OVERLAY_ID = "nico-side-comment-overlay";
  const STORAGE_KEY = "enabled";
  const DEFAULT_SERVER = "https://public.nvcomment.nicovideo.jp";

  // ── State ─────────────────────────────────────────
  let enabled = true;
  let overlay = null;
  let timecodeIntervalId = null;
  let fullscreenTarget = null;
  let commentsCache = []; // [{ vposMs, body, postedAt, nicoruCount, userId }]

  // ── Storage & Messaging ─────────────────────────
  async function initEnabled() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    enabled = data[STORAGE_KEY] !== false;
    if (enabled) {
      startWatching();
      startFetchComments();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TOGGLE") {
      enabled = msg.enabled;
      if (enabled) {
        startWatching();
        startFetchComments();
      } else {
        stopWatching();
        destroyOverlay();
      }
    }
  });

  // ── Fullscreen Detection ────────────────────────
  let _watching = false;

  function startWatching() {
    if (_watching) return;
    _watching = true;
    document.addEventListener("fullscreenchange", onFullscreenChange);
    checkFullscreen();
  }

  function stopWatching() {
    _watching = false;
    document.removeEventListener("fullscreenchange", onFullscreenChange);
  }

  function checkFullscreen() {
    const fsEl = document.fullscreenElement;
    const target = getFullscreenTarget();
    if (fsEl && target) {
      enterFullscreenMode(target);
    }
  }

  function onFullscreenChange() {
    const fsEl = document.fullscreenElement;
    const target = getFullscreenTarget();

    console.log("[NicoSideComment] fullscreenchange fired",
      "fullscreenElement:", fsEl, "target:", target);

    if (fsEl && target) {
      enterFullscreenMode(target);
    } else {
      exitFullscreenMode();
    }
  }

  function getFullscreenTarget() {
    return document.querySelector('[data-styling-name="fullscreen-target"]');
  }

  // ── Comment Fetching (API) ───────────────────────
  async function startFetchComments() {
    const videoId = window.location.pathname.split("/").pop();
    console.log("[NicoSideComment] Fetching comments for", videoId);

    try {
      // Step 1: Get nvComment config from React context (primary)
      // The player's own comment request uses this exact data.
      let nvComment = null;
      for (let i = 0; i < 10; i++) {
        nvComment = findNvComment();
        if (nvComment && nvComment.threadKey && nvComment.params) break;
        await sleep(500);
      }

      let server = nvComment ? nvComment.server || DEFAULT_SERVER : DEFAULT_SERVER;
      let threadKey = nvComment ? nvComment.threadKey : null;
      let params = nvComment ? nvComment.params : null;

      // Step 2: Fallback — fetch thread key via API if not available
      if (!threadKey || !params) {
        console.log("[NicoSideComment] nvComment not found, using keys/thread API");
        const keyUrl =
          `https://nvapi.nicovideo.jp/v1/comment/keys/thread?videoId=${videoId}`;
        const keyResp = await fetch(keyUrl, {
          headers: {
            "X-Frontend-Id": "6",
            "X-Frontend-Version": "0",
          },
          credentials: "include",
        });
        if (!keyResp.ok) throw new Error(`Thread key fetch failed: ${keyResp.status}`);
        const keyJson = await keyResp.json();
        threadKey = keyJson.data.threadKey;

        const payloadB64 = threadKey.split(".")[1];
        const payload = JSON.parse(base64urlDecode(payloadB64));
        const mainTid = (payload.tids && payload.tids[0]) || null;
        if (!mainTid) throw new Error("No thread ID in key");

        params = {
          targets: [
            { id: mainTid, fork: "owner" },
            { id: mainTid, fork: "main" },
            { id: mainTid, fork: "easy" },
          ],
          language: "ja-jp",
        };
      }

      console.log("[NicoSideComment] Comment server:", server);

      // Step 3: Fetch comments (same request shape as the player)
      const commentUrl = `${server}/v1/threads?_frontendId=6`;
      const commentResp = await fetch(commentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Frontend-Id": "6",
          "X-Frontend-Version": "0",
        },
        body: JSON.stringify({
          params: params,
          threadKey: threadKey,
          additionals: {},
        }),
      });
      if (!commentResp.ok) throw new Error(`Comment fetch failed: ${commentResp.status}`);

      const data = await commentResp.json();
      if (data.meta && data.meta.status !== 200) {
        throw new Error(`API error: ${data.meta.status}`);
      }

      // Step 4: Merge all forks, dedupe by id, sort by vposMs
      const merged = [];
      const seen = new Set();
      for (const t of data.data.threads || []) {
        for (const c of t.comments || []) {
          if (c.id && seen.has(c.id)) continue;
          if (c.id) seen.add(c.id);
          merged.push(c);
        }
      }
      merged.sort((a, b) => a.vposMs - b.vposMs);
      commentsCache = merged;
      console.log("[NicoSideComment] Fetched", commentsCache.length, "comments");

      // Step 5: Render into overlay
      renderComments();
    } catch (err) {
      console.error("[NicoSideComment] Comment fetch error:", err);
    }
  }

  // ── React Context Extraction ─────────────────────
  function findNvComment() {
    const root = document.getElementById("root");
    if (!root) return null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      for (const key of Object.keys(el)) {
        if (
          key.startsWith("__reactFiber$") ||
          key.startsWith("__reactInternalInstance$")
        ) {
          let fiber = el[key];
          while (fiber) {
            if (fiber.memoizedProps && fiber.memoizedProps.response) {
              const r = fiber.memoizedProps.response;
              if (r.comment && r.comment.nvComment && r.comment.nvComment.threadKey) {
                return r.comment.nvComment;
              }
            }
            fiber = fiber.return;
          }
        }
      }
    }
    return null;
  }

  // ── Comment Rendering ────────────────────────────
  function renderComments() {
    if (!overlay) {
      overlay = createOverlay();
      overlay.style.display = "none";
      document.body.appendChild(overlay);
    }

    const sc = overlay.querySelector(".nsc-scroll-container");
    if (!sc) return;
    sc.innerHTML = "";

    if (commentsCache.length === 0) {
      sc.innerHTML =
        '<div style="padding:16px;color:rgba(255,255,255,0.5);text-align:center;">コメントがありません</div>';
      return;
    }

    for (const c of commentsCache) {
      const item = document.createElement("div");
      item.className = "nsc-comment-item";
      item.setAttribute("data-nsc-vpos-ms", String(c.vposMs));
      item.setAttribute("data-nsc-time", formatVpos(c.vposMs));

      const body = document.createElement("div");
      body.className = "nsc-comment-body";
      body.textContent = c.body;
      item.appendChild(body);

      const meta = document.createElement("div");
      meta.className = "nsc-comment-meta";

      const timeSpan = document.createElement("span");
      timeSpan.className = "nsc-comment-time";
      timeSpan.textContent = formatVpos(c.vposMs);
      meta.appendChild(timeSpan);

      if (c.nicoruCount > 0) {
        const nicoru = document.createElement("span");
        nicoru.className = "nsc-comment-nicoru";
        nicoru.textContent = "▲ " + c.nicoruCount;
        meta.appendChild(nicoru);
      }

      const postedSpan = document.createElement("span");
      postedSpan.className = "nsc-comment-date";
      postedSpan.textContent = formatDate(c.postedAt);
      meta.appendChild(postedSpan);

      item.appendChild(meta);
      sc.appendChild(item);
    }
  }

  // ── Helpers ──────────────────────────────────────
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function base64urlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return atob(str);
  }

  function formatVpos(vposMs) {
    const totalSec = Math.floor(vposMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min + ":" + String(sec).padStart(2, "0");
  }

  function formatDate(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return d.getFullYear() + "/" +
      String(d.getMonth() + 1).padStart(2, "0") + "/" +
      String(d.getDate()).padStart(2, "0");
  }

  // ── Enter / Exit Fullscreen ─────────────────────
  function enterFullscreenMode(target) {
    fullscreenTarget = target;
    console.log("[NicoSideComment] enterFullscreenMode, target:", fullscreenTarget);

    fullscreenTarget.style.right = "340px";
    fullscreenTarget.style.left = "0";

    if (!overlay) {
      renderComments();
      if (!overlay) return;
    }

    overlay.style.display = "block";
    console.log("[NicoSideComment] overlay shown");

    startTimecodeSync();
  }

  function exitFullscreenMode() {
    stopTimecodeSync();

    if (fullscreenTarget) {
      fullscreenTarget.style.right = "";
      fullscreenTarget.style.left = "";
    }

    if (overlay) {
      overlay.style.display = "none";
    }

    fullscreenTarget = null;
  }

  // ── Timecode Sync ───────────────────────────────
  function startTimecodeSync() {
    if (timecodeIntervalId) clearInterval(timecodeIntervalId);

    timecodeIntervalId = setInterval(() => {
      if (!overlay || overlay.style.display === "none") return;

      const video = document.querySelector('video[data-name="video-content"]');
      if (!video) return;

      const currentMs = video.currentTime * 1000;
      const scrollContainer = overlay.querySelector(".nsc-scroll-container");
      if (!scrollContainer) return;

      const items = scrollContainer.querySelectorAll("[data-nsc-vpos-ms]");
      let bestEl = null;
      let bestDelta = Infinity;

      for (const item of items) {
        const t = parseInt(item.getAttribute("data-nsc-vpos-ms"), 10);
        if (isNaN(t)) continue;
        const delta = Math.abs(t - currentMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestEl = item;
        }
      }

      scrollContainer.querySelectorAll(".nsc-active-comment").forEach(
        (el) => el.classList.remove("nsc-active-comment")
      );

      if (bestEl && bestDelta < 10000) {
        bestEl.classList.add("nsc-active-comment");
        bestEl.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 1000);
  }

  function stopTimecodeSync() {
    if (timecodeIntervalId) {
      clearInterval(timecodeIntervalId);
      timecodeIntervalId = null;
    }
  }

  // ── Overlay Creation ────────────────────────────
  function createOverlay() {
    removeStaleOverlays();

    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("data-nico-side-comment", "true");
    el.setAttribute("data-nvpc-scope", "watch-floating-panel");

    const scrollContainer = document.createElement("div");
    scrollContainer.className = "nsc-scroll-container";
    el.appendChild(scrollContainer);

    return el;
  }

  function removeStaleOverlays() {
    const existing = document.querySelectorAll(`#${OVERLAY_ID}, [data-nico-side-comment]`);
    existing.forEach((el) => el.remove());
  }

  // ── Cleanup ─────────────────────────────────────
  function destroyOverlay() {
    stopTimecodeSync();

    const allOverlays = document.querySelectorAll(
      `#${OVERLAY_ID}, [data-nico-side-comment]`
    );
    allOverlays.forEach((el) => el.remove());
    overlay = null;
    commentsCache = [];
  }

  // ── Init ─────────────────────────────────────────
  initEnabled();

  console.log("[NicoSideComment] Content script loaded");
})();
