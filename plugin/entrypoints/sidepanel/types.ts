/*
The following file has the schemas the side panel shares with the backend
- the interface representation, widget, task representation and chat
- the panel's own state, like a page change waiting to be applied
*/

import type { WidgetItem } from '../../lib/widget-items'
import type { PageContainer, PageElement } from '../../lib/extension'

/*************************************************************************************************
Interface representation
*************************************************************************************************/

export type InterfaceNode = {
  component: string
  description?: string
  style: Record<string, string>
  preferences: Record<string, string> | string[]
  selector?: string
  children: InterfaceNode[]
}
export type InterfaceRepresentationResponse = { tree: InterfaceNode; agreed: boolean }
export type SavedInterface = { id: string; name: string }

/*************************************************************************************************
Widget: the interface representation applied to one page's task representation
*************************************************************************************************/

export type WidgetState = { items?: WidgetItem[]; [key: string]: unknown }
// `degraded` marks the warning widget shown when generation failed. `record_id` is where it's filed in
// the study records, for its screenshots.
export type Widget = { style: Record<string, string>; code: string; state: WidgetState; degraded?: boolean; record_id?: string | null }

/*************************************************************************************************
Task representation: the page's tasks hierarchy and the components within it
*************************************************************************************************/

export type TaskItem = {
  task_id: string
  label: string
  description?: string
  task_type: string
  parent_task_id?: string | null
  component_ids?: string[]
}
export type TaskComponent = {
  component_id: string
  component_type?: string
  label?: string
  description?: string
  dom_selector: string
  member_selectors?: string[]
  associated_task_ids?: string[]
}
export type TaskRelationship = { type: 'depends_on' | 'precedes' | 'alternative_to'; source: string; target: string }
export type TaskNode = {
  page_purpose?: string
  tasks?: TaskItem[]
  components?: TaskComponent[]
  relationships?: TaskRelationship[]
  modeling_notes?: string
}

/*************************************************************************************************
Chat
*************************************************************************************************/

export type ChatEntry = { id: string; role: 'user' | 'assistant'; text: string; suggestions?: string[]; offerSave?: boolean; suggestedName?: string }
export type ChatResponse = {
  reply: string
  suggestions: string[]
  interface_representation: InterfaceNode
  agreed: boolean
  offer_save?: boolean
  suggested_name?: string
}

/*************************************************************************************************
Panel state
*************************************************************************************************/

/*
Where applying the widget is: 'applying' after the user agreed or picked a saved interface,
'syncing' while a page change is applied, then a brief 'done' or 'failed' line
*/
export type ApplyPhase = 'idle' | 'applying' | 'syncing' | 'done' | 'failed'

// A page change waiting to be applied: the questions added, removed and revealed
export type PageChange = { fieldsAdded: number; added: PageElement[]; removed: string[]; revealed: PageElement[][]; containers: PageContainer[] }

// One reading of the active page, with its task representation when the analysis worked
export type Site = { id: string; hasPage: boolean; changed: boolean; task?: TaskNode; error?: string; inputish: number; sameOriginFrames: number; elementCount: number }
