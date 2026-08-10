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
  let commentsCache = []; // [{ vposMs, body, postedAt, nicoruCount, userId, no, fork, threadId, nicoruId }]
  let sidebarVisible = false;
  let toggleButtonObserver = null;
  let panelShiftObserver = null;
  let commentServer = DEFAULT_SERVER;
  let currentVideoId = null;
  let videoWatchInterval = null;
  let autoScrollEnabled = true;
  let scrollListenersAttached = false;

  // ── Storage & Messaging ─────────────────────────
  async function initEnabled() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    enabled = data[STORAGE_KEY] !== false;
    if (enabled) {
      startWatching();
      startFetchComments();
      startVideoWatch();
    }
  }

  // Close any open comment action menu when clicking elsewhere
  document.addEventListener("click", closeAllCommentMenus);

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

  // ── SPA Navigation Detection ─────────────────────
  // niconico is a React SPA: navigating from video A to video B does not
  // reload the page, so the content script is NOT re-run. Poll the URL to
  // detect video changes and reset/re-fetch comments.
  function startVideoWatch() {
    if (videoWatchInterval) return;

    currentVideoId = window.location.pathname.split("/").pop();

    videoWatchInterval = setInterval(() => {
      const videoId = window.location.pathname.split("/").pop();
      if (videoId !== currentVideoId) {
        console.log(
          "[NicoSideComment] Video changed:",
          currentVideoId,
          "→",
          videoId
        );
        currentVideoId = videoId;
        resetForVideoChange();
      }
    }, 1000);
  }

  function stopVideoWatch() {
    if (videoWatchInterval) {
      clearInterval(videoWatchInterval);
      videoWatchInterval = null;
    }
  }

  function resetForVideoChange() {
    // Clear cached comments and the overlay content
    commentsCache = [];
    if (overlay) {
      const sc = overlay.querySelector(".nsc-scroll-container");
      if (sc) sc.innerHTML = "";
    }

    // Fetch comments for the new video
    startFetchComments();
  }

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

    showLoading();

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
        const tids = payload.tids || [];
        if (!tids.length) throw new Error("No thread ID in key");

        // Include ALL thread IDs as targets.
        // sm videos have a single tid; so/channel videos may have multiple
        // (e.g. tids[0] = 0 comments, tids[1] = the real main thread).
        params = {
          targets: tids.flatMap((tid) => [
            { id: tid, fork: "owner" },
            { id: tid, fork: "main" },
            { id: tid, fork: "easy" },
          ]),
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
      commentServer = server;
      const merged = [];
      const seen = new Set();
      for (const t of data.data.threads || []) {
        for (const c of t.comments || []) {
          if (c.id && seen.has(c.id)) continue;
          if (c.id) seen.add(c.id);
          // Attach thread info needed for nicoru / NG / report actions
          c.$fork = t.fork;
          c.$threadId = t.id;
          merged.push(c);
        }
      }
      merged.sort((a, b) => a.vposMs - b.vposMs);
      commentsCache = merged;
      console.log("[NicoSideComment] Fetched", commentsCache.length, "comments");

      // Step 5: Render into overlay
      renderComments();
      hideLoading();
    } catch (err) {
      console.error("[NicoSideComment] Comment fetch error:", err);
      hideLoading();

      // Show an error message only if we have nothing to display yet
      // (do not wipe already-loaded comments on a failed re-fetch).
      if (commentsCache.length === 0 && overlay) {
        const sc = overlay.querySelector(".nsc-scroll-container");
        if (sc) {
          sc.innerHTML =
            '<div style="padding:16px;color:rgba(255,255,255,0.5);text-align:center;">コメントの読み込みに失敗しました</div>';
        }
      }
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
    if (!ensureOverlay()) return;

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
      if (c.id) item.setAttribute("data-nsc-id", String(c.id));

      // ── Main column (body + meta) ──
      const main = document.createElement("div");
      main.className = "nsc-comment-main";

      const body = document.createElement("div");
      body.className = "nsc-comment-body";
      body.textContent = c.body;
      main.appendChild(body);

      const meta = document.createElement("div");
      meta.className = "nsc-comment-meta";

      const timeSpan = document.createElement("span");
      timeSpan.className = "nsc-comment-time";
      timeSpan.textContent = formatVpos(c.vposMs);
      meta.appendChild(timeSpan);

      if (c.nicoruCount > 0) {
        const nicoru = document.createElement("span");
        nicoru.className = "nsc-comment-nicoru";
        nicoru.appendChild(createNicoruIcon("small"));
        nicoru.appendChild(document.createTextNode(" " + c.nicoruCount));
        meta.appendChild(nicoru);
      }

      const postedSpan = document.createElement("span");
      postedSpan.className = "nsc-comment-date";
      postedSpan.textContent = formatDate(c.postedAt);
      meta.appendChild(postedSpan);

      main.appendChild(meta);
      item.appendChild(main);

      // ── Nicoru button (right side, always visible) ──
      const nicoruBtn = document.createElement("button");
      nicoruBtn.type = "button";
      nicoruBtn.className = "nsc-nicoru-btn";
      nicoruBtn.title = "ニコる";
      nicoruBtn.appendChild(createNicoruIcon("small", !!c.nicoruId));
      nicoruBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleNicoru(c, nicoruBtn);
      });
      item.appendChild(nicoruBtn);

      // ── Hover menu (seek / report / NG) ──
      const menu = document.createElement("div");
      menu.className = "nsc-hover-menu";

      const menuItems = [
        {
          label: "▶ この時間に移動",
          handler: () => seekToComment(c),
        },
        {
          label: "⚑ 通報",
          handler: () => reportComment(c),
        },
        {
          label: "NG このコメントをNG",
          handler: () => addCommentNg(c),
        },
        {
          label: "NG このユーザーをNG",
          handler: () => addUserNg(c),
        },
      ];
      for (const mi of menuItems) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "nsc-hover-menu-item";
        btn.textContent = mi.label;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          mi.handler();
          // Close menu after action
          item.classList.remove("nsc-menu-open");
        });
        menu.appendChild(btn);
      }

      item.appendChild(menu);

      // Click to toggle action menu
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = item.classList.contains("nsc-menu-open");
        closeAllCommentMenus();
        if (!isOpen) {
          item.classList.add("nsc-menu-open");
        }
      });

      sc.appendChild(item);
    }
  }

  // ── Comment Action Menu (click to open) ───────────
  function closeAllCommentMenus() {
    const sc = overlay ? overlay.querySelector(".nsc-scroll-container") : null;
    if (!sc) return;
    sc.querySelectorAll(".nsc-comment-item.nsc-menu-open").forEach((el) => {
      el.classList.remove("nsc-menu-open");
    });
  }

  function createNicoruIcon(size, filled) {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const cls = "nsc-nicoru-icon" + (size === "small" ? " nsc-nicoru-icon-small" : "");
    svg.setAttribute("class", cls);
    const path = document.createElementNS(svgNS, "path");
    // Heart shape (niconico nicoru icon)
    path.setAttribute(
      "d",
      "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
    );
    if (filled) {
      path.setAttribute("fill", "currentColor");
    } else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.8");
    }
    svg.appendChild(path);
    return svg;
  }

  // ── Comment Actions (seek / nicoru / NG / report) ──
  function seekToComment(c) {
    const video = document.querySelector('video[data-name="video-content"]');
    if (!video || typeof c.vposMs !== "number") return;
    video.currentTime = c.vposMs / 1000;
    console.log("[NicoSideComment] Seek to", c.vposMs, "ms");
  }

  async function toggleNicoru(c, btn) {
    if (c.$fork === "owner") {
      console.log("[NicoSideComment] Owner comments cannot be nicoru'd");
      return;
    }
    try {
      if (c.nicoruId) {
        // Un-nicoru (nvapi base, same as the player)
        const resp = await fetch(
          `https://nvapi.nicovideo.jp/v1/users/me/nicoru/send/${encodeURIComponent(c.nicoruId)}`,
          {
            method: "DELETE",
            headers: {
              "X-Frontend-Id": "6",
              "X-Frontend-Version": "0",
              "X-Request-With": "nicovideo",
            },
            credentials: "include",
          }
        );
        if (!resp.ok) throw new Error(`Un-nicoru failed: ${resp.status}`);
        c.nicoruId = null;
        c.nicoruCount = Math.max(0, (c.nicoruCount || 1) - 1);
      } else {
        // Get nicoru key (nvapi base, same as the player)
        const keyUrl =
          `https://nvapi.nicovideo.jp/v1/comment/keys/nicoru` +
          `?threadId=${encodeURIComponent(c.$threadId)}` +
          `&fork=${encodeURIComponent(c.$fork)}&pc=1`;
        const keyResp = await fetch(keyUrl, {
          headers: {
            "X-Frontend-Id": "6",
            "X-Frontend-Version": "0",
            "X-Request-With": "https://www.nicovideo.jp",
          },
          credentials: "include",
        });
        if (!keyResp.ok) throw new Error(`Nicoru key failed: ${keyResp.status}`);
        const keyData = await keyResp.json();
        const nicoruKey = keyData.data && keyData.data.nicoruKey;

        // Send nicoru
        const resp = await fetch(
          `${commentServer}/v1/threads/${encodeURIComponent(c.$threadId)}/nicorus`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Frontend-Id": "6",
              "X-Frontend-Version": "0",
              "X-Request-With": "https://www.nicovideo.jp",
            },
            credentials: "omit",
            body: JSON.stringify({
              videoId: currentVideoId,
              fork: c.$fork,
              no: c.no,
              content: c.body,
              nicoruKey: nicoruKey,
            }),
          }
        );
        if (!resp.ok) throw new Error(`Nicoru failed: ${resp.status}`);
        const data = await resp.json();
        // Use the server-provided values (same as the player's Wr() update)
        c.nicoruId = data.data && data.data.nicoruId;
        if (typeof data.data.nicoruCount === "number") {
          c.nicoruCount = data.data.nicoruCount;
        } else {
          c.nicoruCount = (c.nicoruCount || 0) + 1;
        }
      }

      // Update button state
      btn.innerHTML = "";
      btn.appendChild(createNicoruIcon("small", !!c.nicoruId));
      console.log("[NicoSideComment] Nicoru toggled");
    } catch (err) {
      console.error("[NicoSideComment] Nicoru error:", err);
    }
  }

  async function addCommentNg(c) {
    const ok = await addNg(c, { type: "word", source: c.body }, "コメントをNG登録しました");
    if (!ok) return;
    // Remove comments whose body partially matches the NG word
    const needle = c.body;
    const targetIds = commentsCache
      .filter((x) => x.body && x.body.includes(needle))
      .map((x) => x.id);
    commentsCache = commentsCache.filter((x) => !x.body || !x.body.includes(needle));
    const sc = overlay ? overlay.querySelector(".nsc-scroll-container") : null;
    if (sc) removeElementsByIds(sc, targetIds);
  }

  async function addUserNg(c) {
    if (!c.userId) return;
    const ok = await addNg(c, { type: "id", source: c.userId }, "ユーザーをNG登録しました");
    if (!ok) return;
    // Remove all comments by this user
    const targetIds = commentsCache
      .filter((x) => x.userId === c.userId)
      .map((x) => x.id);
    commentsCache = commentsCache.filter((x) => x.userId !== c.userId);
    const sc = overlay ? overlay.querySelector(".nsc-scroll-container") : null;
    if (sc) removeElementsByIds(sc, targetIds);
  }

  // Remove comment DOM elements by their data-nsc-id values
  function removeElementsByIds(sc, ids) {
    for (const id of ids) {
      if (id === undefined || id === null || id === "") continue;
      sc.querySelectorAll(`[data-nsc-id="${CSS.escape(String(id))}"]`)
        .forEach((el) => el.remove());
    }
  }

  async function addNg(c, payload, successMsg) {
    try {
      // NG API lives on nvapi.nicovideo.jp (not the nvcomment server),
      // which allows credentials: "include" via explicit ACAO.
      // Request body is form-urlencoded (same as the player):
      //   type / source / languageId / threadId / commentId
      const resp = await fetch(
        `https://nvapi.nicovideo.jp/v1/users/me/ng-comments/client`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json;charset=utf-8",
            "X-Frontend-Id": "6",
            "X-Frontend-Version": "0",
            "X-Request-With": "nicovideo",
          },
          credentials: "include",
          body: new URLSearchParams({
            type: payload.type,
            source: payload.source,
            languageId: "0",
            threadId: String(c.$threadId),
            commentId: String(c.no),
          }).toString(),
        }
      );
      if (!resp.ok) throw new Error(`NG failed: ${resp.status}`);
      console.log("[NicoSideComment]", successMsg);
      return true;
    } catch (err) {
      console.error("[NicoSideComment] NG error:", err);
      return false;
    }
  }

  function reportComment(c) {
    // Niconico reports via a form POST to comment_allegation/{videoId}.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `https://www.nicovideo.jp/comment_allegation/${encodeURIComponent(
      currentVideoId
    )}`;
    form.target = "_blank";
    form.rel = "noopener";

    const forkLabel =
      c.$fork === "main"
        ? "通常コメント"
        : c.$fork === "owner"
          ? "投稿者コメント"
          : c.$fork === "easy"
            ? "かんたんコメント"
            : c.$fork;

    const inquiry = [
      `違反行為を行っているユーザーID： ${c.userId}`,
      `コメント番号： ${c.no}`,
      `コメント種別： ${forkLabel}`,
      `コメント内容： ${c.body}`,
      "違反と判断された理由：",
    ].join("\n");

    const addHidden = (name, value) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };
    addHidden("target", "comment");
    addHidden("inquiry", inquiry);

    document.body.appendChild(form);
    form.submit();
    form.remove();
    console.log("[NicoSideComment] Report submitted");
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

    // If comments were not fetched yet (e.g. page loaded before player data),
    // retry fetching now.
    if (commentsCache.length === 0) {
      startFetchComments();
    }

    // Sidebar is hidden by default; video fills the whole screen
    sidebarVisible = false;

    if (!overlay) {
      renderComments();
      if (!overlay) return;
    }

    overlay.style.display = "none";

    autoScrollEnabled = true;
    hideResumePopup();
    attachScrollListeners();

    injectToggleButton();
    startToggleButtonWatch();

    startTimecodeSync();
  }

  function exitFullscreenMode() {
    stopTimecodeSync();
    stopToggleButtonWatch();
    removeToggleButton();

    detachScrollListeners();
    hideResumePopup();
    autoScrollEnabled = true;

    if (fullscreenTarget) {
      fullscreenTarget.style.right = "";
      fullscreenTarget.style.left = "";
    }

    if (overlay) {
      overlay.style.display = "none";
    }

    removePanelShift();
    fullscreenTarget = null;
    sidebarVisible = false;
  }

  // ── Floating Panel Shift (avoid sidebar overlay) ──
  // The niconico settings floating panel ([data-nvpc-part="floating"])
  // has z-index 10, far below our overlay (2147483646), so it gets hidden
  // behind the comment sidebar. When the sidebar is shown, shift the panel
  // left by the overlay width (340px) so it is not covered.
  //
  // Note: nico injects CSS that pins the panel to right:24px !important with
  // a higher-specificity selector, so a plain CSS rule cannot override it,
  // and a non-important inline style loses to that !important rule. We must
  // force inline !important via setProperty(), and re-apply it whenever
  // floating-ui rewrites the panel's style (observed via attributes).
  function applyPanelShift() {
    if (panelShiftObserver) return;

    const shiftPanel = () => {
      document
        .querySelectorAll(
          '[data-nvpc-scope="watch-floating-panel"][data-nvpc-part="floating"]'
        )
        .forEach((el) => {
          el.style.setProperty("left", "auto", "important");
          el.style.setProperty("right", "340px", "important");
        });
    };

    shiftPanel();

    panelShiftObserver = new MutationObserver(shiftPanel);
    panelShiftObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  }

  function removePanelShift() {
    if (panelShiftObserver) {
      panelShiftObserver.disconnect();
      panelShiftObserver = null;
    }
    document
      .querySelectorAll(
        '[data-nvpc-scope="watch-floating-panel"][data-nvpc-part="floating"]'
      )
      .forEach((el) => {
        el.style.removeProperty("left");
        el.style.removeProperty("right");
      });
  }

  // ── Sidebar Toggle ──────────────────────────────
  function toggleSidebar(visible) {
    sidebarVisible = visible;

    if (fullscreenTarget) {
      if (sidebarVisible) {
        fullscreenTarget.style.right = "340px";
        fullscreenTarget.style.left = "0";
      } else {
        fullscreenTarget.style.right = "";
        fullscreenTarget.style.left = "";
      }
    }

    if (sidebarVisible) {
      applyPanelShift();
    } else {
      removePanelShift();
    }

    if (overlay) {
      overlay.style.display = sidebarVisible ? "block" : "none";
    }

    updateToggleButton();
    console.log("[NicoSideComment] Sidebar", sidebarVisible ? "shown" : "hidden");
  }

  function injectToggleButton() {
    if (document.querySelector("[data-side-comment-toggle]")) return;

    const controller = document.querySelector('[data-styling-area="floating"]');
    if (!controller) return;

    const anchor = controller.querySelector('button[aria-label="コメントを非表示にする"]');
    if (!anchor) return;

    const btn = document.createElement("button");
    btn.setAttribute("data-side-comment-toggle", "");
    btn.type = "button";
    btn.className = "Pressable cursor_pointer";
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.padding = "0";
    btn.style.border = "none";
    btn.style.background = "none";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSidebar(!sidebarVisible);
    });

    // Insert before the comment visibility toggle button
    anchor.parentNode.insertBefore(btn, anchor);

    updateToggleButton();
    console.log("[NicoSideComment] Toggle button injected");
  }

  function updateToggleButton() {
    const btn = document.querySelector("[data-side-comment-toggle]");
    if (!btn) return;

    // Clear existing content
    btn.innerHTML = "";

    const label = sidebarVisible ? "サイドバーを隠す" : "サイドバーを表示";
    btn.setAttribute("aria-label", label);
    btn.title = label;

    // SVG icon: panel + list layout
    // Outer frame (video area) + right panel (sidebar) with 3 comment lines.
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.style.width = "24px";
    svg.style.height = "24px";
    svg.style.padding = "8px";
    svg.style.boxSizing = "content-box";

    const baseFill = "rgba(242, 242, 242, 0.8)";

    if (sidebarVisible) {
      // Sidebar shown: filled panel + white lines
      const panel = document.createElementNS(svgNS, "path");
      panel.setAttribute("d", "M14 4h7v16h-7z");
      panel.setAttribute("fill", "rgba(242, 242, 242, 0.5)");
      svg.appendChild(panel);

      const frame = document.createElementNS(svgNS, "path");
      frame.setAttribute(
        "d",
        "M3 4h18v16H3zM14 4v16M16 8h3.5v1.5H16zM16 12h3.5v1.5H16zM16 16h3.5v1.5H16z"
      );
      frame.setAttribute("fill", "none");
      frame.setAttribute("stroke", baseFill);
      frame.setAttribute("stroke-width", "1.6");
      svg.appendChild(frame);

      const lines = document.createElementNS(svgNS, "path");
      lines.setAttribute(
        "d",
        "M16 8h3.5v1.5H16zM16 12h3.5v1.5H16zM16 16h3.5v1.5H16z"
      );
      lines.setAttribute("fill", baseFill);
      svg.appendChild(lines);

      // Diagonal slash over the whole frame (indicates "hide")
      const slash = document.createElementNS(svgNS, "path");
      slash.setAttribute("d", "M21 4 L3 20");
      slash.setAttribute("stroke", baseFill);
      slash.setAttribute("stroke-width", "1.6");
      slash.setAttribute("stroke-linecap", "round");
      svg.appendChild(slash);
    } else {
      // Sidebar hidden: empty frame + panel boundary + lines
      const frame = document.createElementNS(svgNS, "path");
      frame.setAttribute(
        "d",
        "M3 4h18v16H3zM14 4v16M16 8h3.5v1.5H16zM16 12h3.5v1.5H16zM16 16h3.5v1.5H16z"
      );
      frame.setAttribute("fill", "none");
      frame.setAttribute("stroke", baseFill);
      frame.setAttribute("stroke-width", "1.6");
      svg.appendChild(frame);

      const lines = document.createElementNS(svgNS, "path");
      lines.setAttribute(
        "d",
        "M16 8h3.5v1.5H16zM16 12h3.5v1.5H16zM16 16h3.5v1.5H16z"
      );
      lines.setAttribute("fill", baseFill);
      svg.appendChild(lines);
    }

    btn.appendChild(svg);
  }

  function removeToggleButton() {
    const btn = document.querySelector("[data-side-comment-toggle]");
    if (btn) btn.remove();
  }

  // ── Toggle Button Survival Watch ────────────────
  function startToggleButtonWatch() {
    if (toggleButtonObserver) return;

    const controller = document.querySelector('[data-styling-area="floating"]');
    if (!controller) return;

    toggleButtonObserver = new MutationObserver(() => {
      if (!document.querySelector("[data-side-comment-toggle]")) {
        injectToggleButton();
      }
    });
    toggleButtonObserver.observe(controller, { childList: true, subtree: true });
  }

  function stopToggleButtonWatch() {
    if (toggleButtonObserver) {
      toggleButtonObserver.disconnect();
      toggleButtonObserver = null;
    }
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

      if (bestEl && bestDelta < 10000 && autoScrollEnabled) {
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

  // ── Manual Scroll Detection & Resume Popup ──────
  let scrollWheelHandler = null;
  let scrollTouchHandler = null;
  let scrollKeyHandler = null;

  function attachScrollListeners() {
    if (scrollListenersAttached) return;
    if (!overlay) return;

    const sc = overlay.querySelector(".nsc-scroll-container");
    if (!sc) return;

    const disableAutoScroll = () => {
      if (!autoScrollEnabled) return;
      autoScrollEnabled = false;
      showResumePopup();
    };

    scrollWheelHandler = disableAutoScroll;
    scrollTouchHandler = disableAutoScroll;
    scrollKeyHandler = (e) => {
      if (
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        disableAutoScroll();
      }
    };

    sc.addEventListener("wheel", scrollWheelHandler, { passive: true });
    sc.addEventListener("touchstart", scrollTouchHandler, { passive: true });
    sc.addEventListener("keydown", scrollKeyHandler);

    scrollListenersAttached = true;
  }

  function detachScrollListeners() {
    if (!scrollListenersAttached || !overlay) return;

    const sc = overlay.querySelector(".nsc-scroll-container");
    if (sc) {
      if (scrollWheelHandler) sc.removeEventListener("wheel", scrollWheelHandler);
      if (scrollTouchHandler) sc.removeEventListener("touchstart", scrollTouchHandler);
      if (scrollKeyHandler) sc.removeEventListener("keydown", scrollKeyHandler);
    }
    scrollWheelHandler = null;
    scrollTouchHandler = null;
    scrollKeyHandler = null;
    scrollListenersAttached = false;
  }

  function showResumePopup() {
    if (!overlay) return;
    const sc = overlay.querySelector(".nsc-scroll-container");
    if (!sc) return;

    // Remove existing popup
    const old = sc.querySelector(".nsc-resume-popup");
    if (old) old.remove();

    const popup = document.createElement("button");
    popup.type = "button";
    popup.className = "nsc-resume-popup";
    popup.textContent = "自動スクロールに戻る";
    popup.addEventListener("click", (e) => {
      e.stopPropagation();
      resumeAutoScroll();
    });

    // Insert at the top of the scroll container
    sc.insertBefore(popup, sc.firstChild);
  }

  function hideResumePopup() {
    if (!overlay) return;
    const sc = overlay.querySelector(".nsc-scroll-container");
    if (!sc) return;
    const popup = sc.querySelector(".nsc-resume-popup");
    if (popup) popup.remove();
  }

  function resumeAutoScroll() {
    autoScrollEnabled = true;
    hideResumePopup();

    // Immediately scroll to the current time position
    const video = document.querySelector('video[data-name="video-content"]');
    if (!video || !overlay) return;
    const currentMs = video.currentTime * 1000;
    const sc = overlay.querySelector(".nsc-scroll-container");
    if (!sc) return;

    const items = sc.querySelectorAll("[data-nsc-vpos-ms]");
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
    if (bestEl) {
      bestEl.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    console.log("[NicoSideComment] Auto-scroll resumed");
  }

  // ── Overlay Creation ────────────────────────────
  function createOverlay() {
    removeStaleOverlays();

    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("data-nico-side-comment", "true");
    el.setAttribute("data-nvpc-scope", "watch-floating-panel");

    // Loading spinner (hidden until showLoading())
    const loading = document.createElement("div");
    loading.className = "nsc-loading";
    loading.style.display = "none";
    el.appendChild(loading);

    const scrollContainer = document.createElement("div");
    scrollContainer.className = "nsc-scroll-container";
    el.appendChild(scrollContainer);

    return el;
  }

  // Create the overlay if it does not exist yet, without showing it.
  function ensureOverlay() {
    if (overlay) return true;
    overlay = createOverlay();
    overlay.style.display = "none";
    document.body.appendChild(overlay);
    return true;
  }

  // ── Loading Spinner ──────────────────────────────
  function showLoading() {
    if (!ensureOverlay()) return;
    const l = overlay.querySelector(".nsc-loading");
    if (l) l.style.display = "flex";
  }

  function hideLoading() {
    if (!overlay) return;
    const l = overlay.querySelector(".nsc-loading");
    if (l) l.style.display = "none";
  }

  function removeStaleOverlays() {
    const existing = document.querySelectorAll(`#${OVERLAY_ID}, [data-nico-side-comment]`);
    existing.forEach((el) => el.remove());
  }

  // ── Cleanup ─────────────────────────────────────
  function destroyOverlay() {
    stopTimecodeSync();
    stopToggleButtonWatch();
    removeToggleButton();
    stopVideoWatch();
    detachScrollListeners();
    hideResumePopup();
    autoScrollEnabled = true;
    removePanelShift();

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
