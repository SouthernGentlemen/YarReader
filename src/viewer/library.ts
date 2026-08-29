/*
 * YarReader portable library browser (export/index.html).
 *
 * Reads the generated catalog only. It never enumerates the filesystem, never
 * issues a network request and never parses JSON at runtime.
 */

(function () {
  "use strict";

  type SortKey = "alphabetical" | "sequence" | "recent" | "year";
  type ViewKey = "all" | "series";

  interface Filters {
    query: string;
    format: string;
    genre: string;
    series: string;
    author: string;
    artist: string;
    publisher: string;
    tag: string;
    year: string;
  }

  interface State {
    view: ViewKey;
    sort: SortKey;
    filters: Filters;
    root: string;
  }

  // Browsing a comic library means picking a series, then picking a chapter.
  // Author, artist, publisher, tag and year all stay in the catalog and remain
  // searchable; none of them earned a tab.
  var VIEWS: { key: ViewKey; label: string }[] = [
    { key: "series", label: "Series" },
    { key: "all", label: "Chapters" },
  ];
  var FORMATS: { key: string; label: string }[] = [
    { key: "", label: "All formats" },
    { key: "rtl", label: "Manga (RTL)" },
    { key: "ltr", label: "Comics (LTR)" },
    { key: "scroll", label: "Webtoons (Scroll)" },
  ];
  var UNIT_PAGE_SIZE = 120;

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
    var text = String(value);
    while (text.length < 4) text = "0" + text;
    return text;
  }

  function emptyFilters(): Filters {
    return { query: "", format: "", genre: "", series: "", author: "", artist: "", publisher: "", tag: "", year: "" };
  }

  function readHash(): { view?: string; sort?: string; filters: Filters } {
    var filters = emptyFilters();
    var out: { view?: string; sort?: string; filters: Filters } = { filters: filters };
    var raw = window.location.hash.replace(/^#/, "");
    if (!raw) return out;
    var parts = raw.split("&");
    for (var i = 0; i < parts.length; i += 1) {
      var pair = parts[i].split("=");
      var key = decodeURIComponent(pair[0] || "");
      var value = decodeURIComponent((pair[1] || "").replace(/\+/g, " "));
      if (key === "view") out.view = value;
      else if (key === "sort") out.sort = value;
      else if (key in filters) (filters as any)[key] = value;
    }
    return out;
  }

  function writeHash(state: State): void {
    var parts: string[] = ["view=" + state.view, "sort=" + state.sort];
    var keys: (keyof Filters)[] = ["query", "format", "genre", "series", "author", "artist", "publisher", "tag", "year"];
    for (var i = 0; i < keys.length; i += 1) {
      var value = state.filters[keys[i]];
      if (value) parts.push(keys[i] + "=" + encodeURIComponent(value));
    }
    var next = "#" + parts.join("&");
    if (window.location.hash !== next) window.location.hash = next;
  }

  function textOf(item: YarCatalogItem): string {
    var bits = [item.series, item.title || "", item.publisher || "", item.summary || ""];
    if (item.authors) bits = bits.concat(item.authors);
    if (item.artists) bits = bits.concat(item.artists);
    if (item.tags) bits = bits.concat(item.tags);
    if (item.genres) bits = bits.concat(item.genres);
    if (item.year) bits.push(String(item.year));
    bits.push(pad4(item.sequence));
    return bits.join(" ").toLowerCase();
  }

  function matches(item: YarCatalogItem, filters: Filters): boolean {
    if (filters.format && item.readingMode !== filters.format) return false;
    if (filters.genre && (!item.genres || item.genres.indexOf(filters.genre) < 0)) return false;
    if (filters.series && item.seriesSlug !== filters.series && item.series !== filters.series) return false;
    if (filters.publisher && item.publisher !== filters.publisher) return false;
    if (filters.year && String(item.year || "") !== filters.year) return false;
    if (filters.author && (!item.authors || item.authors.indexOf(filters.author) < 0)) return false;
    if (filters.artist && (!item.artists || item.artists.indexOf(filters.artist) < 0)) return false;
    if (filters.tag && (!item.tags || item.tags.indexOf(filters.tag) < 0)) return false;
    if (filters.query) {
      var haystack = textOf(item);
      var terms = filters.query.toLowerCase().split(/\s+/);
      for (var i = 0; i < terms.length; i += 1) {
        if (terms[i] && haystack.indexOf(terms[i]) < 0) return false;
      }
    }
    return true;
  }

  function formatLabel(mode: YarReadingMode): string {
    return mode === "scroll" ? "Webtoon" : mode === "rtl" ? "Manga" : "Comic";
  }

  function compare(sort: SortKey): (a: YarCatalogItem, b: YarCatalogItem) => number {
    if (sort === "sequence") {
      return function (a, b) {
        if (a.seriesSlug !== b.seriesSlug) return a.seriesSlug < b.seriesSlug ? -1 : 1;
        return a.sequence - b.sequence;
      };
    }
    if (sort === "recent") {
      return function (a, b) {
        return b.added - a.added;
      };
    }
    if (sort === "year") {
      return function (a, b) {
        var ya = a.year || 0;
        var yb = b.year || 0;
        if (ya !== yb) return yb - ya;
        return a.sortTitle < b.sortTitle ? -1 : a.sortTitle > b.sortTitle ? 1 : 0;
      };
    }
    return function (a, b) {
      return a.sortTitle < b.sortTitle ? -1 : a.sortTitle > b.sortTitle ? 1 : 0;
    };
  }


  function start(options?: YarLibraryStartOptions): void {
    var opts = options || {};
    var mount = document.getElementById(opts.mount || "library");
    if (!mount) return;

    var data: YarCatalog | null = (window as any).COMIC_LIBRARY || (window as any).YAR_LIBRARY || null;
    if (!data || !data.items) {
      var problem = el("div", "yar-error");
      problem.appendChild(el("h1", undefined, "catalog.js was not loaded"));
      problem.appendChild(el("p", undefined, "Include catalog.js before library.js."));
      mount.appendChild(problem);
      return;
    }

    var hash = readHash();
    var state: State = {
      view: (VIEWS.some(function (v) { return v.key === hash.view; }) ? (hash.view as ViewKey) : "series"),
      sort: (hash.sort as SortKey) || "alphabetical",
      filters: hash.filters,
      root: opts.root || "./",
    };

    /* ------------------------------------------------------------ chrome */

    mount.innerHTML = "";
    var page = el("div", "yar-library");

    var header = el("header", "yar-lib-header");
    var brand = el("div", "yar-brand");
    brand.appendChild(el("span", "yar-brand-name", opts.label || "Library"));

    // Say what is actually in here: series first, since that is how it is browsed.
    var seriesTotal = 0;
    var seenSeries: Record<string, boolean> = {};
    for (var s = 0; s < data.items.length; s += 1) {
      if (!seenSeries[data.items[s].seriesSlug]) {
        seenSeries[data.items[s].seriesSlug] = true;
        seriesTotal += 1;
      }
    }
    var pageTotal = 0;
    for (var p = 0; p < data.items.length; p += 1) pageTotal += data.items[p].pageCount || 0;

    brand.appendChild(el(
      "span",
      "yar-brand-count",
      seriesTotal + (seriesTotal === 1 ? " series" : " series") +
        " - " + data.items.length + (data.items.length === 1 ? " chapter" : " chapters") +
        " - " + pageTotal + " pages",
    ));

    var search = el("input", "yar-search") as HTMLInputElement;
    search.type = "search";
    search.placeholder = "Search series, title, year";
    search.value = state.filters.query;
    search.setAttribute("aria-label", "Search the library");

    var sortSelect = el("select", "yar-select") as HTMLSelectElement;
    var sortOptions: { key: SortKey; label: string }[] = [
      { key: "alphabetical", label: "Alphabetical" },
      { key: "sequence", label: "Sequence" },
      { key: "recent", label: "Recently added" },
      { key: "year", label: "Year" },
    ];
    for (var s = 0; s < sortOptions.length; s += 1) {
      var option = el("option", undefined, sortOptions[s].label) as HTMLOptionElement;
      option.value = sortOptions[s].key;
      if (sortOptions[s].key === state.sort) option.selected = true;
      sortSelect.appendChild(option);
    }

    header.appendChild(brand);
    header.appendChild(search);
    header.appendChild(sortSelect);

    var filterBar = el("section", "yar-filter-bar");
    filterBar.setAttribute("aria-label", "Library filters");
    var formatFilters = el("div", "yar-format-filters");
    var genreLabel = el("label", "yar-filter-label", "Genre");
    var genreSelect = el("select", "yar-select yar-genre-select") as HTMLSelectElement;
    genreSelect.setAttribute("aria-label", "Filter by genre");
    var allGenres = el("option", undefined, "All genres") as HTMLOptionElement;
    allGenres.value = "";
    genreSelect.appendChild(allGenres);
    var genreNames: string[] = [];
    var seenGenres: Record<string, boolean> = {};
    for (var genreIndex = 0; genreIndex < data.items.length; genreIndex += 1) {
      var itemGenres = data.items[genreIndex].genres || [];
      for (var genreValue = 0; genreValue < itemGenres.length; genreValue += 1) {
        if (seenGenres[itemGenres[genreValue]]) continue;
        seenGenres[itemGenres[genreValue]] = true;
        genreNames.push(itemGenres[genreValue]);
      }
    }
    genreNames.sort(function (left, right) { return left.localeCompare(right); });
    for (var genreOptionIndex = 0; genreOptionIndex < genreNames.length; genreOptionIndex += 1) {
      var genreOption = el("option", undefined, genreNames[genreOptionIndex]) as HTMLOptionElement;
      genreOption.value = genreNames[genreOptionIndex];
      genreSelect.appendChild(genreOption);
    }
    genreLabel.appendChild(genreSelect);
    filterBar.appendChild(formatFilters);
    filterBar.appendChild(genreLabel);

    var tabs = el("nav", "yar-tabs");
    var activeChips = el("div", "yar-active-filters");
    var results = el("div", "yar-results");
    var unitLimit = UNIT_PAGE_SIZE;
    var lastDrawKey = "";

    page.appendChild(header);
    page.appendChild(filterBar);
    page.appendChild(tabs);
    page.appendChild(activeChips);
    page.appendChild(results);
    mount.appendChild(page);

    /* ------------------------------------------------------------ render */

    function setFilter(key: keyof Filters, value: string): void {
      state.filters[key] = state.filters[key] === value ? "" : value;
      writeHash(state);
      draw();
    }

    function coverFor(item: YarCatalogItem): string | null {
      var relative = item.thumbnail || item.cover;
      return relative ? state.root + relative : null;
    }

    function unitCard(item: YarCatalogItem): HTMLAnchorElement {
      var card = el("a", "yar-card") as HTMLAnchorElement;
      card.href = state.root + item.path + "index.html";

      var art = el("div", "yar-card-art");
      var source = coverFor(item);
      if (source) {
        var image = el("img", "yar-card-image") as HTMLImageElement;
        image.src = source;
        image.alt = item.series + " " + (item.title || "");
        image.width = 320;
        image.height = 480;
        image.setAttribute("loading", "lazy");
        image.setAttribute("decoding", "async");
        art.appendChild(image);
      } else {
        art.appendChild(el("div", "yar-card-placeholder", item.series.slice(0, 2).toUpperCase()));
      }
      var badge = el("span", "yar-card-badge", pad4(item.sequence));
      art.appendChild(badge);
      card.appendChild(art);

      var body = el("div", "yar-card-body");
      body.appendChild(el("span", "yar-card-series", item.series));
      body.appendChild(el("span", "yar-card-title", item.title || "Unit " + pad4(item.sequence)));
      var meta: string[] = [formatLabel(item.readingMode), item.pageCount + (item.pageCount === 1 ? " page" : " pages")];
      if (item.year) meta.push(String(item.year));
      if (item.genres && item.genres.length) meta.push(item.genres[0]);
      body.appendChild(el("span", "yar-card-meta", meta.join(" - ")));
      card.appendChild(body);
      return card;
    }

    function seriesCard(slug: string, items: YarCatalogItem[]): HTMLAnchorElement {
      var first = items[0];
      var card = el("a", "yar-card yar-card-series-tile") as HTMLAnchorElement;
      card.href = "#view=all&series=" + encodeURIComponent(slug);
      card.onclick = function (event) {
        event.preventDefault();
        state.view = "all";
        state.filters = emptyFilters();
        state.filters.series = slug;
        writeHash(state);
        draw();
      };

      var art = el("div", "yar-card-art");
      var source = first.seriesCover ? state.root + first.seriesCover : coverFor(first);
      if (source) {
        var image = el("img", "yar-card-image") as HTMLImageElement;
        image.src = source;
        image.alt = first.series;
        image.width = 320;
        image.height = 480;
        image.setAttribute("loading", "lazy");
        image.setAttribute("decoding", "async");
        art.appendChild(image);
      } else {
        art.appendChild(el("div", "yar-card-placeholder", first.series.slice(0, 2).toUpperCase()));
      }
      art.appendChild(el("span", "yar-card-badge", String(items.length)));
      card.appendChild(art);

      var body = el("div", "yar-card-body");
      body.appendChild(el("span", "yar-card-series", first.series));
      body.appendChild(el("span", "yar-card-title", items.length + (items.length === 1 ? " unit" : " units")));
      var range = items.length > 1 ? pad4(items[0].sequence) + " - " + pad4(items[items.length - 1].sequence) : pad4(items[0].sequence);
      body.appendChild(el("span", "yar-card-meta", formatLabel(first.readingMode) + " - " + range));
      card.appendChild(body);
      return card;
    }

    function drawTopFilters(): void {
      formatFilters.innerHTML = "";
      formatFilters.appendChild(el("span", "yar-filter-heading", "Format"));
      for (var i = 0; i < FORMATS.length; i += 1) {
        (function (format) {
          var active = state.filters.format === format.key;
          var button = el("button", "yar-format-button" + (active ? " yar-format-button-on" : ""), format.label);
          button.setAttribute("type", "button");
          button.setAttribute("aria-pressed", active ? "true" : "false");
          button.onclick = function () {
            state.filters.format = format.key;
            writeHash(state);
            draw();
          };
          formatFilters.appendChild(button);
        })(FORMATS[i]);
      }
      genreSelect.value = state.filters.genre;
    }

    function drawTabs(): void {
      tabs.innerHTML = "";
      for (var i = 0; i < VIEWS.length; i += 1) {
        (function (view) {
          var button = el("button", "yar-tab" + (state.view === view.key ? " yar-tab-on" : ""), view.label);
          button.setAttribute("type", "button");
          button.onclick = function () {
            state.view = view.key;
            writeHash(state);
            draw();
          };
          tabs.appendChild(button);
        })(VIEWS[i]);
      }
    }

    function drawActiveFilters(): void {
      activeChips.innerHTML = "";
      var keys: (keyof Filters)[] = ["format", "genre", "series", "author", "artist", "publisher", "tag", "year", "query"];
      var any = false;
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        var value = state.filters[key];
        if (!value) continue;
        any = true;
        (function (k, v) {
          var chip = el("button", "yar-chip yar-chip-active");
          chip.setAttribute("type", "button");
          var visibleValue = k === "format" ? formatLabel(v as YarReadingMode) : v;
          chip.appendChild(el("span", "yar-chip-label", k + ": " + visibleValue));
          chip.appendChild(el("span", "yar-chip-count", "x"));
          chip.onclick = function () {
            state.filters[k] = "";
            if (k === "query") search.value = "";
            writeHash(state);
            draw();
          };
          activeChips.appendChild(chip);
        })(key, value);
      }
      if (any) {
        var clear = el("button", "yar-chip yar-chip-clear", "Clear all");
        clear.setAttribute("type", "button");
        clear.onclick = function () {
          state.filters = emptyFilters();
          search.value = "";
          writeHash(state);
          draw();
        };
        activeChips.appendChild(clear);
      }
      activeChips.style.display = any ? "" : "none";
    }

    function draw(): void {
      drawTopFilters();
      drawTabs();
      drawActiveFilters();

      var drawKey = state.view + "|" + state.sort + "|" + JSON.stringify(state.filters);
      if (drawKey !== lastDrawKey) unitLimit = UNIT_PAGE_SIZE;
      lastDrawKey = drawKey;

      var seriesShown = 0;
      var visible: YarCatalogItem[] = [];
      for (var i = 0; i < data!.items.length; i += 1) {
        if (matches(data!.items[i], state.filters)) visible.push(data!.items[i]);
      }
      visible.sort(compare(state.sort));

      results.innerHTML = "";

      if (state.view === "series") {
        var groups: Record<string, YarCatalogItem[]> = {};
        var order: string[] = [];
        for (var g = 0; g < visible.length; g += 1) {
          var slug = visible[g].seriesSlug;
          if (!groups[slug]) {
            groups[slug] = [];
            order.push(slug);
          }
          groups[slug].push(visible[g]);
        }
        order.sort(function (a, b) {
          return groups[a][0].series.toLowerCase() < groups[b][0].series.toLowerCase() ? -1 : 1;
        });
        seriesShown = order.length;
        var seriesGrid = el("div", "yar-grid");
        for (var o = 0; o < order.length; o += 1) {
          groups[order[o]].sort(function (a, b) {
            return a.sequence - b.sequence;
          });
          seriesGrid.appendChild(seriesCard(order[o], groups[order[o]]));
        }
        results.appendChild(seriesGrid);
      } else {
        var grid = el("div", "yar-grid");
        var unitCount = Math.min(visible.length, unitLimit);
        for (var v = 0; v < unitCount; v += 1) grid.appendChild(unitCard(visible[v]));
        results.appendChild(grid);
        if (unitCount < visible.length) {
          var more = el("button", "yar-load-more", "Show " + Math.min(UNIT_PAGE_SIZE, visible.length - unitCount) + " more");
          more.setAttribute("type", "button");
          more.onclick = function () {
            unitLimit += UNIT_PAGE_SIZE;
            draw();
          };
          results.appendChild(more);
        }
      }

      if (visible.length === 0) {
        var none = el("div", "yar-empty");
        none.appendChild(el("h2", undefined, "Nothing matches"));
        none.appendChild(el("p", undefined, "Adjust the search or clear the active filters."));
        results.appendChild(none);
      } else {
        var shown = state.view === "series" ? seriesShown : Math.min(visible.length, unitLimit);
        var noun = state.view === "series" ? " series" : visible.length === 1 ? " chapter" : " chapters";
        var label = state.view === "all" && shown < visible.length ? shown + " of " + visible.length + noun : shown + noun;
        var summary = el("p", "yar-result-count", label);
        results.insertBefore(summary, results.firstChild);
      }
    }

    var searchTimer = 0;
    search.oninput = function () {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () {
        state.filters.query = search.value.trim();
        writeHash(state);
        draw();
      }, 120);
    };

    sortSelect.onchange = function () {
      state.sort = sortSelect.value as SortKey;
      writeHash(state);
      draw();
    };

    genreSelect.onchange = function () {
      state.filters.genre = genreSelect.value;
      writeHash(state);
      draw();
    };

    window.addEventListener("hashchange", function () {
      var next = readHash();
      state.view = (VIEWS.some(function (v) { return v.key === next.view; }) ? (next.view as ViewKey) : state.view);
      state.sort = (next.sort as SortKey) || state.sort;
      state.filters = next.filters;
      search.value = state.filters.query;
      sortSelect.value = state.sort;
      draw();
    });

    draw();
  }

  (window as any).ComicLibrary = { start: start };
  (window as any).YarLibrary = { start: start };
})();
