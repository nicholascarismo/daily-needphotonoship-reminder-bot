import 'dotenv/config';
import boltPkg from '@slack/bolt';

const { App, ExpressReceiver } = boltPkg;

/* =========================
   Slack HTTP Receiver
========================= */
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    events: '/slack/events',
    commands: '/slack/command',
    interactive: '/slack/interactive',
  },
});
receiver.app.get('/', (_req, res) => res.status(200).type('text/plain').send('OK'));
receiver.app.get('/health', (_req, res) => res.status(200).type('text/plain').send('OK'));
receiver.app.get('/wake', (_req, res) => {
  res.status(200).type('text/plain').send('awake');
});
receiver.app.get('/version', (_req, res) =>
  res.status(200).json({ SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || '2025-10' })
);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/* =========================
   Env & Config
========================= */
const WATCH_CHANNEL =
  process.env.FORWARD_CHANNEL_ID || process.env.ORDER_EMAIL_CHANNEL_ID || '';

const SHOPIFY_DOMAIN   = process.env.SHOPIFY_DOMAIN;          // e.g. carismodesign.myshopify.com
const SHOPIFY_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_VERSION  = process.env.SHOPIFY_API_VERSION || '2025-10';

const TRELLO_KEY       = process.env.TRELLO_KEY;
const TRELLO_TOKEN     = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID_ENV = process.env.TRELLO_BOARD_ID || '';
const TRELLO_LIST_ID_ENV  = process.env.TRELLO_LIST_ID  || '';
const TRELLO_BOARD_NAME   = process.env.TRELLO_BOARD_NAME || 'Carismo Design';
const TRELLO_LIST_NAME    = process.env.TRELLO_LIST_NAME  || 'Nick To-Do';

/* =========================
   Detection constants
========================= */
const ORDER_REGEX_MULTI  = /C#\d{4,5}/gi;      // find-all
const DAILY_SUBJECT = 'Daily Reminder to Remove NeedPhotoNoShip Tag and Follow-Up Metafields as Needed';

function isDailyReminderString(s) {
  const normalized = (s || '').replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-'); // normalize hyphens
  return /daily\s+reminder/i.test(normalized) && /need\s*photo|needphoto/i.test(normalized);
}

/* Shopify targets */
const CLEAR_TO_NO = 'No';
const TAGS_TO_REMOVE = ['NeedPhotoNoShip', 'NeedsFollowUp_Yes'];
const MF_NEEDS_FOLLOW_UP = { namespace: 'custom', key: '_nc_needs_follow_up_' };
const MF_FOLLOW_UP_NOTES  = { namespace: 'custom', key: 'follow_up_notes' };

/* =========================
   Shopify Admin GraphQL core
========================= */
async function shopifyGQL(query, variables) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      'Shopify-API-Version': SHOPIFY_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopify HTTP ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  if (json.errors?.length) throw new Error(`Shopify GQL errors: ${JSON.stringify(json.errors)}`);
  if (json.data?.errors?.length) throw new Error(`Shopify data.errors: ${JSON.stringify(json.data.errors)}`);
  return json.data;
}

/* =========================
   Shopify Queries & Mutations
========================= */
const ORDER_LOOKUP_GQL = `
  query ($q: String!) {
    orders(first: 1, query: $q) {
      edges {
        node {
          id
          legacyResourceId
          name
          tags
          needsFollowUpMf: metafield(namespace: "custom", key: "_nc_needs_follow_up_") { id value }
          followUpNotesMf: metafield(namespace: "custom", key: "follow_up_notes") { id value }
        }
      }
    }
  }
`;

const METAFIELDS_SET_GQL = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_DELETE_GQL = `
  mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { namespace key }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_GQL = `
  mutation tagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { ... on Order { id tags } }
      userErrors { field message }
    }
  }
`;

const ORDER_NOTE_QUERY_GQL = `
  query ($id: ID!) {
    order(id: $id) {
      id
      note
    }
  }
`;

const ORDER_UPDATE_GQL = `
  mutation orderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id note }
      userErrors { field message }
    }
  }
`;

/* =========================
   Shopify Helpers
========================= */
async function getOrderByName(orderName) {
  const q = `name:'${orderName}' status:any`;
  const data = await shopifyGQL(ORDER_LOOKUP_GQL, { q });
  return data?.orders?.edges?.[0]?.node ?? null;
}

async function setOrderMetafields(orderId, { needsFollowUp }) {
  const metafields = [];
  if (typeof needsFollowUp !== 'undefined') {
    metafields.push({
      ownerId: orderId,
      namespace: MF_NEEDS_FOLLOW_UP.namespace,
      key: MF_NEEDS_FOLLOW_UP.key,
      type: 'single_line_text_field',
      value: String(needsFollowUp),
    });
  }
  if (!metafields.length) return;
  const res = await shopifyGQL(METAFIELDS_SET_GQL, { metafields });
  const errs = res?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet errors: ${JSON.stringify(errs)}`);
}

async function deleteMetafieldByKey({ ownerId, namespace, key }) {
  if (!ownerId || !namespace || !key) return;
  const res = await shopifyGQL(METAFIELDS_DELETE_GQL, {
    metafields: [{ ownerId, namespace, key }],
  });
  const errs = res?.metafieldsDelete?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsDelete errors: ${JSON.stringify(errs)}`);
  return res?.metafieldsDelete?.deletedMetafields || [];
}

async function removeOrderTags(orderId, tags) {
  if (!tags?.length) return [];
  const res = await shopifyGQL(TAGS_REMOVE_GQL, { id: orderId, tags });
  const errs = res?.tagsRemove?.userErrors || [];
  if (errs.length) throw new Error(`tagsRemove errors: ${JSON.stringify(errs)}`);
  return res?.tagsRemove?.node?.tags || [];
}

function orderAdminUrl(legacyId) {
  return `https://${SHOPIFY_DOMAIN}/admin/orders/${legacyId}`;
}

async function prependOrderNote(orderId, newLine) {
  const noteData = await shopifyGQL(ORDER_NOTE_QUERY_GQL, { id: orderId });
  const existingNote = noteData?.order?.note || '';
  const updatedNote = [
    newLine,
    '',
    '',
    '--------',
    '',
    '',
    existingNote
  ].join('\n');

  const res = await shopifyGQL(ORDER_UPDATE_GQL, { input: { id: orderId, note: updatedNote } });
  const errs = res?.orderUpdate?.userErrors || [];
  if (errs.length) throw new Error(`orderUpdate errors: ${JSON.stringify(errs)}`);
  return res?.orderUpdate?.order?.note || '';
}

/* =========================
   Trello helpers
========================= */
async function trelloGET(path) {
  const url = `https://api.trello.com/1${path}${path.includes('?') ? '&' : '?'}key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Trello GET ${path} -> ${r.status}`);
  return r.json();
}
async function trelloPOST(path, payload) {
  const url = `https://api.trello.com/1${path}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`Trello POST ${path} -> ${r.status}`);
  return r.json();
}

let TRELLO_IDS = { boardId: null, listId: null };
async function resolveTrelloIds() {
  if (TRELLO_BOARD_ID_ENV && TRELLO_LIST_ID_ENV) {
    TRELLO_IDS = { boardId: TRELLO_BOARD_ID_ENV, listId: TRELLO_LIST_ID_ENV };
    return TRELLO_IDS;
  }
  const meBoards = await trelloGET('/members/me/boards?fields=name,id&filter=open');
  const board = meBoards.find(b => (b.name || '').trim().toLowerCase() === TRELLO_BOARD_NAME.trim().toLowerCase());
  if (!board) throw new Error(`Trello board not found: ${TRELLO_BOARD_NAME}`);
  const lists = await trelloGET(`/boards/${board.id}/lists?cards=none&filter=open`);
  const list = lists.find(l => (l.name || '').trim().toLowerCase() === TRELLO_LIST_NAME.trim().toLowerCase());
  if (!list) throw new Error(`Trello list not found on board: ${TRELLO_LIST_NAME}`);
  TRELLO_IDS = { boardId: board.id, listId: list.id };
  return TRELLO_IDS;
}

/* =========================
   Slack Email helpers
========================= */
function collectEmailHaystacks(event) {
  const haystacks = [];
  if (event.text) haystacks.push(event.text);

  if (Array.isArray(event.attachments)) {
    for (const a of event.attachments) {
      if (a.title)   haystacks.push(a.title);
      if (a.text)    haystacks.push(a.text);
      if (a.fallback)haystacks.push(a.fallback);
    }
  }

  if (Array.isArray(event.blocks)) {
    for (const b of event.blocks) {
      if ((b.type === 'section' || b.type === 'header') && b.text?.text) {
        haystacks.push(b.text.text);
      }
      if (b.type === 'rich_text') {
        try { haystacks.push(JSON.stringify(b)); } catch {}
      }
    }
  }

  if (Array.isArray(event.files)) {
    for (const f of event.files) {
      if (f.title) haystacks.push(f.title);
      if (f.name)  haystacks.push(f.name);
    }
  }
  if (event.initial_comment?.comment) {
    haystacks.push(event.initial_comment.comment);
  }
  return haystacks.join('\n');
}

function extractSubjectFromSlackEmail(event) {
  const titles = (event.attachments || []).map(a => a.title).filter(Boolean);
  if (titles.length) return titles[0].trim();
  if (event.text) {
    const first = String(event.text).split('\n')[0].trim();
    if (first.toLowerCase().startsWith('subject:')) {
      return first.replace(/^[Ss]ubject:\s*/, '').trim();
    }
    return first;
  }
  return '';
}

/* Download attached file text (Slack Email posts bodies as files in file_share) */
async function slurpSlackFilesText(event, logger) {
  const out = [];
  if (!Array.isArray(event.files) || !event.files.length) return out;

  for (const f of event.files) {
    const url = f.url_private_download || f.url_private;
    if (!url) continue;
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      if (!r.ok) {
        logger?.warn?.('file fetch failed', { status: r.status, name: f.name, mimetype: f.mimetype });
        continue;
      }
      const text = await r.text();
      out.push(text);
      logger?.info?.({ fileFetched: { name: f.name, size: (text || '').length, mimetype: f.mimetype } });
    } catch (e) {
      logger?.error?.('file fetch error', e);
    }
  }
  return out;
}

/* Multi-order detector dedicated to this daily email */
async function extractOrderNamesFromDailyReminder(event, logger) {
  // Prefer exact subject match (robust across Slack Email post formats)
  const subject = (extractSubjectFromSlackEmail(event) || '').trim();
  const subjectIsDaily = subject.toLowerCase() === DAILY_SUBJECT.toLowerCase();

  // Build corpus from everything we can see
  let corpus = collectEmailHaystacks(event);
  let orders = corpus.match(ORDER_REGEX_MULTI) || [];

  // If we didn't clearly see subject or orders, also fetch file bodies
  if ((!subjectIsDaily || !orders.length)) {
    const fileTexts = await slurpSlackFilesText(event, logger);
    if (fileTexts.length) {
      corpus += '\n' + fileTexts.join('\n');
      orders = orders.length ? orders : (corpus.match(ORDER_REGEX_MULTI) || []);
    }
  }

  // Fallback: if the posted subject wasn’t available, detect via body wording
  const isDaily = subjectIsDaily || isDailyReminderString(corpus);

  logger?.info?.({
    dailyCheck: {
      subject,
      isDaily,
      foundOrders: orders.length,
      sample: corpus.slice(0, 160)
    }
  });

  if (!isDaily || !orders.length) return [];

  // Deduplicate while preserving order
  const seen = new Set();
  const deduped = [];
  for (const o of orders) {
    const up = o.toUpperCase();
    if (!seen.has(up)) {
      seen.add(up);
      deduped.push(up);
    }
  }
  return deduped;
}

/* =========================
   UI Blocks (two buttons)
========================= */
function actionBlocksDaily({ orderName, preview }) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `Daily reminder for *${orderName}*.` } },
    preview ? { type: 'context', elements: [{ type: 'mrkdwn', text: `_${preview}_` }] } : null,
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Good, clear tags' }, action_id: 'good_clear', style: 'primary', value: JSON.stringify({ orderName }) },
        { type: 'button', text: { type: 'plain_text', text: 'Make Trello Card' }, action_id: 'make_trello', value: JSON.stringify({ orderName }) }
      ]
    }
  ].filter(Boolean);
}

async function postActionCard({ client, channel, thread_ts, orderName, preview }) {
  await client.chat.postMessage({
    channel,
    thread_ts,
    text: `Actions for ${orderName}`,
    blocks: actionBlocksDaily({ orderName, preview })
  });
}

// Helper for safe code blocks in Slack
function _forCodeBlock(s) {
  return String(s ?? '').replace(/```/g, '`​`​`').trim();
}

/* =========================
   Slack events
========================= */
app.event('message', async ({ event, client, logger }) => {
  try {
    if (!WATCH_CHANNEL) return;
    if (event.channel !== WATCH_CHANNEL) return;

    // Only care about daily reminder emails (multi-order list)
    const orders = await extractOrderNamesFromDailyReminder(event, logger);
    if (!orders.length) return;

    const preview =
      (event.text && event.text.slice(0, 140)) ||
      (event.files?.[0]?.title?.slice(0, 140)) ||
      '';

    for (const orderName of orders) {
      await postActionCard({
        client,
        channel: event.channel,
        thread_ts: event.ts,
        orderName,
        preview
      });
    }
  } catch (e) {
    console.error('message handler error', e);
  }
});

/* =========================
   Slack actions: Good/Clear
========================= */
app.action('good_clear', async ({ ack, body, client, logger }) => {
  await ack();
  const channel = body.channel?.id;
  const thread_ts = body.message?.thread_ts || body.message?.ts;

  let orderName = '';
  try {
    const payload = JSON.parse(body.actions?.[0]?.value || '{}');
    orderName = payload.orderName || '';
  } catch {}

  try {
    const order = await getOrderByName(orderName);
    if (!order) {
      await client.chat.postMessage({ channel, thread_ts, text: `❌ Order not found: ${orderName}` });
      return;
    }

    const orderId  = order.id;
    const legacyId = order.legacyResourceId;

    const oldNeeds = order?.needsFollowUpMf?.value ?? null;
    const oldNotes = order?.followUpNotesMf?.value ?? null;

    // 1) needs_follow_up = "No"
    await setOrderMetafields(orderId, { needsFollowUp: CLEAR_TO_NO });

    // 2) delete follow_up_notes
    await deleteMetafieldByKey({
      ownerId: orderId,
      namespace: MF_FOLLOW_UP_NOTES.namespace,
      key: MF_FOLLOW_UP_NOTES.key,
    });

    // 3) remove tags
    await removeOrderTags(orderId, TAGS_TO_REMOVE);

    // 4) prepend audit line to Notes
    const date = new Date().toISOString().slice(0, 10);
    const by = `@${body.user?.username || body.user?.name || 'user'}`;
    const newLine = `Cleared from daily reminder on ${date} by ${by}`;
    await prependOrderNote(orderId, newLine);

    const adminUrl = orderAdminUrl(legacyId);
    const oldNotesShown = (oldNotes && _forCodeBlock(oldNotes.slice(0, 4000))) || '(blank)';

    const lines = [
      `:white_check_mark: *Updated ${orderName}*`,
      '',
      '• Metafield `custom._nc_needs_follow_up_`:',
      `> ${oldNeeds || '(blank)'} → *No*`,
      '',
      '• Metafield `custom.follow_up_notes` (old → new):',
      '```',
      `${oldNotesShown}`,
      '```',
      '→ \`deleted\`',
      '',
      '• Tags removed:',
      TAGS_TO_REMOVE.join(', '),
      '',
      '• Note prepended with audit entry',
      '',
      `<${adminUrl}|Open Order in Shopify Admin>`
    ];

    await client.chat.postMessage({ channel, thread_ts, text: lines.join('\n') });

  } catch (e) {
    logger?.error?.('good_clear failed', e);
    await client.chat.postMessage({
      channel, thread_ts,
      text: `❌ Failed to clear tags/metafields: ${e.message}`
    });
  }
});

/* =========================
   Slack actions: Make Trello Card
========================= */
app.action('make_trello', async ({ ack, body, client, logger }) => {
  await ack();
  const channel = body.channel?.id;
  const thread_ts = body.message?.thread_ts || body.message?.ts;

  let orderName = '';
  try {
    const payload = JSON.parse(body.actions?.[0]?.value || '{}');
    orderName = payload.orderName || '';
  } catch {}

  try {
    const { listId } = await resolveTrelloIds();
    const title = `${orderName} needs more info, needs email follow up`;
    const card = await trelloPOST('/cards', { idList: listId, name: title });
    await client.chat.postMessage({
      channel, thread_ts,
      text: `📝 Trello card created: ${card.url}`
    });
  } catch (e) {
    logger?.error?.('make_trello failed', e);
    await client.chat.postMessage({
      channel, thread_ts,
      text: `❌ Failed to create Trello card: ${e.message}`
    });
  }
});

/* =========================
   Start
========================= */
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`✅ daily-needphotonoship-reminder bot running on port ${port}`);
  console.log('🔧 Watching channel ID:', WATCH_CHANNEL || '(not set)');

  try {
    await resolveTrelloIds();
    console.log('✅ Trello board/list resolved');
  } catch (e) {
    console.error('⚠️ Trello board/list resolution failed. Will retry on first use.', e.message);
  }
})();