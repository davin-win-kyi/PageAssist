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
- EXISTING components: a summary of what's already modelled: each one's component_id,
  component_type, label and dom_selector.
- NEW elements: what just appeared, with the same fields as a full scan.
- CONTAINERS: the groups the new elements sit in.
{ELEMENT_FIELDS}
# RULES
- Shape new components exactly like the existing ones, following the rules below.
- Relationships may point to existing components by component_id: a question revealed by another
  answer depends_on that question.
- If the new elements are decorative or part of an existing control's dynamic UI, return no
  components.

{COMPONENT_RULES}
{REQUIREMENTS}"""
