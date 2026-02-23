/* ==================================================================
   Notion Screenshot Tool — Content Script
   Injects a floating side-panel into Notion pages and handles
   screenshot capture with configurable visibility toggles.
   ================================================================== */

(() => {
  "use strict";

  // Guard against double-injection
  if (window.__nssInjected) return;
  window.__nssInjected = true;

  // ----------------------------------------------------------------
  // 1. NOTION DOM SELECTORS
  //    Notion's class names are obfuscated and change frequently.
  //    Instead of guessing class names, we use STRUCTURAL selectors:
  //    we anchor on [placeholder="Untitled"] (the title input, which
  //    is stable) and walk the DOM tree relative to it.
  // ----------------------------------------------------------------

  const NotionSelectors = {
    // ---- Internal helpers ----

    /** The title input — the most reliable anchor in Notion's DOM. */
    _titleInput() {
      return document.querySelector('[placeholder="Untitled"]');
    },

    /** Given an element, find the direct child of the scroller that contains it. */
    _scrollerChildOf(el) {
      const scroller = this.captureTarget();
      if (!scroller || !el) return null;
      let current = el;
      while (current && current.parentElement !== scroller) {
        current = current.parentElement;
      }
      return current; // null if el is not inside the scroller
    },

    // ---- Capture target ----

    captureTarget() {
      return (
        document.querySelector(".notion-frame .notion-scroller") ||
        document.querySelector('.notion-frame [class*="scroller"]') ||
        document.querySelector(".notion-frame") ||
        document.querySelector(".notion-page-content")
      );
    },

    // ---- Page elements (structural matching) ----

    /**
     * Page cover image — the large banner at the top.
     * Strategy: walk direct children of the scroller that appear BEFORE
     * the title section and look for one that contains an <img> or a
     * background-image and has significant height.
     */
    pageCover() {
      const scroller = this.captureTarget();
      const titleInput = this._titleInput();
      if (!scroller || !titleInput) return null;

      const titleSection = this._scrollerChildOf(titleInput);
      if (!titleSection) return null;

      for (const child of scroller.children) {
        // Stop once we reach the section that holds the title
        if (child === titleSection) break;
        // Skip tiny/invisible elements
        if (child.offsetHeight < 60 || child.offsetWidth < 100) continue;

        // Has a direct <img>?
        if (child.querySelector("img")) return child;

        // Has a CSS background-image?
        const bg = getComputedStyle(child).backgroundImage;
        if (bg && bg !== "none") return child;

        // Check nested children for background-image or img
        for (const gc of child.querySelectorAll("*")) {
          if (gc.tagName === "IMG") return child;
          const gcBg = getComputedStyle(gc).backgroundImage;
          if (gcBg && gcBg !== "none" && gc.offsetHeight >= 40) return child;
        }
      }
      return null;
    },

    /**
     * Page icon — emoji or uploaded image near the title.
     * Strategy: starting from the title input, walk up the DOM tree.
     * At each level, check siblings for icon-like content (large emoji
     * or small image). Stop before reaching the scroller.
     */
    pageIcon() {
      const titleInput = this._titleInput();
      if (!titleInput) return null;

      let current = titleInput;
      for (let depth = 0; depth < 10; depth++) {
        const parent = current.parentElement;
        if (!parent || parent === this.captureTarget()) break;

        for (const sibling of parent.children) {
          if (sibling === current || sibling.contains(titleInput)) continue;
          if (sibling.offsetHeight === 0 || sibling.offsetWidth === 0) continue;
          // Skip large containers (description, page content, etc.)
          if (sibling.offsetHeight > 200) continue;

          const text = sibling.textContent?.trim();

          // Large emoji: short text content + large font-size
          if (text && text.length <= 4) {
            const hasLargeFont = (el) => parseFloat(getComputedStyle(el).fontSize) >= 40;
            if (hasLargeFont(sibling)) return sibling;
            for (const child of sibling.querySelectorAll("*")) {
              if (hasLargeFont(child)) return sibling;
            }
          }

          // Uploaded icon image (small-ish, roughly square)
          const img = sibling.querySelector("img");
          if (
            img &&
            img.offsetHeight >= 30 && img.offsetHeight <= 200 &&
            img.offsetWidth >= 30 && img.offsetWidth <= 200
          ) {
            return sibling;
          }
        }
        current = parent;
      }
      return null;
    },

    /**
     * Page title — the large editable heading.
     * Strategy: walk up from [placeholder="Untitled"] until we find a
     * parent that has OTHER visible children (like the icon). Return the
     * child branch that contains the title, NOT the shared parent. This
     * lets us hide the title independently of the icon.
     */
    pageTitle() {
      const titleInput = this._titleInput();
      if (!titleInput) return null;

      let el = titleInput;
      const scroller = this.captureTarget();
      while (el.parentElement && el.parentElement !== scroller) {
        const parent = el.parentElement;
        const visibleSiblings = [...parent.children].filter(
          (c) => c !== el && c.offsetHeight > 0 && c.offsetWidth > 0
        );
        if (visibleSiblings.length > 0) {
          // Parent has other visible children — el is the title container
          return el;
        }
        el = parent;
      }
      // Reached the scroller — return the direct child holding the title
      return el;
    },

    /**
     * Page description / subtitle.
     * Strategy 1: look for [placeholder] containing "description" (case-insensitive).
     * Strategy 2: find scroller children between the title section and
     *             the database/page-content section.
     */
    pageDescription() {
      const scroller = this.captureTarget();
      const titleInput = this._titleInput();

      // Strategy 1: placeholder attribute
      const byPlaceholder = document.querySelector(
        '[placeholder*="description" i]'
      );
      if (byPlaceholder) {
        // Walk up to find its container, but stop before merging with
        // the title or scroller
        let el = byPlaceholder;
        while (el.parentElement && el.parentElement !== scroller) {
          const parent = el.parentElement;
          // Stop if the parent also contains the title (shared header section)
          if (titleInput && parent.contains(titleInput) && !el.contains(titleInput)) {
            return el;
          }
          const visibleSiblings = [...parent.children].filter(
            (c) => c !== el && c.offsetHeight > 0 && c.offsetWidth > 0
          );
          if (visibleSiblings.length > 0) return el;
          el = parent;
        }
        return el;
      }

      // Strategy 2: structural — children between title and database
      if (!scroller || !titleInput) return null;
      const titleSection = this._scrollerChildOf(titleInput);
      if (!titleSection) return null;

      const dbBlock = document.querySelector(".notion-collection_view-block");
      const dbSection = dbBlock ? this._scrollerChildOf(dbBlock) : null;
      const pageContent = document.querySelector(".notion-page-content");
      const pcSection = pageContent ? this._scrollerChildOf(pageContent) : null;

      let foundTitle = false;
      for (const child of scroller.children) {
        if (child === titleSection) { foundTitle = true; continue; }
        if (!foundTitle) continue;
        if (child === dbSection || child === pcSection) break;
        if (child.offsetHeight > 0 && child.textContent?.trim()) return child;
      }
      return null;
    },

    /**
     * Notion UI chrome — editing interface elements:
     *   - "+ New" row button at the bottom of tables
     *   - View selector tabs (Board / Table / Timeline / ...)
     *   - Collection toolbars (Filter, Sort, ...)
     * Searches inside .notion-collection_view-block AND the scroller
     * (for full-page databases where there's no collection_view-block).
     * Returns an array of elements.
     */
    uiChrome() {
      const elements = [];
      const seen = new WeakSet();
      const addUnique = (el) => {
        if (el && !seen.has(el)) { seen.add(el); elements.push(el); }
      };

      // Containers to search: collection blocks + scroller (full-page DB)
      const containers = [
        ...document.querySelectorAll(".notion-collection_view-block"),
      ];
      const scroller = this.captureTarget();
      if (scroller) containers.push(scroller);

      for (const container of containers) {
        // 1. "+ New" button
        container.querySelectorAll('[role="button"], div, a').forEach((el) => {
          const text = el.textContent?.trim();
          if (
            (text === "New" || text === "+ New" || text === "+New") &&
            el.offsetHeight > 0 && el.offsetHeight < 50 &&
            el.children.length <= 5
          ) {
            // Walk up to find the row-level wrapper
            let row = el;
            while (
              row.parentElement &&
              row.parentElement !== container &&
              row.parentElement.children.length <= 2
            ) {
              row = row.parentElement;
            }
            addUnique(row);
          }
        });

        // 2. View tabs (short bar with view-type keywords)
        for (const child of container.children) {
          if (child.offsetHeight === 0 || child.offsetHeight > 60) continue;
          const buttons = child.querySelectorAll('[role="button"], [role="tab"], a');
          if (buttons.length < 2) continue;
          const viewKw = ["table", "board", "timeline", "calendar", "list", "gallery"];
          const matches = [...buttons].filter((b) => {
            const t = b.textContent?.toLowerCase() || "";
            return viewKw.some((kw) => t.includes(kw));
          });
          if (matches.length >= 1) {
            addUnique(child);
          }
        }

        // 3. Toolbar (filter / sort controls)
        for (const child of container.children) {
          if (child.offsetHeight === 0 || child.offsetHeight > 50) continue;
          const text = child.textContent?.toLowerCase() || "";
          if (text.includes("filter") || text.includes("sort")) {
            addUnique(child);
          }
        }
      }

      return elements;
    },

    // ---- Layout elements (for wide-database fit / always-hide) ----

    pageContent() {
      return (
        document.querySelector(".notion-page-content") ||
        document.querySelector(".notion-frame .notion-scroller") ||
        document.querySelector(".notion-frame")
      );
    },

    sidebar() {
      return (
        document.querySelector(".notion-sidebar") ||
        document.querySelector('[class*="notion-sidebar"]')
      );
    },

    topBar() {
      return (
        document.querySelector(".notion-topbar") ||
        document.querySelector('[class*="notion-topbar"]') ||
        document.querySelector(
          ".notion-frame > div:first-child:not(.notion-scroller)"
        )
      );
    },

    frame() {
      return (
        document.querySelector(".notion-frame") ||
        document.querySelector('[class*="notion-frame"]')
      );
    },

    collectionViews() {
      return document.querySelectorAll(
        ".notion-collection_view-block, .notion-table-view, .notion-board-view"
      );
    },
  };

  // ----------------------------------------------------------------
  // 2. BUILD THE SIDE PANEL DOM
  // ----------------------------------------------------------------

  function buildPanel() {
    // Tab (collapsed state)
    const tab = document.createElement("div");
    tab.id = "nss-tab";
    tab.textContent = "Screenshot";
    tab.title = "Open Notion Screenshot Tool";

    // Panel
    const panel = document.createElement("div");
    panel.id = "nss-panel";
    panel.innerHTML = `
      <div class="nss-header">
        <h2>Screenshot Tool</h2>
        <button class="nss-close-btn" title="Close panel">&times;</button>
      </div>
      <div class="nss-body">
        <p class="nss-section-label">Presets</p>
        <div class="nss-presets">
          <button class="nss-preset-btn" data-preset="full-page">Full Page</button>
          <button class="nss-preset-btn" data-preset="database-only">Database Only</button>
        </div>

        <p class="nss-section-label">Toggle Options</p>

        <div class="nss-toggle-row">
          <span class="nss-toggle-label">Hide page cover</span>
          <label class="nss-switch">
            <input type="checkbox" data-toggle="cover">
            <span class="nss-slider"></span>
          </label>
        </div>

        <div class="nss-toggle-row">
          <span class="nss-toggle-label">Hide page icon</span>
          <label class="nss-switch">
            <input type="checkbox" data-toggle="icon">
            <span class="nss-slider"></span>
          </label>
        </div>

        <div class="nss-toggle-row">
          <span class="nss-toggle-label">Hide page title</span>
          <label class="nss-switch">
            <input type="checkbox" data-toggle="title">
            <span class="nss-slider"></span>
          </label>
        </div>

        <div class="nss-toggle-row">
          <span class="nss-toggle-label">Hide page description</span>
          <label class="nss-switch">
            <input type="checkbox" data-toggle="description">
            <span class="nss-slider"></span>
          </label>
        </div>

        <div class="nss-toggle-row">
          <span class="nss-toggle-label">Hide Notion UI chrome</span>
          <label class="nss-switch">
            <input type="checkbox" data-toggle="ui-chrome">
            <span class="nss-slider"></span>
          </label>
        </div>

        <div class="nss-toggle-row">
          <span class="nss-toggle-label">Fit wide database</span>
          <label class="nss-switch">
            <input type="checkbox" data-toggle="fit-wide">
            <span class="nss-slider"></span>
          </label>
        </div>

        <button class="nss-screenshot-btn">
          <span class="nss-camera-icon">&#128247;</span>
          Take Screenshot
        </button>
        <div class="nss-status"></div>
      </div>
      <div class="nss-footer">
        <span>v1.0</span>
        <button class="nss-debug-btn" title="Highlight detected elements (check console)">Debug</button>
      </div>
    `;

    document.body.appendChild(tab);
    document.body.appendChild(panel);

    return { tab, panel };
  }

  const { tab, panel } = buildPanel();

  // ----------------------------------------------------------------
  // 3. PANEL OPEN / CLOSE LOGIC
  // ----------------------------------------------------------------

  function openPanel() {
    panel.classList.add("nss-open");
    tab.classList.add("nss-hidden");
  }

  function closePanel() {
    panel.classList.remove("nss-open");
    tab.classList.remove("nss-hidden");
  }

  tab.addEventListener("click", openPanel);
  panel.querySelector(".nss-close-btn").addEventListener("click", closePanel);

  // Listen for toggle from background script (toolbar icon click)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "nss-toggle-panel") {
      if (panel.classList.contains("nss-open")) {
        closePanel();
      } else {
        openPanel();
      }
    }
  });

  // ----------------------------------------------------------------
  // 4. TOGGLE STATE MANAGEMENT
  // ----------------------------------------------------------------

  const toggles = {
    cover: false,
    icon: false,
    title: false,
    description: false,
    "ui-chrome": false,
    "fit-wide": false,
  };

  function getToggle(name) {
    return panel.querySelector(`input[data-toggle="${name}"]`);
  }

  function setToggle(name, value) {
    toggles[name] = value;
    const input = getToggle(name);
    if (input) input.checked = value;
  }

  // Bind change events
  Object.keys(toggles).forEach((key) => {
    const input = getToggle(key);
    if (input) {
      input.addEventListener("change", () => {
        toggles[key] = input.checked;
        updatePresetHighlight();
      });
    }
  });

  // ----------------------------------------------------------------
  // 5. PRESETS
  // ----------------------------------------------------------------

  function applyPreset(preset) {
    if (preset === "full-page") {
      // All toggles OFF — show everything
      Object.keys(toggles).forEach((key) => setToggle(key, false));
    } else if (preset === "database-only") {
      // Hide cover, icon, title, description, UI chrome; fit wide ON
      setToggle("cover", true);
      setToggle("icon", true);
      setToggle("title", true);
      setToggle("description", true);
      setToggle("ui-chrome", true);
      setToggle("fit-wide", true);
    }
    updatePresetHighlight();
  }

  function updatePresetHighlight() {
    const fullPageMatch =
      !toggles.cover &&
      !toggles.icon &&
      !toggles.title &&
      !toggles.description &&
      !toggles["ui-chrome"] &&
      !toggles["fit-wide"];

    const dbOnlyMatch =
      toggles.cover &&
      toggles.icon &&
      toggles.title &&
      toggles.description &&
      toggles["ui-chrome"] &&
      toggles["fit-wide"];

    panel.querySelectorAll(".nss-preset-btn").forEach((btn) => {
      btn.classList.remove("nss-active");
      if (btn.dataset.preset === "full-page" && fullPageMatch) {
        btn.classList.add("nss-active");
      }
      if (btn.dataset.preset === "database-only" && dbOnlyMatch) {
        btn.classList.add("nss-active");
      }
    });
  }

  panel.querySelectorAll(".nss-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  // Initialize with "Full Page" preset active
  updatePresetHighlight();

  // ----------------------------------------------------------------
  // 6. DEBUG — highlight what each selector matches
  // ----------------------------------------------------------------

  function debugSelectors() {
    // Clear previous highlights
    document.querySelectorAll("[data-nss-debug]").forEach((el) => {
      el.style.outline = "";
      delete el.dataset.nssDebug;
    });

    const results = {
      captureTarget: NotionSelectors.captureTarget(),
      pageCover: NotionSelectors.pageCover(),
      pageIcon: NotionSelectors.pageIcon(),
      pageTitle: NotionSelectors.pageTitle(),
      pageDescription: NotionSelectors.pageDescription(),
      sidebar: NotionSelectors.sidebar(),
      topBar: NotionSelectors.topBar(),
    };
    const uiChromeResults = NotionSelectors.uiChrome();

    const colors = {
      captureTarget: "#2196F3",
      pageCover: "#F44336",
      pageIcon: "#FF9800",
      pageTitle: "#4CAF50",
      pageDescription: "#9C27B0",
      sidebar: "#607D8B",
      topBar: "#795548",
    };

    console.group("[NSS] Selector Debug Results");
    for (const [name, el] of Object.entries(results)) {
      if (el) {
        console.log(
          `%c${name}: FOUND`,
          `color: ${colors[name]}; font-weight: bold`,
          el
        );
        el.style.outline = `3px dashed ${colors[name]}`;
        el.dataset.nssDebug = name;
      } else {
        console.warn(`${name}: NOT FOUND`);
      }
    }
    console.log(
      `uiChrome: ${uiChromeResults.length} element(s)`,
      uiChromeResults
    );
    uiChromeResults.forEach((el, i) => {
      el.style.outline = "3px dashed #E91E63";
      el.dataset.nssDebug = `ui-chrome-${i}`;
    });

    // Dump scroller's direct children for manual inspection
    const scroller = results.captureTarget;
    if (scroller) {
      console.log("\nScroller direct children:");
      [...scroller.children].forEach((c, i) => {
        console.log(
          `  [${i}] <${c.tagName.toLowerCase()}> classes="${c.className}" ` +
          `h=${c.offsetHeight} w=${c.offsetWidth} ` +
          `text="${(c.textContent || "").slice(0, 60).replace(/\n/g, "\\n")}"`
        );
      });
    }
    console.groupEnd();

    setStatus(`Found: cover=${!!results.pageCover}, icon=${!!results.pageIcon}, title=${!!results.pageTitle}, desc=${!!results.pageDescription}, ui=${uiChromeResults.length}`);

    // Auto-clear highlights after 6 seconds
    setTimeout(() => {
      document.querySelectorAll("[data-nss-debug]").forEach((el) => {
        el.style.outline = "";
        delete el.dataset.nssDebug;
      });
    }, 6000);
  }

  // Wire up the debug button
  panel.querySelector(".nss-debug-btn").addEventListener("click", debugSelectors);

  // Expose globally so user can also run from console
  window.__nssDebug = debugSelectors;

  // ----------------------------------------------------------------
  // 7. VISIBILITY MANIPULATION (apply / restore)
  // ----------------------------------------------------------------

  /**
   * Temporarily hides targeted Notion elements based on active toggles.
   * Returns a restore function that re-shows everything.
   */
  function applyVisibilitySettings() {
    const hidden = []; // {element, originalDisplay}

    function hideElement(el) {
      if (!el) return;
      hidden.push({ element: el, originalDisplay: el.style.display });
      el.style.display = "none";
    }

    if (toggles.cover) {
      hideElement(NotionSelectors.pageCover());
    }

    if (toggles.icon) {
      hideElement(NotionSelectors.pageIcon());
    }

    if (toggles.title) {
      hideElement(NotionSelectors.pageTitle());
    }

    if (toggles.description) {
      hideElement(NotionSelectors.pageDescription());
    }

    if (toggles["ui-chrome"]) {
      NotionSelectors.uiChrome().forEach(hideElement);
    }

    // Always hide the sidebar and top bar — they should never be in screenshots
    hideElement(NotionSelectors.sidebar());
    hideElement(NotionSelectors.topBar());

    return function restore() {
      hidden.forEach(({ element, originalDisplay }) => {
        element.style.display = originalDisplay;
      });
    };
  }

  // ----------------------------------------------------------------
  // 8. WIDE DATABASE FIT
  // ----------------------------------------------------------------

  /**
   * If "Fit wide database" is ON, temporarily adjusts the page layout
   * so that the full database width is captured.
   * Returns a restore function.
   */
  function applyWideDatabaseFit() {
    const modifications = [];

    if (!toggles["fit-wide"]) {
      return { restore: () => {}, captureWidth: null };
    }

    // Find the widest collection/database element
    let maxWidth = window.innerWidth;
    const collectionViews = NotionSelectors.collectionViews();
    collectionViews.forEach((view) => {
      const scrollWidth = view.scrollWidth;
      if (scrollWidth > maxWidth) {
        maxWidth = scrollWidth;
      }
    });

    // Also check for scrollable table containers
    document.querySelectorAll(".notion-table-view, .notion-scroller.horizontal").forEach((el) => {
      if (el.scrollWidth > maxWidth) {
        maxWidth = el.scrollWidth;
      }
    });

    if (maxWidth <= window.innerWidth) {
      // No overflow; nothing to do
      return { restore: () => {}, captureWidth: null };
    }

    // Temporarily expand containers so html2canvas can capture the full width
    const frame = NotionSelectors.frame();
    if (frame) {
      modifications.push({
        el: frame,
        props: {
          width: frame.style.width,
          maxWidth: frame.style.maxWidth,
          overflow: frame.style.overflow,
        },
      });
      frame.style.width = maxWidth + "px";
      frame.style.maxWidth = maxWidth + "px";
      frame.style.overflow = "visible";
    }

    const pageContent = NotionSelectors.pageContent();
    if (pageContent) {
      modifications.push({
        el: pageContent,
        props: {
          width: pageContent.style.width,
          maxWidth: pageContent.style.maxWidth,
          overflow: pageContent.style.overflow,
        },
      });
      pageContent.style.width = maxWidth + "px";
      pageContent.style.maxWidth = maxWidth + "px";
      pageContent.style.overflow = "visible";
    }

    // Expand collection view blocks themselves
    collectionViews.forEach((view) => {
      modifications.push({
        el: view,
        props: {
          width: view.style.width,
          maxWidth: view.style.maxWidth,
          overflow: view.style.overflow,
        },
      });
      view.style.width = maxWidth + "px";
      view.style.maxWidth = maxWidth + "px";
      view.style.overflow = "visible";
    });

    return {
      captureWidth: maxWidth + 40, // small padding
      restore() {
        modifications.forEach(({ el, props }) => {
          Object.entries(props).forEach(([key, value]) => {
            el.style[key] = value;
          });
        });
      },
    };
  }

  // ----------------------------------------------------------------
  // 9. FULL-PAGE EXPANSION (capture off-screen content)
  // ----------------------------------------------------------------

  /**
   * Temporarily expands all scrollable ancestors of the capture target
   * so that html2canvas can render content below the fold (e.g. long
   * descriptions pushing the table off-screen).
   * Returns a restore function.
   */
  function expandForFullCapture(target) {
    const saved = [];

    // Walk up from the target and expand every scrollable container
    let el = target;
    while (el && el !== document.documentElement) {
      const style = getComputedStyle(el);
      const isScrollable =
        el.scrollHeight > el.clientHeight &&
        (style.overflow === "auto" ||
         style.overflow === "hidden" ||
         style.overflow === "scroll" ||
         style.overflowY === "auto" ||
         style.overflowY === "hidden" ||
         style.overflowY === "scroll");

      if (isScrollable) {
        saved.push({
          el,
          scrollTop: el.scrollTop,
          height: el.style.height,
          maxHeight: el.style.maxHeight,
          overflow: el.style.overflow,
          overflowY: el.style.overflowY,
        });
        el.scrollTop = 0;
        el.style.height = el.scrollHeight + "px";
        el.style.maxHeight = "none";
        el.style.overflow = "visible";
        el.style.overflowY = "visible";
      }
      el = el.parentElement;
    }

    return function restore() {
      saved.forEach(({ el, scrollTop, height, maxHeight, overflow, overflowY }) => {
        el.style.height = height;
        el.style.maxHeight = maxHeight;
        el.style.overflow = overflow;
        el.style.overflowY = overflowY;
        el.scrollTop = scrollTop;
      });
    };
  }

  // ----------------------------------------------------------------
  // 10. SCREENSHOT CAPTURE
  // ----------------------------------------------------------------

  const statusEl = panel.querySelector(".nss-status");
  const screenshotBtn = panel.querySelector(".nss-screenshot-btn");

  function setStatus(text, type = "") {
    statusEl.textContent = text;
    statusEl.className = "nss-status" + (type ? ` nss-${type}` : "");
  }

  async function takeScreenshot() {
    screenshotBtn.disabled = true;
    setStatus("Preparing...");

    // Hide the extension panel and tab during capture
    const panelWasOpen = panel.classList.contains("nss-open");
    panel.style.display = "none";
    tab.style.display = "none";

    // Apply visibility toggles
    const restoreVisibility = applyVisibilitySettings();

    // Determine the target element to capture — the content area
    // to the right of the sidebar (cover + title + page content)
    const target = NotionSelectors.captureTarget() || document.body;

    // Apply wide database fit
    const { restore: restoreWide, captureWidth } = applyWideDatabaseFit();

    // Expand scrollable containers so the full page is captured,
    // not just what's visible in the viewport
    const restoreExpansion = expandForFullCapture(target);

    // Small delay to let the DOM settle after style changes
    await new Promise((r) => setTimeout(r, 150));

    try {
      setStatus("Capturing...");

      // html2canvas options
      const options = {
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#ffffff",
        scale: 2, // 2x for retina-quality output
        logging: false,
        // If we need a wider capture for overflow databases
        ...(captureWidth ? { windowWidth: captureWidth } : {}),
        // Ignore our extension elements
        ignoreElements: (element) => {
          return (
            element.id === "nss-panel" ||
            element.id === "nss-tab"
          );
        },
      };

      const canvas = await html2canvas(target, options);

      // Convert to blob and download
      canvas.toBlob((blob) => {
        if (!blob) {
          setStatus("Failed to generate image", "error");
          return;
        }

        // Auto-download as PNG
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;

        // Generate a filename from the page title
        const titleEl = document.querySelector('[placeholder="Untitled"]');
        const pageTitle =
          titleEl?.textContent?.trim().replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 50) ||
          "notion-screenshot";
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
        a.download = `${pageTitle}-${timestamp}.png`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setStatus("Screenshot saved!", "success");

        // Also try to copy to clipboard
        try {
          navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob }),
          ]).then(() => {
            setStatus("Saved & copied to clipboard!", "success");
          }).catch(() => {
            // Clipboard write failed — download still worked
          });
        } catch (_e) {
          // Clipboard API not available; download still worked
        }
      }, "image/png");
    } catch (err) {
      console.error("[Notion Screenshot]", err);
      setStatus("Capture failed: " + err.message, "error");
    } finally {
      // Restore everything
      restoreExpansion();
      restoreVisibility();
      restoreWide();

      // Re-show extension UI
      panel.style.display = "";
      tab.style.display = "";
      if (panelWasOpen) {
        panel.classList.add("nss-open");
        tab.classList.add("nss-hidden");
      }

      screenshotBtn.disabled = false;

      // Clear status after a few seconds
      setTimeout(() => {
        if (
          statusEl.textContent.includes("saved") ||
          statusEl.textContent.includes("copied")
        ) {
          setStatus("");
        }
      }, 4000);
    }
  }

  screenshotBtn.addEventListener("click", takeScreenshot);

  // ----------------------------------------------------------------
  // 11. DONE — log to console for debugging
  // ----------------------------------------------------------------
  console.log("[Notion Screenshot Tool] Extension loaded.");
})();
