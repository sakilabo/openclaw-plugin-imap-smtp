import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type Params = Record<string, unknown>;

type ServerConfig = {
  host: string;
  port: number;
  security: "ssl" | "starttls";
  user: string;
  password: string;
};

type Identity = {
  address: string;
  name?: string;
};

type AccountConfig = {
  imap: ServerConfig;
  smtp: ServerConfig;
  identities: Identity[];
};

type SpecialUse = "\\Drafts" | "\\Sent" | "\\Trash" | "\\Junk";

type Address = {
  name?: string;
  email: string;
};

type MessageRef = {
  accountId: string;
  path: string;
  uidValidity: string;
  uid: number;
};

type AttachmentInfo = {
  attachmentId: string;
  fileName?: string;
  mime: string;
  size?: number;
  disposition?: string;
  contentId?: string;
};

const MAX_MESSAGES_PER_MAILBOX = 100;
const PREVIEW_BYTES = 2048;
const PREVIEW_LENGTH = 200;

function readAccounts(api: OpenClawPluginApi): Map<string, AccountConfig> {
  const raw = api.pluginConfig?.accounts;
  if (raw === null || typeof raw !== "object" || Object.keys(raw).length === 0) {
    throw new Error("imap-smtp is not configured. Set accounts in plugins.entries.imap-smtp.config.");
  }
  return new Map(Object.entries(raw as Record<string, AccountConfig>));
}

function account(accounts: Map<string, AccountConfig>, accountId: string): AccountConfig {
  const config = accounts.get(accountId);
  if (config === undefined) throw new Error(`Account ${accountId} is not configured.`);
  return config;
}

function serverSecurity(server: ServerConfig): { secure: boolean } {
  if (server.security !== "ssl" && server.security !== "starttls") {
    throw new Error(`security of ${server.host} must be "ssl" or "starttls"; unencrypted connections are not allowed.`);
  }
  return { secure: server.security === "ssl" };
}

async function connect(config: AccountConfig): Promise<ImapFlow> {
  const { secure } = serverSecurity(config.imap);
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  });
  await client.connect();
  return client;
}

async function withImap<T>(config: AccountConfig, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connect(config);
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function smtpTransport(config: AccountConfig) {
  const { secure } = serverSecurity(config.smtp);
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure,
    requireTLS: !secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// IDs: mailboxId is "<accountId>:<path>"; messageId is "<accountId>:<uidValidity>:<uid>:<path>".
function mailboxId(accountId: string, path: string): string {
  return `${accountId}:${path}`;
}

function parseMailboxId(value: string): { accountId: string; path: string } {
  const index = value.indexOf(":");
  if (index <= 0) throw new Error(`Invalid mailboxId: ${value}`);
  return { accountId: value.slice(0, index), path: value.slice(index + 1) };
}

function messageId(accountId: string, uidValidity: bigint | string, uid: number, path: string): string {
  return `${accountId}:${uidValidity}:${uid}:${path}`;
}

function parseMessageId(value: string): MessageRef {
  const match = /^([^:]+):(\d+):(\d+):(.+)$/u.exec(value);
  if (match === null) throw new Error(`Invalid messageId: ${value}`);
  return { accountId: match[1]!, uidValidity: match[2]!, uid: Number(match[3]), path: match[4]! };
}

function isoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.000Z$/u, "Z");
}

function unixTime(params: Params, name: string): Date {
  const value = text(params, name);
  const milliseconds = Date.parse(value);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(milliseconds)) {
    throw new Error(`${name} must be an ISO 8601 date and time with a time zone, like 2026-11-01T09:00:00+09:00.`);
  }
  return new Date(milliseconds);
}

function text(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function integer(params: Params, name: string, fallback: number, maximum: number): number {
  const value = params[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function stringArray(params: Params, name: string): string[] {
  const value = params[name];
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a non-empty array of strings.`);
  }
  return value as string[];
}

function recipients(params: Params, name: string): Address[] {
  const value = params[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value.map((entry) => {
    const recipient = entry as Params;
    return { email: text(recipient, "email"), name: typeof recipient.label === "string" ? recipient.label : undefined };
  });
}

function addresses(list: MessageAddressObject[] | undefined): Address[] | undefined {
  return list?.filter((entry) => entry.address).map((entry) => ({ name: entry.name || undefined, email: entry.address! }));
}

function omitEmpty(key: string, value: unknown): unknown {
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return undefined;
  if (key === "imipMessage" && value === false) return undefined;
  return value;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, omitEmpty) }], details: {} };
}

const SYSTEM_FLAGS: Record<string, string> = {
  seen: "\\Seen",
  flagged: "\\Flagged",
  answered: "\\Answered",
  deleted: "\\Deleted",
  draft: "\\Draft",
};

function flagsObject(flags: Set<string> | undefined): { flags: Record<string, boolean>; keywords?: string[] } {
  const set = flags ?? new Set<string>();
  return {
    flags: Object.fromEntries(Object.entries(SYSTEM_FLAGS).map(([name, flag]) => [name, set.has(flag)])),
    keywords: [...set].filter((flag) => !flag.startsWith("\\")),
  };
}

function walkStructure(node: MessageStructureObject | undefined, visit: (part: MessageStructureObject) => void): void {
  if (node === undefined) return;
  visit(node);
  for (const child of node.childNodes ?? []) walkStructure(child, visit);
}

function attachmentsOf(structure: MessageStructureObject | undefined): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];
  walkStructure(structure, (part) => {
    if (part.childNodes?.length || part.type.startsWith("multipart/")) return;
    const fileName = part.dispositionParameters?.filename ?? part.parameters?.name;
    const isBodyText = (part.type === "text/plain" || part.type === "text/html") && part.disposition !== "attachment" && fileName === undefined;
    if (isBodyText || part.part === undefined) return;
    attachments.push({
      attachmentId: part.part,
      fileName,
      mime: part.type,
      size: part.size,
      disposition: part.disposition,
      contentId: part.id,
    });
  });
  return attachments;
}

function isImipMessage(structure: MessageStructureObject | undefined): boolean {
  let found = false;
  walkStructure(structure, (part) => {
    if (part.type === "text/calendar" && part.parameters?.method !== undefined) found = true;
  });
  return found;
}

function previewPart(structure: MessageStructureObject | undefined): MessageStructureObject | undefined {
  let plain: MessageStructureObject | undefined;
  let html: MessageStructureObject | undefined;
  walkStructure(structure, (part) => {
    if (part.disposition === "attachment") return;
    if (part.type === "text/plain") plain ??= part;
    if (part.type === "text/html") html ??= part;
  });
  return plain ?? html;
}

function decodeTransfer(data: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").toLowerCase()) {
    case "base64": {
      const compact = data.toString("latin1").replace(/[^A-Za-z0-9+/]/gu, "");
      return Buffer.from(compact.slice(0, compact.length - (compact.length % 4)), "base64");
    }
    case "quoted-printable": {
      const source = data.toString("latin1").replace(/=\r?\n/gu, "");
      return Buffer.from(source.replace(/=([0-9A-Fa-f]{2})/gu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
    }
    default:
      return data;
  }
}

function decodeCharset(data: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(data);
  } catch {
    return new TextDecoder("utf-8").decode(data);
  }
}

function previewText(part: MessageStructureObject, data: Buffer): string {
  let content = decodeCharset(decodeTransfer(data, part.encoding), part.parameters?.charset);
  if (part.type === "text/html") content = content.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/giu, " ").replace(/<[^>]*>/gu, " ");
  return content.replace(/\s+/gu, " ").trim().slice(0, PREVIEW_LENGTH);
}

function referencesOf(headers: Buffer | undefined): string[] | undefined {
  const value = headers?.toString("utf8").replace(/\r?\n[ \t]+/gu, " ").match(/^references:\s*(.*)$/imu)?.[1];
  return value?.match(/<[^>]+>/gu) ?? undefined;
}

const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: ["references"] };

async function summaries(client: ImapFlow, accountId: string, path: string, uidValidity: bigint, uids: number[]): Promise<Record<string, unknown>[]> {
  if (uids.length === 0) return [];
  const messages = await client.fetchAll(uids.join(","), SUMMARY_QUERY, { uid: true });
  const previews = new Map<number, string>();
  const byPart = new Map<string, { part: MessageStructureObject; uids: number[] }>();
  for (const message of messages) {
    const part = previewPart(message.bodyStructure);
    const key = part?.part ?? (part ? "1" : undefined);
    if (part === undefined || key === undefined) continue;
    const entry = byPart.get(`${key}|${part.encoding}|${part.parameters?.charset}|${part.type}`) ?? { part: { ...part, part: key }, uids: [] };
    entry.uids.push(message.uid);
    byPart.set(`${key}|${part.encoding}|${part.parameters?.charset}|${part.type}`, entry);
  }
  for (const { part, uids: partUids } of byPart.values()) {
    for (const message of await client.fetchAll(partUids.join(","), { uid: true, bodyParts: [{ key: part.part!, maxLength: PREVIEW_BYTES }] }, { uid: true })) {
      const data = message.bodyParts?.get(part.part!);
      if (data !== undefined) previews.set(message.uid, previewText(part, data));
    }
  }
  return messages
    .map((message) => summary(accountId, path, uidValidity, message, previews.get(message.uid)))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
}

function summary(accountId: string, path: string, uidValidity: bigint, message: FetchMessageObject, preview: string | undefined): Record<string, unknown> {
  const envelope = message.envelope;
  return {
    messageId: messageId(accountId, uidValidity, message.uid, path),
    mailboxId: mailboxId(accountId, path),
    subject: envelope?.subject,
    date: isoDate(envelope?.date),
    receivedDate: isoDate(message.internalDate),
    from: addresses(envelope?.from),
    to: addresses(envelope?.to),
    cc: addresses(envelope?.cc),
    bcc: addresses(envelope?.bcc),
    replyTo: addresses(envelope?.replyTo),
    ...flagsObject(message.flags),
    internetMessageId: envelope?.messageId,
    inReplyTo: envelope?.inReplyTo,
    references: referencesOf(message.headers),
    imipMessage: isImipMessage(message.bodyStructure),
    size: message.size,
    previewText: preview,
    attachments: attachmentsOf(message.bodyStructure),
  };
}

async function openMailbox(client: ImapFlow, ref: { path: string; uidValidity?: string }) {
  const lock = await client.getMailboxLock(ref.path);
  const mailbox = client.mailbox;
  if (mailbox === false) {
    lock.release();
    throw new Error(`Mailbox ${ref.path} could not be opened.`);
  }
  if (ref.uidValidity !== undefined && String(mailbox.uidValidity) !== ref.uidValidity) {
    lock.release();
    throw new Error(`Mailbox ${ref.path} has a new UIDVALIDITY; the messageId is no longer valid.`);
  }
  return { lock, uidValidity: mailbox.uidValidity };
}

async function specialMailbox(client: ImapFlow, use: SpecialUse): Promise<string> {
  const mailbox = (await client.list()).find((entry) => entry.specialUse === use);
  if (mailbox === undefined) throw new Error(`The account has no ${use} mailbox.`);
  return mailbox.path;
}

function groupRefs(ids: string[]): Map<string, { accountId: string; path: string; uidValidity: string; ids: Map<number, string> }> {
  const groups = new Map<string, { accountId: string; path: string; uidValidity: string; ids: Map<number, string> }>();
  for (const id of ids) {
    const ref = parseMessageId(id);
    const key = `${ref.accountId}:${ref.uidValidity}:${ref.path}`;
    const group = groups.get(key) ?? { accountId: ref.accountId, path: ref.path, uidValidity: ref.uidValidity, ids: new Map<number, string>() };
    group.ids.set(ref.uid, id);
    groups.set(key, group);
  }
  return groups;
}

async function getStatus(accounts: Map<string, AccountConfig>, limit: number) {
  return {
    accounts: await Promise.all([...accounts].map(async ([accountId, config]) => {
      const base = { accountId, identities: config.identities };
      try {
        return {
          ...base,
          mailboxes: await withImap(config, async (client) => {
            const mailboxes = await client.list({ statusQuery: { messages: true, unseen: true } });
            const output: Record<string, unknown>[] = [];
            for (const entry of mailboxes) {
              const item: Record<string, unknown> = { mailboxId: mailboxId(accountId, entry.path), name: entry.path, specialRole: entry.specialUse?.replace(/^\\/u, "").toLowerCase() };
              const status = entry.status as { messages?: number; unseen?: number; error?: unknown } | undefined;
              if (status === undefined || status.error !== undefined || status.messages === undefined) {
                output.push({ ...item, error: status?.error === undefined ? "STATUS failed." : errorMessage((status.error as { response?: { responseText?: string } }).response?.responseText ?? status.error) });
                continue;
              }
              Object.assign(item, { total: status.messages, unread: status.unseen });
              if ((status.unseen ?? 0) > 0) {
                try {
                  const { lock, uidValidity } = await openMailbox(client, { path: entry.path });
                  try {
                    const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
                    item.unreadMessages = await summaries(client, accountId, entry.path, uidValidity, uids.sort((a, b) => b - a).slice(0, limit));
                  } finally {
                    lock.release();
                  }
                } catch (error) {
                  item.error = errorMessage(error);
                }
              }
              output.push(item);
            }
            return output;
          }),
        };
      } catch (error) {
        return { ...base, error: errorMessage(error) };
      }
    })),
  };
}

async function fullMessage(client: ImapFlow, ref: MessageRef): Promise<Record<string, unknown>> {
  const { lock, uidValidity } = await openMailbox(client, ref);
  try {
    const [message] = await summaries(client, ref.accountId, ref.path, uidValidity, [ref.uid]);
    if (message === undefined) throw new Error(`Message ${ref.uid} was not found in ${ref.path}.`);
    const fetched = await client.fetchOne(String(ref.uid), { uid: true, source: true }, { uid: true });
    if (fetched === false || fetched.source === undefined) throw new Error(`Message ${ref.uid} was not found in ${ref.path}.`);
    const parsed = await simpleParser(fetched.source);
    return { ...message, previewText: undefined, bodyText: parsed.text, bodyHtml: parsed.html === false ? undefined : parsed.html };
  } finally {
    lock.release();
  }
}

async function thread(client: ImapFlow, accountId: string, message: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const ids = [message.internetMessageId, ...((message.references as string[] | undefined) ?? []), message.inReplyTo].filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return [];
  const root = ids[1] ?? ids[0]!;
  const ref = parseMessageId(String(message.messageId));
  const paths = [...new Set([ref.path, "INBOX", await specialMailbox(client, "\\Sent").catch(() => ref.path)])];
  const found: Record<string, unknown>[] = [];
  for (const path of paths) {
    const { lock, uidValidity } = await openMailbox(client, { path });
    try {
      const criteria = [{ header: { references: root } }, ...[...new Set(ids)].map((id) => ({ header: { "message-id": id } }))];
      const uids = ((await client.search({ or: criteria }, { uid: true })) || []) as number[];
      found.push(...(await summaries(client, accountId, path, uidValidity, uids)));
    } finally {
      lock.release();
    }
  }
  return found.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
}

async function download(config: AccountConfig, params: Params, decodeText: boolean) {
  const ref = parseMessageId(text(params, "messageId"));
  const attachmentId = text(params, "attachmentId");
  return withImap(config, async (client) => {
    const { lock } = await openMailbox(client, ref);
    try {
      const file = await client.download(String(ref.uid), attachmentId, { uid: true, decodeText });
      if (file.content === undefined) throw new Error(`Attachment ${attachmentId} was not found.`);
      const chunks: Buffer[] = [];
      for await (const chunk of file.content) chunks.push(Buffer.from(chunk as Buffer));
      return { data: Buffer.concat(chunks), contentType: file.meta.contentType ?? "application/octet-stream", fileName: file.meta.filename };
    } finally {
      lock.release();
    }
  });
}

function stripHeader(source: Buffer, name: string, replacement?: string): Buffer {
  const raw = source.toString("latin1");
  const end = raw.search(/\r?\n\r?\n/u);
  const head = end < 0 ? raw : raw.slice(0, end);
  const body = end < 0 ? "" : raw.slice(end);
  const lines = head.split(/\r?\n/u);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[ \t]/u.test(line) && skipping) continue;
    skipping = line.toLowerCase().startsWith(`${name.toLowerCase()}:`);
    if (!skipping) kept.push(line);
  }
  if (replacement !== undefined) kept.push(`${name}: ${replacement}`);
  return Buffer.from(kept.join("\r\n") + body, "latin1");
}

async function perMessage(accounts: Map<string, AccountConfig>, ids: string[], operation: (client: ImapFlow, group: { accountId: string; path: string; uids: number[] }) => Promise<Map<number, string | undefined> | void>) {
  const results = new Map<string, Record<string, unknown>>();
  const groups = groupRefs(ids);
  const byAccount = new Map<string, typeof groups extends Map<string, infer G> ? G[] : never>();
  for (const group of groups.values()) byAccount.set(group.accountId, [...(byAccount.get(group.accountId) ?? []), group]);
  await Promise.all([...byAccount].map(async ([accountId, accountGroups]) => {
    try {
      await withImap(account(accounts, accountId), async (client) => {
        for (const group of accountGroups) {
          try {
            const { lock } = await openMailbox(client, group);
            try {
              const existing = new Set((await client.fetchAll([...group.ids.keys()].join(","), { uid: true }, { uid: true })).map((message) => message.uid));
              for (const [uid, id] of group.ids) if (!existing.has(uid)) results.set(id, { messageId: id, error: "Message not found." });
              const uids = [...group.ids.keys()].filter((uid) => existing.has(uid));
              if (uids.length === 0) continue;
              const newIds = await operation(client, { accountId, path: group.path, uids });
              for (const uid of uids) {
                const id = group.ids.get(uid)!;
                results.set(id, { messageId: id, newMessageId: newIds instanceof Map ? newIds.get(uid) : undefined });
              }
            } finally {
              lock.release();
            }
          } catch (error) {
            for (const id of group.ids.values()) results.set(id, { messageId: id, error: errorMessage(error) });
          }
        }
      });
    } catch (error) {
      for (const group of accountGroups) for (const id of group.ids.values()) results.set(id, { messageId: id, error: errorMessage(error) });
    }
  }));
  return result({ results: ids.map((id) => results.get(id)) });
}

async function moveWithMap(client: ImapFlow, accountId: string, uids: number[], destination: string): Promise<Map<number, string | undefined>> {
  const response = await client.messageMove(uids.join(","), destination, { uid: true });
  if (response === false) throw new Error(`Messages could not be moved to ${destination}.`);
  const map = new Map<number, string | undefined>();
  for (const uid of uids) {
    const newUid = response.uidMap?.get(uid);
    map.set(uid, newUid === undefined || response.uidValidity === undefined ? undefined : messageId(accountId, response.uidValidity, newUid, destination));
  }
  return map;
}

const recipientSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["email"],
    properties: {
      email: { type: "string" },
      label: { type: "string", description: "Display name." },
    },
  },
};

const messageIdsSchema = { type: "array", minItems: 1, items: { type: "string" } };
const PER_MESSAGE_RESULT_DESCRIPTION = "results has messageId and, when the message failed, error for each message.";
const SUMMARY_DESCRIPTION = "Each message has messageId, mailboxId, subject, date (sent, ISO 8601 UTC), receivedDate, from, to, cc, bcc, replyTo, flags (seen, flagged, answered, deleted, draft), keywords, internetMessageId (the Message-ID header), inReplyTo, references, imipMessage, size, previewText, and attachments (attachmentId, fileName, mime, size, disposition, contentId). Keys without a value are omitted.";

const attachmentParameters = {
  type: "object",
  additionalProperties: false,
  required: ["messageId", "attachmentId"],
  properties: {
    messageId: { type: "string" },
    attachmentId: { type: "string", description: "attachmentId in attachments of the message." },
  },
};

export default definePluginEntry({
  id: "imap-smtp",
  name: "IMAP SMTP",
  description: "Reads mail through IMAP and sends mail through SMTP.",
  register(api) {
    api.registerTool({
      name: "imap_smtp_get_status",
      label: "Get IMAP Mail Status",
      description: `Get the mail status from the IMAP servers: every account (accountId, identities) and mailbox (mailboxId, name, specialRole, total and unread message counts) with its unreadMessages, newest first and at most maxUnreadMessagesPerMailbox per mailbox. The status is read directly from the servers, so no synchronization is needed. ${SUMMARY_DESCRIPTION} A mailbox without unread messages has no unreadMessages. When an account or a mailbox cannot be read, error holds the reason.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxUnreadMessagesPerMailbox: { type: "integer", minimum: 1, maximum: MAX_MESSAGES_PER_MAILBOX, default: 10 },
        },
      },
      async execute(_id: string, params: Params) {
        return result(await getStatus(readAccounts(api), integer(params, "maxUnreadMessagesPerMailbox", 10, MAX_MESSAGES_PER_MAILBOX)));
      },
    });

    api.registerTool({
      name: "imap_smtp_list_messages",
      label: "List IMAP Messages",
      description: `List messages in a mailbox, newest arrival first. ${SUMMARY_DESCRIPTION}`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["mailboxId"],
        properties: {
          mailboxId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: MAX_MESSAGES_PER_MAILBOX, default: 20 },
          unreadOnly: { type: "boolean", default: false },
          sentBefore: { type: "string", format: "date-time", description: "List only messages sent before this time, in ISO 8601 with a time zone, such as the date of a message. A message sent at exactly this time is not included." },
        },
      },
      async execute(_id: string, params: Params) {
        const { accountId, path } = parseMailboxId(text(params, "mailboxId"));
        const limit = integer(params, "limit", 20, MAX_MESSAGES_PER_MAILBOX);
        const sentBefore = params.sentBefore === undefined ? undefined : unixTime(params, "sentBefore");
        return result(await withImap(account(readAccounts(api), accountId), async (client) => {
          const { lock, uidValidity } = await openMailbox(client, { path });
          try {
            const criteria: Record<string, unknown> = params.unreadOnly === true ? { seen: false } : { all: true };
            // SENTBEFORE compares dates only, so search up to the next day and filter by the exact time.
            if (sentBefore !== undefined) criteria.sentBefore = new Date(sentBefore.getTime() + 24 * 60 * 60 * 1000);
            const uids = (((await client.search(criteria, { uid: true })) || []) as number[]).sort((a, b) => b - a);
            const messages: Record<string, unknown>[] = [];
            for (let start = 0; start < uids.length && messages.length < limit; start += limit) {
              const page = await summaries(client, accountId, path, uidValidity, uids.slice(start, start + limit));
              messages.push(...page.filter((message) => sentBefore === undefined || (typeof message.date === "string" && Date.parse(message.date) < sentBefore.getTime())));
            }
            return { messages: messages.slice(0, limit) };
          } finally {
            lock.release();
          }
        }));
      },
    });

    api.registerTool({
      name: "imap_smtp_get_message",
      label: "Get IMAP Message",
      description: "Get a message with its body (bodyText and bodyHtml) and the items of the message list, except previewText. With includeThread, thread lists the messages of the same conversation found in the message's mailbox, INBOX, and the sent mailbox. The message is not marked as read.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageId"],
        properties: {
          messageId: { type: "string" },
          includeThread: { type: "boolean", default: false },
        },
      },
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        return result(await withImap(account(readAccounts(api), ref.accountId), async (client) => {
          const message = await fullMessage(client, ref);
          return { message, thread: params.includeThread === true ? await thread(client, ref.accountId, message) : undefined };
        }));
      },
    });

    api.registerTool({
      name: "imap_smtp_get_messages",
      label: "Get IMAP Messages",
      description: "Get messages with their bodies, as imap_smtp_get_message does without threads. When a message cannot be read, its entry has messageId and error. The messages are not marked as read.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageIds"],
        properties: {
          messageIds: messageIdsSchema,
        },
      },
      async execute(_id: string, params: Params) {
        const accounts = readAccounts(api);
        const ids = stringArray(params, "messageIds");
        const messages = new Map<string, Record<string, unknown>>();
        const byAccount = new Map<string, string[]>();
        for (const id of ids) {
          try {
            const { accountId } = parseMessageId(id);
            byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), id]);
          } catch (error) {
            messages.set(id, { messageId: id, error: errorMessage(error) });
          }
        }
        await Promise.all([...byAccount].map(async ([accountId, accountIds]) => {
          try {
            await withImap(account(accounts, accountId), async (client) => {
              for (const id of accountIds) {
                try {
                  messages.set(id, await fullMessage(client, parseMessageId(id)));
                } catch (error) {
                  messages.set(id, { messageId: id, error: errorMessage(error) });
                }
              }
            });
          } catch (error) {
            for (const id of accountIds) messages.set(id, { messageId: id, error: errorMessage(error) });
          }
        }));
        return result({ messages: ids.map((id) => messages.get(id)) });
      },
    });

    api.registerTool({
      name: "imap_smtp_get_attachment_text",
      label: "Get IMAP Attachment Text",
      description: "Get the content of an attachment as text. Text parts are converted to UTF-8 from their charset; other parts are decoded as UTF-8. The content is returned as text whatever the type of the attachment is.",
      parameters: attachmentParameters,
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        const file = await download(account(readAccounts(api), ref.accountId), params, true);
        return { content: [{ type: "text" as const, text: file.data.toString("utf8") }], details: {} };
      },
    });

    api.registerTool({
      name: "imap_smtp_get_attachment_image",
      label: "Get IMAP Attachment Image",
      description: "Get the content of an attachment as an image, with the content type of the attachment. The content is returned as an image whatever the type of the attachment is.",
      parameters: attachmentParameters,
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        const file = await download(account(readAccounts(api), ref.accountId), params, false);
        return { content: [{ type: "image" as const, data: file.data.toString("base64"), mimeType: file.contentType }], details: {} };
      },
    });

    api.registerTool({
      name: "imap_smtp_save_attachment_to_openclaw",
      label: "Save IMAP Attachment to OpenClaw",
      description: "Save an attachment as a file in OpenClaw, so that OpenClaw tools can read it. Returns reference (media://inbound/...), path, size, and contentType of the saved file. Files larger than 5 MiB cannot be saved.",
      parameters: attachmentParameters,
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        const file = await download(account(readAccounts(api), ref.accountId), params, false);
        const saved = await saveMediaBuffer(file.data, file.contentType, "inbound", undefined, file.fileName);
        return result({ reference: `media://inbound/${saved.id}`, path: saved.path, size: saved.size, contentType: saved.contentType });
      },
    });

    api.registerTool({
      name: "imap_smtp_save_draft",
      label: "Save IMAP Draft",
      description: "Save a message as a draft in the drafts mailbox of the account, and return it as savedDraft with the items of the message list. fromAddress must be one of the account's identities. To edit a draft, save the edited message with draftMessageIdToReplace; the old draft is deleted permanently only after the new draft is saved, because a saved message cannot be changed on the mail server.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["accountId", "fromAddress", "subject", "body"],
        properties: {
          accountId: { type: "string" },
          fromAddress: { type: "string", description: "Sender address, one of the account's identities." },
          subject: { type: "string" },
          body: { type: "string" },
          isHtml: { type: "boolean", description: "body is HTML. Plain text when omitted." },
          to: recipientSchema,
          cc: recipientSchema,
          bcc: recipientSchema,
          draftMessageIdToReplace: { type: "string", description: "messageId of the draft that the new draft replaces." },
        },
      },
      async execute(_id: string, params: Params) {
        const accountId = text(params, "accountId");
        const config = account(readAccounts(api), accountId);
        const fromAddress = text(params, "fromAddress");
        const identity = config.identities.find((entry) => entry.address.toLowerCase() === fromAddress.toLowerCase());
        if (identity === undefined) throw new Error(`${fromAddress} is not an identity of account ${accountId}.`);
        const replace = params.draftMessageIdToReplace === undefined ? undefined : parseMessageId(text(params, "draftMessageIdToReplace"));
        if (replace !== undefined && replace.accountId !== accountId) throw new Error("draftMessageIdToReplace must be a draft of the same account.");
        const body = text(params, "body");
        const composer = new MailComposer({
          from: { name: identity.name ?? "", address: identity.address },
          to: recipients(params, "to").map((entry) => ({ name: entry.name ?? "", address: entry.email })),
          cc: recipients(params, "cc").map((entry) => ({ name: entry.name ?? "", address: entry.email })),
          bcc: recipients(params, "bcc").map((entry) => ({ name: entry.name ?? "", address: entry.email })),
          subject: text(params, "subject"),
          ...(params.isHtml === true ? { html: body } : { text: body }),
        }).compile();
        composer.keepBcc = true;
        const raw = await composer.build();
        return result(await withImap(config, async (client) => {
          const drafts = await specialMailbox(client, "\\Drafts");
          const appended = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
          if (appended === false || appended.uid === undefined || appended.uidValidity === undefined) throw new Error("The draft was saved, but the server did not return its UID.");
          const { lock } = await openMailbox(client, { path: drafts });
          let savedDraft: Record<string, unknown> | undefined;
          try {
            [savedDraft] = await summaries(client, accountId, drafts, appended.uidValidity, [appended.uid]);
          } finally {
            lock.release();
          }
          let replaceError: string | undefined;
          if (replace !== undefined) {
            try {
              const { lock: replaceLock } = await openMailbox(client, replace);
              try {
                await client.messageDelete(String(replace.uid), { uid: true });
              } finally {
                replaceLock.release();
              }
            } catch (error) {
              replaceError = errorMessage(error);
            }
          }
          return { savedDraft, replacedDraftMessageId: replace !== undefined && replaceError === undefined ? text(params, "draftMessageIdToReplace") : undefined, replaceError };
        }));
      },
    });

    api.registerTool({
      name: "imap_smtp_send",
      label: "Send IMAP Draft",
      description: "Send a draft saved with imap_smtp_save_draft from the drafts mailbox through SMTP, with its From, recipients, subject, body, and attachments. A copy is saved in the sent mailbox, and the draft is deleted permanently, only after the message is sent. The From address must be one of the account's identities.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draftMessageId"],
        properties: {
          draftMessageId: { type: "string", description: "messageId of the draft." },
        },
      },
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "draftMessageId"));
        const config = account(readAccounts(api), ref.accountId);
        return result(await withImap(config, async (client) => {
          const drafts = await specialMailbox(client, "\\Drafts");
          if (ref.path !== drafts) throw new Error(`The message is not in the drafts mailbox ${drafts}.`);
          const { lock } = await openMailbox(client, ref);
          let source: Buffer;
          try {
            const fetched = await client.fetchOne(String(ref.uid), { uid: true, source: true }, { uid: true });
            if (fetched === false || fetched.source === undefined) throw new Error("The draft was not found.");
            source = fetched.source;
          } finally {
            lock.release();
          }
          const parsed = await simpleParser(source);
          const list = (value: typeof parsed.to) => (value === undefined ? [] : Array.isArray(value) ? value : [value]).flatMap((entry) => entry.value).map((entry) => entry.address).filter((address): address is string => typeof address === "string");
          const from = list(parsed.from)[0];
          if (from === undefined || !config.identities.some((entry) => entry.address.toLowerCase() === from.toLowerCase())) {
            throw new Error(`The From address ${from ?? "(none)"} is not an identity of account ${ref.accountId}.`);
          }
          const to = [...list(parsed.to), ...list(parsed.cc), ...list(parsed.bcc)];
          if (to.length === 0) throw new Error("The draft has no recipients.");
          const dated = stripHeader(source, "Date", new Date().toUTCString());
          await smtpTransport(config).sendMail({ envelope: { from, to }, raw: stripHeader(dated, "Bcc") });

          let sentCopyError: string | undefined;
          try {
            await client.append(await specialMailbox(client, "\\Sent"), dated, ["\\Seen"]);
          } catch (error) {
            sentCopyError = errorMessage(error);
          }
          let draftDeleteError: string | undefined;
          try {
            const { lock: deleteLock } = await openMailbox(client, ref);
            try {
              await client.messageDelete(String(ref.uid), { uid: true });
            } finally {
              deleteLock.release();
            }
          } catch (error) {
            draftDeleteError = errorMessage(error);
          }
          return { sent: true, sentCopyError, deletedDraftMessageId: draftDeleteError === undefined ? text(params, "draftMessageId") : undefined, draftDeleteError };
        }));
      },
    });

    api.registerTool({
      name: "imap_smtp_set_flags",
      label: "Set IMAP Flags",
      description: `Set (true) or clear (false) flags of messages. {"seen": true} marks messages as read and {"seen": false} as unread. ${PER_MESSAGE_RESULT_DESCRIPTION}`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageIds", "flags"],
        properties: {
          messageIds: messageIdsSchema,
          flags: {
            type: "object",
            additionalProperties: { type: "boolean" },
            description: "Flags to set or clear. seen (read), flagged (starred), answered, deleted (marked for deletion; the message stays until the mailbox is expunged), and draft are IMAP system flags. Other names, such as $Junk or $Forwarded, are IMAP keywords, which the mail server may not keep.",
          },
        },
      },
      async execute(_id: string, params: Params) {
        const flags = params.flags;
        if (flags === null || typeof flags !== "object" || Array.isArray(flags) || !Object.values(flags).every((value) => typeof value === "boolean")) {
          throw new Error("flags must be an object of booleans.");
        }
        const add = Object.entries(flags).filter(([, value]) => value).map(([name]) => SYSTEM_FLAGS[name] ?? name);
        const remove = Object.entries(flags).filter(([, value]) => !value).map(([name]) => SYSTEM_FLAGS[name] ?? name);
        return perMessage(readAccounts(api), stringArray(params, "messageIds"), async (client, group) => {
          if (add.length > 0) await client.messageFlagsAdd(group.uids.join(","), add, { uid: true });
          if (remove.length > 0) await client.messageFlagsRemove(group.uids.join(","), remove, { uid: true });
        });
      },
    });

    api.registerTool({
      name: "imap_smtp_move_messages",
      label: "Move IMAP Messages",
      description: `Move messages to another mailbox of the same account. A moved message gets a new messageId, returned as newMessageId. ${PER_MESSAGE_RESULT_DESCRIPTION}`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageIds", "destinationMailboxId"],
        properties: {
          messageIds: messageIdsSchema,
          destinationMailboxId: { type: "string" },
        },
      },
      async execute(_id: string, params: Params) {
        const destination = parseMailboxId(text(params, "destinationMailboxId"));
        return perMessage(readAccounts(api), stringArray(params, "messageIds"), async (client, group) => {
          if (group.accountId !== destination.accountId) throw new Error("destinationMailboxId must be a mailbox of the same account.");
          return moveWithMap(client, group.accountId, group.uids, destination.path);
        });
      },
    });

    api.registerTool({
      name: "imap_smtp_delete_messages",
      label: "Delete IMAP Messages",
      description: `Delete messages. Messages are moved to the trash mailbox, and returned with newMessageId; messages already in the trash mailbox are deleted permanently. ${PER_MESSAGE_RESULT_DESCRIPTION}`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageIds"],
        properties: {
          messageIds: messageIdsSchema,
        },
      },
      async execute(_id: string, params: Params) {
        return perMessage(readAccounts(api), stringArray(params, "messageIds"), async (client, group) => {
          const trash = await specialMailbox(client, "\\Trash");
          if (group.path === trash) {
            await client.messageDelete(group.uids.join(","), { uid: true });
            return;
          }
          return moveWithMap(client, group.accountId, group.uids, trash);
        });
      },
    });
  },
});
