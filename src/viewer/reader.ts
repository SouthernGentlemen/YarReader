/*
 * YarReader portable reader.
 *
 * Runs from file:// with no server, no modules, no fetch, no dependencies.
 * Everything it needs arrives through the global catalog defined in catalog.js
 * plus the bootstrap arguments generated into each leaf index.html.
 */

(function () {
  "use strict";

  type Mode = "paged" | "spread" | "scroll";
  type Direction = YarReadingDirection;
  type Fit = "width" | "page" | "zoom";

  interface State {
    item: YarCatalogItem;
    root: string;
    mode: Mode;
    direction: Direction;
    fit: Fit;
    zoom: number;
    index: number;
    chromeHidden: boolean;
    gap: boolean;
  }

  var PRELOAD_AHEAD = 3;
  var PRELOAD_BEHIND = 1;
  var MIN_ZOOM = 0.25;
  var MAX_ZOOM = 6;

  /* ---------------------------------------------------------------- util */

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pad4(value: number): string {
    return pad(value, 4);
  }

  function pad(value: number, width: number): string {
    var text = String(value);
    while (text.length < width) text = "0" + text;
    return text;
  }

  function normalizePath(value: string): string {
    var trimmed = value.replace(/^\.\//, "");
    return trimmed.charAt(trimmed.length - 1) === "/" ? trimmed : trimmed + "/";
  }

  function catalog(): YarCatalog | null {
    var found = (window as any).COMIC_LIBRARY || (window as any).YAR_LIBRARY;
    return found && found.items ? (found as YarCatalog) : null;
  }

  /** Guess the unit path from the URL when no bootstrap argument was given. */
  function pathFromLocation(): string | null {
    var raw = window.location.pathname.replace(/index\.html?$/i, "");
    var decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch (error) {
      decoded = raw;
    }
    var segments = decoded.split("/").filter(function (part) {
      return part.length > 0;
    });
    var data = catalog();
    if (!data) return null;
    for (var depth = 2; depth <= 5 && depth <= segments.length; depth += 1) {
      var candidate = segments.slice(segments.length - depth).join("/") + "/";
      for (var i = 0; i < data.items.length; i += 1) {
        if (data.items[i].path === candidate) return candidate;
      }
    }
    return null;
  }

  function storageKey(item: YarCatalogItem): string {
    return "yar:progress:" + item.path;
  }

  function readProgress(item: YarCatalogItem): number {
    try {
      var raw = window.localStorage.getItem(storageKey(item));
      if (!raw) return 0;
      var value = parseInt(raw, 10);
      if (isNaN(value) || value < 0 || value >= item.pageCount) return 0;
      return value;
    } catch (error) {
      return 0;
    }
  }

  function writeProgress(item: YarCatalogItem, index: number): void {
    try {
      window.localStorage.setItem(storageKey(item), String(index));
    } catch (error) {
      /* file:// storage is optional; reading still works without it */
    }
  }

  function readPreference(name: string, fallback: string): string {
    try {
      return window.localStorage.getItem("yar:pref:" + name) || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writePreference(name: string, value: string): void {
    try {
      window.localStorage.setItem("yar:pref:" + name, value);
    } catch (error) {
      /* optional */
    }
  }

  /* ------------------------------------------------------------- reader */

  function start(options?: YarReaderStartOptions): void {
    var opts = options || {};
    var data = catalog();
    var mount = document.getElementById(opts.mount || "reader");

    if (!mount) return;
    if (!data) {
      mount.appendChild(errorPanel("catalog.js was not loaded", "This page expects catalog.js to be included before reader.js."));
      return;
    }

    var wantedPath = opts.path ? normalizePath(opts.path) : pathFromLocation();
    var item: YarCatalogItem | null = null;
    for (var i = 0; i < data.items.length; i += 1) {
      if (wantedPath && data.items[i].path === wantedPath) {
        item = data.items[i];
        break;
      }
    }

    if (!item) {
      mount.appendChild(
        errorPanel(
          "This unit is not in the catalog",
          wantedPath ? 'No catalog entry matches "' + wantedPath + '".' : "The unit path could not be determined.",
        ),
      );
      return;
    }

    var root = opts.root || "../../../";
    render(mount, item, root, data);
  }

  function errorPanel(title: string, detail: string): HTMLElement {
    var box = el("div", "yar-error");
    box.appendChild(el("h1", undefined, title));
    box.appendChild(el("p", undefined, detail));
    return box;
  }

  function render(mount: HTMLElement, item: YarCatalogItem, root: string, data: YarCatalog): void {
    var defaultMode: Mode = item.readingMode === "scroll" ? "scroll" : "paged";
    var savedMode = readPreference("layout-v2:" + item.path, defaultMode);
    var initialMode: Mode = savedMode === "spread" || savedMode === "scroll" || savedMode === "paged" ? savedMode : defaultMode;
    var defaultDirection: Direction = item.readingMode === "rtl" ? "rtl" : "ltr";
    var savedDirection = readPreference("direction-v2:" + item.path, defaultDirection);
    var savedFit = readPreference("fit", "width");
    var initialFit: Fit = savedFit === "page" || savedFit === "zoom" || savedFit === "width" ? savedFit : "width";
    if (initialMode === "scroll" && initialFit === "page") initialFit = "width";
    var state: State = {
      item: item,
      root: root,
      mode: initialMode,
      direction: savedDirection === "rtl" ? "rtl" : "ltr",
      fit: initialFit,
      zoom: 1,
      index: readProgress(item),
      chromeHidden: false,
      gap: item.readingMode === "scroll" ? false : readPreference("gap", "on") === "on",
    };

    mount.innerHTML = "";
    document.title = item.series + " - " + (item.title || pad4(item.sequence));

    var app = el("div", "yar-app");
    var top = el("header", "yar-bar yar-bar-top");
    var stage = el("div", "yar-stage");
    var bottom = el("footer", "yar-bar yar-bar-bottom");
    var toast = el("div", "yar-toast");

    app.appendChild(top);
    app.appendChild(stage);
    app.appendChild(bottom);
    app.appendChild(toast);
    mount.appendChild(app);

    /* -------------------------------------------------------- top bar */

    var libraryLink = el("a", "yar-btn yar-btn-ghost", "Library");
    libraryLink.setAttribute("href", state.root + "index.html");
    libraryLink.setAttribute("title", "Back to the library");

    var titleBox = el("div", "yar-title");
    var seriesLine = el("span", "yar-title-series", item.series);
    var unitLine = el("span", "yar-title-unit", item.title || "Unit " + pad4(item.sequence));
    titleBox.appendChild(seriesLine);
    titleBox.appendChild(unitLine);

    var modeButton = el("button", "yar-btn", "");
    modeButton.setAttribute("type", "button");
    modeButton.setAttribute("title", "Reading mode (m)");

    var directionButton = el("button", "yar-btn", "");
    directionButton.setAttribute("type", "button");
    directionButton.setAttribute("title", "Reading direction (d)");

    var fitButton = el("button", "yar-btn", "");
    fitButton.setAttribute("type", "button");
    fitButton.setAttribute("title", "Fit mode (w / p)");

    var zoomOut = el("button", "yar-btn yar-btn-icon", "-");
    zoomOut.setAttribute("type", "button");
    zoomOut.setAttribute("title", "Zoom out");
    var zoomIn = el("button", "yar-btn yar-btn-icon", "+");
    zoomIn.setAttribute("type", "button");
    zoomIn.setAttribute("title", "Zoom in");

    var fullscreenButton = el("button", "yar-btn", "Full");
    fullscreenButton.setAttribute("type", "button");
    fullscreenButton.setAttribute("title", "Fullscreen (f)");

    top.appendChild(libraryLink);
    top.appendChild(titleBox);
    var topTools = el("div", "yar-tools");
    topTools.appendChild(modeButton);
    topTools.appendChild(directionButton);
    topTools.appendChild(fitButton);
    topTools.appendChild(zoomOut);
    topTools.appendChild(zoomIn);
    topTools.appendChild(fullscreenButton);
    top.appendChild(topTools);

    /* ----------------------------------------------------- bottom bar */

    var prevButton = el("button", "yar-btn yar-btn-nav", "Prev");
    prevButton.setAttribute("type", "button");
    var nextButton = el("button", "yar-btn yar-btn-nav", "Next");
    nextButton.setAttribute("type", "button");

    var slider = el("input", "yar-slider") as HTMLInputElement;
    slider.type = "range";
    slider.min = "1";
    slider.max = String(Math.max(1, item.pageCount));
    slider.step = "1";
    slider.setAttribute("aria-label", "Jump to page");

    var counter = el("span", "yar-counter", "");

    var jump = el("input", "yar-jump") as HTMLInputElement;
    jump.type = "number";
    jump.min = "1";
    jump.max = String(Math.max(1, item.pageCount));
    jump.setAttribute("aria-label", "Page number");

    bottom.appendChild(prevButton);
    bottom.appendChild(slider);
    bottom.appendChild(counter);
    bottom.appendChild(jump);
    bottom.appendChild(nextButton);

    /* ------------------------------------------------------- plumbing */

    var pageSources: string[] = [];
    for (var p = 1; p <= item.pageCount; p += 1) {
      pageSources.push((item.pageRoot || "") + pad(p, item.pageDigits || 4) + "." + item.pageExtension);
    }

    var preloaded: Record<string, HTMLImageElement> = {};
    var toastTimer = 0;

    function flash(message: string): void {
      toast.textContent = message;
      toast.className = "yar-toast yar-toast-on";
      if (toastTimer) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(function () {
        toast.className = "yar-toast";
      }, 1100);
    }

    function preload(around: number): void {
      var from = Math.max(0, around - PRELOAD_BEHIND);
      var to = Math.min(pageSources.length - 1, around + PRELOAD_AHEAD);
      for (var i = from; i <= to; i += 1) {
        var src = pageSources[i];
        if (preloaded[src]) continue;
        var image = new Image();
        image.src = src;
        preloaded[src] = image;
      }
    }

    /** Spread grouping: the cover stands alone, then pages pair up. */
    function spreadGroups(): number[][] {
      var groups: number[][] = [];
      var total = pageSources.length;
      if (total === 0) return groups;
      groups.push([0]);
      for (var i = 1; i < total; i += 2) {
        if (i + 1 < total) groups.push([i, i + 1]);
        else groups.push([i]);
      }
      return groups;
    }

    function groupIndexFor(pageIndex: number): number {
      var groups = spreadGroups();
      for (var i = 0; i < groups.length; i += 1) {
        for (var j = 0; j < groups[i].length; j += 1) if (groups[i][j] === pageIndex) return i;
      }
      return 0;
    }

    function makePage(pageIndex: number, lazy: boolean): HTMLImageElement {
      var image = el("img", "yar-page") as HTMLImageElement;
      image.src = pageSources[pageIndex];
      image.alt = "Page " + (pageIndex + 1) + " of " + pageSources.length;
      image.setAttribute("draggable", "false");
      if (lazy) image.setAttribute("loading", "lazy");
      image.setAttribute("decoding", "async");
      image.setAttribute("data-page", String(pageIndex + 1));
      var size = item.pageSizes && item.pageSizes[pageIndex];
      if (size && size[0] > 0 && size[1] > 0) {
        image.width = size[0];
        image.height = size[1];
      }
      image.onerror = function () {
        image.classList.add("yar-page-missing");
        image.alt = "Missing page " + pageSources[pageIndex];
      };
      return image;
    }

    function applyFit(): void {
      app.setAttribute("data-fit", state.fit);
      stage.style.setProperty("--yar-zoom", String(state.zoom));
      fitButton.textContent = state.fit === "width" ? "Fit width" : state.fit === "page" ? "Fit page" : "Zoom " + Math.round(state.zoom * 100) + "%";
    }

    function paintChrome(): void {
      app.setAttribute("data-mode", state.mode);
      app.setAttribute("data-direction", state.direction);
      app.className = "yar-app" + (state.chromeHidden ? " yar-chrome-hidden" : "");
      modeButton.textContent = state.mode === "paged" ? "Paged" : state.mode === "spread" ? "Spread" : "Scroll";
      directionButton.textContent = state.direction === "rtl" ? "RTL" : "LTR";
      applyFit();
    }

    function updateCounter(): void {
      var current = Math.min(state.index + 1, pageSources.length);
      counter.textContent = current + " / " + pageSources.length;
      slider.value = String(current);
      if (document.activeElement !== jump) jump.value = String(current);
    }

    function renderStage(): void {
      stage.innerHTML = "";
      stage.scrollTop = 0;
      stage.scrollLeft = 0;

      if (pageSources.length === 0) {
        stage.appendChild(errorPanel("No pages", "This unit contains no normalized pages."));
        return;
      }

      if (state.mode === "scroll") {
        var strip = el("div", "yar-strip" + (state.gap ? " yar-strip-gap" : ""));
        for (var i = 0; i < pageSources.length; i += 1) strip.appendChild(makePage(i, i > 2));
        stage.appendChild(strip);
        return;
      }

      if (state.mode === "spread") {
        var groups = spreadGroups();
        var group = groups[groupIndexFor(state.index)] || [0];
        var spread = el("div", "yar-spread");
        var ordered = group.slice();
        if (state.direction === "rtl") ordered.reverse();
        for (var g = 0; g < ordered.length; g += 1) spread.appendChild(makePage(ordered[g], false));
        if (ordered.length === 1) spread.classList.add("yar-spread-single");
        stage.appendChild(spread);
        preload(group[group.length - 1]);
        return;
      }

      var single = el("div", "yar-single");
      single.appendChild(makePage(state.index, false));
      stage.appendChild(single);
      preload(state.index);
    }

    function goTo(index: number, options?: { silent?: boolean }): void {
      var clamped = Math.max(0, Math.min(pageSources.length - 1, index));
      state.index = clamped;
      writeProgress(item, clamped);
      updateCounter();

      if (state.mode === "scroll") {
        var target = stage.querySelector('img[data-page="' + (clamped + 1) + '"]') as HTMLImageElement | null;
        if (target) stage.scrollTop = target.offsetTop;
        if (!options || !options.silent) preload(clamped);
        return;
      }
      renderStage();
    }

    function step(delta: number): void {
      if (state.mode === "spread") {
        var groups = spreadGroups();
        var current = groupIndexFor(state.index);
        var next = current + delta;
        if (next < 0) {
          flash("Start of unit");
          return;
        }
        if (next >= groups.length) {
          flash("End of unit");
          return;
        }
        goTo(groups[next][0]);
        return;
      }
      var target = state.index + delta;
      if (target < 0) {
        flash("Start of unit");
        return;
      }
      if (target >= pageSources.length) {
        flash("End of unit");
        return;
      }
      goTo(target);
    }

    /** In RTL, "forward" is to the left; navigation semantics mirror. */
    function forward(): void {
      if (state.mode === "scroll") {
        stage.scrollBy({ top: stage.clientHeight * 0.9, behavior: "auto" });
        return;
      }
      step(1);
    }

    function backward(): void {
      if (state.mode === "scroll") {
        stage.scrollBy({ top: -stage.clientHeight * 0.9, behavior: "auto" });
        return;
      }
      step(-1);
    }

    function pressLeft(): void {
      if (state.direction === "rtl") forward();
      else backward();
    }

    function pressRight(): void {
      if (state.direction === "rtl") backward();
      else forward();
    }

    function setMode(mode: Mode): void {
      state.mode = mode;
      writePreference("layout-v2:" + item.path, mode);
      if (mode === "scroll" && state.fit === "page") state.fit = "width";
      paintChrome();
      renderStage();
      goTo(state.index, { silent: true });
      flash(modeButton.textContent || mode);
    }

    function setDirection(direction: Direction): void {
      state.direction = direction;
      writePreference("direction-v2:" + item.path, direction);
      paintChrome();
      renderStage();
      flash(direction === "rtl" ? "Right to left" : "Left to right");
    }

    function setFit(fit: Fit): void {
      state.fit = fit;
      if (fit !== "zoom") state.zoom = 1;
      writePreference("fit", fit);
      applyFit();
    }

    function nudgeZoom(delta: number): void {
      state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number((state.zoom + delta).toFixed(2))));
      state.fit = "zoom";
      applyFit();
      flash(Math.round(state.zoom * 100) + "%");
    }

    function toggleChrome(): void {
      state.chromeHidden = !state.chromeHidden;
      paintChrome();
    }

    function toggleFullscreen(): void {
      var doc = document as Document & {
        webkitFullscreenElement?: Element;
        webkitExitFullscreen?: () => void;
      };
      var root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      var active = document.fullscreenElement || doc.webkitFullscreenElement;
      if (active) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      } else if (root.requestFullscreen) {
        root.requestFullscreen().catch(function () {
          flash("Fullscreen unavailable");
        });
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      } else {
        flash("Fullscreen unavailable");
      }
    }

    /* ---------------------------------------------------------- events */

    modeButton.onclick = function () {
      setMode(state.mode === "paged" ? "spread" : state.mode === "spread" ? "scroll" : "paged");
    };
    directionButton.onclick = function () {
      setDirection(state.direction === "ltr" ? "rtl" : "ltr");
    };
    fitButton.onclick = function () {
      setFit(state.fit === "width" ? "page" : "width");
      flash(fitButton.textContent || "");
    };
    zoomIn.onclick = function () {
      nudgeZoom(0.25);
    };
    zoomOut.onclick = function () {
      nudgeZoom(-0.25);
    };
    fullscreenButton.onclick = toggleFullscreen;
    prevButton.onclick = backward;
    nextButton.onclick = forward;

    slider.oninput = function () {
      goTo(parseInt(slider.value, 10) - 1);
    };
    jump.onchange = function () {
      var value = parseInt(jump.value, 10);
      if (!isNaN(value)) goTo(value - 1);
    };

    document.addEventListener("keydown", function (event) {
      if (event.defaultPrevented) return;
      var target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;

      switch (event.key) {
        case "ArrowLeft":
          pressLeft();
          break;
        case "ArrowRight":
          pressRight();
          break;
        case "ArrowUp":
        case "PageUp":
          backward();
          break;
        case "ArrowDown":
        case "PageDown":
          forward();
          break;
        case " ":
          if (event.shiftKey) backward();
          else forward();
          break;
        case "Home":
          goTo(0);
          break;
        case "End":
          goTo(pageSources.length - 1);
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "w":
        case "W":
          setFit("width");
          flash("Fit width");
          break;
        case "p":
        case "P":
          setFit("page");
          flash("Fit page");
          break;
        case "m":
        case "M":
          setMode(state.mode === "paged" ? "spread" : state.mode === "spread" ? "scroll" : "paged");
          break;
        case "d":
        case "D":
          setDirection(state.direction === "ltr" ? "rtl" : "ltr");
          break;
        case "h":
        case "H":
          toggleChrome();
          break;
        case "+":
        case "=":
          nudgeZoom(0.25);
          break;
        case "-":
        case "_":
          nudgeZoom(-0.25);
          break;
        case "Escape":
          if (state.chromeHidden) toggleChrome();
          break;
        default:
          return;
      }
      event.preventDefault();
    });

    /* Horizontal swipe in paged/spread; continuous scrolling stays native. */
    var touchStartX = 0;
    var touchStartY = 0;
    var touchTracking = false;
    var suppressClickUntil = 0;

    stage.onclick = function (event) {
      if (Date.now() < suppressClickUntil) return;
      if (state.mode === "scroll") {
        toggleChrome();
        return;
      }
      var bounds = stage.getBoundingClientRect();
      var ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width);
      if (ratio < 0.32) pressLeft();
      else if (ratio > 0.68) pressRight();
      else toggleChrome();
    };

    stage.addEventListener(
      "touchstart",
      function (event) {
        if (event.touches.length !== 1) {
          touchTracking = false;
          return;
        }
        touchTracking = true;
        touchStartX = event.touches[0].clientX;
        touchStartY = event.touches[0].clientY;
      },
      { passive: true },
    );

    stage.addEventListener(
      "touchend",
      function (event) {
        if (!touchTracking) return;
        touchTracking = false;
        var touch = event.changedTouches[0];
        if (!touch) return;
        var dx = touch.clientX - touchStartX;
        var dy = touch.clientY - touchStartY;
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) suppressClickUntil = Date.now() + 400;
        if (state.mode === "scroll") return;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
        suppressClickUntil = Date.now() + 400;
        if (dx < 0) pressRight();
        else pressLeft();
      },
      { passive: true },
    );

    /* Scroll mode keeps the counter in step with the continuous strip. */
    var scrollTimer = 0;
    stage.addEventListener(
      "scroll",
      function () {
        if (state.mode !== "scroll") return;
        if (scrollTimer) return;
        scrollTimer = window.setTimeout(function () {
          scrollTimer = 0;
          var images = stage.querySelectorAll("img[data-page]");
          var middle = stage.scrollTop + stage.clientHeight * 0.3;
          for (var i = 0; i < images.length; i += 1) {
            var image = images[i] as HTMLImageElement;
            if (image.offsetTop + image.offsetHeight >= middle) {
              var page = parseInt(image.getAttribute("data-page") || "1", 10) - 1;
              if (page !== state.index) {
                state.index = page;
                writeProgress(item, page);
                updateCounter();
              }
              break;
            }
          }
        }, 120);
      },
      { passive: true },
    );

    /* Neighbouring units, so a chapter can be finished without going back. */
    var siblings: YarCatalogItem[] = [];
    for (var s = 0; s < data.items.length; s += 1) {
      if (data.items[s].seriesSlug === item.seriesSlug) siblings.push(data.items[s]);
    }
    siblings.sort(function (a, b) {
      return a.sequence - b.sequence;
    });
    var position = -1;
    for (var q = 0; q < siblings.length; q += 1) if (siblings[q].path === item.path) position = q;

    if (position > 0) bottom.insertBefore(unitLink("<<", siblings[position - 1], state.root), prevButton);
    if (position >= 0 && position < siblings.length - 1) bottom.appendChild(unitLink(">>", siblings[position + 1], state.root));

    paintChrome();
    renderStage();
    updateCounter();
    preload(state.index);
    if (state.index > 0) goTo(state.index, { silent: true });
  }

  function unitLink(label: string, target: YarCatalogItem, root: string): HTMLAnchorElement {
    var link = el("a", "yar-btn yar-btn-unit", label) as HTMLAnchorElement;
    link.href = root + target.path + "index.html";
    link.title = target.series + " - " + (target.title || String(target.sequence));
    return link;
  }

  (window as any).ComicReader = { start: start };
  (window as any).YarReader = { start: start };
})();
