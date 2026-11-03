# Changelog

## 0.2.0 — 2026-11-03

### Added

- `imap_search_messages`, a tool that searches mailboxes with IMAP SEARCH, or with IMAP SORT when sort keys are given, and returns the messages or the response of the server for each mailbox.
- `capabilities` of the IMAP server for each account in `imap_get_status`.
- `uid` of messages.
- `before`, `after`, and `sortDirection` of `imap_list_messages`, to list messages in a range of UIDs or dates in either direction. Dates are compared with the Date header, or the arrival time without one.
- `prereadPlainBytes` and `prereadHtmlBytes` in the tools and the plugin config, to set the bytes read to make `previewText`.

### Changed

- Name the tools `imap_` or `smtp_` by their operation instead of `imap_smtp_`, and take the draft of `smtp_send` as `imapDraftMessageId` instead of `draftMessageId`.
- Key accounts by the email address of the mailbox, named `accountMailAddress` instead of `accountId`.
- List messages newest first by date with SORT on a server that has it, and in the order they were added to the mailbox without it. The result gives the order in `sortKey` and `sortDirection`.
- Make `previewText` from 1024 bytes of `text/plain` or 2048 bytes of `text/html`, leaving out a character, an encoded unit, or an HTML tag cut at the end, instead of cutting it at 200 characters.
- Search with the public search of imapflow, sorted by UID, when the SORT or SEARCH command fails.

### Removed

- `sentBefore` of `imap_list_messages`, replaced by `before`.

## 0.1.0 — 2026-11-02

Initial release of IMAP SMTP, giving OpenClaw agents tools that work directly with IMAP and SMTP servers.

### Added

- Tools to get the status of every account and mailbox, list messages, and read messages, conversations, and attachments.
- Tools to save and replace drafts in the drafts mailbox and send them through SMTP.
- Tools to set flags, move, and delete multiple messages in one call.
