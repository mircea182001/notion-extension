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
  //    Notion's class names are obfuscated. We use structural /
  //    semantic selectors wherever possible and fall back to
  //    heuristic matchers. Each selector is documented so it can
  //    be updated if Notion's DOM changes.
  // ----------------------------------------------------------------

  const NotionSelectors = {
    /**
     * Page cover image — the large banner at the top.
     * Notion wraps it in an <img> inside a container with
     * a "page-cover" style; we also try [data-block-id] ancestors.
     * Structural path: .notion-page-content > first child img wrapper.
     */
    pageCover() {
      return (
        // Direct class-based selector (most common)
        document.querySelector(".notion-page-cover") ||
        // Fallback: large image at top of the page content area
        document.querySelector(
          '.notion-page-content > div:first-child img[style*="object-fit"]'
        )?.closest("div[style]")
      );
    },

    /**
     * Page icon — emoji or uploaded image at the top-left.
     * Usually inside a container with role="button" near the title,
     * or a div with class containing "page-icon".
     */
    pageIcon() {
      return (
        document.querySelector(".notion-page-icon") ||
        // Fallback: the icon container is typically the first child
        // within the record-icon wrapper
        document.querySelector(".notion-record-icon") ||
        document.querySelector(
          '.notion-page-content [role="button"][style*="font-size: 78px"]'
        )?.closest("div")
      );
    },

    /**
     * Page title — the large editable heading.
     * Notion renders it as a div[placeholder="Untitled"] or
     * h1-style element with contenteditable.
     */
    pageTitle() {
      return (
        document.querySelector(
          '.notion-page-content [placeholder="Untitled"]'
        )?.closest(".notion-selectable") ||
        document.querySelector(
          '.notion-page-content div[data-content-editable-leaf][style*="font-size: 40px"]'
        )?.closest(".notion-selectable") ||
        // Fallback: first large text block in page content
        (() => {
          const candidates = document.querySelectorAll(
            ".notion-page-content .notion-selectable"
          );
          for (const el of candidates) {
            const h = el.querySelector(
              'h1, [style*="font-size: 40px"], [placeholder="Untitled"]'
            );
            if (h) return el;
          }
          return null;
        })()
      );
    },

    /**
     * Page description / subtitle — the text block right below the title.
     * Notion uses a placeholder "Add a description..." or similar.
     */
    pageDescription() {
      return (
        document.querySelector(
          '.notion-page-content [placeholder*="description"]'
        )?.closest(".notion-selectable") ||
        document.querySelector(
          '.notion-page-content [placeholder*="Description"]'
        )?.closest(".notion-selectable")
      );
    },

    /**
     * Notion UI chrome — elements that are part of the Notion
     * editing interface rather than page content:
     *   - "+ New" row button at the bottom of tables
     *   - View selector tabs (Board / Timeline / Table / etc.)
     *   - Collection toolbars
     * Returns an array of elements.
     */
    uiChrome() {
      const elements = [];

      // "+ New" button row below tables/databases
      // This is typically a div with text "New" and a "+" icon,
      // often matched by a role or specific class pattern.
      document.querySelectorAll(".notion-collection-view-body").forEach((body) => {
        // The "New" row is usually the next sibling or a child after the table
        const newRows = body.parentElement?.querySelectorAll(
          'div[role="button"]'
        );
        newRows?.forEach((btn) => {
          if (btn.textContent?.trim() === "New" || btn.textContent?.trim() === "+ New") {
            elements.push(btn.closest(".notion-selectable") || btn);
          }
        });
      });

      // Direct selector for the new row
      document.querySelectorAll('.notion-new-record-button, [class*="newRow"]').forEach((el) => {
        elements.push(el);
      });

      // Also try the "New" link at the bottom of table views
      document.querySelectorAll('.notion-table-view-add-row, .notion-list-view-add-row, .notion-board-view-add-row').forEach((el) => {
        elements.push(el);
      });

      // Broader heuristic: any row at the bottom of a collection that
      // has a "plus" SVG and "New" text
      document.querySelectorAll('.notion-collection_view-block').forEach((block) => {
        const candidates = block.querySelectorAll('div[role="button"]');
        candidates.forEach((btn) => {
          const text = btn.textContent?.trim().toLowerCase();
          if (text === "new" || text === "+ new") {
            const wrapper = btn.closest('[style*="height: 33px"]') ||
                            btn.closest('[style*="height: 32px"]') ||
                            btn;
            elements.push(wrapper);
          }
        });
      });

      // View selector / tab bar above databases
      // This is the bar that shows "Table | Board | Timeline | ..."
      document.querySelectorAll('.notion-collection-view-tab-bar, .notion-collection_view_page-tab-bar').forEach((el) => {
        elements.push(el);
      });

      // Fallback: look for tab containers above collection views
      document.querySelectorAll('.notion-collection_view-block').forEach((block) => {
        // The tab bar is typically the first or second child with
        // multiple clickable items in a horizontal row
        const firstChildren = block.children;
        for (let i = 0; i < Math.min(firstChildren.length, 3); i++) {
          const child = firstChildren[i];
          const tabs = child.querySelectorAll('[role="tab"], [role="button"]');
          if (tabs.length >= 2) {
            // Check if this looks like a view switcher
            const tabTexts = [...tabs].map((t) => t.textContent?.trim().toLowerCase());
            const viewKeywords = ["table", "board", "timeline", "calendar", "list", "gallery"];
            const matchCount = tabTexts.filter((t) =>
              viewKeywords.some((kw) => t.includes(kw))
            ).length;
            if (matchCount >= 2) {
              elements.push(child);
            }
          }
        }
      });

      // Collection toolbar (filter, sort, search bar above databases)
      document.querySelectorAll('.notion-collection-view-toolbar, .notion-collection_view-toolbar').forEach((el) => {
        elements.push(el);
      });

      return [...new Set(elements)]; // deduplicate
    },

    /**
     * The main page content area — what we want to screenshot.
     * This excludes the sidebar and top navigation.
     */
    pageContent() {
      return (
        document.querySelector(".notion-page-content") ||
        document.querySelector(".notion-scroller") ||
        // Fallback: the main frame area
        document.querySelector('.notion-frame [class*="scroller"]') ||
        document.querySelector(".notion-frame")
      );
    },

    /**
     * The scroller / frame that contains the page.
     * Used for wide-database fitting.
     */
    frame() {
      return (
        document.querySelector(".notion-frame") ||
        document.querySelector('[class*="notion-frame"]')
      );
    },

    /**
     * Database / collection view blocks.
     * Used for wide-database fitting — we need to know the
     * actual content width of the database.
     */
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
      <div class="nss-footer">Notion Screenshot Tool v1.0</div>
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
  // 6. VISIBILITY MANIPULATION (apply / restore)
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

    return function restore() {
      hidden.forEach(({ element, originalDisplay }) => {
        element.style.display = originalDisplay;
      });
    };
  }

  // ----------------------------------------------------------------
  // 7. WIDE DATABASE FIT
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
  // 8. SCREENSHOT CAPTURE
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

    // Apply wide database fit
    const { restore: restoreWide, captureWidth } = applyWideDatabaseFit();

    // Small delay to let the DOM settle after style changes
    await new Promise((r) => setTimeout(r, 150));

    try {
      setStatus("Capturing...");

      // Determine the target element to capture
      const target = NotionSelectors.pageContent() || document.querySelector(".notion-frame") || document.body;

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
        const titleEl = document.querySelector(
          '.notion-page-content [placeholder="Untitled"]'
        );
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
  // 9. DONE — log to console for debugging
  // ----------------------------------------------------------------
  console.log("[Notion Screenshot Tool] Extension loaded.");
})();
