# Terminal presentation

The interactive UI is a Harness channel. PI is embedded through its SDK
(`createAgentSession`, `AgentSession.subscribe`); no PI CLI subprocess is used.
UI labels are English and do not prescribe the language of model responses.
The conversation markers are language-independent; there is no "You:"/"Agent:" label.

- **❯**: cyan input, displayed literally rather than interpreted as Markdown.
- **│**: a quiet magenta gutter for assistant output, with normal body text.
- **·**: subdued administrative notes.
- **✓**, **✕**, **■**: success, failure and cancellation, with green, red and yellow accents.
  The shapes remain distinct without color.
- `NO_COLOR` (including an empty value), or `TERM=dumb`, disables application colors.
  The interactive terminal library still needs cursor/control sequences for layout.

## Markdown

Assistant messages, restored history and streamed previews use pi-tui's native
`Markdown` component, not plain Text. Headings, emphasis, inline code, fenced code,
lists, blockquotes, links and tables use terminal-aware layout. Code blocks have
language labels and subtle borders; code text has a distinct color. This does not
provide language-specific syntax-token highlighting yet. Unknown languages and
unfinished streaming fences still display their contents. Terminal control sequences
in incoming text are stripped before rendering. Components cache parsed layout;
activity refreshes do not reparse unchanged history.

## Activity

Tool starts/ends do not add conversation messages. The compact activity area below
conversation output shows a spinner, elapsed time, active tool names, completed/failed
tool counts and queued input. Repeated concurrent tool names have a multiplicity count.
It never displays tool arguments, credentials or hidden reasoning.

The Harness typing lifecycle starts the working indicator before SDK session opening,
and ends it on success, cancellation or failure. Waiting for SDK/model output is
labelled honestly; it does not claim to know whether the provider is thinking internally.
Partial text appears in the scrollable conversation as events arrive. The final answer
replaces that transient preview without first collapsing the preview during delivery.
Activity refreshes every 100 ms; provider response latency and scheduler timing are unchanged.

## Scrolling

The primary conversation scroll view follows new messages and streaming text when at
the bottom. Scrolling up suspends following and preserves the reading position while
new content arrives. A clickable **↓ Jump to latest · Ctrl+End** indicator appears
at the bottom of the conversation viewport while away from the end. Clicking it or
pressing Ctrl+End jumps down and resumes following. Scrolling back down also resumes
following. Dialogs retain their own keyboard handling. Selecting a different session
resets text selection and follows that conversation's end.

The model/reasoning footer stays below the editor/dialogs. Presentation changes do not
replace the Harness queue, state durability or delivery guarantees.
