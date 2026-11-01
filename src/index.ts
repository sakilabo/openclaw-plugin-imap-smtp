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
  accountMailAddress: string;
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
// accountMailAddress is the email address of the mailbox. It has no colon, which separates the parts of the IDs.
const ACCOUNT_MAIL_ADDRESS_PATTERN = /^[^:@\s]+@[^:@\s]+$/u;
const DEFAULT_PREREAD_PLAIN_BYTES = 1024;
const DEFAULT_PREREAD_HTML_BYTES = 2048;

type PrereadBytes = { plain: number; html: number };

// Bytes read from the start of a text/plain or text/html part to make previewText.
function prereadBytes(api: OpenClawPluginApi, params: Params): PrereadBytes {
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
  const bytes = (name: string, fallback: number) => {
    const configured = api.pluginConfig?.[name] ?? fallback;
    if (!positive(configured)) throw new Error(`${name} in plugins.entries.imap-smtp.config must be a positive integer.`);
    const value = params[name] ?? configured;
    if (!positive(value)) throw new Error(`${name} must be a positive integer.`);
    return value;
  };
  return { plain: bytes("prereadPlainBytes", DEFAULT_PREREAD_PLAIN_BYTES), html: bytes("prereadHtmlBytes", DEFAULT_PREREAD_HTML_BYTES) };
}

function readAccounts(api: OpenClawPluginApi): Map<string, AccountConfig> {
  const raw = api.pluginConfig?.accounts;
  if (raw === null || typeof raw !== "object" || Object.keys(raw).length === 0) {
    throw new Error("imap-smtp is not configured. Set accounts in plugins.entries.imap-smtp.config.");
  }
  const accounts = new Map(Object.entries(raw as Record<string, AccountConfig>));
  for (const accountMailAddress of accounts.keys()) {
    if (!ACCOUNT_MAIL_ADDRESS_PATTERN.test(accountMailAddress)) throw new Error(`Account ${accountMailAddress} must be keyed by the email address of its mailbox.`);
  }
  return accounts;
}

function account(accounts: Map<string, AccountConfig>, accountMailAddress: string): AccountConfig {
  const config = accounts.get(accountMailAddress);
  if (config === undefined) throw new Error(`Account ${accountMailAddress} is not configured.`);
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

// IDs: mailboxId is "<accountMailAddress>:<path>"; messageId is "<accountMailAddress>:<uidValidity>:<uid>:<path>".
function mailboxId(accountMailAddress: string, path: string): string {
  return `${accountMailAddress}:${path}`;
}

function parseMailboxId(value: string): { accountMailAddress: string; path: string } {
  const index = value.indexOf(":");
  if (index <= 0) throw new Error(`Invalid mailboxId: ${value}`);
  return { accountMailAddress: value.slice(0, index), path: value.slice(index + 1) };
}

function messageId(accountMailAddress: string, uidValidity: bigint | string, uid: number, path: string): string {
  return `${accountMailAddress}:${uidValidity}:${uid}:${path}`;
}

function parseMessageId(value: string): MessageRef {
  const match = /^([^:]+):(\d+):(\d+):(.+)$/u.exec(value);
  if (match === null) throw new Error(`Invalid messageId: ${value}`);
  return { accountMailAddress: match[1]!, uidValidity: match[2]!, uid: Number(match[3]), path: match[4]! };
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

function bound(params: Params, name: string): Bound {
  const value = params[name];
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a UID (a positive integer) or an ISO 8601 date and time with a time zone.`);
    return { uid: value };
  }
  return { date: unixTime(params, name) };
}

function sortDirectionParam(params: Params): SortDirection {
  const value = params.sortDirection;
  if (value !== "ascending" && value !== "descending") throw new Error('sortDirection must be "ascending" or "descending".');
  return value;
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

// Decodes the first bytes of a text part. The data may end in the middle of an encoded unit or a character.
function decodeTransfer(data: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").toLowerCase()) {
    case "base64": {
      // The padding "=" is kept, so a part read to its end is decoded to its last byte.
      const compact = data.toString("latin1").replace(/[^A-Za-z0-9+/=]/gu, "");
      return Buffer.from(compact.slice(0, compact.length - (compact.length % 4)), "base64");
    }
    case "quoted-printable": {
      const source = data.toString("latin1").replace(/=(?:[0-9A-Fa-f]?|\r)$/u, "").replace(/=\r?\n/gu, "");
      return Buffer.from(source.replace(/=([0-9A-Fa-f]{2})/gu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
    }
    default:
      return data;
  }
}

function decodeCharset(data: Buffer, charset: string | undefined): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  // stream: true keeps an incomplete character at the end out of the output.
  return decoder.decode(data, { stream: true });
}

function previewText(part: MessageStructureObject, data: Buffer): string {
  let content = decodeCharset(decodeTransfer(data, part.encoding), part.parameters?.charset);
  if (part.type === "text/html") {
    content = content
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<(style|script)[^>]*>[\s\S]*$/iu, " ")
      .replace(/<[^>]*>/gu, " ")
      .replace(/<[^>]*$/u, " ");
  }
  return content.replace(/\s+/gu, " ").trim();
}

function referencesOf(headers: Buffer | undefined): string[] | undefined {
  const value = headers?.toString("utf8").replace(/\r?\n[ \t]+/gu, " ").match(/^references:\s*(.*)$/imu)?.[1];
  return value?.match(/<[^>]+>/gu) ?? undefined;
}

const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: ["references"] };

async function summaries(client: ImapFlow, accountMailAddress: string, path: string, uidValidity: bigint, uids: number[], preread: PrereadBytes | undefined): Promise<Record<string, unknown>[]> {
  if (uids.length === 0) return [];
  const messages = await client.fetchAll(uids.join(","), SUMMARY_QUERY, { uid: true });
  const previews = new Map<number, string>();
  const byPart = new Map<string, { part: MessageStructureObject; uids: number[] }>();
  // Without preread, previewText is not made.
  if (preread !== undefined) {
    for (const message of messages) {
      const part = previewPart(message.bodyStructure);
      const key = part?.part ?? (part ? "1" : undefined);
      if (part === undefined || key === undefined) continue;
      const entry = byPart.get(`${key}|${part.encoding}|${part.parameters?.charset}|${part.type}`) ?? { part: { ...part, part: key }, uids: [] };
      entry.uids.push(message.uid);
      byPart.set(`${key}|${part.encoding}|${part.parameters?.charset}|${part.type}`, entry);
    }
    for (const { part, uids: partUids } of byPart.values()) {
      const maxLength = part.type === "text/html" ? preread.html : preread.plain;
      for (const message of await client.fetchAll(partUids.join(","), { uid: true, bodyParts: [{ key: part.part!, maxLength }] }, { uid: true })) {
        const data = message.bodyParts?.get(part.part!);
        if (data !== undefined) previews.set(message.uid, previewText(part, data));
      }
    }
  }
  const byUid = new Map(messages.map((message) => [message.uid, message]));
  return uids.flatMap((uid) => {
    const message = byUid.get(uid);
    return message === undefined ? [] : [summary(accountMailAddress, path, uidValidity, message, previews.get(message.uid))];
  });
}

type ImapAttribute = { type: "ATOM" | "STRING" | "SEQUENCE"; value: string } | ImapAttribute[];
type ImapExec = (command: string, attributes: ImapAttribute[], options: { untagged: Record<string, (response: { numbers?: number[]; attributes?: { value?: unknown }[] }) => Promise<void>> }) => Promise<{ next(): void }>;

function imapDate(date: Date): string {
  const [year, month, day] = date.toISOString().slice(0, 10).split("-");
  return `${Number(day)}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1]}-${year}`;
}

// The key of the message that the messages are sorted by.
// date: the RFC 5256 SORT date, the Date header or the arrival time without one. Used with SORT.
// uid: the order messages were added to the mailbox, as UIDs ascend. Used without SORT.
type SortKey = "date" | "uid";
type SortDirection = "ascending" | "descending";

// A bound of a range: a UID, or a date compared with the Date header, or the arrival time without one.
type Bound = { uid: number } | { date: Date };

const DAY = 24 * 60 * 60 * 1000;

// Search keys for a bound. Dates are compared by day in the sender's or the server's time zone,
// so the search is two days wider and the caller filters the exact bound.
function boundKeys(bound: Bound, side: "before" | "after"): ImapAttribute[] {
  if ("uid" in bound) {
    // "n:*" also matches the largest UID when it is below n, so the caller filters the exact bound.
    const range = side === "before" ? `1:${Math.max(bound.uid - 1, 1)}` : `${bound.uid + 1}:*`;
    return [{ type: "ATOM", value: "UID" }, { type: "SEQUENCE", value: range }];
  }
  const date: ImapAttribute = { type: "ATOM", value: imapDate(new Date(bound.date.getTime() + (side === "before" ? 2 : -2) * DAY)) };
  const [sent, arrival] = side === "before" ? ["SENTBEFORE", "BEFORE"] : ["SENTSINCE", "SINCE"];
  return [
    { type: "ATOM", value: "OR" },
    { type: "ATOM", value: sent },
    date,
    [{ type: "ATOM", value: "NOT" }, { type: "ATOM", value: "HEADER" }, { type: "ATOM", value: "DATE" }, { type: "STRING", value: "" }, { type: "ATOM", value: arrival }, date],
  ];
}

function withinBound(message: Record<string, unknown>, bound: Bound | undefined, side: "before" | "after"): boolean {
  if (bound === undefined) return true;
  const [value, limit] = "uid" in bound ? [Number(message.uid), bound.uid] : [Date.parse(String(message.date ?? message.receivedDate)), bound.date.getTime()];
  return side === "before" ? value < limit : value > limit;
}

type SearchCriteria = { unseen?: boolean; before?: Bound; after?: Bound };

// UIDs in the selected mailbox, sorted by date with SORT, or by UID without it. The caller filters the exact bounds.
// The commands go through an internal API of imapflow. When it fails, the public search is used, sorted by UID.
async function sortedUids(client: ImapFlow, criteria: SearchCriteria, sortDirection: SortDirection): Promise<{ uids: number[]; sortKey: SortKey }> {
  try {
    return await sortedUidsByCommand(client, criteria, sortDirection);
  } catch {
    return { uids: sortByUid(await searchUidsByPublicApi(client, criteria), sortDirection), sortKey: "uid" };
  }
}

function sortByUid(uids: number[], sortDirection: SortDirection): number[] {
  return uids.sort((a, b) => (sortDirection === "descending" ? b - a : a - b));
}

// One public search per condition, intersected, because imapflow takes one OR per query.
async function searchUidsByPublicApi(client: ImapFlow, criteria: SearchCriteria): Promise<number[]> {
  const queries: Record<string, unknown>[] = [];
  if (criteria.unseen === true) queries.push({ seen: false });
  for (const side of ["before", "after"] as const) {
    const bound = criteria[side];
    if (bound === undefined) continue;
    if ("uid" in bound) {
      queries.push({ uid: side === "before" ? `1:${Math.max(bound.uid - 1, 1)}` : `${bound.uid + 1}:*` });
      continue;
    }
    const date = new Date(`${new Date(bound.date.getTime() + (side === "before" ? 2 : -2) * DAY).toISOString().slice(0, 10)}T00:00:00Z`);
    queries.push(side === "before" ? { or: [{ sentBefore: date }, { not: { header: { date: true } }, before: date }] } : { or: [{ sentSince: date }, { not: { header: { date: true } }, since: date }] });
  }
  if (queries.length === 0) queries.push({ all: true });
  let uids: number[] | undefined;
  for (const query of queries) {
    const found = await client.search(query, { uid: true });
    if (!Array.isArray(found)) throw new Error("The mail server refused the search.");
    const previous = uids === undefined ? undefined : new Set(uids);
    uids = previous === undefined ? found : found.filter((uid) => previous.has(uid));
  }
  return uids ?? [];
}

async function sortedUidsByCommand(client: ImapFlow, criteria: SearchCriteria, sortDirection: SortDirection): Promise<{ uids: number[]; sortKey: SortKey }> {
  const keys: ImapAttribute[] = [];
  if (criteria.unseen === true) keys.push({ type: "ATOM", value: "UNSEEN" });
  if (criteria.before !== undefined) keys.push(...boundKeys(criteria.before, "before"));
  if (criteria.after !== undefined) keys.push(...boundKeys(criteria.after, "after"));
  if (keys.length === 0) keys.push({ type: "ATOM", value: "ALL" });
  const uids: number[] = [];
  const collect = async (untagged: { numbers?: number[]; attributes?: { value?: unknown }[] }) => {
    uids.push(...(untagged.numbers ?? (untagged.attributes ?? []).map((attribute) => Number(attribute.value))));
  };
  // imapflow has no SORT command and does not take these search keys as they are, so they are sent through the connection's command queue.
  const exec = (client as unknown as { exec: ImapExec }).exec.bind(client);
  if (client.capabilities.has("SORT")) {
    const order: ImapAttribute[] = sortDirection === "descending" ? [{ type: "ATOM", value: "REVERSE" }, { type: "ATOM", value: "DATE" }] : [{ type: "ATOM", value: "DATE" }];
    (await exec("UID SORT", [order, { type: "ATOM", value: "UTF-8" }, ...keys], { untagged: { SORT: collect } })).next();
    return { uids, sortKey: "date" };
  }
  // Sorting by date here would need the date of every matching message, so the arrival order is used.
  (await exec("UID SEARCH", keys, { untagged: { SEARCH: collect } })).next();
  return { uids: sortByUid(uids, sortDirection), sortKey: "uid" };
}

function summary(accountMailAddress: string, path: string, uidValidity: bigint, message: FetchMessageObject, preview: string | undefined): Record<string, unknown> {
  const envelope = message.envelope;
  return {
    messageId: messageId(accountMailAddress, uidValidity, message.uid, path),
    mailboxId: mailboxId(accountMailAddress, path),
    uid: message.uid,
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

function groupRefs(ids: string[]): Map<string, { accountMailAddress: string; path: string; uidValidity: string; ids: Map<number, string> }> {
  const groups = new Map<string, { accountMailAddress: string; path: string; uidValidity: string; ids: Map<number, string> }>();
  for (const id of ids) {
    const ref = parseMessageId(id);
    const key = `${ref.accountMailAddress}:${ref.uidValidity}:${ref.path}`;
    const group = groups.get(key) ?? { accountMailAddress: ref.accountMailAddress, path: ref.path, uidValidity: ref.uidValidity, ids: new Map<number, string>() };
    group.ids.set(ref.uid, id);
    groups.set(key, group);
  }
  return groups;
}

async function getStatus(accounts: Map<string, AccountConfig>, limit: number, preread: PrereadBytes) {
  return {
    accounts: await Promise.all([...accounts].map(async ([accountMailAddress, config]) => {
      const base = { accountMailAddress, identities: config.identities };
      try {
        return {
          ...base,
          mailboxes: await withImap(config, async (client) => {
            const mailboxes = await client.list({ statusQuery: { messages: true, unseen: true } });
            const output: Record<string, unknown>[] = [];
            for (const entry of mailboxes) {
              const item: Record<string, unknown> = { mailboxId: mailboxId(accountMailAddress, entry.path), name: entry.path, specialRole: entry.specialUse?.replace(/^\\/u, "").toLowerCase() };
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
                    const { uids, sortKey } = await sortedUids(client, { unseen: true }, "descending");
                    item.unreadMessages = await summaries(client, accountMailAddress, entry.path, uidValidity, uids.slice(0, limit), preread);
                    Object.assign(item, { sortKey, sortDirection: "descending" });
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
    const [message] = await summaries(client, ref.accountMailAddress, ref.path, uidValidity, [ref.uid], undefined);
    if (message === undefined) throw new Error(`Message ${ref.uid} was not found in ${ref.path}.`);
    const fetched = await client.fetchOne(String(ref.uid), { uid: true, source: true }, { uid: true });
    if (fetched === false || fetched.source === undefined) throw new Error(`Message ${ref.uid} was not found in ${ref.path}.`);
    const parsed = await simpleParser(fetched.source);
    return { ...message, previewText: undefined, bodyText: parsed.text, bodyHtml: parsed.html === false ? undefined : parsed.html };
  } finally {
    lock.release();
  }
}

async function thread(client: ImapFlow, accountMailAddress: string, message: Record<string, unknown>, preread: PrereadBytes): Promise<Record<string, unknown>[]> {
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
      found.push(...(await summaries(client, accountMailAddress, path, uidValidity, uids, preread)));
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

async function perMessage(accounts: Map<string, AccountConfig>, ids: string[], operation: (client: ImapFlow, group: { accountMailAddress: string; path: string; uids: number[] }) => Promise<Map<number, string | undefined> | void>) {
  const results = new Map<string, Record<string, unknown>>();
  const groups = groupRefs(ids);
  const byAccount = new Map<string, typeof groups extends Map<string, infer G> ? G[] : never>();
  for (const group of groups.values()) byAccount.set(group.accountMailAddress, [...(byAccount.get(group.accountMailAddress) ?? []), group]);
  await Promise.all([...byAccount].map(async ([accountMailAddress, accountGroups]) => {
    try {
      await withImap(account(accounts, accountMailAddress), async (client) => {
        for (const group of accountGroups) {
          try {
            const { lock } = await openMailbox(client, group);
            try {
              const existing = new Set((await client.fetchAll([...group.ids.keys()].join(","), { uid: true }, { uid: true })).map((message) => message.uid));
              for (const [uid, id] of group.ids) if (!existing.has(uid)) results.set(id, { messageId: id, error: "Message not found." });
              const uids = [...group.ids.keys()].filter((uid) => existing.has(uid));
              if (uids.length === 0) continue;
              const newIds = await operation(client, { accountMailAddress, path: group.path, uids });
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

async function moveWithMap(client: ImapFlow, accountMailAddress: string, uids: number[], destination: string): Promise<Map<number, string | undefined>> {
  const response = await client.messageMove(uids.join(","), destination, { uid: true });
  if (response === false) throw new Error(`Messages could not be moved to ${destination}.`);
  const map = new Map<number, string | undefined>();
  for (const uid of uids) {
    const newUid = response.uidMap?.get(uid);
    map.set(uid, newUid === undefined || response.uidValidity === undefined ? undefined : messageId(accountMailAddress, response.uidValidity, newUid, destination));
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
const prereadBytesSchema = {
  prereadPlainBytes: {
    type: "integer",
    minimum: 1,
    description: "Bytes read from the start of a text/plain part to make previewText. Defaults to prereadPlainBytes in the plugin config, or 1024 when it is not set.",
  },
  prereadHtmlBytes: {
    type: "integer",
    minimum: 1,
    description: "Bytes read from the start of a text/html part to make previewText of a message without a text/plain part. Defaults to prereadHtmlBytes in the plugin config, or 2048 when it is not set.",
  },
};

const boundSchema = { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", format: "date-time" }] };
const BOUND_DESCRIPTION = "A uid (an integer) compares the uid of the messages. A date and time in ISO 8601 with a time zone (a string) compares the date of the messages, or receivedDate for a message without date. A message at exactly the bound is not included.";

const SORT_KEY_DESCRIPTION = "sortKey is the key of the messages they are sorted by: date (the Date header, or receivedDate without one) on a server with the SORT extension, or uid (the order the messages were added to the mailbox) on a server without it.";

const SUMMARY_DESCRIPTION = "Each message has messageId, mailboxId, uid (the IMAP UID, which ascends in the order messages are added to the mailbox), subject, date (sent, ISO 8601 UTC), receivedDate, from, to, cc, bcc, replyTo, flags (seen, flagged, answered, deleted, draft), keywords, internetMessageId (the Message-ID header), inReplyTo, references, imipMessage, size, previewText, and attachments (attachmentId, fileName, mime, size, disposition, contentId). Keys without a value are omitted.";

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
      name: "imap_get_status",
      label: "Get IMAP Mail Status",
      description: `Get the mail status from the IMAP servers: every account (accountMailAddress, identities) and mailbox (mailboxId, name, specialRole, total and unread message counts) with its unreadMessages, newest first (sortDirection descending) and at most maxUnreadMessagesPerMailbox per mailbox. ${SORT_KEY_DESCRIPTION} The status is read directly from the servers, so no synchronization is needed. ${SUMMARY_DESCRIPTION} A mailbox without unread messages has no unreadMessages. When an account or a mailbox cannot be read, error holds the reason.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxUnreadMessagesPerMailbox: { type: "integer", minimum: 1, maximum: MAX_MESSAGES_PER_MAILBOX, default: 10 },
          ...prereadBytesSchema,
        },
      },
      async execute(_id: string, params: Params) {
        return result(await getStatus(readAccounts(api), integer(params, "maxUnreadMessagesPerMailbox", 10, MAX_MESSAGES_PER_MAILBOX), prereadBytes(api, params)));
      },
    });

    api.registerTool({
      name: "imap_list_messages",
      label: "List IMAP Messages",
      description: `List messages in a mailbox, in the order of sortKey and sortDirection, which the result also has. ${SORT_KEY_DESCRIPTION} ${SUMMARY_DESCRIPTION}`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["mailboxId"],
        properties: {
          mailboxId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: MAX_MESSAGES_PER_MAILBOX, default: 20 },
          unreadOnly: { type: "boolean", default: false },
          before: { ...boundSchema, description: `List only messages before this bound. ${BOUND_DESCRIPTION}` },
          after: { ...boundSchema, description: `List only messages after this bound. ${BOUND_DESCRIPTION}` },
          sortDirection: { type: "string", enum: ["descending", "ascending"], description: "descending lists the newest first, and ascending the oldest first. Defaults to ascending when only after is given, and to descending otherwise." },
          ...prereadBytesSchema,
        },
      },
      async execute(_id: string, params: Params) {
        const { accountMailAddress, path } = parseMailboxId(text(params, "mailboxId"));
        const limit = integer(params, "limit", 20, MAX_MESSAGES_PER_MAILBOX);
        const preread = prereadBytes(api, params);
        const before = params.before === undefined ? undefined : bound(params, "before");
        const after = params.after === undefined ? undefined : bound(params, "after");
        const sortDirection = params.sortDirection === undefined ? (after !== undefined && before === undefined ? "ascending" : "descending") : sortDirectionParam(params);
        return result(await withImap(account(readAccounts(api), accountMailAddress), async (client) => {
          const { lock, uidValidity } = await openMailbox(client, { path });
          try {
            const { uids, sortKey } = await sortedUids(client, { unseen: params.unreadOnly === true, before, after }, sortDirection);
            const messages: Record<string, unknown>[] = [];
            for (let start = 0; start < uids.length && messages.length < limit; start += limit) {
              const page = await summaries(client, accountMailAddress, path, uidValidity, uids.slice(start, start + limit), preread);
              messages.push(...page.filter((message) => withinBound(message, before, "before") && withinBound(message, after, "after")));
            }
            return { sortKey, sortDirection, messages: messages.slice(0, limit) };
          } finally {
            lock.release();
          }
        }));
      },
    });

    api.registerTool({
      name: "imap_get_message",
      label: "Get IMAP Message",
      description: "Get a message with its body (bodyText and bodyHtml) and the items of the message list, except previewText. With includeThread, thread lists the messages of the same conversation found in the message's mailbox, INBOX, and the sent mailbox. The message is not marked as read.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageId"],
        properties: {
          messageId: { type: "string" },
          includeThread: { type: "boolean", default: false },
          ...prereadBytesSchema,
        },
      },
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        return result(await withImap(account(readAccounts(api), ref.accountMailAddress), async (client) => {
          const message = await fullMessage(client, ref);
          return { message, thread: params.includeThread === true ? await thread(client, ref.accountMailAddress, message, prereadBytes(api, params)) : undefined };
        }));
      },
    });

    api.registerTool({
      name: "imap_get_messages",
      label: "Get IMAP Messages",
      description: "Get messages with their bodies, as imap_get_message does without threads. When a message cannot be read, its entry has messageId and error. The messages are not marked as read.",
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
            const { accountMailAddress } = parseMessageId(id);
            byAccount.set(accountMailAddress, [...(byAccount.get(accountMailAddress) ?? []), id]);
          } catch (error) {
            messages.set(id, { messageId: id, error: errorMessage(error) });
          }
        }
        await Promise.all([...byAccount].map(async ([accountMailAddress, accountMessageIds]) => {
          try {
            await withImap(account(accounts, accountMailAddress), async (client) => {
              for (const id of accountMessageIds) {
                try {
                  messages.set(id, await fullMessage(client, parseMessageId(id)));
                } catch (error) {
                  messages.set(id, { messageId: id, error: errorMessage(error) });
                }
              }
            });
          } catch (error) {
            for (const id of accountMessageIds) messages.set(id, { messageId: id, error: errorMessage(error) });
          }
        }));
        return result({ messages: ids.map((id) => messages.get(id)) });
      },
    });

    api.registerTool({
      name: "imap_get_attachment_text",
      label: "Get IMAP Attachment Text",
      description: "Get the content of an attachment as text. Text parts are converted to UTF-8 from their charset; other parts are decoded as UTF-8. The content is returned as text whatever the type of the attachment is.",
      parameters: attachmentParameters,
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        const file = await download(account(readAccounts(api), ref.accountMailAddress), params, true);
        return { content: [{ type: "text" as const, text: file.data.toString("utf8") }], details: {} };
      },
    });

    api.registerTool({
      name: "imap_get_attachment_image",
      label: "Get IMAP Attachment Image",
      description: "Get the content of an attachment as an image, with the content type of the attachment. The content is returned as an image whatever the type of the attachment is.",
      parameters: attachmentParameters,
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        const file = await download(account(readAccounts(api), ref.accountMailAddress), params, false);
        return { content: [{ type: "image" as const, data: file.data.toString("base64"), mimeType: file.contentType }], details: {} };
      },
    });

    api.registerTool({
      name: "imap_save_attachment_to_openclaw",
      label: "Save IMAP Attachment to OpenClaw",
      description: "Save an attachment as a file in OpenClaw, so that OpenClaw tools can read it. Returns reference (media://inbound/...), path, size, and contentType of the saved file. Files larger than 5 MiB cannot be saved.",
      parameters: attachmentParameters,
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "messageId"));
        const file = await download(account(readAccounts(api), ref.accountMailAddress), params, false);
        const saved = await saveMediaBuffer(file.data, file.contentType, "inbound", undefined, file.fileName);
        return result({ reference: `media://inbound/${saved.id}`, path: saved.path, size: saved.size, contentType: saved.contentType });
      },
    });

    api.registerTool({
      name: "imap_save_draft",
      label: "Save IMAP Draft",
      description: "Save a message as a draft in the drafts mailbox of the account, and return it as savedDraft with the items of the message list. fromAddress must be one of the account's identities. To edit a draft, save the edited message with draftMessageIdToReplace; the old draft is deleted permanently only after the new draft is saved, because a saved message cannot be changed on the mail server.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["accountMailAddress", "fromAddress", "subject", "body"],
        properties: {
          accountMailAddress: { type: "string" },
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
        const accountMailAddress = text(params, "accountMailAddress");
        const config = account(readAccounts(api), accountMailAddress);
        const fromAddress = text(params, "fromAddress");
        const identity = config.identities.find((entry) => entry.address.toLowerCase() === fromAddress.toLowerCase());
        if (identity === undefined) throw new Error(`${fromAddress} is not an identity of account ${accountMailAddress}.`);
        const replace = params.draftMessageIdToReplace === undefined ? undefined : parseMessageId(text(params, "draftMessageIdToReplace"));
        if (replace !== undefined && replace.accountMailAddress !== accountMailAddress) throw new Error("draftMessageIdToReplace must be a draft of the same account.");
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
            [savedDraft] = await summaries(client, accountMailAddress, drafts, appended.uidValidity, [appended.uid], prereadBytes(api, {}));
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
      name: "smtp_send",
      label: "Send IMAP Draft",
      description: "Send a draft saved with imap_save_draft from the drafts mailbox through SMTP, with its From, recipients, subject, body, and attachments. A copy is saved in the sent mailbox, and the draft is deleted permanently, only after the message is sent. The From address must be one of the account's identities.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["imapDraftMessageId"],
        properties: {
          imapDraftMessageId: { type: "string", description: "messageId of the draft in the IMAP drafts mailbox, as returned by imap_save_draft." },
        },
      },
      async execute(_id: string, params: Params) {
        const ref = parseMessageId(text(params, "imapDraftMessageId"));
        const config = account(readAccounts(api), ref.accountMailAddress);
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
            throw new Error(`The From address ${from ?? "(none)"} is not an identity of account ${ref.accountMailAddress}.`);
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
          return { sent: true, sentCopyError, deletedImapDraftMessageId: draftDeleteError === undefined ? text(params, "imapDraftMessageId") : undefined, draftDeleteError };
        }));
      },
    });

    api.registerTool({
      name: "imap_set_flags",
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
      name: "imap_move_messages",
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
          if (group.accountMailAddress !== destination.accountMailAddress) throw new Error("destinationMailboxId must be a mailbox of the same account.");
          return moveWithMap(client, group.accountMailAddress, group.uids, destination.path);
        });
      },
    });

    api.registerTool({
      name: "imap_delete_messages",
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
          return moveWithMap(client, group.accountMailAddress, group.uids, trash);
        });
      },
    });
  },
});
