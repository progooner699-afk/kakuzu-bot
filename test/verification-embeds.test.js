const test = require('node:test');
const assert = require('assert');

const { formatRobloxProfileValue } = require('../handlers/verificationHelpers');

test('formatRobloxProfileValue returns a clickable Roblox profile link when a user ID exists', () => {
  const value = formatRobloxProfileValue({
    robloxDisplayName: 'Kakuzu',
    robloxUsername: 'kakuzu',
    robloxUserId: '123456'
  });

  assert.strictEqual(value, '[Kakuzu (@kakuzu)](https://www.roblox.com/users/123456/profile)');
});

test('formatRobloxProfileValue falls back to plain text when no user ID is available', () => {
  const value = formatRobloxProfileValue({
    robloxDisplayName: 'Kakuzu',
    robloxUsername: 'kakuzu'
  });

  assert.strictEqual(value, 'Kakuzu (@kakuzu)');
});
