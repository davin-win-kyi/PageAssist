/*
The following file is the saved tab of the side panel
- saving the current interface representation under a name
- searching, applying and deleting the saved ones
*/

import { savedAccent } from './helpers'
import type { SavedInterface } from './types'

type SavedTabProps = {
  saved: SavedInterface[]
  search: string
  onSearch: (value: string) => void
  nameDraft: string
  onNameDraft: (value: string) => void
  saving: boolean
  onSave: (event: React.FormEvent) => void
  onActivate: (item: SavedInterface) => void
  onDelete: (item: SavedInterface) => void
}

export default function SavedTab(props: SavedTabProps) {
  const { saved, search } = props
  const query = search.trim().toLowerCase()
  const filtered = query ? saved.filter(item => item.name.toLowerCase().includes(query)) : saved

  return (
    <div className="saved-panel" id="panel-saved" role="tabpanel" aria-labelledby="tab-saved">
      <form className="save-current-form" onSubmit={props.onSave}>
        <label htmlFor="save-name" className="sr-only">Name the task interface</label>
        <input
          id="save-name"
          value={props.nameDraft}
          onChange={event => props.onNameDraft(event.target.value)}
          placeholder="Name the task interface…"
        />
        <button type="submit" disabled={!props.nameDraft.trim() || props.saving}>Save</button>
      </form>

      {saved.length > 5 && (
        <input
          className="saved-search"
          type="search"
          value={search}
          onChange={event => props.onSearch(event.target.value)}
          placeholder="Search saved…"
          aria-label="Search saved interfaces"
        />
      )}

      {saved.length === 0 ? (
        <p className="saved-empty">No task interfaces made yet. Shape one in Chat, then save it here to reuse on other sites.</p>
      ) : filtered.length === 0 ? (
        <p className="saved-empty">No saved interface matches “{search}”.</p>
      ) : (
        <ul className="saved-list">
          {filtered.map(item => {
            const accent = savedAccent(item.id)
            return (
              <li key={item.id} className="saved-row" style={{ '--saved-hue': accent.hue } as React.CSSProperties}>
                <button type="button" className="saved-item" onClick={() => props.onActivate(item)}>
                  <span className="saved-item-emoji" aria-hidden="true">{accent.emoji}</span>
                  <span className="saved-item-name">{item.name}</span>
                </button>
                <button type="button" className="saved-item-delete" aria-label={`Delete ${item.name}`} title="Delete" onClick={() => props.onDelete(item)}>
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
