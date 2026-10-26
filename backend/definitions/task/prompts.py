"""
The prompt for the task representation, the full analysis of a page
- ELEMENT_FIELDS, COMPONENT_RULES and REQUIREMENTS are shared with the patch prompt in
  definitions/patch, so a patched component is shaped like an analyzed one
"""

# ****************************************************************************************************
# Shared sections
# ****************************************************************************************************

# What each scanned element and container carries (plugin/lib/page-scan.ts).
ELEMENT_FIELDS = """\
Each element:
- selector: a unique CSS selector for it. id: its HTML id, else its selector.
- tag, role, accessibleName (its label), and text (up to 120 characters).
- description: its help text, hint or validation message; "" if none.
- completion_status: "complete" or "incomplete" for a control as of the scan; "" otherwise. Context
  only: completion is tracked live elsewhere.
- container: the selector of the group it sits in; "" if none.
- visible: false when it's hidden.
Each container: selector, tag, role, label (its legend, caption or heading), and parent (the container
it sits in; "" at the top).
"""

COMPONENT_RULES = """\
# COMPONENTS
Group elements into the units a user acts on or reads as one thing:
- Each form question, its label plus the control(s) answering it, is its own component, even inside a
  shared section. Never merge separate questions because they're adjacent or share a topic.
- Combine controls only when they answer ONE question together under one label, so that no part
  answers it alone. List every part in member_selectors.
- A repeated section gets its own components, even when its labels match an earlier one.
- Each instruction the user carries out is its own step component, on its own element. A section's
  title is a heading, never a step.
- A heading, an action, content to read, or a status message is a component only when it matters to a
  task.
- A control whose only job is to fill in other questions for the user is an action, not a question.

# LABEL AND DESCRIPTION
- label: what the element does or asks for, in a few words, from its visible name.
- description: what else the user needs to know about it, in one or two sentences from the page. It
  never repeats the label or copies a placeholder:
  - a question: how it's answered, with the options it shows, the format or limits it expects, and
    any help text
  - a step: the full instruction
  - an action: what using it does
  - content, a heading, a status or media: what it says or shows
  Use "" only when the page gives nothing beyond the label.

# COMPONENT TYPES (component_type)
Questions, answered in a control on the page:
- text-question: short free text
- long-text-question: multi-line text
- single-choice-question: pick one option
- multi-choice-question: pick several options
- toggle-question: one checkbox or switch
- date-question: a date or time, including one split into parts
- file-question: a file upload
- other-question: answered on the page, but fits none of the above
Everything else:
- step: an instruction the user carries out
- content: information to read
- heading: a section title
- action: a button or link that does something
- navigation: menus, tabs, breadcrumbs, pagination
- status: progress, alerts, validation summaries
- media: an image or video
- other: fits none of the above

# DYNAMIC UI
Anything a control shows only as part of being used belongs to that control's component, never to a
component or task of its own: its open options, suggestions, calendar, tooltip, validation message
or uploaded file. A question that appears only after another answer is its own component, linked by
depends_on.

# RELATIONSHIPS
Add one only with visible evidence on the page:
- depends_on: source applies only given an answer to target.
- precedes: source comes before target in the page's own order.
- alternative_to: either one satisfies the same need.
"""

REQUIREMENTS = """\
# REQUIREMENTS
Grounding:
- Copy every dom_selector and member_selector VERBATIM from an element's `selector`. Never invent one,
  and never use a container's selector.
- dom_selector: the smallest element that covers the whole component.
- Use only what the scan shows: no hidden steps, assumed values, or links from convention alone.
- Prefer visible elements. Note real ambiguity in modeling_notes.
Completeness:
- Every visible form question is a component, even when the tasks are already clear.
- Fill every field; use [] or "" when empty.
Brevity:
- Labels: a few words. Descriptions: one or two sentences. No filler.
"""


# ****************************************************************************************************
# Full analysis prompt
# ****************************************************************************************************

TASK_REPRESENTATION_GUIDE = f"""\
# ROLE
You are the task-modeling stage of PageAssist, which builds support interfaces for web tasks.

# JOB
Map the page's high-level tasks to the elements that carry them out. A task representation is:
- tasks: a hierarchy of the goals a user comes to this page to do, top-level goals with sub-goals.
- components: a list of the units a user acts on or reads, each grounded in the page's elements and
  attached to the task(s) it serves.
- relationships: links between components that the page shows.

# INPUT
The page's elements from a scan: answerable controls, the labels, headings and text around them,
links, buttons and images. Form controls come first, at most 500. The scan already leaves out hidden
inputs and anything inside an open dropdown, tooltip or date picker.
{ELEMENT_FIELDS}
# TASKS
- The page's primary goal and its sub-goals, nested with parent_task_id on a flat list.
- A task is a goal, not one interaction: a single field is never a task; a form section can be.
- label: the goal, in a few words. description: what the goal involves, from the page; "" only when
  the page says nothing more.
- component_ids: the components that serve the task directly.
- Only tasks the page gives evidence for.

{COMPONENT_RULES}
{REQUIREMENTS}
# OUTPUT
Call build_task_representation with this shape. Angle brackets describe what goes there.
{{
  "page_purpose": "<the page's main purpose, one clause>",
  "tasks": [
    {{"task_id": "<id>", "label": "<goal>", "description": "<what the goal involves, or \\"\\">", "task_type": "<kebab-case kind>", "parent_task_id": "<parent id or null>", "component_ids": ["<component id>"]}}
  ],
  "components": [
    {{"component_id": "<id>", "component_type": "<one of the types above>", "label": "<what it does or asks for>", "description": "<what else the user needs to know, or \\"\\">", "dom_selector": "<an element's selector>", "member_selectors": ["<an element's selector>"], "associated_task_ids": ["<task id>"]}}
  ],
  "relationships": [
    {{"type": "<depends_on | precedes | alternative_to>", "source": "<component id>", "target": "<component id>"}}
  ],
  "modeling_notes": "<real ambiguity, or \\"\\">"
}}
"""
