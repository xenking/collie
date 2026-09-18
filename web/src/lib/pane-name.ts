// Custom row naming keeps the pane's location and its own work name separate. The dashboard renders
// the project/tab breadcrumb, while the pane's chosen or live title remains available as its second line.
import { baseName, shortCwd } from "./format";
import { paneDisplayName, type AgentView, type TabView } from "./types";

/** A two-line label used by the space view. */
export interface PaneTitle {
  primary: string;
  secondary: string | null;
}

/** A herd row's project, tab, and pane-specific second line, kept as separate DOM runs. */
export interface PaneParts {
  project: string;
  tab: string | null;
  secondary: string | null;
}

export const TITLE_SEP = " · ";
export const PLACE_SEP = " › ";

/** The name supplied by the pane itself, including a named one-pane tab. */
export function paneName(pane: AgentView): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.sessionName) return pane.sessionName;
  const tab = soleTabName(pane);
  if (tab !== null) return tab;
  if (pane.terminalTitle && pane.terminalTitleStale !== true) return pane.terminalTitle;
  return pane.kind === "shell" ? "shell" : pane.agent;
}

/** A tab name only when the bridge established that the operator chose it. */
export function soleTabName(pane: { soleTabName?: string | undefined }): string | null {
  const name = pane.soleTabName?.trim();
  return name ? name : null;
}

/** Positional labels are still labels in the UI: this flag only controls their muted presentation. */
export function isUnnamedTab(label: string | null | undefined): boolean {
  const trimmed = label?.trim();
  if (!trimmed) return true;
  return /^\d+$/u.test(trimmed) || /^Tab #\d+$/u.test(trimmed);
}

export interface TabTitle {
  text: string;
  positional: boolean;
}

/** Return a visible title for every non-empty tab label, including numeric/default labels. */
export function tabTitle(raw: string | null | undefined): TabTitle | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return { text: trimmed, positional: isUnnamedTab(trimmed) };
}

/** Join a workspace and tab without silently dropping a numeric tab label. */
export function placeOf(space: string, tabLabel: string | null | undefined): string {
  const tab = tabTitle(tabLabel);
  return tab === null ? space : `${space}${PLACE_SEP}${tab.text}`;
}

/** True when a pane has a name supplied by an operator or a live process. */
export function paneHasOwnName(pane: AgentView): boolean {
  return Boolean(
    pane.paneLabel ||
      pane.sessionName ||
      soleTabName(pane) !== null ||
      (pane.terminalTitle && pane.terminalTitleStale !== true),
  );
}

/** A one-pane tab cell follows the pane's name; groups retain their tab label/position. */
export function tabCellTitle(raw: string | null | undefined, panes: readonly AgentView[]): TabTitle | null {
  if (panes.length === 1 && paneHasOwnName(panes[0]!)) {
    return { text: paneName(panes[0]!), positional: false };
  }
  return tabTitle(raw);
}

export interface PlaceParts {
  space: string;
  tab: TabTitle | null;
}

/** Return the place as separate runs so a narrow row truncates the project before the tab. */
export function panePlaceParts(pane: AgentView, tabs?: readonly TabView[]): PlaceParts {
  const known = tabs?.find((tv) => tv.tabId === pane.tabId && (tv.host === undefined || tv.host === pane.host));
  const raw = known?.label ?? pane.tabLabel;
  return {
    space: pane.workspaceLabel || pane.workspaceId,
    tab: tabTitle(raw),
  };
}

export function panePlace(pane: AgentView, tabs?: readonly TabView[]): string {
  const { space, tab } = panePlaceParts(pane, tabs);
  return tab === null ? space : `${space}${PLACE_SEP}${tab.text}`;
}

/** A shortened cwd for a row whose space and tab are already headings. */
export function paneCwdLine(pane: AgentView): string | null {
  return pane.cwd ? shortCwd(pane.cwd) : null;
}

function informativeCwd(cwd: string, project: string): string | null {
  if (!cwd) return null;
  if (baseName(cwd).toLowerCase() === project.trim().toLowerCase()) return null;
  return shortCwd(cwd);
}

/** The herd list's own-name/cwd rule; unlike the header gate it compares against the project. */
export function paneParts(pane: AgentView): PaneParts {
  const project = pane.workspaceLabel || pane.workspaceId;
  const stale = pane.terminalTitle !== undefined && pane.terminalTitleStale === true;
  const own = pane.paneLabel || pane.sessionName || (stale ? "" : pane.terminalTitle);
  const secondary = own || informativeCwd(pane.cwd, project) || (stale ? pane.terminalTitle : null);
  return {
    project,
    tab: pane.tabLabel ?? null,
    secondary: secondary ?? null,
  };
}

/** The space-view row keeps the custom pane-display precedence and puts cwd beneath it. */
export function paneTitleInTab(pane: AgentView): PaneTitle {
  return { primary: paneDisplayName(pane), secondary: pane.cwd ? shortCwd(pane.cwd) : null };
}

/** The pane header's cwd gate: keep only path segments not already present in its rendered name. */
export function cwdBeyondName(cwd: string, name: string): string | null {
  if (!cwd) return null;
  const short = shortCwd(cwd);
  const shown = new Set(name.toLowerCase().split(/[^a-z0-9._-]+/u).filter(Boolean));
  const segments = short.split("/").filter((segment) => segment !== "" && segment !== "~" && segment !== "…");
  if (segments.length === 0 || segments.every((segment) => shown.has(segment.toLowerCase()))) return null;
  return short;
}
