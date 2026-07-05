const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const HEX_SEGMENT = /^[0-9a-f]{8,}$/i;
const MAX_SEGMENT_LENGTH = 32;

export interface SplitPath {
  pathname: string;
  query: string;
}

export function splitPathQuery(path: string): SplitPath {
  const questionMark = path.indexOf("?");
  if (questionMark === -1) {
    return { pathname: path, query: "" };
  }
  return { pathname: path.slice(0, questionMark), query: path.slice(questionMark + 1) };
}

/**
 * Collapses dynamic URL segments (ids, uuids, hashes) into ":id" so pages
 * group naturally: /users/123/profile -> /users/:id/profile.
 */
export function pathGroup(pathname: string): string {
  if (pathname === "" || pathname === "/") {
    return "/";
  }

  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const segments = trimmed.split("/").map((segment) => {
    if (segment === "") {
      return segment;
    }
    if (
      NUMERIC_SEGMENT.test(segment) ||
      UUID_SEGMENT.test(segment) ||
      HEX_SEGMENT.test(segment) ||
      segment.length > MAX_SEGMENT_LENGTH
    ) {
      return ":id";
    }
    return segment;
  });

  const grouped = segments.join("/");
  return grouped === "" ? "/" : grouped;
}
