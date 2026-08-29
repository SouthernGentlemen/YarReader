/* Shared ambient declarations for the portable viewer scripts. */

type YarReadingMode = "ltr" | "rtl" | "scroll";
type YarReadingDirection = "ltr" | "rtl";

interface YarCatalogItem {
  path: string;
  seriesSlug: string;
  series: string;
  title?: string;
  volume?: number | string;
  chapter?: number | string;
  issue?: number | string;
  sequence: number;
  year?: number;
  authors?: string[];
  artists?: string[];
  publisher?: string;
  tags?: string[];
  genres?: string[];
  summary?: string;
  language?: string;
  readingMode: YarReadingMode;
  direction: YarReadingDirection;
  pageCount: number;
  pageExtension: string;
  /** Relative directory containing numbered page images. */
  pageRoot?: string;
  /** Width of generated numeric page names. */
  pageDigits?: number;
  /** Intrinsic page dimensions, used to reserve stable space in scroll mode. */
  pageSizes?: number[][];
  cover?: string;
  thumbnail?: string;
  seriesCover?: string;
  added: number;
  sortTitle: string;
}

interface YarCatalog {
  schemaVersion: number;
  generator: string;
  itemCount: number;
  items: YarCatalogItem[];
}

interface YarReaderStartOptions {
  /** Export-root-relative path of this unit, e.g. "library/one-piece/1000/". */
  path?: string;
  /** Relative prefix back to the export root, e.g. "../../../". */
  root?: string;
  mount?: string;
}

interface YarLibraryStartOptions {
  root?: string;
  mount?: string;
  /** Library name shown as the title, e.g. "library-001". */
  label?: string;
}

interface Window {
  COMIC_LIBRARY: YarCatalog;
  YAR_LIBRARY: YarCatalog;
  ComicReader: { start(options?: YarReaderStartOptions): void };
  ComicLibrary: { start(options?: YarLibraryStartOptions): void };
}
