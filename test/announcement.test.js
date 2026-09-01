const test = require('node:test');
const assert = require('assert');
const announcement = require('../commands/announcement');

const NL = String.fromCharCode(10);

function fakeState(overrides = {}) {
  return {
    title: 'Server Update',
    description: 'Patch notes for this week.',
    fields: [
      { name: 'Rules', value: 'Be respectful' },
      { name: 'Rewards', value: '10K cash' },
      { name: 'Schedule', value: 'Every Friday' },
      { name: 'Schedule 2', value: 'Every Saturday' },
      { name: 'Schedule 3', value: 'Every Sunday' },
      { name: 'Schedule 4', value: 'Every Monday' },
      { name: 'Schedule 5', value: 'Every Tuesday' },
      { name: 'Schedule 6', value: 'Every Wednesday' }
    ],
    thumbnailUrl: 'https://example.com/banner.png',
    ping: '@everyone',
    webhookName: 'Kakuzu News',
    panelMessageId: null,
    ...overrides
  };
}

test('announcement card sets the V2 flag and wraps in a Container', () => {
  const payload = announcement.buildAnnouncementPayload(fakeState());
  assert.strictEqual(payload.flags, 1 << 15); // IS_COMPONENTS_V2
  assert.strictEqual(payload.components.length, 1);
  const container = payload.components[0];
  assert.strictEqual(container.type, 17); // Container
  assert.strictEqual(container.accent_color, 0x5865f2);
});

test('thumbnail renders as a wide MediaGallery banner at the TOP', () => {
  const payload = announcement.buildAnnouncementPayload(fakeState());
  const components = payload.components[0].components;
  assert.strictEqual(components[0].type, 12); // MediaGallery is the first component
  assert.strictEqual(components[0].items.length, 1);
  assert.match(components[0].items[0].media.url, /^https:\/\//);

  // No thumbnail -> content starts with the title TextDisplay.
  const noThumb = announcement.buildAnnouncementPayload(fakeState({ thumbnailUrl: null }));
  assert.notStrictEqual(noThumb.components[0].components[0].type, 12);
});

test('supports up to 8 fields, each followed by a native V2 separator', () => {
  const payload = announcement.buildAnnouncementPayload(fakeState());
  const components = payload.components[0].components;
  const textContents = components
    .filter((c) => c.type === 10)
    .flatMap((c) => c.content)
    .join(NL);
  const separators = components.filter((c) => c.type === 14);

  const fields = fakeState().fields;
  assert.strictEqual(fields.length, announcement.MAX_FIELDS);
  fields.forEach((f) => {
    assert.ok(textContents.includes(f.name));
    assert.ok(textContents.includes(f.value));
  });
  // One separator after the banner-less title section + 1 per field + footer = 9
  assert.strictEqual(separators.length, fields.length + 2);
  separators.forEach((s) => {
    assert.strictEqual(s.divider, true);
    assert.strictEqual(s.spacing, 1);
  });
});

test('title, description and footer sections are present', () => {
  const payload = announcement.buildAnnouncementPayload(fakeState());
  const textContents = payload.components[0].components
    .filter((c) => c.type === 10)
    .flatMap((c) => c.content)
    .join(NL);
  assert.ok(textContents.includes('# 📢 Server Update'));
  assert.ok(textContents.includes('Patch notes for this week.'));
  assert.ok(textContents.includes('Announced <t:'));
});

test('builder panel exposes all button rows including Field 1-8', () => {
  const panel = announcement.buildBuilderComponents(fakeState());
  assert.strictEqual(panel.flags, 1 << 15);
  const container = panel.components[0];
  const rows = container.components.filter((c) => c.type === 1);
  assert.ok(rows.length >= 4);

  const ids = rows.flatMap((r) => r.components.map((b) => b.custom_id));
  ['annb_title', 'annb_desc', 'annb_thumb', 'annb_ping', 'annb_webhook',
    'annb_preview', 'annb_publish', 'annb_cancel', 'annb_clearfields',
    'annb_field_1', 'annb_field_2', 'annb_field_3', 'annb_field_4', 'annb_field_5',
    'annb_field_6', 'annb_field_7', 'annb_field_8'
  ].forEach((id) => assert.ok(ids.includes(id), 'missing button ' + id));
});