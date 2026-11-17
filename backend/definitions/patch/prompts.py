"""
The prompt for the page-change patch
- models only the elements that just appeared, the same way the full analysis would, using the
  shared sections of definitions/task
"""

from definitions.task.prompts import ELEMENT_FIELDS, COMPONENT_RULES, REQUIREMENTS

PATCH_TASK_REPRESENTATION_GUIDE = f"""\
# ROLE
You update an EXISTING task representation of a webpage. A few elements just appeared on it. Return
ONLY the new components for them, plus any relationships from them. Never restate existing
components or tasks.

# INPUT
- PAGE PURPOSE: what the page is for.
- TASKS: the page's tasks, each with its task_id, label, description and parent_task_id.
- EXISTING components: a summary of what's already modelled: each one's component_id,
  component_type, label, dom_selector and associated_task_ids.
- NEW elements: what just appeared, with the same fields as a full scan.
- CONTAINERS: the groups the new elements sit in.
{ELEMENT_FIELDS}
# RULES
- Shape new components exactly like the existing ones, following the rules below.
- Relationships may point to existing components by component_id: a question revealed by another
  answer depends_on that question.
- If the new elements are decorative or part of an existing control's dynamic UI, return no
  components.
- File each new component under the TASKS it serves, by task_id in associated_task_ids. A question
  revealed by another answer serves that question's tasks. A component serves a task only when doing
  that task needs it; being on the same page is not enough. Use [] when it serves none of them, and
  never invent a task_id.

{COMPONENT_RULES}
{REQUIREMENTS}"""
