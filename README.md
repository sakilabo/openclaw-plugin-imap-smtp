# IMAP SMTP for OpenClaw

OpenClaw plugin that gives agents tools to read mail through IMAP and send mail through SMTP. The plugin works directly with the mail servers, so agents share the mailboxes, flags, and drafts with any other mail client of the same accounts.

## Tools

| Tool | Description |
| --- | --- |
| `imap_get_status` | Gets the mail status: every account and mailbox with its counts and unread messages. |
| `imap_list_messages` | Lists the messages of a mailbox. |
| `imap_get_message` | Gets a message with its body, and optionally the messages of its conversation. |
| `imap_get_messages` | Gets messages with their bodies. |
| `imap_get_attachment_text` | Gets the content of an attachment as text. |
| `imap_get_attachment_image` | Gets the content of an attachment as an image. |
| `imap_save_attachment_to_openclaw` | Saves an attachment as a file in OpenClaw and returns its reference. |
| `imap_save_draft` | Saves a message as a draft in the drafts mailbox, or replaces a draft with an edited one. |
| `smtp_send` | Sends a draft saved in the drafts mailbox. |
| `imap_set_flags` | Sets or clears flags of messages, such as `seen` to mark them as read or unread and `flagged` to star them. |
| `imap_move_messages` | Moves messages to another mailbox. |
| `imap_delete_messages` | Deletes messages. |

Mailboxes are identified by `mailboxId` (`<accountMailAddress>:<path>`) and messages by `messageId` (`<accountMailAddress>:<UIDVALIDITY>:<UID>:<path>`). A message moved to another mailbox gets a new `messageId`. Dates are ISO 8601. Reading a message does not mark it as read.

The plugin finds the drafts, sent, and trash mailboxes by their special use, which the server or the mailbox name gives.

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
