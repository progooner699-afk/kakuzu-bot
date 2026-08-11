const test = require('node:test');
const assert = require('assert');

const command = require('../commands/link-roblox');

function createInteraction(overrides = {}) {
  return {
    member: {
      permissions: {
        has: () => false
      }
    },
    reply: async () => ({ ok: true }),
    client: {
      user: {
        displayAvatarURL: () => 'https://example.com/avatar.png'
      }
    },
    ...overrides
  };
}

test('link-roblox command denies access without admin or manage-messages permission', async () => {
  const interaction = createInteraction();
  let replyPayload;
  interaction.reply = async (payload) => {
    replyPayload = payload;
    return payload;
  };

  await command.execute(interaction);

  assert.ok(replyPayload);
  assert.match(replyPayload.content, /Administrator|Manage Messages/);
});

test('link-roblox command allows admins to continue', async () => {
  const interaction = createInteraction({
    member: {
      permissions: {
        has: () => true
      }
    }
  });
  let replyPayload;
  interaction.reply = async (payload) => {
    replyPayload = payload;
    return payload;
  };

  await command.execute(interaction);

  assert.ok(replyPayload);
  assert.ok(replyPayload.embeds);
  assert.strictEqual(replyPayload.embeds[0].data.title, 'Roblox Account Linking System');
});
