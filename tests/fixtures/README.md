# Export fixtures

Stand-ins for the zips Anthropic mails out for a Claude data export, written
by hand to match the real thing's shape file for file and field for field —
including the parts that used to break the importer: an assistant turn whose
reply arrives alongside `tool_use` and `tool_result` blocks, and the fenced
"This block is not supported on your current device yet" placeholder that the
export writes into that turn's flat `text`.

Made up rather than copied, because a real export is somebody's chat history
and this directory is in version control.
