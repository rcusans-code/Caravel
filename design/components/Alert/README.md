# Alert
An inline banner for a state that needs attention: margin call, demo mode, or a blocked action.

**Provide:** a tone (`cv-alert--margin`, `--info`, `--error`), a title naming the object ("Margin call on Repo #016"), one sentence saying what happened and what to do with exact numbers, and at most one action button. Use `role="alert"` for margin calls and errors, `role="status"` for info.

The glyph in `.cv-alert__icon` repeats the meaning in shape (!, i, ×), so the tone never depends on color alone.
