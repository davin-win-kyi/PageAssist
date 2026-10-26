/*
The following file has the smaller helpers for the side panel
- site ids, and checking if a page was analyzed before it finished loading
- checking a tree for content, and the colors and names of saved interfaces
*/

import type { PageElement } from '../../lib/extension'
import type { InterfaceNode, PageChange, TaskNode } from './types'

/*************************************************************************************************
Pages
*************************************************************************************************/

// A page's id: its host, path and query, with slashes swapped for "~"
export function siteIdFor(pageUrl?: string): string {
  if (!pageUrl) return ''
  try {
    const url = new URL(pageUrl)
    return `${url.hostname}${url.pathname}${url.search}`.replace(/\/$/, '').replace(/\//g, '~')
  } catch {
    return ''
  }
}

const INPUTISH_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton'])
export const countInputish = (elements?: PageElement[]) =>
  (elements || []).filter(e => ['input', 'textarea', 'select'].includes(e.tag) || (e.role && INPUTISH_ROLES.has(e.role))).length

/*
Whether an analysis likely ran before the page finished loading: few components while the page
shows several controls or same-origin frames, or an almost empty shell page
*/
export type SiteScan = { task?: TaskNode; inputish: number; sameOriginFrames: number; elementCount: number }
export function looksSparse(site: SiteScan): boolean {
  if (!site.task) return false
  const components = site.task.components?.length ?? 0
  const looksLikeShell = components === 0 && site.elementCount < 15
  return components < 3 && (site.inputish >= 2 || site.sameOriginFrames > 0 || looksLikeShell)
}

// Two page changes as one, for a change that arrives while another is being applied
export const mergeChanges = (a: PageChange, b: PageChange): PageChange => ({
  fieldsAdded: a.fieldsAdded + b.fieldsAdded,
  added: [...a.added, ...b.added],
  removed: [...new Set([...a.removed, ...b.removed])],
  revealed: [...a.revealed, ...b.revealed],
  containers: [...a.containers, ...b.containers],
})

/*************************************************************************************************
Interface representations
*************************************************************************************************/

/*
Whether a tree holds an actual concept, so an empty widget is never shown. Mirrors
tree_has_content in the backend.
*/
export function treeHasContent(tree?: InterfaceNode): boolean {
  if (!tree) return false
  const prefs = tree.preferences
  const prefCount = Array.isArray(prefs) ? prefs.length : Object.keys(prefs || {}).length
  return !!tree.component?.trim() || !!tree.description?.trim() || prefCount > 0 || (tree.children?.length ?? 0) > 0
}

/*
An emoji and hue per saved entry, from its id so renaming doesn't change them
*/
const SAVED_EMOJIS = ['📋', '🎯', '🧭', '📝', '🗂️', '🔖', '⭐', '🧩', '📌', '🧾', '📊', '🏷️', '🪧', '🧠', '🕹️', '🎛️', '📎', '🗒️', '🚦', '🧵']
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
export function savedAccent(id: string): { emoji: string; hue: number } {
  const h = hashString(id)
  return { emoji: SAVED_EMOJIS[h % SAVED_EMOJIS.length] ?? '📋', hue: h % 360 }
}

/*
A readable default save name: the model's suggestion, else the description, else the component
*/
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57).trimEnd()}…` : s)
export function defaultSaveName(suggested: string | undefined, description: string, component: string, savedCount: number): string {
  return (suggested || '').trim()
    || clip(description.trim())
    || (component ? `${titleCase(component)} strategy` : '')
    || `Interface ${savedCount + 1}`
}
