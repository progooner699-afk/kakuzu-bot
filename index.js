require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const config = require('./config.json');
const commandHandler = require('./handlers/commandHandler');
const raidStateManager = require('./handlers/raidStateManager');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
client.raidStateManager = raidStateManager;

commandHandler.loadCommands(client);

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
        client.once(event.name, (...args) => {
            event.execute(...args, client).catch(error => console.error(`Event ${event.name} error:`, error));
        });
    } else {
        client.on(event.name, (...args) => {
            event.execute(...args, client).catch(error => console.error(`Event ${event.name} error:`, error));
        });
    }
}

raidStateManager.ensureDataFiles();

client.login(process.env.DISCORD_TOKEN);
