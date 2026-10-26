/*
The following file is the chat tab of the side panel
- the conversation, with its quick replies and save offers
- the typing, applying and result lines for the widget
- the message box and the button to start over
*/

import { RefreshCw, Send } from 'lucide-react'
import type { ApplyPhase, ChatEntry } from './types'

type ChatTabProps = {
  transcript: ChatEntry[]
  logRef: React.RefObject<HTMLDivElement | null>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  message: string
  isThinking: boolean
  busy: boolean
  agreed: boolean
  applyPhase: ApplyPhase
  applyResultText: string
  liveUpdate: boolean
  pageUnavailable: boolean
  activeSourceId: string
  activeSourceName: string
  onSend: (text?: string) => void
  onMessageChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  onUpdateSource: (entryId: string) => void
  onSaveAsNew: (entryId: string, suggestedName?: string) => void
  onRetry: () => void
  onRestart: () => void
}

export default function ChatTab(props: ChatTabProps) {
  const { transcript, isThinking, applyPhase, activeSourceId, activeSourceName, pageUnavailable, busy } = props
  // quick replies and save offers wait while the widget is being applied
  const interfaceApplying = applyPhase === 'applying' || applyPhase === 'syncing'

  return (
    <>
      <div className="chat-log" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" ref={props.logRef} aria-live="polite">
        {transcript.map(entry => (
          <div className={`bubble-row ${entry.role}`} key={entry.id}>
            <div className="bubble">
              <p>{entry.text}</p>
            </div>
            {entry.suggestions && entry.suggestions.length > 0 && !interfaceApplying && !isThinking && (
              <div className="suggestion-row">
                {entry.suggestions.map(suggestion => (
                  <button key={suggestion} type="button" onClick={() => props.onSend(suggestion)}>{suggestion}</button>
                ))}
              </div>
            )}
            {entry.offerSave && !interfaceApplying && (
              <div className="suggestion-row">
                {activeSourceId && (
                  <button type="button" onClick={() => props.onUpdateSource(entry.id)}>Update “{activeSourceName}”</button>
                )}
                <button type="button" onClick={() => props.onSaveAsNew(entry.id, entry.suggestedName)}>{activeSourceId ? 'Save as new' : `Save${entry.suggestedName ? ` as “${entry.suggestedName}”` : ' this interface'}`}</button>
              </div>
            )}
          </div>
        ))}
        {isThinking && (
          <div className="bubble-row assistant">
            <div className="bubble typing" aria-label="PageAssist is typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        {interfaceApplying && !isThinking && (
          <div className="bubble-row assistant">
            <div className="bubble progress" role="status">
              {applyPhase === 'syncing' ? 'Detected a change on the page — updating the support' : 'Applying the change to the page'}
              <span className="dots"><span /><span /><span /></span>
            </div>
          </div>
        )}
        {(applyPhase === 'done' || applyPhase === 'failed') && (
          <div className="bubble-row assistant">
            <div className="bubble" role="status">{props.applyResultText}</div>
          </div>
        )}
        {props.liveUpdate && applyPhase === 'idle' && !isThinking && (
          <div className="bubble-row assistant">
            <div className="bubble" role="status">✓ Support updated for a change on the page.</div>
          </div>
        )}
      </div>

      {pageUnavailable && (
        <div className="page-unavailable" role="alert">
          <span>Can’t read this page, so there’s nothing to build support for. Reload the tab and reopen this panel.</span>
          <button type="button" onClick={props.onRetry}>Retry</button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={event => { event.preventDefault(); props.onSend() }}
      >
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <textarea
          id="chat-input"
          ref={props.textareaRef}
          value={props.message}
          onChange={props.onMessageChange}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); props.onSend() } }}
          placeholder={pageUnavailable ? 'Analyze a page to continue…' : busy ? 'Working…' : props.agreed ? 'Respond or refine the support…' : 'Describe what you’re struggling with…'}
          rows={1}
          disabled={busy || pageUnavailable}
        />
        <button type="submit" className="send-button" aria-label="Send message" disabled={!props.message.trim() || busy || pageUnavailable}>
          <Send size={18} />
        </button>
      </form>

      <button type="button" className="end-chat-link" onClick={props.onRestart}>
        <RefreshCw size={13} aria-hidden="true" />
        End chat &amp; start over
      </button>
    </>
  )
}
