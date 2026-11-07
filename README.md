# IMAP SMTP for OpenClaw

OpenClaw plugin that lets an agent use its own mailbox. The agent checks new mail, reads messages and attachments, writes drafts, sends them, and files or deletes messages, working directly with the IMAP and SMTP servers of its account. The mailboxes, flags, and drafts stay on the mail server, so people and other mail clients share them with the agent.

## Tools

Mailboxes are identified by `mailboxId` (`<accountMailAddress>:<path>`) and messages by `messageId` (`<accountMailAddress>:<UIDVALIDITY>:<UID>:<path>`). A message moved to another mailbox gets a new `messageId`. Dates are ISO 8601. Reading a message does not mark it as read.

The plugin finds the drafts, sent, and trash mailboxes by their special use, which the server or the mailbox name gives. The mailboxes named `mailfilter` and `alias`, which Courier-IMAP lists for the files `.mailfilter` and `.alias` of the Maildir, are left out of the mailboxes of `imap_get_status` and `imap_search_messages` when they cannot be selected.

Messages in lists have `messageId`, `mailboxId`, `uid`, `subject`, `date` (sent), `receivedDate`, the addresses, `flags`, `keywords`, `internetMessageId`, `inReplyTo`, `references`, `imipMessage`, `size`, `previewText`, and `attachments`. `previewText` is made from the first bytes of the `text/plain` part, or of the `text/html` part of a message without `text/plain`; a character, an encoded unit, or an HTML tag cut at the end is left out.

Lists of messages from `imap_get_status` and `imap_list_messages` are sorted by `sortKey` in `sortDirection`, which the result has. `sortKey` is `date` (the Date header, or `receivedDate` without one) on a server with the SORT extension, or `uid` (the order the messages were added to the mailbox) on a server without it, or when the SORT command cannot be sent.

### `imap_get_status`

Gets every account with the capabilities of its IMAP server, and every mailbox with its message counts and up to `maxUnreadMessagesPerMailbox` unread messages, newest first.

| Parameter | Value |
| --- | --- |
| `maxUnreadMessagesPerMailbox` | 1 to 100, default 10 |
| `prereadPlainBytes`, `prereadHtmlBytes` | Bytes read to make `previewText`. Defaults to the plugin config. |

### `imap_list_messages`

Lists the messages of a mailbox.

| Parameter | Value |
| --- | --- |
| `mailboxId` | Required |
| `limit` | 1 to 100, default 20 |
| `unreadOnly` | Lists only unread messages. Default false. |
| `before`, `after` | Lists only messages before or after the bound: a `uid` (an integer), or a date and time with a time zone (a string) compared with `date`, or `receivedDate` without one. A message at exactly the bound is not included. |
| `sortDirection` | `descending` (newest first) or `ascending` (oldest first). Defaults to `ascending` when only `after` is given, and to `descending` otherwise. |
| `prereadPlainBytes`, `prereadHtmlBytes` | Bytes read to make `previewText`. Defaults to the plugin config. |

### `imap_search_messages`

Searches messages in mailboxes with `UID SEARCH`, or with `UID SORT` when `sortKeys` is given. The result has `results` with an entry for each mailbox: `mailboxId` and its `messages` in the order the server returned them, or `error` with the response of the server when it rejected the search. All parameters are optional.

| Parameter | Value |
| --- | --- |
| `mailboxIds` | Mailboxes to search. Defaults to every mailbox of every account except the drafts and trash mailboxes. |
| `predicate` | A string is searched with `TEXT`, in the header or the body; strings in an array all must be found. An object holds IMAP SEARCH keys that all must match: each property name is a search key with its arguments except the last, and the value is the last argument, a string or a number. `true` sends the key alone, `false` sends it with `NOT`, and an array sends the key once for each value, such as `{"SUBJECT": "invoice", "HEADER X-Mailer": "Foo", "SEEN": false, "SINCE": "1-Oct-2026"}`. |
| `unread` | `true` searches only unread messages (`UNSEEN`), and `false` only read messages (`SEEN`). |
| `flagged` | `true` searches only flagged messages (`FLAGGED`), and `false` only messages without the flag (`UNFLAGGED`). |
| `sortKeys` | IMAP SORT criteria, such as `["REVERSE DATE", "SUBJECT"]`. Without `sortKeys`, the messages are not sorted. |
| `limit` | Number of messages per mailbox, sent as `RETURN (PARTIAL 1:<limit>)` |
| `prereadPlainBytes`, `prereadHtmlBytes` | Bytes read to make `previewText`. Defaults to the plugin config. |

`CHARSET UTF-8` is sent when the search has non-ASCII text.

### `imap_get_message`

Gets a message with its body (`bodyText` and `bodyHtml`).

| Parameter | Value |
| --- | --- |
| `messageId` | Required |
| `includeThread` | Also lists the messages of the same conversation in the message's mailbox, INBOX, and the sent mailbox. Default false. |
| `prereadPlainBytes`, `prereadHtmlBytes` | Bytes read to make `previewText` of the messages of the conversation. Defaults to the plugin config. |

### `imap_get_messages`

Gets messages with their bodies, as `imap_get_message` does without conversations.

| Parameter | Value |
| --- | --- |
| `messageIds` | Required |

### `imap_get_attachment_text`, `imap_get_attachment_image`

Gets the content of an attachment as text (converted to UTF-8 from the charset of a text part) or as an image.

| Parameter | Value |
| --- | --- |
| `messageId`, `attachmentId` | Required |

### `imap_save_attachment_to_openclaw`

Saves an attachment of up to 5 MiB as a file in OpenClaw and returns its reference (`media://inbound/...`).

| Parameter | Value |
| --- | --- |
| `messageId`, `attachmentId` | Required |

### `imap_save_draft`

Saves a message as a draft in the drafts mailbox of the account. To edit a draft, saves the edited message and then deletes the old draft permanently.

| Parameter | Value |
| --- | --- |
| `accountMailAddress`, `fromAddress`, `subject`, `body` | Required. `fromAddress` must be one of the account's `identities`. |
| `isHtml` | `body` is HTML. Default false. |
| `to`, `cc`, `bcc` | Recipients (`email`, `label`) |
| `draftMessageIdToReplace` | `messageId` of the draft that the new draft replaces |

### `smtp_send`

Sends a draft through SMTP. A copy is saved in the sent mailbox, and the draft is deleted permanently, only after the message is sent. The Bcc header is not sent to the recipients and is kept in the copy.

| Parameter | Value |
| --- | --- |
| `imapDraftMessageId` | Required. `messageId` of the draft in the IMAP drafts mailbox. |

### `imap_set_flags`

Sets or clears flags of messages.

| Parameter | Value |
| --- | --- |
| `messageIds` | Required |
| `flags` | Required. Flag names with true (set) or false (clear): `seen`, `flagged`, `answered`, `deleted`, `draft`, or IMAP keywords such as `$Junk`. |

### `imap_move_messages`

Moves messages to another mailbox of the same account, and returns their `newMessageId`.

| Parameter | Value |
| --- | --- |
| `messageIds`, `destinationMailboxId` | Required |

### `imap_delete_messages`

Moves messages to the trash mailbox, and returns their `newMessageId`. Messages already in the trash mailbox are deleted permanently.

| Parameter | Value |
| --- | --- |
| `messageIds` | Required |

`imap_set_flags`, `imap_move_messages`, and `imap_delete_messages` return `results` with `messageId` and, when the message failed, `error` for each message.

## Configuration

Set the accounts in `plugins.entries.imap-smtp.config.accounts` of `openclaw.json`, keyed by the email address of each mailbox. The email address is the `accountMailAddress`. [`openclaw.json.sample`](openclaw.json.sample) lists the items.

| Item | Value |
| --- | --- |
| `prereadPlainBytes`, `prereadHtmlBytes` | Default number of bytes read from the start of the `text/plain` part, or of the `text/html` part of a message without `text/plain`, to make `previewText` (1024 and 2048 when not set). The tools' parameters of the same names override them. A character, an encoded unit, or an HTML tag cut at the end is left out. |
| `imap`, `smtp` | `host`, `port`, `security`, `user`, and `password` of each server |
| `security` | `ssl` for a TLS connection, or `starttls` to upgrade the connection with STARTTLS. The connection fails when the server does not offer STARTTLS. Unencrypted connections are not supported. |
| `identities` | Sender addresses (`address`, `name`) that drafts and sent messages may use |

## Build and install

```sh
npm install
npm run build
npm pack
openclaw plugins install openclaw-plugin-imap-smtp-<version>.tgz --force
```

## License

[UPL-1.0](LICENSE)
