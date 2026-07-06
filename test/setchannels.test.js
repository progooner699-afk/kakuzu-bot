const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const setChannelsCommand = require('../commands/setchannels');
const raidStateManager = require('../handlers/raidStateManager');

const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');

function resetSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify({
    raidChannel: null,
    helpChannel: null,
    leaderboardChannel: null,
    leaderboardMessageId: null,
    resultChannel: null
  }, null, 4));
}

test('setchannels stores leaderboard channel under the expected settings key', async () => {
  resetSettings();

  const interaction = {
    options: {
      getChannel(name) {
        return { id: `${name}-channel` };
      }
    },
    client: { user: { id: 'bot-id' } },
    reply: async () => {},
    member: {}
  };

  const publishLeaderboardCalls = [];
  const originalPublish = raidStateManager.publishLeaderboard;
  raidStateManager.publishLeaderboard = async () => {
    publishLeaderboardCalls.push(true);
  };

  try {
    await setChannelsCommand.execute(interaction);
    const settings = raidStateManager.loadSettings();

    assert.equal(settings.raidChannel, 'raid_channel-channel');
    assert.equal(settings.helpChannel, 'help_channel-channel');
    assert.equal(settings.leaderboardChannel, 'leaderboard_channel-channel');
    assert.equal(settings.lbChannel, 'leaderboard_channel-channel');
    assert.equal(publishLeaderboardCalls.length, 1);
  } finally {
    raidStateManager.publishLeaderboard = originalPublish;
    resetSettings();
  }
});
